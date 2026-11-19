use std::{path::Path, path::PathBuf};

use crate::tool_script;

const SCRIPT: &str = "terminal-environment.ps1";

/// Whether the copy Jouzu ships is installed under this root.
pub fn bundled_copy(root: &Path) -> bool {
    root.join("runtime/terminal/installed/WindowsTerminal.exe").is_file()
}

/// The Windows Terminal that should host the console: the copy Jouzu ships once it is installed,
/// otherwise the one this PC has. Nothing here means the standard console host.
pub fn host(root: &Path) -> Option<PathBuf> {
    let output = tool_script::run(root, SCRIPT, &[]).ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    path.is_file().then_some(path)
}

/// What the interface shows: which copies exist, which one is used, whether the archive is here, and
/// whether this Windows draws the console with the host that damages the interface.
pub fn report(root: &Path) -> Result<serde_json::Value, String> {
    let output = tool_script::run(root, SCRIPT, &["-Report".to_string()])?;
    if !output.status.success() {
        return Err(tool_script::failure(&output, "Cannot read the Windows Terminal state"));
    }
    // The script resolves the copies and reports which one is used; nothing here re-decides it.
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid Windows Terminal state".to_string())?;
    Ok(value)
}

/// Installs the bundled Windows Terminal: the shipped archive when it is present, otherwise the
/// pinned release from the terminal repository, verified by digest before extraction.
pub fn install(root: &Path) -> Result<PathBuf, String> {
    let output = tool_script::run(root, SCRIPT, &["-Install".to_string()])?;
    tool_script::printed_path(&output, "Windows Terminal installation failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_without_the_helper_reports_no_host_instead_of_panicking() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(host(directory.path()), None);
        assert!(!bundled_copy(directory.path()));
    }
}
