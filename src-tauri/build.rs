fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri's app manifest does not cover integration-test executables.
        // Mock-app tests link TaskDialogIndirect, which requires ComCtl32 v6.
        println!(
            r#"cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"#
        );
    }
}
