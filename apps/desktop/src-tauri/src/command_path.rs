//! The terminal command entry. The value lives in the user environment, so the script that owns it
//! reads and changes it; the app only asks and reports.

use crate::tool_script;
use std::path::{Path, PathBuf};

const SCRIPT: &str = "command-path.ps1";

/// The per-user directory the shim files live in, under the same root as the rest of the installation.
pub fn directory(managed: &Path) -> PathBuf {
    managed.join("bin")
}

fn ask(root: &Path, managed: &Path, action: &str, write: bool) -> Result<serde_json::Value, String> {
    crate::runtime_install::write_tool_scripts(managed)?;
    let mut arguments = vec![
        "-Directory".to_string(),
        directory(managed).to_string_lossy().into_owned(),
        "-Action".to_string(),
        action.to_string(),
    ];
    if write {
        arguments.push("-Write".to_string());
    }
    let install = crate::runtime::install_root()?;
    let output = tool_script::run_with_install_root(root, &install, SCRIPT, &arguments)?;
    if !output.status.success() {
        return Err(tool_script::failure(
            &output,
            "Cannot read the terminal command state",
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid terminal command state".to_string())
}

/// Where the entry stands, and what a shell started now would run.
pub fn report(root: &Path, managed: &Path) -> Result<serde_json::Value, String> {
    ask(root, managed, "Report", false)
}

/// The authorized action: Jouzu's entry answers before the command it supersedes.
pub fn use_jouzu(root: &Path, managed: &Path) -> Result<serde_json::Value, String> {
    ask(root, managed, "Precedence", true)
}

/// Repair the entry: the copies and the shim files are written again by the scripts the installer uses,
/// so a command that was deleted or damaged is restored without reinstalling anything.
pub fn repair(root: &Path, managed: &Path) -> Result<serde_json::Value, String> {
    let directory = directory(managed);
    // The helper already passes -InstallRoot, which the script takes once.
    let install = crate::runtime::install_root()?;
    let copies = crate::tool_script::run_with_install_root(root, &install, "command-entries.ps1", &[])?;
    if !copies.status.success() {
        return Err(crate::tool_script::failure(&copies, "Cannot restore the terminal command"));
    }
    let shims = crate::tool_script::run_with_install_root(
        root,
        &install,
        SCRIPT,
        &[
            "-Directory".to_string(),
            directory.to_string_lossy().into_owned(),
            "-Action".to_string(),
            "Install".to_string(),
        ],
    )?;
    if !shims.status.success() {
        return Err(crate::tool_script::failure(&shims, "Cannot restore the terminal command"));
    }
    report(root, managed)
}

/// Take the entry out of the user PATH: the names answer from wherever they did before this installation.
pub fn remove(root: &Path, managed: &Path) -> Result<serde_json::Value, String> {
    ask(root, managed, "Remove", true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_directory_sits_under_the_managed_root() {
        assert_eq!(
            directory(Path::new("C:/managed")),
            PathBuf::from("C:/managed/bin")
        );
    }
}
