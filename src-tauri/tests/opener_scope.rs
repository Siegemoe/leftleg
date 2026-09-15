#![cfg(windows)]
use std::fs;

#[test]
fn configured_opener_scope_allows_generated_images_with_repeated_separators() {
    let app = tauri::test::mock_app();
    let root = std::env::temp_dir().join(format!("leftleg-opener-{}", uuid::Uuid::new_v4()));
    let images = root.join(".pi").join("images");
    fs::create_dir_all(&images).unwrap();
    fs::write(images.join("sample.png"), b"test").unwrap();
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    let allow = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["identifier"] == "opener:allow-open-path")
        .unwrap()["allow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| std::path::PathBuf::from(p["path"].as_str().unwrap()))
        .collect();
    let config = tauri::utils::config::FsScope::Scope {
        allow,
        deny: vec![],
        require_literal_leading_dot: None,
    };
    let scope = tauri::fs::Scope::new(&app, &config).unwrap();
    let path = format!("{}\\\\.pi\\images\\sample.png", root.display());
    let allowed = scope.is_allowed(&path);
    fs::remove_dir_all(&root).unwrap();
    assert!(allowed, "configured opener scope rejected {path}");
}
