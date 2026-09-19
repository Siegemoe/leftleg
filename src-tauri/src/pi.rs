use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct RequestEntry {
    pub tx: std::sync::mpsc::Sender<Value>,
}

#[derive(Default)]
pub struct PendingMap {
    inner: Mutex<HashMap<String, RequestEntry>>,
}

impl PendingMap {
    pub fn insert(&self, id: String, tx: std::sync::mpsc::Sender<Value>) -> bool {
        let mut map = self.inner.lock().unwrap();
        if map.contains_key(&id) {
            return false;
        }
        map.insert(id, RequestEntry { tx });
        true
    }
    pub fn remove(&self, id: &str) -> Option<std::sync::mpsc::Sender<Value>> {
        self.inner.lock().unwrap().remove(id).map(|e| e.tx)
    }
    pub fn clear(&self) {
        self.inner.lock().unwrap().clear();
    }
}

/// What to do with one JSONL line read from pi's stdout.
#[derive(Debug, PartialEq)]
pub enum LineAction {
    /// Empty or unparseable line — skip entirely.
    Skip,
    /// An event for the webview.
    Emit(Value),
    /// A `type:"response"` message: resolve the pending request by id,
    /// falling back to emitting when the id is unknown.
    Response { id: String, value: Value },
}

/// Classify one raw stdout line. Framing contract: lines are split on `\n`
/// only (by the reader thread), any trailing `\r` is stripped here, empty and
/// invalid-JSON lines are skipped, `type:"response"` messages with a string
/// id are routed to the pending-request map, everything else goes to the UI.
pub fn classify_line(bytes: &[u8]) -> LineAction {
    let mut slice = bytes;
    if slice.last() == Some(&b'\r') {
        slice = &slice[..slice.len() - 1];
    }
    if slice.is_empty() {
        return LineAction::Skip;
    }
    let Ok(value) = serde_json::from_slice::<Value>(slice) else {
        return LineAction::Skip;
    };
    if value.get("type").and_then(|t| t.as_str()) == Some("response") {
        if let Some(id) = value.get("id").and_then(|v| v.as_str()).map(String::from) {
            return LineAction::Response { id, value };
        }
    }
    LineAction::Emit(value)
}

/// Pass session paths directly to Node, never through cmd.exe expansion.
pub fn build_pi_args(session_path: Option<&str>) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    if let Some(path) = session_path {
        args.push("--session".to_string());
        args.push(path.to_string());
    }
    args
}

pub(crate) fn pi_entry_from_shim(shim: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let root = shim.parent().ok_or("pi shim has no parent")?;
    for package in [
        "@earendil-works/pi-coding-agent",
        "@mariozechner/pi-coding-agent",
    ] {
        let dir = root.join("node_modules").join(package);
        // A missing OR corrupt/odd manifest must not abort the search: the
        // fallback package name may still be intact (e.g. mid-`pi update`).
        let Ok(raw) = std::fs::read_to_string(dir.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(bin) = manifest["bin"]["pi"]
            .as_str()
            .or_else(|| manifest["bin"].as_str())
        else {
            continue;
        };
        let entry = std::fs::canonicalize(dir.join(bin)).map_err(|e| e.to_string())?;
        if !entry.starts_with(std::fs::canonicalize(&dir).map_err(|e| e.to_string())?) {
            return Err("pi bin escapes package directory".into());
        }
        // canonicalize is only for containment validation. On Windows it
        // returns a verbatim (\\?\) path that Node cannot use as its main script.
        return Ok(dir.join(bin));
    }
    Err("Could not resolve the npm pi package next to pi.cmd".into())
}

/// Resolve the npm pi package next to pi.cmd and return its identity.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModuleInfo {
    pub name: String,
    pub version: String,
    pub path: String,
}

