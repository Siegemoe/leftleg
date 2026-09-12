use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Handle to a running `pi --mode rpc` subprocess.
pub struct PiProcess {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
    pub pending: Arc<PendingMap>,
    seq: AtomicU64,
}

impl PiProcess {
    /// Spawn `pi --mode rpc` in the given working directory and start the
    /// stdout reader thread that forwards events to the webview.
    pub fn spawn(app: AppHandle, cwd: &str) -> Result<Arc<PiProcess>, String> {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "pi", "--mode", "rpc"])
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
        });

        // Reader thread: strict JSONL framing — split on '\n' only, strip '\r'.
        let app_handle = app.clone();
        let pending = proc.pending.clone();
        let proc_ref = proc.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.split(b'\n') {
                let Ok(bytes) = line else { break };
                let mut slice = &bytes[..];
                if slice.last() == Some(&b'\r') {
                    slice = &slice[..slice.len() - 1];
                }
                if slice.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_slice::<Value>(slice) else {
                    continue;
                };
                match value.get("type").and_then(|t| t.as_str()) {
                    // Correlated response: resolve the pending request.
                    Some("response") => {
                        let id = value.get("id").and_then(|v| v.as_str()).map(String::from);
                        if let Some(id) = id {
                            if let Some(tx) = pending.remove(&id) {
                                let _ = tx.send(value.clone());
                                continue; // response consumed; still emit for safety below
                            }
                        }
                        let _ = app_handle.emit("pi-event", &value);
                    }
                    // Everything else (events, extension_ui_request) -> webview.
                    _ => {
                        let _ = app_handle.emit("pi-event", &value);
                    }
                }
            }
            // Stream ended: pi exited.
            pending.clear();
            // Fail all still-pending requests.
            let _ = &proc_ref;
            let _ = app_handle.emit("pi-exit", ());
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
        let mut guard = self.stdin.lock().unwrap();
        *guard = None; // drop stdin first so pi exits cleanly
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
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
    match rx.recv_timeout(timeout) {
        Ok(value) => Ok(value),
        Err(_) => {
            proc.pending.remove(&id);
            Err(format!("timed out waiting for response to {id}"))
        }
    }
}
