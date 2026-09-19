#![cfg(windows)]
//! The three remaining webview-supplied project_dir commands — git_repo_info,
//! list_artifacts, delete_artifact — now share git_diff_summary's boundary: a
//! renderer-chosen directory outside every allowed root must be rejected
//! before the body runs, so git -C, the artifact scan, the asset-scope grant,
//! and the delete all become unreachable for it (the CodeQL gaps in
//! docs/CODEQL-TRIAGE-2026-09-19.md). Lives in its own integration binary
//! because tauri::test's mock runtime in the lib test binary changes that
//! exe's DLL linkage into a non-starter.
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn temp_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("leftleg-gate-{tag}-{}", uuid::Uuid::new_v4()))
}

#[test]
fn project_dir_commands_reject_roots_outside_the_allowed_set() {
    let app = tauri::test::mock_app();
    app.manage(leftleg_lib::PiState::new());
    let app = app.handle().clone();
    // PI_CODING_AGENT_DIR is the controllable containment root in tests (the
    // process map stays empty and app data doesn't resolve under the mock
    // runtime); pointing it at the fixture stands in for the dialog-picked,
    // pi_start-registered project the gate must accept.
    let project = temp_dir("project");
    let outside = temp_dir("outside");
    fs::create_dir_all(project.join(".pi").join("images")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        project.join(".pi").join("images").join("a.png"),
        [0x89u8, 0x50, 0x4e, 0x47],
    )
    .unwrap();
    // A real checkout (init only — unborn HEAD, no commits needed) so the
    // body's success below means something, not just the gate's.
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .current_dir(&project)
            .args(args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    };
    git(&["init"]);
    let previous = std::env::var("PI_CODING_AGENT_DIR").ok();
    std::env::set_var("PI_CODING_AGENT_DIR", &project);

    // The registered project passes: each gated body reaches its work.
    let info = leftleg_lib::git_repo_info_checked(&app, project.to_str().unwrap()).unwrap();
    assert!(info.repo);
    assert!(!info.toplevel.is_empty());
    let report = leftleg_lib::list_artifacts_checked(&app, project.to_str().unwrap()).unwrap();
    assert_eq!(report.images.len(), 1, "scan ran after the gate");
    let img = report.images[0].path.clone();
    leftleg_lib::delete_artifact_allowed(&app, project.to_str().unwrap(), &img).unwrap();
    assert!(!project.join(".pi").join("images").join("a.png").exists());

    // A renderer-chosen directory outside every root is refused by each gated
    // path — git never runs there (-C), nothing is scanned, no directory
    // scope is granted, and no delete is authorized.
    for err in [
        leftleg_lib::git_repo_info_checked(&app, outside.to_str().unwrap())
            .err()
            .expect("git_repo_info must reject an unregistered root"),
        leftleg_lib::list_artifacts_checked(&app, outside.to_str().unwrap())
            .err()
            .expect("list_artifacts must reject an unregistered root"),
        leftleg_lib::delete_artifact_allowed(
            &app,
            outside.to_str().unwrap(),
            &outside.join("x.png").to_string_lossy(),
        )
        .err()
        .expect("delete_artifact must reject an unregistered root"),
    ] {
        assert!(err.contains("outside"), "{err}");
    }

    match previous {
        Some(v) => std::env::set_var("PI_CODING_AGENT_DIR", v),
        None => std::env::remove_var("PI_CODING_AGENT_DIR"),
    }
    fs::remove_dir_all(project).unwrap();
    fs::remove_dir_all(outside).unwrap();
}
