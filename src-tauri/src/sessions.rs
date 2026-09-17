use serde::Serialize;
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::time::SystemTime;
use tauri::Manager;

/// Resolve pi's agent dir (respects PI_CODING_AGENT_DIR), where sessions live
/// under `<agent_dir>/sessions/<cwd-slug>/*.jsonl`.
pub fn agent_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".pi").join("agent")
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub path: String,
    pub cwd: String,
    pub timestamp: String,
    #[serde(rename = "fileModified")]
    pub file_modified: u64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub name: Option<String>,
    #[serde(rename = "firstMessage")]
    pub first_message: Option<String>,
}

/// Latest `session_info` entry name (set via set_session_name), if any.
fn session_display_name(path: &std::path::Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut name = None;
    for line in reader.lines() {
        // One bad line (invalid UTF-8, transient read error) must not lose the
        // name found in the rest of the file.
        let Ok(line) = line else { continue };
        if !line.contains("session_info") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("session_info") {
                if let Some(n) = v.get("name").and_then(|n| n.as_str()) {
                    if !n.trim().is_empty() {
                        name = Some(n.trim().to_string());
                    }
                }
            }
        }
    }
    name
}

/// Extract a short snippet from the first user message in a session file.
/// Malformed or non-message lines are skipped; they do not abort the scan.
fn first_user_text(path: &std::path::Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().take(200) {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(msg_type) = v.get("type").and_then(|t| t.as_str()) else {
            continue;
        };
        if msg_type != "message" {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        let Some(role) = msg.get("role").and_then(|r| r.as_str()) else { continue };
        if role != "user" {
            continue;
        }
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(serde_json::Value::Array(blocks)) => blocks.iter().find_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            }),
            _ => None,
        };
        if let Some(t) = text {
            let t = t.trim().replace('\n', " ");
            let t: String = t.chars().take(120).collect();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

/// Parse the first line of a session file into (cwd, timestamp, session_id).
/// `None` when the line is not a `type:"session"` header or is invalid JSON.
fn parse_session_header(first_line: &str) -> Option<(String, String, String)> {
    let v = serde_json::from_str::<serde_json::Value>(first_line.trim()).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    let field = |k: &str| v.get(k).and_then(|c| c.as_str()).unwrap_or_default().to_string();
    Some((field("cwd"), field("timestamp"), field("id")))
}

/// List all persisted sessions (all projects), newest-modified first.
#[tauri::command]
pub async fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(scan_sessions).await.map_err(|e| e.to_string())?
}

/// Cache of fully-parsed session files keyed by path, validated against
/// (mtime, size). list_sessions runs on every sidebar refresh and would
/// otherwise re-read every jsonl in the agent dir each time; entries whose
/// stamp changed (or vanished files) are re-parsed, so renames and appends
/// stay fresh. Held per process — the GUI is the only writer of sessions.
static SESSION_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, u64, SessionInfo)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn scan_sessions() -> Result<Vec<SessionInfo>, String> {
    let root = agent_dir().join("sessions");
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut cache = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<SessionInfo> = Vec::new();
    let mut fresh: std::collections::HashMap<PathBuf, (u64, u64, SessionInfo)> =
        std::collections::HashMap::new();
    let project_dirs = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for pd in project_dirs.flatten() {
        if !pd.path().is_dir() {
            continue;
        }
        let files = match fs::read_dir(pd.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let path = f.path();
            let ext_ok = path.extension().and_then(|e| e.to_str()) == Some("jsonl");
            if !ext_ok {
                continue;
            }
            let meta = match f.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t: SystemTime| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let size = meta.len();
            if let Some((cm, cs, info)) = cache.get(&path) {
                if *cm == modified && *cs == size {
                    fresh.insert(path.clone(), (*cm, *cs, info.clone()));
                    out.push(info.clone());
                    continue;
                }
            }
            // Parse the header line: {"type":"session","version":..,"id":..,"timestamp":..,"cwd":..}
            let Ok(content) = fs::File::open(&path) else { continue };
            let mut reader = std::io::BufReader::new(content);
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() {
                continue;
            }
            let Some((cwd, timestamp, session_id)) = parse_session_header(&header) else {
                continue;
            };
            let info = SessionInfo {
                name: session_display_name(&path),
                path: path.to_string_lossy().into_owned(),
                cwd,
                timestamp,
                file_modified: modified,
                session_id,
                first_message: first_user_text(&path),
            };
            fresh.insert(path.clone(), (modified, size, info.clone()));
            out.push(info);
        }
    }
    *cache = fresh;
    out.sort_by_key(|s| std::cmp::Reverse(s.file_modified));
    Ok(out)
}

