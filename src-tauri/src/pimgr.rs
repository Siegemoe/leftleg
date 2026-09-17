// pi package-manager bridge: a tightly guarded runner for `pi update` plus a
// read-only extension integrity report for the startup check. The webview can
// only pass allowlisted update flags; no shell is involved and output is
// captured. pi stays authoritative for what update does — Leftleg only drives
// it and reports.

use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Single-flight + state flag for managed `pi update` runs. While set,
/// `run_pi_manager` refuses concurrent invocations, and `pi_start` refuses to
/// spawn: the update rewrites the npm package a live pi runs from, so new
/// processes must not start (and two updates must not interleave) meanwhile.
static PI_UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

/// True while a managed `pi update` subprocess is in flight.
pub fn pi_update_running() -> bool {
    PI_UPDATE_RUNNING.load(Ordering::SeqCst)
}

/// Run `pi update` with the given (pre-validated) flags, single-flight: the
/// compare_exchange closes the gap a frontend-side lock leaves open (two
/// webview callers, or a stale frontend that lost its in-flight flag).
pub fn run_pi_manager_impl(flags: Vec<String>) -> Result<PiManagerResult, String> {
    if PI_UPDATE_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("pi update is already running".into());
    }
    let result = run_pi_update(flags);
    PI_UPDATE_RUNNING.store(false, Ordering::SeqCst);
    result
}

/// Run `pi update` with the given (pre-validated) flags: no shell, captured
/// output, bounded runtime — a hung package manager must not pin the request,
/// and a timed-out run must not leak its process tree.
///
/// Launches `node <pi-entry>` directly (same resolution as the RPC bridge)
/// instead of `pi.cmd`, which would route through cmd.exe. Both stdout and
/// stderr are drained by dedicated readers so the child can never block on a
/// full pipe; on timeout the whole tree is killed, which closes the pipe write
/// ends and lets the readers finish before we report.
fn run_pi_update(flags: Vec<String>) -> Result<PiManagerResult, String> {
    use std::io::Read;
    validate_update_flags(&flags)?;
    let shim = resolve_pi_shim()?;
    let entry = crate::pi::pi_entry_from_shim(&shim)?;
    let sibling_node = shim.parent().ok_or("pi shim has no parent")?.join("node.exe");
    let mut cmd = Command::new(if sibling_node.is_file() { sibling_node } else { std::path::PathBuf::from("node") });
    cmd.arg(entry).arg("update").args(&flags);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawning pi update: {e}"))?;
    // The child holds its own process handle, so its PID cannot be reused
    // before we reap it — taskkill by PID below is safe.
    let pid = child.id();
    let mut stdout_pipe = child.stdout.take().ok_or("pi update stdout unavailable")?;
    let mut stderr_pipe = child.stderr.take().ok_or("pi update stderr unavailable")?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(UPDATE_TIMEOUT_SECS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    // Tree-kill first: npm grandchildren can outlive a plain
                    // kill and would keep the pipe readers blocked forever.
                    #[cfg(windows)]
                    {
                        let _ = Command::new("taskkill.exe")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .creation_flags(CREATE_NO_WINDOW)
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status();
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("pi update: {e}"));
            }
        }
    };
    let out = out_reader.join().unwrap_or_default();
    let _ = err_reader.join();
    let status = match status {
        Some(status) => status,
        None => {
            return Err(format!(
                "pi update timed out after {UPDATE_TIMEOUT_SECS}s and was stopped"
            ))
        }
    };
    Ok(PiManagerResult {
        exit_code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out).into_owned(),
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
