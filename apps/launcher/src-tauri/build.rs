fn main() {
    println!("cargo:rerun-if-changed=../../../packaging/launcher/control.mjs");
    // See scripts/build-app.mjs: the shell and the host it bundles carry the
    // same build id. Builds outside that script are "dev".
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build-id");
    println!("cargo:rerun-if-changed={}", path.display());
    let id = std::fs::read_to_string(&path)
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    let id = if id.is_empty() { "dev".to_string() } else { id };
    println!("cargo:rustc-env=JOUZU_BUILD_ID={id}");
    let commit = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build-commit");
    println!("cargo:rerun-if-changed={}", commit.display());
    let commit = std::fs::read_to_string(&commit)
        .map(|text| text.trim().to_string())
        .unwrap_or_default();
    let commit = if commit.is_empty() { "unknown".to_string() } else { commit };
    println!("cargo:rustc-env=JOUZU_COMMIT={commit}");
    tauri_build::build()
}