/// Leftleg's own GUI state (theme, project dir, last session). Stored in app data.
#[tauri::command]
pub async fn read_gui_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = dir.join("leftleg.json");
        if !file.exists() {
            return Ok(serde_json::json!({}));
        }
        let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_gui_state(
    app: tauri::AppHandle,
    state: serde_json::Value,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("leftleg.json");
        atomic_write(
            &file,
            &serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn atomic_write(file: &std::path::Path, text: &str) -> Result<(), String> {
    let tmp = file.with_file_name(format!(".leftleg-{}.tmp", uuid::Uuid::new_v4()));
    let result = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, file));
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result.map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct PickedFile {
    pub name: String,
    pub path: String,
    /// Base64 payload when the read succeeded; absent when it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// Per-file failure (oversized, unreadable); absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Open the OS attach dialog and read the picked files in one native
/// operation. The webview has no path→bytes command, so a compromised
/// renderer can only read what the user just picked in the dialog. Per-file
/// failures ride along as `error` so one oversized file doesn't lose the rest.
#[tauri::command]
pub async fn pick_and_read_files(app: tauri::AppHandle) -> Result<Vec<PickedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || pick_and_read_files_impl(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn pick_and_read_files_impl(app: &tauri::AppHandle) -> Result<Vec<PickedFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Attach files")
        .add_filter(
            "Images & text",
            &["png", "jpg", "jpeg", "gif", "webp", "bmp", "txt", "md", "json", "ts", "js", "py", "rs", "toml", "yaml", "yml", "csv", "log"],
        )
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    let Some(paths) = picked else {
        return Ok(Vec::new()); // cancelled — not an error
    };
    let mut out = Vec::with_capacity(paths.len());
    for picked in paths {
        let path = match picked.into_path() {
            Ok(p) => p,
            Err(e) => {
                out.push(PickedFile { name: String::new(), path: String::new(), data: None, error: Some(e.to_string()) });
                continue;
            }
        };
        let shown = path.to_string_lossy().into_owned();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        match read_attachment(&shown) {
            Ok(data) => out.push(PickedFile { name, path: shown, data: Some(data), error: None }),
            Err(e) => out.push(PickedFile { name, path: shown, data: None, error: Some(e) }),
        }
    }
    Ok(out)
}

fn read_attachment(path: &str) -> Result<String, String> {
    use std::io::Read;
    const LIMIT: u64 = 20 * 1024 * 1024;
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    if f.metadata().map_err(|e| e.to_string())?.len() > LIMIT { return Err("Attachment exceeds 20 MiB limit".into()); }
    let mut buf = Vec::new();
    f.take(LIMIT + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > LIMIT { return Err("Attachment exceeds 20 MiB limit".into()); }
    Ok(base64_encode(&buf))
}

// ---------- guarded local open ----------

/// Extensions the OS would execute rather than render when "opened". Tool
/// cards and artifact rows only ever offer data files; anything on this list
/// is refused instead of handed to the OS. Case-insensitive, and the rfind
/// makes double extensions count (report.tar.bat is denied).
const OPEN_DENY_EXTENSIONS: &[&str] = &[
    "exe", "bat", "cmd", "com", "scr", "pif", "msi", "msp", "mst", "cpl",
    "ps1", "psm1", "vbs", "vbe", "ws", "wsf", "wsc", "hta", "jar", "lnk",
    "dll", "reg", "sh", "bash", "applescript",
];

fn is_denied_executable(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let lower = name.to_ascii_lowercase();
    let Some(dot) = lower.rfind('.') else { return false };
    OPEN_DENY_EXTENSIONS.contains(&&lower[dot + 1..])
}

/// Canonical path for containment checks: the resolved path when it exists,
/// otherwise the canonical parent + file name (so a not-yet-created file
/// under a real directory still checks against the right root).
fn canonical_ancestor(path: &std::path::Path) -> Option<PathBuf> {
    if let Ok(c) = fs::canonicalize(path) {
        return Some(c);
    }
    let parent = path.parent()?;
    let canon_parent = fs::canonicalize(parent).ok()?;
    Some(canon_parent.join(path.file_name()?))
}

/// Open a local path with the OS default handler. Guarded three ways: the
/// path must resolve inside a live project directory, the pi agent dir, or
/// Leftleg's app-data dir; executables are refused outright (an "open" on
/// those is a run, not a view); and check+open both run natively so a
/// compromised webview has no arbitrary-open primitive. Web URLs keep using
/// the opener plugin from the webview (its default permission allows
/// http/https only).
#[tauri::command]
pub async fn open_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_path_checked(&app, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Validate an open request against the containment roots. Split from
/// `open_path_checked` so tests can exercise the boundary without opening
/// anything. Returns the resolved path to hand to the OS. Generic over the
/// runtime so the mock-runtime test can drive it.
pub fn open_path_allowed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
) -> Result<PathBuf, String> {
    use tauri::Manager;
    let target = std::path::Path::new(path);
    if !target.is_absolute() {
        return Err("open path must be absolute".into());
    }
    if is_denied_executable(target) {
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or(path);
        return Err(format!("refusing to open executable file: {name}"));
    }
    let resolved = canonical_ancestor(target).ok_or_else(|| "open path not found".to_string())?;
    // Containment probe: the canonical file when it exists, else its canonical
    // parent. All sides go through canonicalize so verbatim (\\?\) forms and
    // symlinks compare consistently.
    let probe = if resolved.exists() {
        fs::canonicalize(&resolved).unwrap_or_else(|_| resolved.clone())
    } else {
        resolved.parent().map(PathBuf::from).unwrap_or_else(|| resolved.clone())
    };
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(c) = fs::canonicalize(agent_dir()) {
        roots.push(c);
    }
    for project in app.state::<crate::PiState>().project_dirs() {
        if let Ok(c) = fs::canonicalize(&project) {
            roots.push(c);
        }
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        if let Ok(c) = fs::canonicalize(&data_dir) {
            roots.push(c);
        }
    }
    if !roots.iter().any(|root| probe.starts_with(root)) {
        return Err("open path is outside the allowed directories".into());
    }
    Ok(resolved)
}

fn open_path_checked(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let resolved = open_path_allowed(app, path)?;
    app.opener()
        .open_path(resolved.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Minimal standard base64 encoder (no external deps).
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ---------- project artifacts (image_generate outputs + canonical docs) ----------

/// Hard cap on returned image artifacts; the UI shows the newest first.
pub const MAX_ARTIFACT_FILES: usize = 500;
/// Scan bound before sorting: read_dir order is arbitrary, so collect up to
/// this many entries, sort by mtime desc, then truncate to MAX_ARTIFACT_FILES
/// — otherwise the "newest 500" guarantee fails on huge directories.
const ARTIFACT_SCAN_BOUND: usize = 5000;

#[derive(Serialize, Clone)]
pub struct ArtifactFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: u64,
    pub exists: bool,
}

#[derive(Serialize, Clone)]
pub struct ArtifactsReport {
    pub images: Vec<ArtifactFile>,
    pub docs: Vec<ArtifactFile>,
}

fn artifact_from_path(path: &std::path::Path, exists: bool) -> ArtifactFile {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let (size, modified_ms) = if exists {
        match fs::metadata(path) {
            Ok(m) => (
                m.len(),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            ),
            Err(_) => (0, 0),
        }
    } else {
        (0, 0)
    };
    ArtifactFile { name, path: path.to_string_lossy().into_owned(), size, modified_ms, exists }
}

/// Scan a project's artifacts: `.pi/images/` (image_generate outputs, newest
/// first, bounded) plus the canonical project docs (AGENTS.md, .pi/SYSTEM.md,
/// .pi/APPEND_SYSTEM.md) with exists flags so the UI can render a stable list.
pub fn scan_artifacts(project_dir: &str) -> Result<ArtifactsReport, String> {
    let root = std::path::Path::new(project_dir);
    if !root.is_dir() {
        return Err("project directory not found".into());
    }
    let mut images: Vec<ArtifactFile> = Vec::new();
    let images_dir = root.join(".pi").join("images");
    if images_dir.is_dir() {
        // Same boundary as delete: resolve the real directory once, then keep
        // only entries that canonicalize inside it (symlink containment).
        let canon_dir = fs::canonicalize(&images_dir).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&images_dir).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            let Ok(canon) = fs::canonicalize(&path) else { continue };
            if !canon.starts_with(&canon_dir) || !canon.is_file() {
                continue;
            }
            let name = canon.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Skip temp files from atomic writes (".<name>.tmp-...").
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            // Keep the plain (non-verbatim) entry path for display/open; the
            // canonicalized twin is only used for containment + file checks.
            images.push(artifact_from_path(&path, true));
            if images.len() >= ARTIFACT_SCAN_BOUND {
                break;
            }
        }
    }
    images.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    images.truncate(MAX_ARTIFACT_FILES);
    let docs = [
        ("AGENTS.md", root.join("AGENTS.md")),
        ("SYSTEM.md", root.join(".pi").join("SYSTEM.md")),
        ("APPEND_SYSTEM.md", root.join(".pi").join("APPEND_SYSTEM.md")),
    ]
    .into_iter()
    .map(|(label, path)| {
        let mut file = artifact_from_path(&path, path.is_file());
        file.name = label.to_string();
        file
    })
    .collect();
    Ok(ArtifactsReport { images, docs })
}

/// Delete one image artifact. Guarded: the path must be absolute and resolve
/// (through symlinks) inside `<project>/.pi/images`.
pub fn delete_artifact_checked(project_dir: &str, path: &str) -> Result<(), String> {
    let root = std::path::Path::new(project_dir);
    if !root.is_dir() {
        return Err("project directory not found".into());
    }
    let images_dir = root.join(".pi").join("images");
    if !images_dir.is_dir() {
        return Err("project has no images directory".into());
    }
    let target = std::path::Path::new(path);
    if !target.is_absolute() {
        return Err("artifact path must be absolute".into());
    }
    let canon_dir = fs::canonicalize(&images_dir).map_err(|e| e.to_string())?;
    let canon_target = fs::canonicalize(target).map_err(|e| format!("artifact not found: {e}"))?;
    if !canon_target.starts_with(&canon_dir) {
        return Err("path traversal rejected".into());
    }
    if !canon_target.is_file() {
        return Err("artifact is not a file".into());
    }
    fs::remove_file(&canon_target).map_err(|e| e.to_string())
}

/// Extend the asset-protocol scope with a project's images dir so the webview
/// can stream generated images into <img> tags without base64 inflation.
/// Called on project activation (pi_start) and on artifacts listing so first-
/// generation previews work without opening the browser first. Idempotent.
pub fn allow_project_images_scope(app: &tauri::AppHandle, project: &str) {
    use tauri::Manager;
    let images_dir = std::path::Path::new(project).join(".pi").join("images");
    // The first generated image arrives after project activation. Ensure the
    // managed directory exists now so its scope is already registered when
    // that first tool result renders.
    let _ = fs::create_dir_all(&images_dir);
    if !images_dir.is_dir() {
        return;
    }
    let scope = app.asset_protocol_scope();
    // Allow both the plain and canonical forms — Windows canonicalize returns
    // verbatim (\\?\) paths, and scope matching normalizes the request path
    // against registered entries.
    let _ = scope.allow_directory(&images_dir, true);
    if let Ok(canon) = fs::canonicalize(&images_dir) {
        let _ = scope.allow_directory(&canon, true);
    }
}

// ---------- project git checkout info ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo: bool,
    pub branch: String,
    pub dirty: u32,
    pub toplevel: String,
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _GitCommandExt;

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = cmd.output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Inspect the project's git checkout: current branch, uncommitted-entry
/// count, and worktree root. `repo: false` when the directory isn't a
/// worktree (or git is unavailable) — the UI treats that as "no git".
pub fn git_repo_info_impl(project_dir: &str) -> GitRepoInfo {
    let none = GitRepoInfo { repo: false, branch: String::new(), dirty: 0, toplevel: String::new() };
    if run_git(project_dir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return none;
    }
    let toplevel = run_git(project_dir, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let branch = run_git(project_dir, &["branch", "--show-current"])
        .ok()
        .filter(|b| !b.is_empty())
        .or_else(|| run_git(project_dir, &["rev-parse", "--short", "HEAD"]).ok())
        .unwrap_or_default();
    let dirty = run_git(project_dir, &["status", "--porcelain"])
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);
    GitRepoInfo { repo: true, branch, dirty, toplevel }
}

/// Git checkout info for a project directory.
#[tauri::command]
pub async fn git_repo_info(project_dir: String) -> Result<GitRepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(git_repo_info_impl(&project_dir)))
        .await
        .map_err(|e| e.to_string())?
}

