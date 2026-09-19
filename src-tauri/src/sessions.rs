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
        let Some(msg) = v.get("message") else {
            continue;
        };
        let Some(role) = msg.get("role").and_then(|r| r.as_str()) else {
            continue;
        };
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
    let field = |k: &str| {
        v.get(k)
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string()
    };
    Some((field("cwd"), field("timestamp"), field("id")))
}

/// List all persisted sessions (all projects), newest-modified first.
#[tauri::command]
pub async fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(scan_sessions)
        .await
        .map_err(|e| e.to_string())?
}

/// Cache of fully-parsed session files keyed by path, validated against
/// (mtime, size). list_sessions runs on every sidebar refresh and would
/// otherwise re-read every jsonl in the agent dir each time; entries whose
/// stamp changed (or vanished files) are re-parsed, so renames and appends
/// stay fresh. Held per process — the GUI is the only writer of sessions.
/// Cache value per file: (mtime ms, size, fully-parsed session header).
type SessionCache = std::collections::HashMap<PathBuf, (u64, u64, SessionInfo)>;
static SESSION_CACHE: std::sync::LazyLock<std::sync::Mutex<SessionCache>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(SessionCache::new()));

fn scan_sessions() -> Result<Vec<SessionInfo>, String> {
    let root = agent_dir().join("sessions");
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut cache = SESSION_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<SessionInfo> = Vec::new();
    let mut fresh: SessionCache = SessionCache::new();
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
            let Ok(content) = fs::File::open(&path) else {
                continue;
            };
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
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
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
            &[
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "txt", "md", "json", "ts", "js", "py",
                "rs", "toml", "yaml", "yml", "csv", "log",
            ],
        )
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    let Some(paths) = picked else {
        return Ok(Vec::new()); // cancelled — not an error
    };
    let mut out = Vec::with_capacity(paths.len());
    // Cumulative batch budget: one multi-select must not balloon into
    // hundreds of MiB of base64 in webview memory. Budgeted on raw file
    // size before reading so oversized files are never pulled into memory.
    const BATCH_LIMIT: u64 = 50 * 1024 * 1024;
    let mut budget = BATCH_LIMIT;
    for picked in paths {
        let path = match picked.into_path() {
            Ok(p) => p,
            Err(e) => {
                out.push(PickedFile {
                    name: String::new(),
                    path: String::new(),
                    data: None,
                    error: Some(e.to_string()),
                });
                continue;
            }
        };
        let shown = path.to_string_lossy().into_owned();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > budget {
            out.push(PickedFile {
                name,
                path: shown,
                data: None,
                error: Some(format!(
                    "Attachment batch exceeds the 50 MiB total limit (file is {size} bytes)"
                )),
            });
            continue;
        }
        match read_attachment(&shown) {
            Ok(data) => {
                budget = budget.saturating_sub(size);
                out.push(PickedFile {
                    name,
                    path: shown,
                    data: Some(data),
                    error: None,
                })
            }
            Err(e) => out.push(PickedFile {
                name,
                path: shown,
                data: None,
                error: Some(e),
            }),
        }
    }
    Ok(out)
}

fn read_attachment(path: &str) -> Result<String, String> {
    use std::io::Read;
    const LIMIT: u64 = 20 * 1024 * 1024;
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    if f.metadata().map_err(|e| e.to_string())?.len() > LIMIT {
        return Err("Attachment exceeds 20 MiB limit".into());
    }
    let mut buf = Vec::new();
    f.take(LIMIT + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > LIMIT {
        return Err("Attachment exceeds 20 MiB limit".into());
    }
    Ok(base64_encode(&buf))
}

// ---------- guarded local open ----------

/// Extensions the OS would execute rather than render when "opened". Tool
/// cards and artifact rows only ever offer data files; anything on this list
/// is refused instead of handed to the OS. Case-insensitive, and the rfind
/// makes double extensions count (report.tar.bat is denied). Includes the
/// silent runners on stock Windows: .js/.jse open with WScript with no
/// prompt, .url launches its target (defeating containment), .chm/.msc/
/// ClickOnce/macro Office formats all execute.
const OPEN_DENY_EXTENSIONS: &[&str] = &[
    "exe",
    "bat",
    "cmd",
    "com",
    "scr",
    "pif",
    "msi",
    "msp",
    "mst",
    "cpl",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "ws",
    "wsf",
    "wsc",
    "hta",
    "jar",
    "lnk",
    "url",
    "chm",
    "msc",
    "application",
    "settingcontent-ms",
    "diagcab",
    "docm",
    "xlsm",
    "dll",
    "reg",
    "sh",
    "bash",
    "applescript",
];

fn is_denied_executable(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    // Trailing dots/spaces are creatable via verbatim APIs and would make an
    // extension like "bat " miss the list; trim them before matching.
    let lower = name
        .to_ascii_lowercase()
        .trim_end_matches(['.', ' '])
        .to_string();
    let Some(dot) = lower.rfind('.') else {
        return false;
    };
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

/// Validate a local path against the containment roots: live project
/// directories, the pi agent dir, and Leftleg's app-data dir. Split from
/// `open_path_allowed` so tests can exercise the boundary without opening
/// anything, and so the text reader can share containment without inheriting
/// the OS-open denylist — a read is not a run, and tracked source like .js
/// must stay viewable. Returns the resolved path. Generic over the runtime
/// so the mock-runtime test can drive it.
fn path_containment_allowed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
) -> Result<PathBuf, String> {
    use tauri::Manager;
    let target = std::path::Path::new(path);
    if !target.is_absolute() {
        return Err("path must be absolute".into());
    }
    let resolved = canonical_ancestor(target).ok_or_else(|| "path not found".to_string())?;
    // Containment probe: the canonical file when it exists, else its canonical
    // parent. All sides go through canonicalize so verbatim (\\?\) forms and
    // symlinks compare consistently.
    let probe = if resolved.exists() {
        fs::canonicalize(&resolved).unwrap_or_else(|_| resolved.clone())
    } else {
        resolved
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| resolved.clone())
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
        return Err("path is outside the allowed directories".into());
    }
    Ok(resolved)
}

