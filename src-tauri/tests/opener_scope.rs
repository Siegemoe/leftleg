#![cfg(windows)]
//! The local-open boundary: `open_path` must only ever resolve inside the
//! pi agent dir, a live project dir, or Leftleg's app-data dir, and must
//! refuse executable files (an OS "open" on those is a run, not a view).
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn temp_dir(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("leftleg-open-{tag}-{}", uuid::Uuid::new_v4()))
}

#[test]
fn open_path_containment_and_executable_denylist() {
    let app = tauri::test::mock_app();
    app.manage(leftleg_lib::PiState::new());
    let app = app.handle().clone();
    // The agent root is the controllable one in tests (PI_CODING_AGENT_DIR);
    // this binary runs a single test, so mutating the env is safe.
    let agent = temp_dir("agent");
    fs::create_dir_all(agent.join("sessions")).unwrap();
    std::env::set_var("PI_CODING_AGENT_DIR", &agent);
    let outside = temp_dir("outside");
    fs::create_dir_all(&outside).unwrap();

    let inside = agent.join("sessions").join("notes.md");
    fs::write(&inside, b"hi").unwrap();
    fs::write(outside.join("secret.md"), b"x").unwrap();

    // Inside the agent root: allowed.
    assert!(
        leftleg_lib::open_path_allowed(&app, inside.to_str().unwrap()).is_ok(),
        "agent-dir file should open"
    );
    // Outside every root: refused.
    assert!(
        leftleg_lib::open_path_allowed(&app, outside.join("secret.md").to_str().unwrap()).is_err(),
        "file outside all roots should be refused"
    );
    // Executable denylist applies even inside an allowed root.
    let exe = agent.join("tool.bat");
    fs::write(&exe, b"x").unwrap();
    assert!(
        leftleg_lib::open_path_allowed(&app, exe.to_str().unwrap()).is_err(),
        "executable file should be refused"
    );
    // A not-yet-existing file under an allowed dir checks via its parent.
    assert!(
        leftleg_lib::open_path_allowed(&app, agent.join("missing.md").to_str().unwrap()).is_ok(),
        "missing file under an allowed root should pass via its parent"
    );

    std::env::remove_var("PI_CODING_AGENT_DIR");
    fs::remove_dir_all(&agent).unwrap();
    fs::remove_dir_all(&outside).unwrap();
}
