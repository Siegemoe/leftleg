#![cfg(windows)]
//! read_text_file's full pipeline for renderer-supplied paths: shape check,
//! the open-path containment boundary, then the tracked/binary/read gates.
//! Lives in its own integration binary because tauri::test's mock runtime in
//! the lib test binary changes that exe's DLL linkage into a non-starter.
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn temp_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("leftleg-rte-{tag}-{}", uuid::Uuid::new_v4()))
}

#[test]
fn read_text_file_enforces_containment_tracked_and_binary_gates() {
    let app = tauri::test::mock_app();
    app.manage(leftleg_lib::PiState::new());
    let app = app.handle().clone();
    // The repo checkout doubles as the containment root (via
    // PI_CODING_AGENT_DIR) and provides real tracked files. Env is saved and
    // restored; this binary runs a single test, so mutating it is safe.
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
    let previous = std::env::var("PI_CODING_AGENT_DIR").ok();
    std::env::set_var("PI_CODING_AGENT_DIR", &repo_root);

    // Tracked repo file inside the allowed root: full pipeline works.
    let ok = leftleg_lib::read_text_file_checked(&app, repo_root.to_str().unwrap(), "package.json").unwrap();
    assert!(ok.content.contains('{'));
    assert!(ok.loc > 0);
    assert!(!ok.truncated);

    // Renderer-supplied absolute path: rejected before the filesystem.
    let absolute = std::env::temp_dir().join("leftleg-rte-abs-evil.txt");
    let err = leftleg_lib::read_text_file_checked(&app, repo_root.to_str().unwrap(), absolute.to_str().unwrap()).unwrap_err();
    assert!(err.contains("repo-relative"), "{err}");
    // `..` components: rejected even though they'd stay inside the root.
    let err = leftleg_lib::read_text_file_checked(&app, repo_root.to_str().unwrap(), "src/../../../etc/passwd").unwrap_err();
    assert!(err.contains("repo-relative"), "{err}");

    // Tracked binary type: refused before reading.
    let err = leftleg_lib::read_text_file_checked(&app, repo_root.to_str().unwrap(), "src-tauri/icons/icon.png").unwrap_err();
    assert!(err.contains("binary file type"), "{err}");

    // Untracked (and nonexistent) path: refused by the tracked check.
    let err = leftleg_lib::read_text_file_checked(&app, repo_root.to_str().unwrap(), "nonexistent-file-xyz.txt").unwrap_err();
    assert!(err.contains("not tracked"), "{err}");

    // A real file outside every containment root: refused.
    let outside = temp_dir("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.md"), "x").unwrap();
    let err = leftleg_lib::read_text_file_checked(&app, outside.to_str().unwrap(), "secret.md").unwrap_err();
    assert!(err.contains("outside"), "{err}");
    let err = leftleg_lib::project_dir_allowed(&app, outside.to_str().unwrap()).unwrap_err();
    assert!(err.contains("outside"), "{err}");
    assert!(leftleg_lib::project_dir_allowed(&app, repo_root.to_str().unwrap()).is_ok());

    // A read is not a run: tracked source with an OS-open-denied extension
    // (.js opens WScript with no prompt) must still be viewable text, while
    // the same file stays refused for OS-open.
    let jsrepo = temp_dir("jsrepo");
    fs::create_dir_all(&jsrepo).unwrap();
    fs::write(jsrepo.join("tool.js"), "console.log('hi');\n").unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .current_dir(&jsrepo)
            .args(["-c", "user.name=test", "-c", "user.email=test@leftleg"])
            .args(args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} failed");
    };
    git(&["init"]);
    git(&["add", "-A"]);
    git(&["commit", "-m", "init"]);
    std::env::set_var("PI_CODING_AGENT_DIR", &jsrepo);
    let ok = leftleg_lib::read_text_file_checked(&app, jsrepo.to_str().unwrap(), "tool.js").unwrap();
    assert_eq!(ok.content, "console.log('hi');\n");
    assert_eq!(ok.loc, 1);
    let err = leftleg_lib::open_path_allowed(&app, jsrepo.join("tool.js").to_str().unwrap()).unwrap_err();
    assert!(err.contains("refusing to open executable file"), "{err}");

    match previous {
        Some(v) => std::env::set_var("PI_CODING_AGENT_DIR", v),
        None => std::env::remove_var("PI_CODING_AGENT_DIR"),
    }
    fs::remove_dir_all(&outside).unwrap();
    fs::remove_dir_all(&jsrepo).unwrap();
}