pub fn pi_module_info_impl() -> Result<PiModuleInfo, String> {
    let mut where_cmd = Command::new("where.exe");
    #[cfg(windows)]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    let found = where_cmd
        .arg("pi.cmd")
        .output()
        .map_err(|e| format!("locating pi: {e}"))?;
    let paths = String::from_utf8_lossy(&found.stdout);
    let shim = std::path::Path::new(
        paths
            .lines()
            .next()
            .ok_or("pi.cmd not found on PATH")?
            .trim(),
    );
    let root = shim.parent().ok_or("pi shim has no parent")?;
    for package in [
        "@earendil-works/pi-coding-agent",
        "@mariozechner/pi-coding-agent",
    ] {
        let dir = root.join("node_modules").join(package);
        let Ok(raw) = std::fs::read_to_string(dir.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let name = manifest
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(package)
            .to_string();
        let version = manifest
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        return Ok(PiModuleInfo {
            name,
            version,
            path: dir.to_string_lossy().into_owned(),
        });
    }
    Err("Could not resolve the npm pi package".into())
}

/// Identity of the installed pi module (npm package name + version).
#[tauri::command]
pub async fn pi_module_info() -> Result<PiModuleInfo, String> {
    tauri::async_runtime::spawn_blocking(pi_module_info_impl)
        .await
        .map_err(|e| e.to_string())?
}

/// Handle to a running `pi --mode rpc` subprocess.
pub struct PiProcess {
    /// Unique per spawn — the webview uses it to drop stale events from a
    /// replaced process (a killed process's tail can outlive the spawn that
    /// replaced it).
    pub id: u64,
    /// Project dir this process is rooted in; tags every emitted event.
    pub cwd: String,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    pub pending: Arc<PendingMap>,
    seq: AtomicU64,
    /// Set before a deliberate kill so the webview can tell a user stop
    /// from a crash when `pi-exit` fires.
    expecting_exit: AtomicBool,
    exited: AtomicBool,
    exit_error: Mutex<Option<String>>,
}

const STDERR_LIMIT: usize = 8192;

fn retain_stderr(tail: &mut Vec<u8>, bytes: &[u8]) {
    tail.extend_from_slice(bytes);
    if tail.len() > STDERR_LIMIT {
        tail.drain(..tail.len() - STDERR_LIMIT);
    }
}

static NEXT_PROCESS_ID: AtomicU64 = AtomicU64::new(1);

impl PiProcess {
    /// Spawn `pi --mode rpc` in the given working directory and start the
    /// stdout reader thread that forwards events to the webview.
    /// `session_path` resumes that session file via `--session` at startup.
    pub fn spawn(
        app: AppHandle,
        cwd: &str,
        session_path: Option<&str>,
    ) -> Result<Arc<PiProcess>, String> {
        let mut where_cmd = Command::new("where.exe");
        #[cfg(windows)]
        where_cmd.creation_flags(CREATE_NO_WINDOW);
        let found = where_cmd
            .arg("pi.cmd")
            .output()
            .map_err(|e| format!("locating pi: {e}"))?;
        let paths = String::from_utf8_lossy(&found.stdout);
        let shim = std::path::Path::new(
            paths
                .lines()
                .next()
                .ok_or("pi.cmd not found on PATH")?
                .trim(),
        );
        let entry = pi_entry_from_shim(shim)?;
        let sibling_node = shim
            .parent()
            .ok_or("pi shim has no parent")?
            .join("node.exe");
        let mut cmd = Command::new(if sibling_node.is_file() {
            sibling_node
        } else {
            "node".into()
        });
        cmd.arg(entry)
            .args(build_pi_args(session_path))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn pi: {e}"))?;

        let (stdin, stdout, mut stderr) =
            match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
                (Some(i), Some(o), Some(e)) => (i, o, e),
                _ => {
                    // Never leave a spawned child orphaned on a partial stdio setup.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("failed to capture pi stdio pipes".into());
                }
            };
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        let tail = stderr_tail.clone();
        let (stderr_done, stderr_finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0; 1024];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                retain_stderr(&mut tail.lock().unwrap(), &buf[..n]);
            }
            let _ = stderr_done.send(());
        });

        let proc = Arc::new(PiProcess {
            id: NEXT_PROCESS_ID.fetch_add(1, Ordering::SeqCst),
            cwd: cwd.to_string(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            pending: Arc::new(PendingMap::default()),
            seq: AtomicU64::new(1),
            expecting_exit: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            exit_error: Mutex::new(None),
        });

        // Reader thread: strict JSONL framing — split on '\n' only, strip '\r'.
        // Read in bounded chunks with a hard per-line cap so a runaway pi
        // emitting an endless line costs bounded memory instead of an OOM.
        let app_handle = app.clone();
        let pending = proc.pending.clone();
        let proc_ref = proc.clone();
        std::thread::spawn(move || {
            let process_line = |bytes: &[u8]| {
                // Every line is wrapped in an envelope naming the owning
                // process, so the webview can route multi-project events and
                // drop stale ones after a respawn.
                let envelope = |value: Value| {
                    serde_json::json!({
                        "project": proc_ref.cwd,
                        "proc": proc_ref.id,
                        "event": value,
                    })
                };
                match classify_line(bytes) {
                    LineAction::Skip => {}
                    LineAction::Emit(value) => {
                        let _ = app_handle.emit("pi-event", envelope(value));
                    }
                    LineAction::Response { id, value } => {
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(value); // response consumed by the waiting request
                        } else {
                            // Unknown id (late timeout, restart, etc.) — surface to the webview.
                            let _ = app_handle.emit("pi-event", envelope(value));
                        }
                    }
                }
            };
            const MAX_LINE_BYTES: usize = 64 * 1024 * 1024; // 20 MiB attachments base64-encoded inside events
            let mut stdout = stdout;
            let mut line: Vec<u8> = Vec::with_capacity(8 * 1024);
            let mut chunk = [0u8; 16 * 1024];
            let mut skipping_oversized = false;
            loop {
                let n = match stdout.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                let mut start = 0usize;
                for i in 0..n {
                    if chunk[i] != b'\n' {
                        continue;
                    }
                    if skipping_oversized {
                        skipping_oversized = false;
                    } else {
                        line.extend_from_slice(&chunk[start..i]);
                        process_line(&line);
                        line.clear();
                    }
                    start = i + 1;
                }
                if !skipping_oversized {
                    line.extend_from_slice(&chunk[start..n]);
                    if line.len() > MAX_LINE_BYTES {
                        // A drop must at least be diagnosable — the webview
                        // never sees this line and can't explain the gap.
                        crate::log_native(
                            &app_handle,
                            &format!(
                                "dropped oversized pi line ({}, {} bytes)",
                                proc_ref.id,
                                line.len()
                            ),
                        );
                        line.clear();
                        skipping_oversized = true; // discard the rest of this line
                    }
                }
            }
            if !skipping_oversized && !line.is_empty() {
                process_line(&line); // final line without a trailing newline
            }
            // Stream ended: pi exited. Tell the webview whether we killed it
            // on purpose (stop/restart) or it died on its own (crash).
            // Drain the final diagnostic without hanging on inherited pipes.
            let _ = stderr_finished.recv_timeout(Duration::from_millis(200));
            let detail = String::from_utf8_lossy(&stderr_tail.lock().unwrap())
                .trim()
                .to_string();
            let error = if detail.is_empty() {
                "pi exited before responding".to_string()
            } else {
                format!("pi exited before responding: {detail}")
            };
            *proc_ref.exit_error.lock().unwrap() = Some(error.clone());
            proc_ref.exited.store(true, Ordering::SeqCst);
            pending.clear();
            let expected = proc_ref.expecting_exit.load(Ordering::SeqCst);
            if !expected {
                // Sync native log: append_log became async, and dropping its
                // future here would silently lose crash diagnostics.
                crate::log_native(&app_handle, &format!("pi-exit [{}]: {error}", proc_ref.cwd));
            }
            let _ = app_handle.emit(
                "pi-exit",
                serde_json::json!({
                    "project": proc_ref.cwd,
                    "proc": proc_ref.id,
                    "expected": expected,
                    "error": error,
                }),
            );
        });

        Ok(proc)
    }

    pub fn next_id(&self) -> String {
        format!("ll-{}", self.seq.fetch_add(1, Ordering::SeqCst))
    }

    /// Write a raw JSON line to pi's stdin.
    pub fn send_line(&self, line: &str) -> Result<(), String> {
        if self.exited.load(Ordering::SeqCst) {
            return Err(self
                .exit_error
                .lock()
                .unwrap()
                .clone()
                .unwrap_or("pi process exited".into()));
        }
        let mut guard = self.stdin.lock().unwrap();
        // A writer can wait behind another blocked write. Recheck after taking
        // the lock so a request whose deadline poisoned the transport cannot
        // dispatch later when that older writer finally releases it.
        if self.exited.load(Ordering::SeqCst) {
            return Err(self
                .exit_error
                .lock()
                .unwrap()
                .clone()
                .unwrap_or("pi process exited".into()));
        }
        if let Some(stdin) = guard.as_mut() {
            stdin
                .write_all(line.as_bytes())
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("write failed: {e}"))
        } else {
            Err("pi process stdin closed".into())
        }
    }

    pub fn is_alive(&self) -> bool {
        !self.exited.load(Ordering::SeqCst)
            && matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    /// Make a stalled stdin transport unavailable and stop its process tree
    /// without waiting for the stdin mutex. A queued writer may own or be
    /// waiting on that mutex; send_line's post-lock check prevents it from
    /// delivering after the caller has timed out.
    fn poison_transport(&self, error: &str) {
        *self.exit_error.lock().unwrap() = Some(error.to_string());
        self.exited.store(true, Ordering::SeqCst);
        self.pending.clear();
        if let Ok(mut child) = self.child.lock() {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn kill(&self) {
        self.expecting_exit.store(true, Ordering::SeqCst);
        self.exited.store(true, Ordering::SeqCst);
        self.pending.clear();
        // Killing the child closes its pipes, which unblocks the reader thread
        // and any writer blocked on a full stdin pipe, before we take the lock.
        if let Ok(mut child) = self.child.lock() {
            // Tree-kill first and unconditionally: when node already exited on
            // its own, a tool grandchild can still hold the stdout/stderr write
            // ends — skipping the tree kill would leave the reader thread
            // waiting for EOF forever and `pi-exit` never fires. taskkill on a
            // reaped PID fails harmlessly (output is swallowed).
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        *self.stdin.lock().unwrap() = None;
    }
}

/// Await a correlated response. A dropped channel means the pi process died
/// while the request was in flight — report that, not a bogus timeout.
pub fn wait_response(
    rx: std::sync::mpsc::Receiver<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    match rx.recv_timeout(timeout) {
        Ok(value) => Ok(value),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err("timed out waiting for response from pi".to_string())
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("pi exited before responding".to_string())
        }
    }
}

/// Send a command and wait (bounded) for the correlated response. The
/// deadline covers the write phase too: pi that stopped reading stdin would
/// otherwise block the send forever and the response timeout would never even
/// start. The write runs on its own thread; if it is still blocked at expiry
/// the transport is poisoned and its process tree is stopped. This is stricter
/// than a response timeout: once write delivery is ambiguous, keeping the
/// process alive could execute the command after the UI reports failure.
pub fn request(proc: &Arc<PiProcess>, mut cmd: Value, timeout: Duration) -> Result<Value, String> {
    if !cmd.is_object() {
        return Err("RPC command must be an object".into());
    }
    let id = cmd
        .get("id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| proc.next_id());
    if let Some(obj) = cmd.as_object_mut() {
        obj.insert("id".into(), Value::String(id.clone()));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    if !proc.pending.insert(id.clone(), tx) {
        return Err(format!("RPC id already pending: {id}"));
    }
    let line = match serde_json::to_string(&cmd) {
        Ok(line) => line,
        Err(e) => {
            proc.pending.remove(&id);
            return Err(e.to_string());
        }
    };
    let deadline = std::time::Instant::now() + timeout;
    let writer_proc = Arc::clone(proc);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done_tx.send(writer_proc.send_line(&line));
    });
    match done_rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            proc.pending.remove(&id);
            return Err(e);
        }
        Err(_) => {
            proc.pending.remove(&id);
            let error = "timed out writing to pi (process was stopped to prevent delayed delivery)";
            proc.poison_transport(error);
            return Err(error.into());
        }
    }
    match wait_response(
        rx,
        deadline.saturating_duration_since(std::time::Instant::now()),
    ) {
        Ok(value) => Ok(value),
        Err(e) => {
            proc.pending.remove(&id);
            Err(proc.exit_error.lock().unwrap().clone().unwrap_or(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stopped_process() -> PiProcess {
        let mut command = Command::new("cmd");
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.args(["/C", "exit", "0"]).spawn().unwrap();
        child.wait().unwrap();
        PiProcess {
            id: 1,
            cwd: String::new(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(None)),
            pending: Arc::new(PendingMap::default()),
            seq: AtomicU64::new(1),
            expecting_exit: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            exit_error: Mutex::new(None),
        }
    }

    #[test]
    fn failed_send_does_not_leak_pending_requests() {
        let proc = Arc::new(stopped_process());
        let result = request(
            &proc,
            serde_json::json!({"id":"test", "type":"get_state"}),
            Duration::from_millis(10),
        );
        assert!(result.unwrap_err().contains("stdin closed"));
        assert!(proc.pending.remove("test").is_none());
        assert!(request(&proc, Value::Null, Duration::from_millis(10))
            .unwrap_err()
            .contains("object"));
    }

    #[test]
    fn write_timeout_never_dispatches_a_queued_prompt_later() {
        use std::io::BufRead;
        let marker =
            std::env::temp_dir().join(format!("leftleg-late-rpc-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new("node");
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command.args(["-e", "process.stdout.write('ready\\n'); require('readline').createInterface({input:process.stdin}).on('line',line=>require('fs').writeFileSync(process.argv[1],line));"])
            .arg(&marker).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "ready\n");
        let stdin = child.stdin.take();
        let proc = Arc::new(PiProcess {
            id: 1,
            cwd: String::new(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(PendingMap::default()),
            seq: AtomicU64::new(1),
            expecting_exit: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            exit_error: Mutex::new(None),
        });
        // Simulate another writer holding the pipe until after this request's
        // deadline. A timed-out queued prompt must never reach the child.
        let held_stdin = proc.stdin.lock().unwrap();
        let result = request(
            &proc,
            serde_json::json!({"type":"prompt","message":"side effect"}),
            Duration::from_millis(50),
        );
        let rejected_further_work = proc.exited.load(Ordering::SeqCst);
        drop(held_stdin);
        std::thread::sleep(Duration::from_millis(200));
        proc.kill();
        let dispatched = marker.exists();
        let _ = std::fs::remove_file(&marker);
        assert!(result.unwrap_err().contains("timed out writing"));
        assert!(
            !dispatched,
            "timed-out prompt was dispatched after its caller received failure"
        );
        assert!(
            rejected_further_work,
            "stalled transport must reject later work"
        );
    }

    #[test]
    fn kill_unblocks_a_writer_when_pi_stops_reading_stdin() {
        let mut command = Command::new("node");
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .args(["-e", "setInterval(() => {}, 1000)"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let stdin = child.stdin.take();
        let proc = Arc::new(PiProcess {
            id: 1,
            cwd: String::new(),
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(PendingMap::default()),
            seq: AtomicU64::new(1),
            expecting_exit: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            exit_error: Mutex::new(None),
        });
        let writer = proc.clone();
        let send = std::thread::spawn(move || writer.send_line(&"x".repeat(4 * 1024 * 1024)));
        std::thread::sleep(Duration::from_millis(50));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            proc.kill();
            let _ = tx.send(());
        });
        let result = rx.recv_timeout(Duration::from_secs(5));
        if result.is_err() {
            let mut cleanup = Command::new("taskkill.exe");
            #[cfg(windows)]
            cleanup.creation_flags(CREATE_NO_WINDOW);
            let _ = cleanup
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
        assert!(result.is_ok(), "kill blocked behind a pipe writer");
        assert!(send.join().unwrap().is_err());
    }

    #[test]
    fn duplicate_ids_cannot_disconnect_the_original_waiter() {
        let map = PendingMap::default();
        let (first, rx) = std::sync::mpsc::channel();
        assert!(map.insert("same".into(), first));
        assert!(!map.insert("same".into(), std::sync::mpsc::channel().0));
        map.remove("same")
            .unwrap()
            .send(serde_json::json!("first"))
            .unwrap();
        assert_eq!(rx.recv().unwrap(), "first");
    }

    #[test]
    fn session_paths_are_literal_node_arguments() {
        let path = "C:\\work & play\\100%PATH%\\session.jsonl";
        let mut cmd = Command::new("node");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd
            .args([
                "-e",
                "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
                "--",
            ])
            .args(build_pi_args(Some(path)))
            .output()
            .unwrap();
        assert!(out.status.success());
        let args: Vec<String> = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(args, vec!["--mode", "rpc", "--session", path]);
    }

    #[test]
    fn resolves_npm_bin_from_manifest_without_running_a_shell() {
        let dir = std::env::temp_dir().join(format!("leftleg-pi-bin-{}", uuid::Uuid::new_v4()));
        let package = dir.join("node_modules/@earendil-works/pi-coding-agent");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), r#"{"bin":{"pi":"cli.js"}}"#).unwrap();
        std::fs::write(package.join("cli.js"), "process.stdout.write(JSON.stringify({type:'response',success:true,args:process.argv.slice(2)}))").unwrap();
        let entry = pi_entry_from_shim(&dir.join("pi.cmd")).unwrap();
        let mut cmd = Command::new("node");
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd.arg(entry).args(build_pi_args(None)).output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let response: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(response["success"], true);
        assert_eq!(response["args"], serde_json::json!(["--mode", "rpc"]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn stderr_retains_bounded_final_diagnostic() {
        let mut tail = Vec::new();
        retain_stderr(&mut tail, &vec![b'x'; STDERR_LIMIT * 2]);
        retain_stderr(&mut tail, b"\nError: EISDIR\n");
        assert_eq!(tail.len(), STDERR_LIMIT);
        assert!(tail.ends_with(b"Error: EISDIR\n"));
    }

    #[test]
    fn strips_trailing_cr() {
        // reader splits on '\n' only, so CRLF input leaves the '\r' on the line
        match classify_line(b"{\"type\":\"agent_start\"}\r") {
            LineAction::Emit(v) => assert_eq!(v["type"], "agent_start"),
            other => panic!("expected Emit, got {other:?}"),
        }
    }

    #[test]
    fn skips_empty_lines() {
        assert_eq!(classify_line(b""), LineAction::Skip);
        assert_eq!(classify_line(b"\r"), LineAction::Skip);
    }

    #[test]
    fn skips_invalid_json() {
        assert_eq!(classify_line(b"{not json"), LineAction::Skip);
    }

    #[test]
    fn forwards_events_to_webview() {
        match classify_line(b"{\"type\":\"extension_ui_request\",\"id\":\"e1\"}") {
            LineAction::Emit(v) => {
                assert_eq!(v["type"], "extension_ui_request");
                assert_eq!(v["id"], "e1");
            }
            other => panic!("expected Emit, got {other:?}"),
        }
    }

    #[test]
    fn routes_responses_with_string_id_to_pending_map() {
        let line = b"{\"type\":\"response\",\"id\":\"ll-1\",\"success\":true}";
        match classify_line(line) {
            LineAction::Response { id, value } => {
                assert_eq!(id, "ll-1");
                assert_eq!(value["success"], true);
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn responses_without_string_id_fall_back_to_emit() {
        // numeric id — cannot be correlated, must surface to the webview
        let line = b"{\"type\":\"response\",\"id\":42,\"success\":false}";
        assert!(matches!(classify_line(line), LineAction::Emit(_)));
    }

    #[test]
    fn pending_map_roundtrip_removal_and_clear() {
        let map = PendingMap::default();
        let (tx, rx) = std::sync::mpsc::channel();
        map.insert("a".to_string(), tx);

        let tx = map.remove("a").expect("entry present after insert");
        tx.send(serde_json::json!({"ok": true})).unwrap();
        assert_eq!(rx.recv().unwrap()["ok"], true);
        assert!(
            map.remove("a").is_none(),
            "entry must be removed on first take"
        );

        map.insert("b".to_string(), std::sync::mpsc::channel().0);
        map.clear();
        assert!(map.remove("b").is_none(), "clear must empty the map");
    }

    #[test]
    fn pi_args_include_session_flag_only_when_resuming() {
        let base = build_pi_args(None);
        assert_eq!(base, vec!["--mode", "rpc"]);

        let resumed = build_pi_args(Some("C:\\proj\\session.jsonl"));
        assert_eq!(
            resumed,
            vec!["--mode", "rpc", "--session", "C:\\proj\\session.jsonl"]
        );
    }

    #[test]
    fn wait_response_reports_disconnect_as_process_exit() {
        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        drop(tx); // pi died: the sender side is gone
        let err = wait_response(rx, Duration::from_millis(50)).unwrap_err();
        assert!(err.contains("pi exited before responding"), "got: {err}");
    }

    #[test]
    fn wait_response_reports_real_timeouts() {
        let (_tx, rx) = std::sync::mpsc::channel::<Value>();
        let err = wait_response(rx, Duration::from_millis(20)).unwrap_err();
        assert!(err.contains("timed out"), "got: {err}");
    }

    #[test]
    fn wait_response_returns_the_correlated_value() {
        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        tx.send(serde_json::json!({"type":"response","id":"ll-1","success":true}))
            .unwrap();
        let v = wait_response(rx, Duration::from_millis(50)).unwrap();
        assert_eq!(v["success"], true);
    }
}
