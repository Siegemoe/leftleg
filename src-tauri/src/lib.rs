mod pi;
mod sessions;

use pi::PiProcess;
use serde_json::Value;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, State};

/// Tauri-managed state holding the live pi subprocess.
pub struct PiState {
    inner: std::sync::Mutex<Option<Arc<PiProcess>>>,
}

impl PiState {
    pub fn new() -> Self {
        PiState { inner: std::sync::Mutex::new(None) }
    }

    pub fn get(&self) -> Option<Arc<PiProcess>> {
        self.inner.lock().unwrap().clone()
    }
}

/// Start (or restart) a `pi --mode rpc` process for the given project dir.
/// `session_path`, when given, resumes that session via `--session` so the
/// subprocess boots into the session the UI highlights.
// (private: tauri's #[command] macro conflicts with #[macro_export] re-exports
// when pub commands are defined at the crate root)
#[tauri::command]
fn pi_start(
    app: tauri::AppHandle,
    state: State<PiState>,
    cwd: String,
    session_path: Option<String>,
) -> Result<(), String> {
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    if let Some(path) = &session_path {
        // pi would exit at startup on a missing file; fail loudly here instead
        // so the caller can fall back to a fresh start with a visible note.
        if !std::path::Path::new(path).is_file() {
            return Err(format!("session file not found: {path}"));
        }
    }
    // Stop any existing process first.
    if let Some(existing) = state.get() {
        existing.kill();
    }
    *state.inner.lock().unwrap() = None;

    let proc = PiProcess::spawn(app, &cwd, session_path.as_deref())?;
    *state.inner.lock().unwrap() = Some(proc);
    Ok(())
}

/// Kill the current pi process.
#[tauri::command]
fn pi_stop(state: State<PiState>) -> Result<(), String> {
    if let Some(proc) = state.get() {
        proc.kill();
    }
    *state.inner.lock().unwrap() = None;
    Ok(())
}

/// Is the pi process alive?
#[tauri::command]
fn pi_status(state: State<PiState>) -> bool {
    state.get().map(|p| p.is_alive()).unwrap_or(false)
}

/// Send an RPC command to pi and wait for its correlated response.
#[tauri::command]
fn pi_request(state: State<PiState>, command: Value, timeout_secs: Option<u64>) -> Result<Value, String> {
    let proc = state.get().ok_or("pi process not running")?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120));
    pi::request(&proc, command, timeout)
}

/// Fire-and-forget line (used for extension_ui_response and notifications).
#[tauri::command]
fn pi_send(state: State<PiState>, line: Value) -> Result<(), String> {
    let proc = state.get().ok_or("pi process not running")?;
    let text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
    proc.send_line(&text)
}

#[tauri::command]
fn get_agent_dir() -> String {
    sessions::agent_dir().to_string_lossy().into_owned()
}

/// Append a line to Leftleg's own log file (app_data/logs/leftleg.log).
#[tauri::command]
fn append_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("leftleg.log");
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&file)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    let _ = writeln!(f, "{}", line);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Native crash forensics: panics must leave a trace on disk.
    let log_dir = std::env::var("APPDATA").ok().map(|d| std::path::PathBuf::from(d).join("dev.leftleg.app").join("logs"));
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = &log_dir {
            let _ = fs::create_dir_all(dir);
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let line = format!("[panic@{}] {}\nbacktrace: {:?}\n", stamp, info, std::backtrace::Backtrace::force_capture());
            let _ = fs::OpenOptions::new().create(true).append(true).open(dir.join("rust-panic.log")).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
        }
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PiState::new())
        .invoke_handler(tauri::generate_handler![
            pi_start,
            pi_stop,
            pi_status,
            pi_request,
            pi_send,
            sessions::list_sessions,
            sessions::read_gui_state,
            sessions::write_gui_state,
            sessions::read_file_base64,
            get_agent_dir,
            append_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
