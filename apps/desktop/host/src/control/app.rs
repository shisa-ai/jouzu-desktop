//! Resolving the interpreter and the active Jouzu app for a control operation.
//!
//! The shell owns the same rules today; the host takes them over unchanged so a
//! receipt can never point the host at an arbitrary directory.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Selection {
    schema_version: u32,
    slot: String,
    version: String,
}

/// A receipt version must be a plain `major.minor.patch` with optional pre-release
/// and build metadata. This matches what `semver::Version::parse` accepted in the
/// shell for the shapes a receipt actually carries, without adding a dependency.
fn valid_version(text: &str) -> bool {
    let (core, rest) = match text.find(['-', '+']) {
        Some(index) => (&text[..index], &text[index..]),
        None => (text, ""),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    if !parts
        .iter()
        .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    rest.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'+')
}

/// Resolve the active Jouzu app: the bundled `app/` by default, or a verified
/// version slot from the update receipt.
pub fn resolve_app(install: &Path, managed: &Path) -> Result<PathBuf, String> {
    let updates = managed.join("updates");
    let receipt = updates.join("active.json");
    let bytes = match std::fs::read(&receipt) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(install.join("app")),
        Err(_) => return Err("Cannot read active Jouzu selection".into()),
    };
    if bytes.len() > 4096 {
        return Err("Invalid active Jouzu selection".into());
    }
    let selection: Selection =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid active Jouzu selection")?;
    if selection.schema_version != 1
        || selection.slot.is_empty()
        || selection.slot.len() > 100
        || !selection
            .slot
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || !valid_version(&selection.version)
    {
        return Err("Invalid active Jouzu selection".into());
    }
    let slots = updates
        .join("versions")
        .canonicalize()
        .map_err(|_| "Jouzu version storage unavailable")?;
    let app = slots
        .join(&selection.slot)
        .join("app")
        .canonicalize()
        .map_err(|_| "Selected Jouzu version unavailable")?;
    if !app.starts_with(&slots)
        || !app.join("bootstrap.mjs").is_file()
        || !app.join("node_modules/jouzu/dist/cli.js").is_file()
    {
        return Err("Selected Jouzu version is incomplete".into());
    }
    let package: serde_json::Value = serde_json::from_slice(
        &std::fs::read(app.join("node_modules/jouzu/package.json"))
            .map_err(|_| "Selected Jouzu metadata unavailable")?,
    )
    .map_err(|_| "Invalid Jouzu metadata")?;
    if package["name"] != "jouzu" || package["version"] != selection.version {
        return Err("Selected Jouzu version mismatch".into());
    }
    Ok(app)
}

/// The Node that ships with Jouzu. There is no fallback to a `node` on PATH:
/// another version would run Jouzu's code with different behaviour, and the
/// difference would only show as strange errors. A missing one is reported.
pub fn node_executable(managed: &Path) -> PathBuf {
    managed.join("runtime").join("node").join("node.exe")
}

/// Node's entrypoint resolver rejects Windows verbatim paths. Keep canonical paths
/// for containment checks and convert only at the process boundary.
pub fn process_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::Prefix;
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            let mut output = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut value = PathBuf::from(r"\\");
                    value.push(server);
                    value.push(share);
                    value
                }
                _ => return path.to_path_buf(),
            };
            for component in components {
                if !matches!(component, Component::RootDir) {
                    output.push(component.as_os_str());
                }
            }
            return output;
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_slot(managed: &Path, slot: &str, version: &str) {
        let app = managed.join("updates").join("versions").join(slot).join("app");
        std::fs::create_dir_all(app.join("node_modules/jouzu/dist")).unwrap();
        std::fs::write(app.join("bootstrap.mjs"), "fixture").unwrap();
        std::fs::write(app.join("node_modules/jouzu/dist/cli.js"), "fixture").unwrap();
        std::fs::write(
            app.join("node_modules/jouzu/package.json"),
            format!(r#"{{"name":"jouzu","version":"{version}"}}"#),
        )
        .unwrap();
    }

    fn receipt(managed: &Path, body: &str) {
        let updates = managed.join("updates");
        std::fs::create_dir_all(&updates).unwrap();
        std::fs::write(updates.join("active.json"), body).unwrap();
    }

    #[test]
    fn the_bundled_app_is_the_default() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("managed");
        let install = root.path().join("install");
        std::fs::create_dir_all(&managed).unwrap();
        assert_eq!(resolve_app(&install, &managed).unwrap(), install.join("app"));
    }

    #[test]
    fn a_valid_slot_wins_over_the_install_path() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("managed");
        let install = root.path().join("install");
        write_slot(&managed, "test-slot", "0.1.18");
        receipt(
            &managed,
            r#"{"schemaVersion":1,"slot":"test-slot","version":"0.1.18"}"#,
        );
        let resolved = resolve_app(&install, &managed).unwrap();
        assert!(resolved.ends_with("test-slot\\app") || resolved.ends_with("test-slot/app"));
    }

    #[test]
    fn an_invalid_slot_is_an_error_not_a_fallback() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("managed");
        std::fs::create_dir_all(&managed).unwrap();
        for slot in ["../escape", "C:\\escape", "", "test.slot", "a".repeat(101).as_str()] {
            receipt(
                &managed,
                &format!(r#"{{"schemaVersion":1,"slot":"{slot}","version":"0.1.18"}}"#),
            );
            assert!(resolve_app(&managed, &managed).is_err(), "slot {slot:?} accepted");
        }
    }

    #[test]
    fn a_version_mismatch_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("managed");
        write_slot(&managed, "test-slot", "0.1.18");
        receipt(
            &managed,
            r#"{"schemaVersion":1,"slot":"test-slot","version":"0.1.19"}"#,
        );
        assert!(resolve_app(&managed, &managed).is_err());
    }

    #[test]
    fn an_incomplete_slot_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let managed = root.path().join("managed");
        let app = managed.join("updates").join("versions").join("test-slot").join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("bootstrap.mjs"), "fixture").unwrap();
        receipt(
            &managed,
            r#"{"schemaVersion":1,"slot":"test-slot","version":"0.1.18"}"#,
        );
        assert!(resolve_app(&managed, &managed).is_err());
    }

    #[test]
    fn versions_are_validated_like_the_shell_did() {
        for valid in ["0.1.18", "1.0.0", "0.2.5-beta.1", "1.2.3+build.5"] {
            assert!(valid_version(valid), "{valid} should be valid");
        }
        for invalid in ["", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.x", "latest"] {
            assert!(!valid_version(invalid), "{invalid} should be invalid");
        }
    }

    #[test]
    fn the_node_path_drops_a_verbatim_prefix() {
        #[cfg(windows)]
        {
            assert_eq!(
                process_path(Path::new(r"\\?\C:\managed\runtime\node\node.exe")),
                PathBuf::from(r"C:\managed\runtime\node\node.exe")
            );
            assert_eq!(
                process_path(Path::new(r"\\?\UNC\server\share\app")),
                PathBuf::from(r"\\server\share\app")
            );
        }
        assert_eq!(process_path(Path::new(r"C:\managed")), PathBuf::from(r"C:\managed"));
    }
}