/// Open a local path with the OS default handler. Guarded three ways: the
/// path must resolve inside a live project directory, the pi agent dir, or
/// Leftleg's app-data dir; executables are refused outright (an "open" on
/// those is a run, not a view); and check+open both run natively so a
/// compromised webview has no arbitrary-open primitive. Web URLs keep using
/// the opener plugin from the webview (its default permission allows
/// http/https only).
pub fn open_path_allowed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
) -> Result<PathBuf, String> {
    let target = std::path::Path::new(path);
    if is_denied_executable(target) {
        let name = target.file_name().and_then(|n| n.to_str()).unwrap_or(path);
        return Err(format!("refusing to open executable file: {name}"));
    }
    let resolved = path_containment_allowed(app, path)?;
    // The requested name may lie (a symlink named "helper" can resolve to
    // evil.exe), so the denylist also runs on the canonical name.
    if is_denied_executable(&resolved) {
        let name = resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path);
        return Err(format!("refusing to open executable file: {name}"));
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
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
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

#[derive(Serialize, Clone, Debug)]
pub struct ArtifactFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "modifiedMs")]
    pub modified_ms: u64,
    pub exists: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct ArtifactsReport {
    pub images: Vec<ArtifactFile>,
    pub docs: Vec<ArtifactFile>,
}

