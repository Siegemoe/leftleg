mod pi;
mod sessions;

use pi::PiProcess;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, State};

/// Tauri-managed state holding the live pi subprocesses. T3-style
/// orchestration: one process per project, the UI focuses one at a time,
/// background projects keep running and their events stay tagged.
pub struct PiState {
    processes: std::sync::Mutex<HashMap<String, Arc<PiProcess>>>,
    /// Which project's process receives project-less commands.
    active: std::sync::Mutex<Option<String>>,
}

impl PiState {
    pub fn new() -> Self {
        PiState {
            processes: std::sync::Mutex::new(HashMap::new()),
            active: std::sync::Mutex::new(None),
        }
    }

    /// A live process for the given project, if any.
    pub fn live_process(&self, project: &str) -> Option<Arc<PiProcess>> {
        let proc = self.processes.lock().unwrap().get(project).cloned();
        proc.filter(|p| p.is_alive())
    }

    /// Resolve the process a command targets: the named project when given
    /// (must be running), otherwise the active project's process.
    pub fn resolve(&self, project: Option<&str>) -> Result<Arc<PiProcess>, String> {
        let key = match project {
            Some(p) => p.to_string(),
            None => self
                .active
                .lock()
                .unwrap()
                .clone()
                .ok_or("no active pi process")?,
        };
        self.processes
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .ok_or_else(|| format!("pi process not running for {key}"))
    }

    pub fn set_active(&self, project: &str) {
        *self.active.lock().unwrap() = Some(project.to_string());
    }

    pub fn insert(&self, project: &str, proc: Arc<PiProcess>) {
        self.processes.lock().unwrap().insert(project.to_string(), proc);
        self.set_active(project);
    }

    pub fn remove(&self, project: &str) -> Option<Arc<PiProcess>> {
        let removed = self.processes.lock().unwrap().remove(project);
        let mut active = self.active.lock().unwrap();
        if active.as_deref() == Some(project) {
            *active = None;
        }
        removed
    }
}

/// Start (or refocus) the pi process for a project. A live process for the
/// project is reused — it keeps its session and any in-flight work; callers
/// refocus it and may issue `switch_session` themselves. Pass
/// `force_restart` to kill and respawn instead. Returns the new (or reused)
/// process id so the webview can drop stale events from replaced processes.
/// `session_path`, when given on a fresh spawn, resumes that session via
/// `--session` so the subprocess boots into the session the UI highlights.
// (private: tauri's #[command] macro conflicts with #[macro_export] re-exports
// when pub commands are defined at the crate root)
#[tauri::command]
fn pi_start(
    app: tauri::AppHandle,
    state: State<PiState>,
    project: String,
    session_path: Option<String>,
    force_restart: Option<bool>,
) -> Result<u64, String> {
    if !std::path::Path::new(&project).is_dir() {
        return Err(format!("not a directory: {project}"));
    }
    if let Some(existing) = state.live_process(&project) {
        if !force_restart.unwrap_or(false) {
            state.set_active(&project);
            return Ok(existing.id);
        }
        existing.kill();
        state.remove(&project);
    }
    if let Some(path) = &session_path {
        // pi would exit at startup on a missing file; fail loudly here instead
        // so the caller can fall back to a fresh start with a visible note.
        if !std::path::Path::new(path).is_file() {
            return Err(format!("session file not found: {path}"));
        }
    }
    let proc = PiProcess::spawn(app, &project, session_path.as_deref())?;
    let id = proc.id;
    state.insert(&project, proc);
    Ok(id)
}

/// Kill a project's pi process (the active one when no project is given).
#[tauri::command]
fn pi_stop(state: State<PiState>, project: Option<String>) -> Result<(), String> {
    let proc = state.resolve(project.as_deref())?;
    let key = proc.cwd.clone();
    proc.kill();
    state.remove(&key);
    Ok(())
}

/// Is the pi process alive (active project, or the named one)?
#[tauri::command]
fn pi_status(state: State<PiState>, project: Option<String>) -> bool {
    state.resolve(project.as_deref()).map(|p| p.is_alive()).unwrap_or(false)
}

/// Send an RPC command to pi and wait for its correlated response.
#[tauri::command]
fn pi_request(
    state: State<PiState>,
    command: Value,
    project: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<Value, String> {
    let proc = state.resolve(project.as_deref())?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120));
    pi::request(&proc, command, timeout)
}

/// Fire-and-forget line (used for extension_ui_response and notifications).
#[tauri::command]
fn pi_send(state: State<PiState>, line: Value, project: Option<String>) -> Result<(), String> {
    let proc = state.resolve(project.as_deref())?;
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

/// Write a GUI-provided file into the agent directory under `extensions/`.
/// Reserved for explicitly installing the settings companion (path-traversal
/// guarded; never arbitrary file targets).
#[tauri::command]
fn write_agent_extension(app: tauri::AppHandle, rel_path: String, content: String) -> Result<(), String> {
    let agent_dir = sessions::agent_dir();
    let target = agent_dir.join("extensions").join(&rel_path);
    // Guard: the resolved target must stay inside <agent_dir>/extensions.
    let canon_base = agent_dir.join("extensions");
    let _ = fs::create_dir_all(&canon_base).map_err(|e| e.to_string())?;
    let canon_base = fs::canonicalize(&canon_base).map_err(|e| e.to_string())?;
    if target.components().any(|c| c.as_os_str() == "..") {
        return Err("path traversal rejected".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let canon_parent = fs::canonicalize(target.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    if !canon_parent.starts_with(&canon_base) {
        return Err("path traversal rejected".into());
    }
    fs::write(&target, content).map_err(|e| e.to_string())?;
    let _ = app; // reserved for future telemetry-free install notes
    Ok(())
}

#[cfg(test)]
mod companion_install_tests {
    use super::*;

    #[test]
    fn write_agent_extension_rejects_traversal() {
        // The command itself needs an AppHandle; test the traversal predicate directly.
        use std::path::{Path, PathBuf};
        let rel = "..\\..\\evil.ts";
        let target = PathBuf::from("C:\\tmp").join("extensions").join(rel);
        assert!(target.components().any(|c| c.as_os_str() == ".."));
        let ok = Path::new("extensions/leftleg-settings/index.ts");
        assert!(!ok.components().any(|c| c.as_os_str() == ".."));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_state_starts_without_resolvable_process() {
        let state = PiState::new();
        assert!(state.resolve(None).is_err(), "no active project yet");
        assert!(state.resolve(Some("/a")).is_err(), "unknown project");
    }

    #[test]
    fn pi_state_active_pointer_follows_set_active() {
        let state = PiState::new();
        state.set_active("/a");
        assert_eq!(state.active.lock().unwrap().as_deref(), Some("/a"));
        state.set_active("/b");
        assert_eq!(state.active.lock().unwrap().as_deref(), Some("/b"));
    }

    #[test]
    fn pi_state_remove_clears_active_pointer_only_for_that_project() {
        let state = PiState::new();
        state.set_active("/a");
        state.remove("/a");
        assert_eq!(state.active.lock().unwrap().as_deref(), None, "removing the active project clears the pointer");
        state.set_active("/b");
        state.remove("/other");
        assert_eq!(state.active.lock().unwrap().as_deref(), Some("/b"), "removing another project leaves active alone");
    }
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
            write_agent_extension,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
