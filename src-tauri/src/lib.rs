mod pi;
mod pimgr;
mod sessions;

/// Containment boundary for local opens, re-exported for the integration
/// test that exercises it without opening anything.
pub use sessions::open_path_allowed;

use pi::PiProcess;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{Manager, State};

/// Tauri-managed state holding the live pi subprocesses. T3-style
/// orchestration: one process per project, the UI focuses one at a time,
/// background projects keep running and their events stay tagged.
pub struct PiState {
    processes: std::sync::Mutex<HashMap<String, Arc<PiProcess>>>,
    /// Which project's process receives project-less commands.
    active: std::sync::Mutex<Option<String>>,
    /// Set before handing control to the Windows updater. Once set, no new Pi
    /// process or RPC command may enter while the owned process trees stop.
    update_shutdown: AtomicBool,
}

impl PiState {
    pub fn new() -> Self {
        PiState {
            processes: std::sync::Mutex::new(HashMap::new()),
            active: std::sync::Mutex::new(None),
            update_shutdown: AtomicBool::new(false),
        }
    }

    fn ensure_available(&self) -> Result<(), String> {
        if self.update_shutdown.load(Ordering::SeqCst) {
            Err("Leftleg is preparing to install an update".into())
        } else {
            Ok(())
        }
    }

    /// A live process for the given project, if any. The availability check and
    /// focus change share the process-map lock with update shutdown, so either
    /// this reuse completes first or shutdown rejects it.
    pub fn focus_live_process(&self, project: &str) -> Result<Option<Arc<PiProcess>>, String> {
        let processes = self.processes.lock().unwrap();
        self.ensure_available()?;
        let proc = processes.get(project).cloned().filter(|p| p.is_alive());
        if proc.is_some() {
            self.set_active(project);
        }
        Ok(proc)
    }

    /// Resolve the process a command targets: the named project when given
    /// (must be running), otherwise the active project's process.
    pub fn resolve(&self, project: Option<&str>) -> Result<Arc<PiProcess>, String> {
        self.ensure_available()?;
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

    /// Register a freshly spawned process. Returns any displaced still-alive
    /// process so the caller can tree-kill it off-thread — a silent overwrite
    /// would leak a running pi (orphans hold project files and burn tokens).
    pub fn insert(
        &self,
        project: &str,
        proc: Arc<PiProcess>,
    ) -> Result<Vec<Arc<PiProcess>>, String> {
        let mut processes = self.processes.lock().unwrap();
        // Recheck under the same lock used by begin_update_shutdown. This closes
        // the race where a slow spawn starts just before update preparation.
        self.ensure_available()?;
        let displaced = processes
            .insert(project.to_string(), proc)
            .filter(|old| old.is_alive())
            .into_iter()
            .collect();
        drop(processes);
        self.set_active(project);
        Ok(displaced)
    }

    pub fn remove(&self, project: &str) -> Option<Arc<PiProcess>> {
        let removed = self.processes.lock().unwrap().remove(project);
        let mut active = self.active.lock().unwrap();
        if active.as_deref() == Some(project) {
            *active = None;
        }
        removed
    }

    /// Snapshot of every project with a registered process (live or dying).
    /// Used by path-containment checks: files a tool card or artifact row
    /// offers to open must live under one of these, the agent dir, or app data.
    pub fn project_dirs(&self) -> Vec<String> {
        self.processes.lock().unwrap().keys().cloned().collect()
    }

    /// Atomically reject new work and detach every owned Pi process. Callers
    /// kill the returned processes outside the map lock so shutdown cannot
    /// deadlock with a reader or writer finishing its work.
    fn begin_update_shutdown(&self) -> Result<Vec<Arc<PiProcess>>, String> {
        let mut processes = self.processes.lock().unwrap();
        if self
            .update_shutdown
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("update shutdown is already in progress".into());
        }
        let detached = processes.drain().map(|(_, proc)| proc).collect();
        drop(processes);
        *self.active.lock().unwrap() = None;
        Ok(detached)
    }

