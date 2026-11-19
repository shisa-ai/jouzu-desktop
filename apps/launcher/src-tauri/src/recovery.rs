use std::{path::Path, process::Command};

pub fn restore_bundled(root: &Path, managed: &Path) -> Result<(), String> {
    let _lease = crate::update_lock::lock(managed, true)?;
    let updates = managed.join("updates");
    if updates.join("operation.lock").exists() {
        return Err("An update is active or interrupted. Restart Jouzu Desktop and retry after the update process exits.".into());
    }
    let app = root.join("app");
    let metadata: serde_json::Value = serde_json::from_slice(
        &std::fs::read(app.join("node_modules/jouzu/package.json")).map_err(|_| "Bundled Jouzu is unavailable. Repair the installation.")?
    ).map_err(|_| "Bundled Jouzu metadata is invalid")?;
    let version = metadata["version"].as_str().ok_or("Missing bundled version")?;
    let mut command = Command::new(crate::runtime_install::node_executable(&root));
    command.arg("--input-type=module").arg("--eval")
        .arg("import {pathToFileURL} from 'node:url'; const [script,app,version]=process.argv.slice(1); const {checkStagedHealth}=await import(pathToFileURL(script)); await checkStagedHealth({node:process.execPath,app,version});")
        .arg(crate::node_path::node_path(&root.join("runtime/launcher-update/check-update-health.mjs")))
        .arg(crate::node_path::node_path(&app)).arg(version)
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let output = command.output().map_err(|_| "Cannot check bundled Jouzu")?;
    if !output.status.success() {return Err("Bundled Jouzu failed its startup check. Repair the installation.".into());}
    let active = updates.join("active.json");
    if active.exists() {
        let mut backup = tempfile::NamedTempFile::new_in(&updates).map_err(|_| "Cannot preserve recovery record")?;
        let bytes = std::fs::read(&active).map_err(|_| "Cannot read selected version")?;
        use std::io::Write;
        backup.write_all(&bytes).map_err(|_| "Cannot preserve selected version")?;
        backup.persist(updates.join("recovery.json")).map_err(|_| "Cannot preserve selected version")?;
        std::fs::remove_file(active).map_err(|_| "Cannot restore bundled version")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn repair_jouzu(app: tauri::AppHandle) -> Result<(), String> {
    let root = crate::runtime::application_root(&app)?;
    let managed = crate::runtime::managed_root()?;
    let log = managed.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || restore_bundled(&root, &managed))
        .await
        .map_err(|_| "Recovery task failed".to_string())?;
    let result = match &outcome {
        Ok(()) => "restored the bundled version".to_string(),
        Err(error) => format!("failed {error}"),
    };
    crate::logs::append(&log, "launcher.log", &format!("restore bundled Jouzu {result}"));
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_bundle_preserves_selection_and_user_data() {
        let dir = tempfile::tempdir().unwrap();
        let managed = dir.path().join("managed");
        std::fs::create_dir_all(managed.join("updates")).unwrap();
        std::fs::create_dir_all(managed.join("data")).unwrap();
        let selection = managed.join("updates/active.json");
        std::fs::write(&selection, "broken selection").unwrap();
        std::fs::write(managed.join("data/settings.json"), "user settings").unwrap();
        assert!(restore_bundled(&dir.path().join("absent"), &managed).is_err());
        assert_eq!(std::fs::read_to_string(selection).unwrap(), "broken selection");
        assert_eq!(std::fs::read_to_string(managed.join("data/settings.json")).unwrap(), "user settings");
    }
    #[test]
    fn interrupted_transaction_is_not_deleted_by_recovery() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("updates")).unwrap();
        let lock = dir.path().join("updates/operation.lock");
        std::fs::write(&lock, "owner").unwrap();
        assert!(restore_bundled(dir.path(), dir.path()).unwrap_err().contains("interrupted"));
        assert_eq!(std::fs::read_to_string(lock).unwrap(), "owner");
    }
}

