// pi package-manager bridge: a tightly guarded runner for `pi update` plus a
// read-only extension integrity report for the startup check. The webview can
// only pass allowlisted update flags; no shell is involved and output is
// captured. pi stays authoritative for what update does — Leftleg only drives
// it and reports.

use serde::Serialize;
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const UPDATE_TIMEOUT_SECS: u64 = 600;

/// Flags the webview may pass to `pi update`. Kept minimal: the startup
/// updater uses `--all`; the others cover narrower passes we may drive later.
const ALLOWED_UPDATE_FLAGS: &[&str] = &["--all", "--self", "--extensions", "--models"];

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiManagerResult {
    pub exit_code: i32,
    pub stdout: String,
}

/// Validate update flags against the allowlist (also the unit-test seam).
pub fn validate_update_flags(flags: &[String]) -> Result<(), String> {
    for f in flags {
        if !ALLOWED_UPDATE_FLAGS.contains(&f.as_str()) {
            return Err(format!("disallowed pi update flag: {f}"));
        }
    }
    Ok(())
}

fn resolve_pi_shim() -> Result<std::path::PathBuf, String> {
    let mut where_cmd = Command::new("where.exe");
    #[cfg(windows)]
    where_cmd.creation_flags(CREATE_NO_WINDOW);
    let found = where_cmd.arg("pi.cmd").output().map_err(|e| format!("locating pi: {e}"))?;
    let line = String::from_utf8_lossy(&found.stdout).lines().next().unwrap_or("").trim().to_string();
    if line.is_empty() {
        return Err("pi.cmd not found on PATH".into());
    }
    Ok(std::path::PathBuf::from(line))
}

/// Run `pi update` with the given (pre-validated) flags: no shell, captured
/// output, bounded runtime — a hung package manager must not pin the request.
pub fn run_pi_manager_impl(flags: Vec<String>) -> Result<PiManagerResult, String> {
    validate_update_flags(&flags)?;
    let shim = resolve_pi_shim()?;
    let mut cmd = Command::new(&shim);
    cmd.arg("update").args(&flags);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawning pi update: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = child.wait_with_output();
        let _ = tx.send(out);
    });
    let output = match rx.recv_timeout(Duration::from_secs(UPDATE_TIMEOUT_SECS)) {
        Ok(res) => res.map_err(|e| format!("pi update: {e}"))?,
        Err(_) => return Err(format!("pi update timed out after {UPDATE_TIMEOUT_SECS}s")),
    };
    Ok(PiManagerResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
    })
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionIntegrity {
    pub source: String,
    pub trusted: bool,
}

#[derive(Debug, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PiIntegrityReport {
    pub extensions: Vec<ExtensionIntegrity>,
}

/// Classify one configured source string: `npm:`-registry specs are trusted;
/// anything else (local files, git URLs, junk) is flagged for the startup gate.
pub fn classify_source(source: &str) -> ExtensionIntegrity {
    ExtensionIntegrity { source: source.to_string(), trusted: source.starts_with("npm:") }
}

/// Read-only integrity report: classify every entry in the `packages` array of
/// the user's pi settings.json. No network, no writes.
pub fn pi_integrity_report_impl() -> Result<PiIntegrityReport, String> {
    let path = crate::sessions::agent_dir().join("settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(PiIntegrityReport::default());
    };
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("parsing pi settings: {e}"))?;
    let mut extensions = Vec::new();
    if let Some(list) = value.get("packages").and_then(|v| v.as_array()) {
        for item in list {
            if let Some(source) = item.as_str() {
                extensions.push(classify_source(source));
            }
        }
    }
    Ok(PiIntegrityReport { extensions })
}

/// Run `pi update` with allowlisted flags (startup harness/extension updater).
#[tauri::command]
pub async fn run_pi_manager(flags: Vec<String>) -> Result<PiManagerResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_pi_manager_impl(flags))
        .await
        .map_err(|e| e.to_string())?
}

/// Read-only integrity report over the user's pi extension sources.
#[tauri::command]
pub async fn pi_integrity_report() -> Result<PiIntegrityReport, String> {
    tauri::async_runtime::spawn_blocking(pi_integrity_report_impl)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_known_update_flags() {
        assert!(validate_update_flags(&["--all".to_string()]).is_ok());
        assert!(validate_update_flags(&["--self".to_string()]).is_ok());
        assert!(validate_update_flags(&["--extensions".to_string()]).is_ok());
    }

    #[test]
    fn rejects_arbitrary_and_shellish_flags() {
        assert!(validate_update_flags(&["--extensions; rm -rf /".to_string()]).is_err());
        assert!(validate_update_flags(&["-x".to_string()]).is_err());
        assert!(validate_update_flags(&["--force".to_string()]).is_err());
    }

    #[test]
    fn npm_sources_are_trusted_others_flagged() {
        assert!(classify_source("npm:@foo/bar").trusted);
        assert!(!classify_source("./local/ext.ts").trusted);
        assert!(!classify_source("git:github.com/x/y").trusted);
    }
}