    fn cancel_update_shutdown(&self) {
        self.update_shutdown.store(false, Ordering::SeqCst);
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
async fn pi_start(
    app: tauri::AppHandle,
    state: State<'_, PiState>,
    project: String,
    session_path: Option<String>,
    force_restart: Option<bool>,
) -> Result<u64, String> {
    // Check before both the reuse and spawn paths. `insert` rechecks under the
    // process-map lock to cover a shutdown that starts while spawning.
    state.ensure_available()?;
    // The update rewrites the npm package pi runs from — spawning during it
    // can load a half-written bundle. The frontend defers too; this is the
    // native backstop for races (and for a frontend that lost its lock).
    if pimgr::pi_update_running() {
        return Err("pi update is running — start the project when it finishes".into());
    }
    if !std::path::Path::new(&project).is_dir() {
        return Err(format!("not a directory: {project}"));
    }
    if let Some(existing) = state.focus_live_process(&project)? {
        if !force_restart.unwrap_or(false) {
            return Ok(existing.id);
        }
        // Tree-kill off the main thread: taskkill waits for its own process.
        let doomed = existing.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || doomed.kill()).await;
        state.remove(&project);
    }
    if let Some(path) = &session_path {
        // pi would exit at startup on a missing file; fail loudly here instead
        // so the caller can fall back to a fresh start with a visible note.
        if !std::path::Path::new(path).is_file() {
            return Err(format!("session file not found: {path}"));
        }
    }
    // Spawn off-thread: where.exe, canonicalize, and CreateProcess are real
    // disk/process work that antivirus can amplify into UI-visible stalls.
    let spawn_app = app.clone();
    let spawn_dir = project.clone();
    let spawn_session = session_path.clone();
    let spawned = tauri::async_runtime::spawn_blocking(move || {
        PiProcess::spawn(spawn_app, &spawn_dir, spawn_session.as_deref())
    })
    .await
    .map_err(|e| format!("pi spawn worker failed: {e}"))?;
    let proc = spawned?;
    let id = proc.id;
    match state.insert(&project, proc.clone()) {
        Ok(displaced) => {
            // Defensive: a live process should have been removed before spawn,
            // but if one raced in, tree-kill it so it can't leak. Detached —
            // taskkill is independent of this request's outcome.
            for old in displaced {
                let _ = tauri::async_runtime::spawn_blocking(move || old.kill());
            }
        }
        Err(error) => {
            proc.kill();
            return Err(error);
        }
    }
    // Grant the webview asset access to this project's generated images so
    // tool-card previews work from the first generation on. Granted only after
    // a successful spawn; the scope is cumulative, so failed starts must not
    // register directories that were never opened.
    sessions::allow_project_images_scope(&app, &project);
    Ok(id)
}

/// Kill a project's pi process (the active one when no project is given).
#[tauri::command]
async fn pi_stop(state: State<'_, PiState>, project: Option<String>) -> Result<(), String> {
    let proc = state.resolve(project.as_deref())?;
    let key = proc.cwd.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || proc.kill()).await;
    state.remove(&key);
    Ok(())
}

/// Is the pi process alive (active project, or the named one)?
#[tauri::command]
fn pi_status(state: State<PiState>, project: Option<String>) -> bool {
    state.resolve(project.as_deref()).map(|p| p.is_alive()).unwrap_or(false)
}

/// Final native update boundary. Once this returns, every owned Pi process tree
/// is stopped and native commands reject new Pi work until install succeeds or
/// the frontend explicitly cancels after an installer-launch failure.
#[tauri::command]
async fn prepare_for_update(state: State<'_, PiState>) -> Result<usize, String> {
    let processes = state.begin_update_shutdown()?;
    let count = processes.len();
    let stopped = tauri::async_runtime::spawn_blocking(move || {
        for proc in processes {
            proc.kill();
        }
    })
    .await;
    if let Err(error) = stopped {
        return Err(format!(
            "Pi shutdown worker failed; restart Leftleg before continuing: {error}"
        ));
    }
    Ok(count)
}

#[tauri::command]
fn cancel_update_shutdown(state: State<PiState>) {
    state.cancel_update_shutdown();
}

/// Send an RPC command to pi and wait for its correlated response.
#[tauri::command]
async fn pi_request(
    state: State<'_, PiState>,
    command: Value,
    project: Option<String>,
    timeout_secs: Option<u64>,
    expected_proc: Option<u64>,
) -> Result<Value, String> {
    let proc = state.resolve(project.as_deref())?;
    if expected_proc.is_some_and(|id| id != proc.id) { return Err("pi process replaced before request dispatch".into()); }
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120));
    tauri::async_runtime::spawn_blocking(move || pi::request(&proc, command, timeout))
        .await.map_err(|e| format!("RPC worker failed: {e}"))?
}

/// Fire-and-forget line (used for extension_ui_response and notifications).
#[tauri::command]
async fn pi_send(
    state: State<'_, PiState>,
    line: Value,
    project: Option<String>,
    expected_proc: Option<u64>,
) -> Result<(), String> {
    let proc = state.resolve(project.as_deref())?;
    if expected_proc.is_some_and(|id| id != proc.id) {
        return Err("pi process replaced before response dispatch".into());
    }
    let text = serde_json::to_string(&line).map_err(|e| e.to_string())?;
    // A full pipe blocks the write until pi drains it; never hold the main
    // thread on that.
    tauri::async_runtime::spawn_blocking(move || proc.send_line(&text))
        .await
        .map_err(|e| format!("pi send worker failed: {e}"))?
}

#[tauri::command]
fn get_agent_dir() -> String {
    sessions::agent_dir().to_string_lossy().into_owned()
}

