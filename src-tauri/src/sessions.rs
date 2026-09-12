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
        let line = line.ok()?;
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
fn first_user_text(path: &std::path::Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().take(200) {
        let line = line.ok()?;
        let v: serde_json::Value = serde_json::from_str(&line).ok()?;
        if v.get("type")?.as_str()? == "message" {
            let msg = v.get("message")?;
            if msg.get("role")?.as_str()? == "user" {
                let text = match msg.get("content") {
                    Some(serde_json::Value::String(s)) => Some(s.clone()),
                    Some(serde_json::Value::Array(blocks)) => blocks.iter().find_map(|b| {
                        if b.get("type")?.as_str()? == "text" {
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
        }
    }
    None
}

/// List all persisted sessions (all projects), newest-modified first.
#[tauri::command]
pub fn list_sessions() -> Result<Vec<SessionInfo>, String> {
    let root = agent_dir().join("sessions");
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<SessionInfo> = Vec::new();
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
            // Parse the header line: {"type":"session","version":..,"id":..,"timestamp":..,"cwd":..}
            let Ok(content) = fs::File::open(&path) else { continue };
            let mut reader = std::io::BufReader::new(content);
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(header.trim()) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("session") {
                continue;
            }
            let modified = f
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t: SystemTime| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(SessionInfo {
                name: session_display_name(&path),
                path: path.to_string_lossy().into_owned(),
                cwd: v
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .unwrap_or_default()
                    .into(),
                timestamp: v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .into(),
                file_modified: modified,
                session_id: v
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or_default()
                    .into(),
                first_message: first_user_text(&path),
            });
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.file_modified));
    Ok(out)
}

/// Leftleg's own GUI state (theme, project dir, last session). Stored in app data.
#[tauri::command]
pub fn read_gui_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let file = dir.join("leftleg.json");
    if !file.exists() {
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_gui_state(
    app: tauri::AppHandle,
    state: serde_json::Value,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("leftleg.json");
    fs::write(&file, serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Read a local file as base64 (for attaching images to prompts).
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(base64_encode(&buf))
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
