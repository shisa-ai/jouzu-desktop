use std::path::{Path, PathBuf};

/// Runs the Git Bash helper through the shared runner.
#[cfg(windows)]
fn helper_with(root: &Path, arguments: &[String]) -> Result<std::process::Output, String> {
    crate::tool_script::run(root, "git-environment.ps1", arguments)
}

/// What the interface needs: which sources exist, their versions, which one is chosen and which one
/// would be used. Nothing here uses a system Git on its own.
#[cfg(windows)]
pub fn report(root: &Path) -> Result<serde_json::Value, String> {
    let output = helper_with(root, &["-Report".to_string()])?;
    if !output.status.success() {
        return Err(crate::tool_script::failure(&output, "Cannot read the Git Bash state"));
    }
    let mut value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "Invalid Git Bash state")?;
    // Jouzu's own copies first, then the one this PC has, so a machine with its own Git Bash keeps
    // working while the copy the app is qualified against stays the one it installs.
    value["effective"] = if !value["bundled"].is_null() {
        value["bundled"].clone()
    } else if !value["managed"].is_null() {
        value["managed"].clone()
    } else {
        value["system"].clone()
    };
    Ok(value)
}

/// The bash to launch Jouzu with. On Windows it comes from the managed helper, which
/// never silently uses a system Git; elsewhere the platform's own bash is the runtime.
pub fn find(root: &Path) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        let _ = root;
        for candidate in ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"] {
            let path = PathBuf::from(candidate);
            if path.is_file() && std::process::Command::new(&path).args(["-lc", "exit 0"]).status().map(|status| status.success()).unwrap_or(false) {
                return Ok(path);
            }
        }
        return Err("Bash is unavailable. Install it to run Jouzu.".into());
    }
    #[cfg(windows)]
    {
        let output = helper_with(root, &[])?;
        if !output.status.success() {
            return Err(crate::tool_script::failure(&output, "Git Bash is unavailable. Install it in Settings → System."));
        }
        let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if !path.is_file() {
            return Err("Git Bash detection returned an invalid path".into());
        }
        Ok(path)
    }
}

/// Installs Jouzu's Git Bash: the bundled archive when it is present, otherwise the pinned
/// git-for-windows release, verified by digest and publisher before it is extracted.
#[cfg(windows)]
pub fn install(root: &Path) -> Result<PathBuf, String> {
    let output = helper_with(root, &["-Install".to_string()])?;
    if !output.status.success() {
        return Err(crate::tool_script::failure(&output, "Git Bash installation failed"));
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if !path.is_file() {
        return Err("Git Bash installation did not produce a usable path".into());
    }
    Ok(path)
}

/// Other platforms use their own bash, so the row reports that copy instead of managing one.
#[cfg(not(windows))]
pub fn report(root: &Path) -> Result<serde_json::Value, String> {
    let bash = find(root)?;
    let directory = bash
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mut command = std::process::Command::new("git");
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let git = command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default();
    let environment = serde_json::json!({
        "path": directory.to_string_lossy(),
        "git": git,
        "bash": bash.to_string_lossy(),
    });
    Ok(serde_json::json!({
        "bundled": null,
        "managed": null,
        "system": environment.clone(),
        "bundled_present": false,
        "managed_present": false,
        "system_present": true,
        "archive": false,
        "effective": environment,
    }))
}

#[cfg(not(windows))]
pub fn install(_root: &Path) -> Result<PathBuf, String> {
    Err("Jouzu uses this platform's bash; there is nothing to install.".into())
}