/// Append a line to Leftleg's own log file (app_data/logs/leftleg.log).
/// Rotates to `leftleg.log.1` past 5 MiB so the log can't grow unbounded, and
/// caps single lines so one pathological entry can't dominate the file.
#[tauri::command]
async fn append_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    const LOG_MAX_LINE_BYTES: usize = 64 * 1024;
    let dir = native_log_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut line = line;
        if line.len() > LOG_MAX_LINE_BYTES {
            let mut cut = LOG_MAX_LINE_BYTES;
            while cut > 0 && !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
            line.push_str(" …[truncated]");
        }
        write_log_line(&dir, &line)
    })
    .await
    .map_err(|e| format!("log worker failed: {e}"))?
}

fn native_log_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("logs"))
        .map_err(|e| format!("no app data dir: {e}"))
}

/// Best-effort native log write for backend-side diagnostics (reader-loop
/// drops, panic hook neighbors). Errors are swallowed by design — logging must
/// never take the caller down.
pub(crate) fn log_native(app: &tauri::AppHandle, line: &str) {
    if let Ok(dir) = native_log_dir(app) {
        let _ = write_log_line(&dir, line);
    }
}

fn write_log_line(dir: &std::path::Path, line: &str) -> Result<(), String> {
    const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = dir.join("leftleg.log");
    if file.metadata().map(|m| m.len()).unwrap_or(0) > LOG_MAX_BYTES {
        let _ = fs::rename(&file, dir.join("leftleg.log.1"));
    }
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&file)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Write a GUI-provided file into the agent directory under `extensions/`.
/// Reserved for explicitly installing the Leftleg companions (settings, media);
/// path-traversal guarded; never arbitrary file targets.
#[tauri::command]
async fn write_agent_extension(
    app: tauri::AppHandle,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let agent_dir = sessions::agent_dir();
    // Validate before creating any directories outside the allowed root.
    let rel = companion_relative_path(&rel_path)?;
    let _ = app; // reserved for future telemetry-free install notes
    tauri::async_runtime::spawn_blocking(move || {
        let target = agent_dir.join("extensions").join(&rel);
        // Guard: the resolved target must stay inside <agent_dir>/extensions.
        let canon_base = agent_dir.join("extensions");
        fs::create_dir_all(&canon_base).map_err(|e| e.to_string())?;
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
        if target.exists() && !fs::canonicalize(&target).map_err(|e| e.to_string())?.starts_with(&canon_base) {
            return Err("path traversal rejected".into());
        }
        fs::write(&target, content).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("extension writer failed: {e}"))?
}

fn companion_relative_path(rel: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(rel);
    if path.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err("path traversal rejected".into());
    }
    match rel.replace('\\', "/").as_str() {
        "leftleg-settings/index.ts" | "leftleg-media/index.ts" => Ok(path.to_path_buf()),
        _ => Err("only Leftleg companions (settings, media) can be installed".into()),
    }
}

#[cfg(test)]
mod companion_install_tests {
    use super::*;

    #[test]
    fn write_agent_extension_rejects_traversal() {
        for invalid in ["..\\..\\evil.ts", "C:\\outside\\index.ts", "/outside/index.ts", "other-extension/index.ts"] {
            assert!(companion_relative_path(invalid).is_err());
        }
        assert!(companion_relative_path("leftleg-settings/index.ts").is_ok());
        assert!(companion_relative_path("leftleg-media/index.ts").is_ok());
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

    #[test]
    fn update_shutdown_rejects_new_commands_until_cancelled() {
        let state = PiState::new();
        let processes = state.begin_update_shutdown().unwrap();
        assert!(processes.is_empty());
        assert!(state
            .resolve(None)
            .err()
            .unwrap()
            .contains("preparing to install"));
        assert!(state
            .begin_update_shutdown()
            .err()
            .unwrap()
            .contains("already in progress"));
        state.cancel_update_shutdown();
        assert!(state
            .resolve(None)
            .err()
            .unwrap()
            .contains("no active pi process"));
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PiState::new())
        .invoke_handler(tauri::generate_handler![
            pi_start,
            pi_stop,
            pi_status,
            prepare_for_update,
            cancel_update_shutdown,
            pi_request,
            pi_send,
            sessions::list_sessions,
            sessions::read_gui_state,
            sessions::write_gui_state,
            sessions::pick_and_read_files,
            sessions::open_path,
            sessions::list_artifacts,
            sessions::delete_artifact,
            sessions::git_repo_info,
            pi::pi_module_info,
            pimgr::run_pi_manager,
            pimgr::pi_integrity_report,
            get_agent_dir,
            append_log,
            write_agent_extension,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let state = app.state::<PiState>();
                for proc in state.processes.lock().unwrap().values() { proc.kill(); }
            }
        });
}
