use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Selection {
    pub schema_version: u32,
    pub slot: String,
    pub version: String,
}

/// Resolve a verified version slot without permitting receipt-controlled absolute
/// paths. Installation upgrades may replace bundled app/, but not this selection.
pub fn resolve_app(install: &Path, managed: &Path) -> Result<PathBuf, String> {
    let updates = managed.join("updates");
    let receipt = updates.join("active.json");
    let bytes = match std::fs::read(&receipt) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(install.join("app")),
        Err(_) => return Err("Cannot read active Jouzu selection".into()),
    };
    if bytes.len() > 4096 { return Err("Invalid active Jouzu selection".into()); }
    let selection: Selection = serde_json::from_slice(&bytes).map_err(|_| "Invalid active Jouzu selection")?;
    if selection.schema_version != 1 || selection.slot.is_empty() || selection.slot.len() > 100
        || !selection.slot.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || semver::Version::parse(&selection.version).is_err() {
        return Err("Invalid active Jouzu selection".into());
    }
    let slots = updates.join("versions").canonicalize().map_err(|_| "Jouzu version storage unavailable")?;
    let app = slots.join(&selection.slot).join("app").canonicalize().map_err(|_| "Selected Jouzu version unavailable")?;
    if !app.starts_with(&slots) || !app.join("bootstrap.mjs").is_file() || !app.join("node_modules/jouzu/dist/cli.js").is_file() {
        return Err("Selected Jouzu version is incomplete".into());
    }
    let package: serde_json::Value = serde_json::from_slice(&std::fs::read(app.join("node_modules/jouzu/package.json")).map_err(|_| "Selected Jouzu metadata unavailable")?).map_err(|_| "Invalid Jouzu metadata")?;
    if package["name"] != "jouzu" || package["version"] != selection.version {
        return Err("Selected Jouzu version mismatch".into());
    }
    Ok(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_default_and_selected_slot_survive_install_path_change() {
        let root = tempfile::tempdir().unwrap(); let managed = root.path().join("managed");
        let old = root.path().join("old"); let new = root.path().join("new");
        assert_eq!(resolve_app(&old, &managed).unwrap(), old.join("app"));
        let app = managed.join("updates/versions/test-slot/app");
        std::fs::create_dir_all(app.join("node_modules/jouzu/dist")).unwrap();
        std::fs::write(app.join("bootstrap.mjs"), "fixture").unwrap();
        std::fs::write(app.join("node_modules/jouzu/dist/cli.js"), "fixture").unwrap();
        std::fs::write(app.join("node_modules/jouzu/package.json"), r#"{"name":"jouzu","version":"0.1.18"}"#).unwrap();
        let receipt = managed.join("updates/active.json");
        std::fs::write(&receipt, r#"{"schemaVersion":1,"slot":"test-slot","version":"0.1.18"}"#).unwrap();
        assert_eq!(resolve_app(&old, &managed).unwrap(), app.canonicalize().unwrap());
        assert_eq!(resolve_app(&new, &managed).unwrap(), app.canonicalize().unwrap());
        for slot in ["../escape", "C:\\escape", "", "test.slot"] {
            std::fs::write(&receipt, serde_json::to_vec(&Selection {schema_version:1,slot:slot.into(),version:"0.1.18".into()}).unwrap()).unwrap();
            assert!(resolve_app(&old,&managed).is_err());
        }
    }
}
