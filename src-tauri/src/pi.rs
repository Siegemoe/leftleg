use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
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
    pub fn insert(&self, id: String, tx: std::sync::mpsc::Sender<Value>) {
        self.inner.lock().unwrap().insert(id, RequestEntry { tx });
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

/// Build the argv for `pi --mode rpc` (optionally resuming a session file).
/// `cmd /C` is needed because npm installs `pi` as a .cmd shim on Windows.
pub fn build_pi_args(session_path: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "/C".to_string(),
        "pi".to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
    ];
    if let Some(path) = session_path {
        args.push("--session".to_string());
        args.push(path.to_string());
    }
    args
}

/// Handle to a running `pi --mode rpc` subprocess.
pub struct PiProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    pub pending: Arc<PendingMap>,
    seq: AtomicU64,
    /// Set before a deliberate kill so the webview can tell a user stop
    /// from a crash when `pi-exit` fires.
    expecting_exit: AtomicBool,
}

impl PiProcess {
    /// Spawn `pi --mode rpc` in the given working directory and start the
    /// stdout reader thread that forwards events to the webview.
    /// `session_path` resumes that session file via `--session` at startup.
    pub fn spawn(app: AppHandle, cwd: &str, session_path: Option<&str>) -> Result<Arc<PiProcess>, String> {
        let mut cmd = Command::new("cmd");
        cmd.args(build_pi_args(session_path))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn pi: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let proc = Arc::new(PiProcess {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(Some(stdin))),
            pending: Arc::new(PendingMap::default()),
            seq: AtomicU64::new(1),
            expecting_exit: AtomicBool::new(false),
        });

        // Reader thread: strict JSONL framing — split on '\n' only, strip '\r'.
        let app_handle = app.clone();
        let pending = proc.pending.clone();
        let proc_ref = proc.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.split(b'\n') {
                let Ok(bytes) = line else { break };
                match classify_line(&bytes) {
                    LineAction::Skip => {}
                    LineAction::Emit(value) => {
                        let _ = app_handle.emit("pi-event", &value);
                    }
                    LineAction::Response { id, value } => {
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(value); // response consumed by the waiting request
                        } else {
                            // Unknown id (late timeout, restart, etc.) — surface to the webview.
                            let _ = app_handle.emit("pi-event", &value);
                        }
                    }
                }
            }
            // Stream ended: pi exited. Tell the webview whether we killed it
            // on purpose (stop/restart) or it died on its own (crash).
            pending.clear();
            let expected = proc_ref.expecting_exit.load(Ordering::SeqCst);
            let _ = app_handle.emit("pi-exit", serde_json::json!({ "expected": expected }));
        });

        Ok(proc)
    }

    pub fn next_id(&self) -> String {
        format!("ll-{}", self.seq.fetch_add(1, Ordering::SeqCst))
    }

    /// Write a raw JSON line to pi's stdin.
    pub fn send_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
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
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }

    pub fn kill(&self) {
        self.expecting_exit.store(true, Ordering::SeqCst);
        let mut guard = self.stdin.lock().unwrap();
        *guard = None; // drop stdin first so pi exits cleanly
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
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

/// Send a command and wait (bounded) for the correlated response.
pub fn request(
    proc: &PiProcess,
    mut cmd: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = cmd
        .get("id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| proc.next_id());
    if let Some(obj) = cmd.as_object_mut() {
        obj.insert("id".into(), Value::String(id.clone()));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    proc.pending.insert(id.clone(), tx);
    let line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    proc.send_line(&line)?;
    match wait_response(rx, timeout) {
        Ok(value) => Ok(value),
        Err(e) => {
            proc.pending.remove(&id);
            Err(e)
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(map.remove("a").is_none(), "entry must be removed on first take");

        map.insert("b".to_string(), std::sync::mpsc::channel().0);
        map.clear();
        assert!(map.remove("b").is_none(), "clear must empty the map");
    }

    #[test]
    fn pi_args_include_session_flag_only_when_resuming() {
        let base = build_pi_args(None);
        assert_eq!(base, vec!["/C", "pi", "--mode", "rpc"]);

        let resumed = build_pi_args(Some("C:\\proj\\session.jsonl"));
        assert_eq!(resumed, vec!["/C", "pi", "--mode", "rpc", "--session", "C:\\proj\\session.jsonl"]);
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
        tx.send(serde_json::json!({"type":"response","id":"ll-1","success":true})).unwrap();
        let v = wait_response(rx, Duration::from_millis(50)).unwrap();
        assert_eq!(v["success"], true);
    }
}