/// List a project's artifacts (generated images + known docs). Also extends
/// the asset-protocol scope with the project's images dir (covers the case
/// where images appeared without a fresh pi_start).
#[tauri::command]
pub async fn list_artifacts(app: tauri::AppHandle, project_dir: String) -> Result<ArtifactsReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let report = scan_artifacts(&project_dir)?;
        allow_project_images_scope(&app, &project_dir);
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete one image artifact (guarded to <project>/.pi/images).
#[tauri::command]
pub async fn delete_artifact(project_dir: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_artifact_checked(&project_dir, &path)).await.map_err(|e| e.to_string())?
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn gui_preferences_replace_existing_file_atomically() {
        let dir = temp_dir("gui-atomic");
        let file = dir.join("leftleg.json");
        fs::write(&file, "old").unwrap();
        atomic_write(&file, "new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn git_repo_info_reads_checkout() {
        // The build directory lives inside this repo, so the checkout is real.
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let info = git_repo_info_impl(repo_root.to_str().unwrap());
        assert!(info.repo);
        assert!(!info.branch.is_empty());

        let nonrepo = std::env::temp_dir().join(format!("leftleg-nonrepo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&nonrepo).unwrap();
        let info2 = git_repo_info_impl(nonrepo.to_str().unwrap());
        assert!(!info2.repo);
        assert_eq!(info2.dirty, 0);
        fs::remove_dir_all(nonrepo).unwrap();
    }

    #[test]
    fn artifacts_list_and_delete_are_guarded() {
        let dir = std::env::temp_dir().join(format!("leftleg-artifacts-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        let images = dir.join(".pi").join("images");
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("a.png"), [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        fs::write(images.join(".img.tmp-1"), "t").unwrap();
        fs::write(dir.join("AGENTS.md"), "# docs").unwrap();
        let report = scan_artifacts(dir.to_str().unwrap()).unwrap();
        assert_eq!(report.images.len(), 1, "temp files must be skipped");
        assert_eq!(report.images[0].name, "a.png");
        let existing_docs = report.docs.iter().filter(|d| d.exists).count();
        assert_eq!(existing_docs, 1, "only AGENTS.md exists in the fixture");
        assert!(report.docs.iter().all(|d| d.name != ""));

        // Guarded delete: inside ok, outside/relative rejected.
        let inside = images.join("a.png");
        delete_artifact_checked(dir.to_str().unwrap(), inside.to_str().unwrap()).unwrap();
        assert!(!inside.exists());
        let outside = dir.join("AGENTS.md");
        assert!(delete_artifact_checked(dir.to_str().unwrap(), outside.to_str().unwrap()).is_err());
        assert!(delete_artifact_checked(dir.to_str().unwrap(), "relative.png").is_err());
        assert!(delete_artifact_checked("Z:\\nowhere-project", "C:\\somewhere.png").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn oversized_attachment_is_rejected_before_allocation() {
        let dir = temp_dir("attachment-limit");
        let file = dir.join("large.bin");
        fs::File::create(&file).unwrap().set_len(20 * 1024 * 1024 + 1).unwrap();
        assert!(read_attachment(file.to_str().unwrap()).unwrap_err().contains("20 MiB"));
        fs::remove_dir_all(dir).unwrap();
    }

    /// Unique temp dir per test; best-effort cleanup via leak-tolerance.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("leftleg-test-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_lines(path: &std::path::Path, lines: &[&str]) {
        let mut f = fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    // ---------- base64_encode (RFC 4648 vectors) ----------

    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    // ---------- parse_session_header ----------

    #[test]
    fn header_parses_cwd_timestamp_id() {
        let line = r#"{"type":"session","version":3,"id":"abc-123","timestamp":"2026-09-12T17:45:40Z","cwd":"C:/dev/active/pi-agent-gui"}"#;
        let (cwd, ts, id) = parse_session_header(line).expect("valid header");
        assert_eq!(cwd, "C:/dev/active/pi-agent-gui");
        assert_eq!(ts, "2026-09-12T17:45:40Z");
        assert_eq!(id, "abc-123");
    }

    #[test]
    fn header_rejects_non_session_and_invalid_json() {
        assert!(parse_session_header(r#"{"type":"message"}"#).is_none());
        assert!(parse_session_header("not json at all").is_none());
        assert!(parse_session_header("").is_none());
    }

    #[test]
    fn header_defaults_missing_fields_to_empty_strings() {
        let (cwd, ts, id) = parse_session_header(r#"{"type":"session"}"#).expect("typed header");
        assert_eq!((cwd.as_str(), ts.as_str(), id.as_str()), ("", "", ""));
    }

    // ---------- session_display_name ----------

    #[test]
    fn latest_session_info_name_wins_and_is_trimmed() {
        let dir = temp_dir("name");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"session","id":"1"}"#,
            r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"session_info","name":"  first name  "}"#,
            r#"{"type":"message","message":{"role":"assistant","content":"hey"}}"#,
            r#"{"type":"session_info","name":"renamed"}"#,
        ]);
        assert_eq!(session_display_name(&path), Some("renamed".to_string()));
    }

    #[test]
    fn empty_names_are_ignored() {
        let dir = temp_dir("name-empty");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"session_info","name":""}"#,
            r#"{"type":"session_info","name":"   "}"#,
        ]);
        assert_eq!(session_display_name(&path), None);
    }

    #[test]
    fn no_session_info_means_no_name() {
        let dir = temp_dir("name-none");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"session","id":"1"}"#,
            r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
        ]);
        assert_eq!(session_display_name(&path), None);
    }

    // ---------- first_user_text ----------

    #[test]
    fn first_user_text_string_content() {
        let dir = temp_dir("fut-str");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"session","id":"1"}"#,
            r#"{"type":"message","message":{"role":"user","content":"fix the login bug"}}"#,
        ]);
        assert_eq!(first_user_text(&path), Some("fix the login bug".to_string()));
    }

    #[test]
    fn first_user_text_block_content() {
        let dir = temp_dir("fut-blocks");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"from a block"}]}}"#,
        ]);
        assert_eq!(first_user_text(&path), Some("from a block".to_string()));
    }

    #[test]
    fn first_user_text_skips_non_user_and_malformed_lines() {
        let dir = temp_dir("fut-skip");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"message","message":{"role":"assistant","content":"assistant first"}}"#,
            "this line is not json <<<",
            r#"{"no_type_here":true}"#,
            r#"{"type":"message","message":{"role":"user","content":"found it"}}"#,
        ]);
        assert_eq!(first_user_text(&path), Some("found it".to_string()));
    }

    #[test]
    fn first_user_text_truncates_to_120_chars_and_flattens_newlines() {
        let dir = temp_dir("fut-trunc");
        let path = dir.join("s.jsonl");
        let long = format!(r#"{{"type":"message","message":{{"role":"user","content":"a\nb {}"}}}}"#, "x".repeat(200));
        write_lines(&path, &[&long]);
        let got = first_user_text(&path).unwrap();
        assert!(got.starts_with("a b xxx"));
        assert_eq!(got.chars().count(), 120);
    }

    #[test]
    fn first_user_text_empty_content_falls_through_to_next_user_message() {
        let dir = temp_dir("fut-empty");
        let path = dir.join("s.jsonl");
        write_lines(&path, &[
            r#"{"type":"message","message":{"role":"user","content":"   "}}"#,
            r#"{"type":"message","message":{"role":"user","content":"the real one"}}"#,
        ]);
        assert_eq!(first_user_text(&path), Some("the real one".to_string()));
    }
}