fn artifact_from_path(path: &std::path::Path, exists: bool) -> ArtifactFile {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
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
    ArtifactFile {
        name,
        path: path.to_string_lossy().into_owned(),
        size,
        modified_ms,
        exists,
    }
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
        for entry in fs::read_dir(&images_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let path = entry.path();
            let Ok(canon) = fs::canonicalize(&path) else {
                continue;
            };
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
    images.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    images.truncate(MAX_ARTIFACT_FILES);
    let docs = [
        ("AGENTS.md", root.join("AGENTS.md")),
        ("SYSTEM.md", root.join(".pi").join("SYSTEM.md")),
        (
            "APPEND_SYSTEM.md",
            root.join(".pi").join("APPEND_SYSTEM.md"),
        ),
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
pub fn allow_project_images_scope<R: tauri::Runtime>(app: &tauri::AppHandle<R>, project: &str) {
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo: bool,
    pub branch: String,
    pub dirty: u32,
    pub toplevel: String,
}

#[cfg(windows)]
use std::os::windows::process::CommandExt as _GitCommandExt;

fn run_git_bytes(dir: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = cmd.output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(out.stdout)
}

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    run_git_bytes(dir, args).map(|out| String::from_utf8_lossy(&out).trim().to_string())
}

/// Inspect the project's git checkout: current branch, uncommitted-entry
/// count, and worktree root. `repo: false` when the directory isn't a
/// worktree (or git is unavailable) — the UI treats that as "no git".
pub fn git_repo_info_impl(project_dir: &str) -> GitRepoInfo {
    let none = GitRepoInfo {
        repo: false,
        branch: String::new(),
        dirty: 0,
        toplevel: String::new(),
    };
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
    GitRepoInfo {
        repo: true,
        branch,
        dirty,
        toplevel,
    }
}

/// Git checkout info for a project directory.
#[tauri::command]
pub async fn git_repo_info(
    app: tauri::AppHandle,
    project_dir: String,
) -> Result<GitRepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git_repo_info_checked(&app, &project_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// The git_repo_info command body, generic over the runtime so the
/// integration test can drive the gated path with the mock runtime.
pub fn git_repo_info_checked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_dir: &str,
) -> Result<GitRepoInfo, String> {
    // The -C directory is a webview-supplied string: without the boundary
    // below a compromised renderer picks which directory git runs in, where
    // config-driven execution (core.fsmonitor on status, textconv drivers on
    // diff) is arbitrary command execution. Same containment boundary as the
    // diff/ls/stat commands.
    project_dir_allowed(app, project_dir)?;
    Ok(git_repo_info_impl(project_dir))
}

/// List a project's artifacts (generated images + known docs). Also extends
/// the asset-protocol scope with the project's images dir (covers the case
/// where images appeared without a fresh pi_start).
#[tauri::command]
pub async fn list_artifacts(
    app: tauri::AppHandle,
    project_dir: String,
) -> Result<ArtifactsReport, String> {
    tauri::async_runtime::spawn_blocking(move || list_artifacts_checked(&app, &project_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// The list_artifacts command body. The gate sits before the scan and before
/// the scope grant: allow_directory on an unvalidated root would hand the
/// webview read access to a renderer-chosen directory tree, so an ungated
/// listing is not just a filesystem probe but a scope-widening primitive.
pub fn list_artifacts_checked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_dir: &str,
) -> Result<ArtifactsReport, String> {
    project_dir_allowed(app, project_dir)?;
    let report = scan_artifacts(project_dir)?;
    allow_project_images_scope(app, project_dir);
    Ok(report)
}

/// Delete one image artifact (guarded to <project>/.pi/images).
#[tauri::command]
pub async fn delete_artifact(
    app: tauri::AppHandle,
    project_dir: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_artifact_allowed(&app, &project_dir, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// The delete_artifact command body. The per-file containment below already
/// proves the target resolves inside <project>/.pi/images, but the project
/// root itself is webview-supplied — without the gate the delete would be
/// authorized by an attacker-chosen root, and delete is strictly more
/// dangerous than the read commands that already gate it.
pub fn delete_artifact_allowed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_dir: &str,
    path: &str,
) -> Result<(), String> {
    project_dir_allowed(app, project_dir)?;
    delete_artifact_checked(project_dir, path)
}

// ---------- repo tree, diff summary, and guarded text reads ----------

/// Cap on per-file diff entries returned by git_diff_summary.
const MAX_DIFF_FILES: usize = 200;
/// Cap on tracked-file entries returned by repo_files.
const MAX_REPO_FILES: usize = 5000;
/// Cap on paths accepted per file_stats_batch call.
const MAX_STATS_BATCH: usize = 200;
/// Files above this size are too costly to scan for line counts (loc: None).
const LOC_READ_CAP: u64 = 1024 * 1024;
/// read_text_file's hard cap; larger files return the first chunk with
/// truncated: true rather than an error.
const TEXT_READ_CAP: u64 = 512 * 1024;
/// Binary sniff window: a NUL in the first 8 KiB marks non-text content.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// File types that are never source text: repo file listings omit them and
/// read_text_file refuses them before reading any bytes. Matched
/// case-insensitively on the final extension (rfind makes double extensions
/// count — archive.tar.gz is binary via gz, like the open-path denylist).
const BINARY_EXTENSIONS: &[&str] = &[
    // images
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tif", "tiff", "svg", "icns",
    // fonts
    "woff", "woff2", "ttf", "otf", "eot", // media
    "mp3", "mp4", "wav", "ogg", "webm", "avi", "mov", "mkv", // archives
    "zip", "gz", "tar", "bz2", "xz", "7z", "rar", // documents
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", // executables and object code
    "exe", "dll", "so", "dylib", "lib", "a", "obj", "bin", "dat", "wasm",
    // databases and build artifacts
    "db", "sqlite", "pdb", "msi", "aps", "rsp", "suo", "class", "jar",
];

fn is_binary_extension(path: &str) -> bool {
    let Some(name) = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
    else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    let Some(dot) = lower.rfind('.') else {
        return false;
    };
    BINARY_EXTENSIONS.contains(&&lower[dot + 1..])
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    pub path: String,
    pub added: u64,
    pub deleted: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffSummary {
    pub repo: bool,
    pub files: Vec<GitDiffFile>,
    pub truncated: bool,
}

/// One `-z` numstat record ("added<TAB>deleted<TAB>path"; the caller splits
/// records on NUL). Binary rows report "-" in both count columns and are
/// dropped; malformed rows are dropped too so a stray git notice can't
/// poison the list. -z (no quotepath) keeps paths verbatim — a quoted
/// `"caf\303\251.txt"` form could never be handed back to read_text_file.
fn parse_numstat_row(record: &str) -> Option<GitDiffFile> {
    let mut parts = record.splitn(3, '\t');
    let added = parts.next()?;
    let deleted = parts.next()?;
    let path = parts.next()?;
    if added == "-" || deleted == "-" {
        return None;
    }
    Some(GitDiffFile {
        path: path.to_string(),
        added: added.trim().parse().unwrap_or(0),
        deleted: deleted.trim().parse().unwrap_or(0),
    })
}

fn nul_records(output: &str) -> impl Iterator<Item = &str> {
    output.split('\0').filter(|record| !record.is_empty())
}

/// Working-tree vs HEAD change counts per file. Like git_repo_info, any git
/// failure (including not-a-repo) reads as "no git" — repo: false with an
/// empty list — because the UI treats that as "no data", not an error. A
/// worktree whose HEAD is unborn (no commits yet) is a repo with an empty
/// diff, not "no git".
pub fn git_diff_summary_impl(project_dir: &str) -> GitDiffSummary {
    if run_git(project_dir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
        return GitDiffSummary {
            repo: false,
            files: Vec::new(),
            truncated: false,
        };
    }
    let Ok(out) = run_git_bytes(
        project_dir,
        &["diff", "HEAD", "--numstat", "--no-renames", "-z"],
    ) else {
        return GitDiffSummary {
            repo: true,
            files: Vec::new(),
            truncated: false,
        };
    };
    let out = String::from_utf8_lossy(&out);
    let mut files: Vec<GitDiffFile> = nul_records(&out).filter_map(parse_numstat_row).collect();
    let truncated = files.len() > MAX_DIFF_FILES;
    files.truncate(MAX_DIFF_FILES);
    GitDiffSummary {
        repo: true,
        files,
        truncated,
    }
}

/// Per-file working-tree diff summary for a project directory.
#[tauri::command]
pub async fn git_diff_summary(
    app: tauri::AppHandle,
    project_dir: String,
) -> Result<GitDiffSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_dir_allowed(&app, &project_dir)?;
        Ok(git_diff_summary_impl(&project_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileList {
    pub repo: bool,
    pub files: Vec<RepoFile>,
    pub truncated: bool,
}

/// Tracked files with sizes. Binary-typed entries are omitted (the UI only
/// lists viewable text) and unstattable ones report size 0. Git failure
/// (including not-a-repo) reads as repo: false, same as git_repo_info.
pub fn repo_files_impl(project_dir: &str) -> RepoFileList {
    let Ok(out) = run_git_bytes(project_dir, &["ls-files", "-z"]) else {
        return RepoFileList {
            repo: false,
            files: Vec::new(),
            truncated: false,
        };
    };
    let out = String::from_utf8_lossy(&out);
    // With -z, NUL is the only separator. A newline can legally be part of a
    // Git path on platforms that permit it, so treating it as a separator
    // invents two files. Paths are relative to project_dir.
    let mut paths: Vec<&str> = nul_records(&out).collect();
    let truncated = paths.len() > MAX_REPO_FILES;
    paths.truncate(MAX_REPO_FILES);
    let files = paths
        .into_iter()
        .filter(|rel| !is_binary_extension(rel))
        .map(|rel| RepoFile {
            path: rel.to_string(),
            size: fs::metadata(std::path::Path::new(project_dir).join(rel))
                .map(|m| m.len())
                .unwrap_or(0),
        })
        .collect();
    RepoFileList {
        repo: true,
        files,
        truncated,
    }
}

/// Tracked-file listing with sizes for a project directory.
#[tauri::command]
pub async fn repo_files(
    app: tauri::AppHandle,
    project_dir: String,
) -> Result<RepoFileList, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_dir_allowed(&app, &project_dir)?;
        Ok(repo_files_impl(&project_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub loc: Option<u64>,
    pub size: u64,
    pub is_text: bool,
}

/// Line count for a byte buffer: newline count, plus one for a final
/// unterminated line only when the buffer holds the whole file — a truncated
/// read's tail may be cut mid-line and must not count.
fn count_loc(bytes: &[u8], complete: bool) -> u64 {
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    if complete && !bytes.is_empty() && bytes[bytes.len() - 1] != b'\n' {
        newlines + 1
    } else {
        newlines
    }
}

/// NUL anywhere in the sniff window marks non-text content.
fn has_nul_prefix(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Read at most `cap` bytes; returns (bytes, original file length). `take`
/// bounds the read so an oversized file never fills memory; callers detect
/// truncation by comparing the length against the buffer.
fn read_capped(path: &std::path::Path, cap: u64) -> std::io::Result<(Vec<u8>, u64)> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let original_len = file.metadata()?.len();
    let mut buf = Vec::new();
    (&mut file).take(cap).read_to_end(&mut buf)?;
    Ok((buf, original_len))
}

/// Reject every path shape that does not name a file relative to the project
/// root: empty, bare `.` (ls-files would match the whole repo), a trailing
/// separator (a directory, not a file), absolute, drive-relative, rooted
/// (`/x` would replace the root on a Windows join), and `..` — even when
/// `..` would stay inside the root.
fn repo_relative_path(path: &str) -> Result<PathBuf, String> {
    let p = std::path::Path::new(path);
    let bad = path.is_empty()
        || path == "."
        || path.ends_with(['/', '\\'])
        || p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
    if bad {
        return Err("repo-relative path expected".into());
    }
    Ok(p.to_path_buf())
}

/// Resolve a repo-relative path against the project root and prove it stays
/// inside: the canonical-ancestor technique (same as the open-path boundary)
/// resolves symlinks in every existing component so a link can't smuggle the
/// target out of the root. Returns the joined path for filesystem use.
fn resolve_in_project(project_dir: &str, rel_path: &str) -> Result<PathBuf, String> {
    let rel = repo_relative_path(rel_path)?;
    let root = std::path::Path::new(project_dir);
    let joined = root.join(&rel);
    let canon_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let resolved = canonical_ancestor(&joined).ok_or_else(|| "path not found".to_string())?;
    if !resolved.starts_with(&canon_root) {
        return Err("path traversal rejected".into());
    }
    Ok(joined)
}

fn file_stat_one(project_dir: &str, rel: &str) -> FileStat {
    let degraded = FileStat {
        path: rel.to_string(),
        loc: None,
        size: 0,
        is_text: false,
    };
    let joined = match resolve_in_project(project_dir, rel) {
        Ok(p) => p,
        Err(_) => return degraded,
    };
    let size = fs::metadata(&joined).map(|m| m.len()).unwrap_or(0);
    let Ok((buf, original_len)) = read_capped(&joined, LOC_READ_CAP) else {
        return FileStat {
            path: rel.to_string(),
            loc: None,
            size,
            is_text: false,
        };
    };
    // The extension check keeps is_text honest for NUL-free binary formats
    // (svg, woff) that the sniff window alone would pass.
    let is_text = !is_binary_extension(rel) && !has_nul_prefix(&buf);
    let loc = if original_len <= LOC_READ_CAP {
        Some(count_loc(&buf, buf.len() as u64 == original_len))
    } else {
        None
    };
    FileStat {
        path: rel.to_string(),
        loc,
        size,
        is_text,
    }
}

/// Stats for a batch of repo-relative paths, one entry per request in request
/// order. Individual failures (traversal, missing, unreadable) degrade that
/// entry to loc: None / is_text: false / size 0 instead of failing the batch.
pub fn file_stats_batch_impl(project_dir: &str, paths: &[String]) -> Vec<FileStat> {
    paths
        .iter()
        .take(MAX_STATS_BATCH)
        .map(|rel| file_stat_one(project_dir, rel))
        .collect()
}

/// Size/line-count/textness for a batch of repo-relative paths.
#[tauri::command]
pub async fn file_stats_batch(
    app: tauri::AppHandle,
    project_dir: String,
    paths: Vec<String>,
) -> Result<Vec<FileStat>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        project_dir_allowed(&app, &project_dir)?;
        Ok(file_stats_batch_impl(&project_dir, &paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextFileContent {
    pub path: String,
    pub content: String,
    pub loc: u64,
    pub size: u64,
    pub truncated: bool,
}

/// Tracked check + capped read for an already-contained path. Split from
/// `read_text_file_checked` so tests can exercise tracking, the denylist, and
/// the caps without an app handle.
fn read_tracked_text(project_dir: &str, path: &str) -> Result<TextFileContent, String> {
    // Only repo-tracked files are readable: agent-dir and app-data paths can
    // never pass this even when containment would allow them. -z keeps the
    // echoed paths verbatim, and requiring an exact match (not just
    // pathspec-matched) rejects directory paths like "src" that ls-files
    // would otherwise satisfy — the read below wants a file, not a folder.
    if run_git_bytes(project_dir, &["ls-files", "-z", "--", path])
        .map(|out| {
            String::from_utf8_lossy(&out)
                .split('\0')
                .all(|listed| listed != path)
        })
        .unwrap_or(true)
    {
        return Err("file is not tracked in this repository".into());
    }
    if is_binary_extension(path) {
        return Err("binary file type".into());
    }
    let joined = std::path::Path::new(project_dir).join(repo_relative_path(path)?);
    let (buf, original_len) =
        read_capped(&joined, TEXT_READ_CAP).map_err(|e| format!("{path}: {e}"))?;
    if has_nul_prefix(&buf) {
        return Err("binary file".into());
    }
    Ok(TextFileContent {
        path: path.to_string(),
        content: String::from_utf8_lossy(&buf).into_owned(),
        loc: count_loc(&buf, buf.len() as u64 == original_len),
        size: original_len,
        truncated: original_len > TEXT_READ_CAP,
    })
}

/// Require renderer-supplied repository roots to use the same containment
/// boundary as file reads. This prevents the diff/tree/stat commands from
/// becoming arbitrary filesystem probes if the webview is compromised.
pub fn project_dir_allowed<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_dir: &str,
) -> Result<PathBuf, String> {
    let resolved = path_containment_allowed(app, project_dir)?;
    if !resolved.is_dir() {
        return Err("project directory not found".into());
    }
    Ok(resolved)
}

/// Full read path for a renderer-supplied repo-relative path: shape check,
/// the containment boundary (shared with "open" — but without its executable
/// denylist, since a read is not a run and tracked source like .js must stay
/// viewable), then the tracked/denylist/read gates.
pub fn read_text_file_checked<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project_dir: &str,
    path: &str,
) -> Result<TextFileContent, String> {
    let rel = repo_relative_path(path)?;
    let joined = std::path::Path::new(project_dir).join(&rel);
    path_containment_allowed(app, &joined.to_string_lossy())?;
    read_tracked_text(project_dir, path)
}

/// Read a tracked text file (repo-relative) from a project directory,
/// truncated at 512 KiB.
#[tauri::command]
pub async fn read_text_file(
    app: tauri::AppHandle,
    project_dir: String,
    path: String,
) -> Result<TextFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_text_file_checked(&app, &project_dir, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Create a new project folder in one native operation: the OS folder dialog
/// runs in Rust, so the parent is only ever a directory the user just picked
/// and the webview supplies nothing but the folder name. The name is
/// validated to a safe Windows/POSIX folder name and only directories are
/// ever created. Cancelling the dialog resolves to `None` — not an error, so
/// the card can stay open.
#[tauri::command]
pub async fn pick_and_create_project_dir(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pick_and_create_project_dir_impl(&app, &name))
        .await
        .map_err(|e| e.to_string())?
}

fn pick_and_create_project_dir_impl(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("Choose where to create the project")
        .blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(None); // cancelled — not an error
    };
    let parent = picked.into_path().map_err(|e| e.to_string())?;
    create_project_dir_checked(&parent.to_string_lossy(), name).map(Some)
}

/// Windows reserved device names — CON, PRN, AUX, NUL, COM1-9, LPT1-9 — are
/// rejected as the full name or the stem before any extension ("con.txt"),
/// mirroring how Windows resolves them regardless of extension.
fn is_reserved_windows_name(trimmed: &str) -> bool {
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    stem == "CON"
        || stem == "PRN"
        || stem == "AUX"
        || stem == "NUL"
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn create_project_dir_checked(parent: &str, name: &str) -> Result<String, String> {
    let parent_path = std::path::Path::new(parent);
    if !parent_path.is_absolute() {
        return Err("parent folder must be absolute".into());
    }
    if !parent_path.is_dir() {
        return Err("parent folder does not exist".into());
    }
    let trimmed = name.trim();
    let bad = trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\'])
        || trimmed
            .chars()
            .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20)
        || trimmed.ends_with(['.', ' '])
        || is_reserved_windows_name(trimmed);
    if bad {
        return Err("project name must be a plain folder name".into());
    }
    if trimmed.encode_utf16().count() > 200 {
        return Err("project name is too long".into());
    }
    let target = parent_path.join(trimmed);
    if target.exists() && !target.is_dir() {
        return Err("a file with that name already exists".into());
    }
    fs::create_dir_all(&target).map_err(|e| format!("couldn't create folder: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
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
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let info = git_repo_info_impl(repo_root.to_str().unwrap());
        assert!(info.repo);
        assert!(!info.branch.is_empty());

        let nonrepo =
            std::env::temp_dir().join(format!("leftleg-nonrepo-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&nonrepo).unwrap();
        let info2 = git_repo_info_impl(nonrepo.to_str().unwrap());
        assert!(!info2.repo);
        assert_eq!(info2.dirty, 0);
        fs::remove_dir_all(nonrepo).unwrap();
    }

    #[test]
    fn artifacts_list_and_delete_are_guarded() {
        let dir = std::env::temp_dir().join(format!(
            "leftleg-artifacts-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
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
        assert!(report.docs.iter().all(|d| !d.name.is_empty()));

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
        fs::File::create(&file)
            .unwrap()
            .set_len(20 * 1024 * 1024 + 1)
            .unwrap();
        assert!(read_attachment(file.to_str().unwrap())
            .unwrap_err()
            .contains("20 MiB"));
        fs::remove_dir_all(dir).unwrap();
    }

    /// Unique temp dir per test; best-effort cleanup via leak-tolerance.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("leftleg-test-{}-{}", tag, uuid::Uuid::new_v4()));
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
        write_lines(
            &path,
            &[
                r#"{"type":"session","id":"1"}"#,
                r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
                r#"{"type":"session_info","name":"  first name  "}"#,
                r#"{"type":"message","message":{"role":"assistant","content":"hey"}}"#,
                r#"{"type":"session_info","name":"renamed"}"#,
            ],
        );
        assert_eq!(session_display_name(&path), Some("renamed".to_string()));
    }

    #[test]
    fn empty_names_are_ignored() {
        let dir = temp_dir("name-empty");
        let path = dir.join("s.jsonl");
        write_lines(
            &path,
            &[
                r#"{"type":"session_info","name":""}"#,
                r#"{"type":"session_info","name":"   "}"#,
            ],
        );
        assert_eq!(session_display_name(&path), None);
    }

    #[test]
    fn no_session_info_means_no_name() {
        let dir = temp_dir("name-none");
        let path = dir.join("s.jsonl");
        write_lines(
            &path,
            &[
                r#"{"type":"session","id":"1"}"#,
                r#"{"type":"message","message":{"role":"user","content":"hi"}}"#,
            ],
        );
        assert_eq!(session_display_name(&path), None);
    }

    // ---------- first_user_text ----------

    #[test]
    fn first_user_text_string_content() {
        let dir = temp_dir("fut-str");
        let path = dir.join("s.jsonl");
        write_lines(
            &path,
            &[
                r#"{"type":"session","id":"1"}"#,
                r#"{"type":"message","message":{"role":"user","content":"fix the login bug"}}"#,
            ],
        );
        assert_eq!(
            first_user_text(&path),
            Some("fix the login bug".to_string())
        );
    }

    #[test]
    fn first_user_text_block_content() {
        let dir = temp_dir("fut-blocks");
        let path = dir.join("s.jsonl");
        write_lines(
            &path,
            &[
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"from a block"}]}}"#,
            ],
        );
        assert_eq!(first_user_text(&path), Some("from a block".to_string()));
    }

    #[test]
    fn first_user_text_skips_non_user_and_malformed_lines() {
        let dir = temp_dir("fut-skip");
        let path = dir.join("s.jsonl");
        write_lines(
            &path,
            &[
                r#"{"type":"message","message":{"role":"assistant","content":"assistant first"}}"#,
                "this line is not json <<<",
                r#"{"no_type_here":true}"#,
                r#"{"type":"message","message":{"role":"user","content":"found it"}}"#,
            ],
        );
        assert_eq!(first_user_text(&path), Some("found it".to_string()));
    }

    #[test]
    fn first_user_text_truncates_to_120_chars_and_flattens_newlines() {
        let dir = temp_dir("fut-trunc");
        let path = dir.join("s.jsonl");
        let long = format!(
            r#"{{"type":"message","message":{{"role":"user","content":"a\nb {}"}}}}"#,
            "x".repeat(200)
        );
        write_lines(&path, &[&long]);
        let got = first_user_text(&path).unwrap();
        assert!(got.starts_with("a b xxx"));
        assert_eq!(got.chars().count(), 120);
    }

    #[test]
    fn first_user_text_empty_content_falls_through_to_next_user_message() {
        let dir = temp_dir("fut-empty");
        let path = dir.join("s.jsonl");
        write_lines(
            &path,
            &[
                r#"{"type":"message","message":{"role":"user","content":"   "}}"#,
                r#"{"type":"message","message":{"role":"user","content":"the real one"}}"#,
            ],
        );
        assert_eq!(first_user_text(&path), Some("the real one".to_string()));
    }

    // ---------- repo tree, diff summary, and text-file reads ----------

    #[test]
    fn numstat_parses_text_skips_binary_and_malformed() {
        let row = parse_numstat_row("12\t3\tsrc/main.rs").expect("text row");
        assert_eq!(
            (row.path.as_str(), row.added, row.deleted),
            ("src/main.rs", 12, 3)
        );
        assert!(
            parse_numstat_row("-\t-\tlogo.png").is_none(),
            "binary rows are skipped"
        );
        assert!(parse_numstat_row("1\t2").is_none(), "missing path column");
        assert!(parse_numstat_row("").is_none(), "empty line");
        assert_eq!(
            parse_numstat_row("0\t0\tname with spaces.txt")
                .unwrap()
                .path,
            "name with spaces.txt"
        );
        assert_eq!(
            parse_numstat_row("7\t\tpath").unwrap().deleted,
            0,
            "empty count parses as 0"
        );
    }

    #[test]
    fn nul_output_keeps_newlines_inside_paths() {
        let records: Vec<&str> = nul_records("line\nbreak.txt\0 leading.txt\0").collect();
        assert_eq!(records, vec!["line\nbreak.txt", " leading.txt"]);
    }

    #[test]
    fn diff_summary_real_repo_and_nonrepo() {
        // The build directory lives inside this repo, so the checkout is real.
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let summary = git_diff_summary_impl(repo_root.to_str().unwrap());
        assert!(summary.repo);
        assert!(summary.files.iter().all(|f| !f.path.is_empty()));

        let nonrepo = temp_dir("diff-nonrepo");
        let s2 = git_diff_summary_impl(nonrepo.to_str().unwrap());
        assert!(!s2.repo);
        assert!(s2.files.is_empty());
        assert!(!s2.truncated);
        fs::remove_dir_all(nonrepo).unwrap();
    }

    #[test]
    fn diff_summary_caps_at_200_entries() {
        let dir = temp_dir("diff-cap");
        run_git(dir.to_str().unwrap(), &["init"]).unwrap();
        for i in 0..210 {
            fs::write(dir.join(format!("f{i:03}.txt")), format!("v1-{i}\n")).unwrap();
        }
        run_git(dir.to_str().unwrap(), &["add", "-A"]).unwrap();
        run_git(
            dir.to_str().unwrap(),
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@leftleg",
                "commit",
                "-m",
                "init",
            ],
        )
        .unwrap();
        for i in 0..210 {
            fs::write(dir.join(format!("f{i:03}.txt")), format!("v2-{i}\n")).unwrap();
        }
        let summary = git_diff_summary_impl(dir.to_str().unwrap());
        assert!(summary.repo);
        assert!(summary.truncated, "210 changed files exceed the cap");
        assert_eq!(summary.files.len(), MAX_DIFF_FILES);
        assert!(summary.files.iter().all(|f| f.added == 1 && f.deleted == 1));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn repo_files_real_repo_lists_package_json() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let list = repo_files_impl(repo_root.to_str().unwrap());
        assert!(list.repo);
        assert!(!list.files.is_empty());
        let pkg = list
            .files
            .iter()
            .find(|f| f.path == "package.json")
            .expect("package.json is tracked");
        assert!(pkg.size > 0, "size comes from the file's metadata");
        assert!(
            list.files.iter().all(|f| !is_binary_extension(&f.path)),
            "denylisted extensions are omitted even when tracked"
        );

        let nonrepo = temp_dir("files-nonrepo");
        let l2 = repo_files_impl(nonrepo.to_str().unwrap());
        assert!(!l2.repo);
        assert!(l2.files.is_empty());
        assert!(!l2.truncated);
        fs::remove_dir_all(nonrepo).unwrap();
    }

    #[test]
    fn repo_files_and_reader_preserve_a_leading_space_path() {
        let dir = temp_dir("files-whitespace");
        run_git(dir.to_str().unwrap(), &["init"]).unwrap();
        fs::write(dir.join(" leading.txt"), "kept\n").unwrap();
        run_git(dir.to_str().unwrap(), &["add", "-A"]).unwrap();
        run_git(
            dir.to_str().unwrap(),
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@leftleg",
                "commit",
                "-m",
                "init",
            ],
        )
        .unwrap();

        let list = repo_files_impl(dir.to_str().unwrap());
        assert!(list.files.iter().any(|file| file.path == " leading.txt"));
        let read = read_tracked_text(dir.to_str().unwrap(), " leading.txt").unwrap();
        assert_eq!(read.content, "kept\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn binary_extension_denylist_matches_final_extension_case_insensitively() {
        for hit in [
            "a.png",
            "photo.BMP",
            "x/y/z.svg",
            "archive.tar.gz",
            "site.woff2",
            "app.class",
            "OLD.SUO",
            "core.dylib",
            "movie.mkv",
            "db.sqlite",
            "run.7z",
            "a.tar",
        ] {
            assert!(is_binary_extension(hit), "{hit} must be denied");
        }
        for miss in [
            "main.rs",
            "notes.txt",
            "README",
            ".gitignore",
            "style.css",
            "pkg.json",
            "dir.d/file",
            "makefile",
        ] {
            assert!(!is_binary_extension(miss), "{miss} must be allowed");
        }
    }

    #[test]
    fn count_loc_counts_trailing_unterminated_line_only_when_complete() {
        assert_eq!(count_loc(b"a\nb\n", true), 2);
        assert_eq!(
            count_loc(b"a\nb", true),
            2,
            "unterminated final line counts when complete"
        );
        assert_eq!(
            count_loc(b"a\nb", false),
            1,
            "truncated tail line must not count"
        );
        assert_eq!(count_loc(b"", true), 0);
        assert_eq!(count_loc(b"\n", true), 1);
        assert_eq!(count_loc(b"a", true), 1);
        assert_eq!(count_loc(b"a", false), 0);
    }

    #[test]
    fn file_stats_batch_reports_text_sizes_and_degrades_failures() {
        let dir = temp_dir("stats");
        fs::write(dir.join("trailing.txt"), "one\ntwo\n").unwrap();
        fs::write(dir.join("notrail.txt"), "one\ntwo").unwrap();
        fs::write(dir.join("empty.txt"), "").unwrap();
        fs::write(dir.join("nul.txt"), b"a\0b\n").unwrap();
        fs::write(dir.join("img.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        fs::File::create(dir.join("big.txt"))
            .unwrap()
            .set_len(LOC_READ_CAP + 1)
            .unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("inner.txt"), "x\n").unwrap();

        let paths: Vec<String> = [
            "trailing.txt",
            "notrail.txt",
            "empty.txt",
            "nul.txt",
            "img.png",
            "big.txt",
            "sub/inner.txt",
            "missing.txt",
            "../outside.txt",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // Results are one-per-request in request order.
        let stats = file_stats_batch_impl(dir.to_str().unwrap(), &paths);
        assert_eq!(stats.len(), paths.len());
        let s = |i: usize| &stats[i];
        assert_eq!((s(0).loc, s(0).is_text, s(0).size), (Some(2), true, 8));
        assert_eq!(
            (s(1).loc, s(1).is_text, s(1).size),
            (Some(2), true, 7),
            "no trailing newline adds the last line"
        );
        assert_eq!((s(2).loc, s(2).is_text, s(2).size), (Some(0), true, 0));
        assert!(!s(3).is_text, "NUL in the sniff window marks binary");
        assert_eq!(s(3).loc, Some(1));
        assert!(
            !s(4).is_text,
            "denylisted extension is binary even without NULs"
        );
        assert_eq!(
            (s(5).loc, s(5).size),
            (None, LOC_READ_CAP + 1),
            "oversized file gets no loc"
        );
        assert_eq!(
            (s(6).loc, s(6).is_text, s(6).size),
            (Some(1), true, 2),
            "subdirectory paths resolve"
        );
        assert_eq!(
            (s(7).loc, s(7).is_text, s(7).size),
            (None, false, 0),
            "missing file degrades"
        );
        assert_eq!(
            (s(8).loc, s(8).is_text, s(8).size),
            (None, false, 0),
            "traversal degrades"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_stats_batch_caps_input_at_200() {
        let paths: Vec<String> = (0..205).map(|i| format!("f{i}.txt")).collect();
        let stats = file_stats_batch_impl(".", &paths);
        assert_eq!(stats.len(), MAX_STATS_BATCH);
        assert!(
            stats.iter().all(|s| s.loc.is_none()),
            "nonexistent entries degrade without failing"
        );
    }

    #[test]
    fn repo_relative_path_rejects_non_relative_shapes() {
        assert!(repo_relative_path("src/main.rs").is_ok());
        assert!(repo_relative_path("./src/main.rs").is_ok());
        for bad in [
            "C:\\Windows\\evil.txt",
            "/etc/passwd",
            "..\\evil.txt",
            "src/../../../etc/passwd",
            "a/../b",
            "C:relative.txt",
            // not files: empty, the repo itself, and trailing separators
            "",
            ".",
            "src/",
            "src\\",
            "./",
        ] {
            assert!(repo_relative_path(bad).is_err(), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn read_tracked_text_caps_size_and_refuses_binary_extensions() {
        let dir = temp_dir("text-caps");
        run_git(dir.to_str().unwrap(), &["init"]).unwrap();
        fs::write(dir.join("small.txt"), "hi").unwrap();
        fs::write(dir.join("fake.png"), [0u8, 1, 2]).unwrap();
        let big = b"a\n".repeat(300 * 1024); // 600 KiB, past the 512 KiB cap
        fs::write(dir.join("big.txt"), &big).unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("inner.txt"), "x\n").unwrap();
        run_git(dir.to_str().unwrap(), &["add", "-A"]).unwrap();
        run_git(
            dir.to_str().unwrap(),
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@leftleg",
                "commit",
                "-m",
                "init",
            ],
        )
        .unwrap();

        let small = read_tracked_text(dir.to_str().unwrap(), "small.txt").unwrap();
        assert_eq!(small.content, "hi");
        assert_eq!(small.loc, 1);
        assert!(!small.truncated);
        assert_eq!(small.size, 2);

        let inner = read_tracked_text(dir.to_str().unwrap(), "sub/inner.txt").unwrap();
        assert_eq!(inner.content, "x\n");

        let big = read_tracked_text(dir.to_str().unwrap(), "big.txt").unwrap();
        assert!(big.truncated);
        assert_eq!(
            big.content.len() as u64,
            TEXT_READ_CAP,
            "content is capped, not refused"
        );
        assert_eq!(
            big.loc,
            TEXT_READ_CAP / 2,
            "truncated tail line must not count"
        );
        assert_eq!(
            big.size,
            (300 * 1024 * 2) as u64,
            "size reports the original length"
        );

        let err = read_tracked_text(dir.to_str().unwrap(), "fake.png").unwrap_err();
        assert!(err.contains("binary file type"), "{err}");
        let err = read_tracked_text(dir.to_str().unwrap(), "never-committed.txt").unwrap_err();
        assert!(err.contains("not tracked"), "{err}");
        // A directory path satisfies the ls-files pathspec but is not a file:
        // exact-match on the echoed listing must refuse it.
        let err = read_tracked_text(dir.to_str().unwrap(), "sub").unwrap_err();
        assert!(err.contains("not tracked"), "{err}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn diff_summary_keeps_special_paths_verbatim() {
        // Default core.quotepath would escape non-ASCII names as
        // "caf\303\251.txt"; -z output must arrive unquoted so the path can be
        // handed straight back to read_text_file.
        let dir = temp_dir("diff-quote");
        run_git(dir.to_str().unwrap(), &["init"]).unwrap();
        fs::write(dir.join("café.txt"), "v1\n").unwrap();
        run_git(dir.to_str().unwrap(), &["add", "-A"]).unwrap();
        run_git(
            dir.to_str().unwrap(),
            &[
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@leftleg",
                "commit",
                "-m",
                "init",
            ],
        )
        .unwrap();
        fs::write(dir.join("café.txt"), "v2\n").unwrap();
        let summary = git_diff_summary_impl(dir.to_str().unwrap());
        assert!(summary.repo);
        assert!(
            summary.files.iter().any(|f| f.path == "café.txt"),
            "non-ASCII path must not be quoted, got {:?}",
            summary.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn diff_summary_unborn_head_is_a_repo_with_empty_diff() {
        // `git diff HEAD` is fatal before the first commit; the sidebar chip
        // (rev-parse-based) already calls this a repo, so the Diff dock must
        // agree instead of reporting "not a git repository".
        let dir = temp_dir("diff-unborn");
        run_git(dir.to_str().unwrap(), &["init"]).unwrap();
        fs::write(dir.join("seed.txt"), "x\n").unwrap();
        let summary = git_diff_summary_impl(dir.to_str().unwrap());
        assert!(summary.repo, "no commits yet is still a repo");
        assert!(summary.files.is_empty());
        assert!(!summary.truncated);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn create_project_dir_validates_name_and_parent() {
        let parent = temp_dir("proj-create");
        fs::create_dir_all(&parent).unwrap();

        // Happy path: single safe component, created and returned absolute.
        let made = create_project_dir_checked(parent.to_str().unwrap(), " My Project ").unwrap();
        assert_eq!(
            std::path::Path::new(&made).file_name().unwrap(),
            "My Project"
        );
        assert!(std::path::Path::new(&made).is_dir(), "{made} must exist");

        // Existing directory is idempotent; existing file is refused.
        assert_eq!(
            create_project_dir_checked(parent.to_str().unwrap(), "My Project").unwrap(),
            made
        );
        fs::write(parent.join("taken.txt"), "x").unwrap();
        assert!(create_project_dir_checked(parent.to_str().unwrap(), "taken.txt").is_err());

        // Name must be one plain component. (Surrounding whitespace is
        // trimmed by design — the happy path above accepts " My Project ".)
        for bad in [
            "",
            "  ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "evil:name",
            "wild*",
            "q?x",
            "trail.",
            "trail .",
            "a<b",
        ] {
            assert!(
                create_project_dir_checked(parent.to_str().unwrap(), bad).is_err(),
                "{bad:?} must be rejected",
            );
        }

        // Control characters (<0x20) and over-long names are rejected. (The
        // 200-unit limit is pinned from the reject side plus a shorter
        // positive control: a 200-char dir name under %TEMP% can blow past
        // MAX_PATH and fail create_dir_all for unrelated reasons.)
        assert!(create_project_dir_checked(parent.to_str().unwrap(), "a\nb").is_err());
        let long = "x".repeat(201);
        assert!(create_project_dir_checked(parent.to_str().unwrap(), &long).is_err());
        assert!(
            create_project_dir_checked(parent.to_str().unwrap(), &"x".repeat(150)).is_ok(),
            "long-but-under-limit name must be accepted",
        );

        // Windows reserved device names — bare or as a stem before any
        // extension, any case; COM0/LPT0 and similar-looking names are fine.
        for bad in [
            "con", "CON", "Con.txt", "prn", "aux.zip", "nul", "com1", "COM9", "lpt4", "LPT1.txt",
        ] {
            assert!(
                create_project_dir_checked(parent.to_str().unwrap(), bad).is_err(),
                "{bad:?} must be rejected",
            );
        }
        for ok in ["connect", "console", "com0", "lpt0", "com10", "nul-off"] {
            create_project_dir_checked(parent.to_str().unwrap(), ok)
                .unwrap_or_else(|e| panic!("{ok:?} must be accepted: {e}"));
        }

        // Parent must be absolute and existing.
        assert!(create_project_dir_checked("relative-parent", "x").is_err());
        assert!(create_project_dir_checked(parent.join("nope").to_str().unwrap(), "x").is_err());

        fs::remove_dir_all(parent).unwrap();
    }
}
