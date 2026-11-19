use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

/// The helpers are part of this build, not of the installed runtime: each run writes the copy this
/// binary carries before starting it, so an updated app never runs a helper an older version left
/// behind, and an installation from before the folder had this name needs no repair.
const SCRIPTS: [(&str, &str); 5] = [
    ("git-environment.ps1", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/git-environment.ps1"))),
    ("extract-portable-git.ps1", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/extract-portable-git.ps1"))),
    ("terminal-environment.ps1", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/terminal-environment.ps1"))),
    ("command-path.ps1", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/command-path.ps1"))),
    ("command-entries.ps1", include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packaging/desktop/command-entries.ps1"))),
];

/// Where the helpers live under a runtime root.
pub fn directory(runtime_root: &Path) -> PathBuf {
    runtime_root.join("runtime").join("desktop-tools")
}

/// Write every helper this build carries. A file that already holds the same text is left alone, so
/// the window and the console never rewrite a helper the other one is running.
pub fn write_all(runtime_root: &Path) -> Result<(), String> {
    let directory = directory(runtime_root);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for (name, body) in SCRIPTS {
        let path = directory.join(name);
        if std::fs::read(&path).ok().as_deref() != Some(body.as_bytes()) {
            std::fs::write(&path, body).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Runs a packaged PowerShell helper, which owns every Windows-specific detail of that component:
/// which trees are usable, which versions they report, and how a bundled archive is verified.
pub fn run(root: &Path, script: &str, arguments: &[String]) -> Result<Output, String> {
    run_with_install_root(root, root, script, arguments)
}

/// The script lives under the runtime root, but the executables it manages
/// (console.exe and its copies) live beside the binary; on a split install these are
/// different drives. Only the command-entry helpers need the second root.
pub fn run_with_install_root(
    runtime_root: &Path,
    install_root: &Path,
    script: &str,
    arguments: &[String],
) -> Result<Output, String> {
    write_all(runtime_root)?;
    let windows = std::env::var_os("SystemRoot").ok_or("Windows directory unavailable")?;
    let mut command =
        Command::new(PathBuf::from(windows).join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    // Windows PowerShell must resolve its own modules. A caller started from PowerShell 7
    // carries that version's module path, where Windows PowerShell's Security module fails
    // to load; removing it lets the helper use its default module path.
    command.env_remove("PSModulePath");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(directory(runtime_root).join(script))
        .arg("-InstallRoot")
        .arg(install_root);
    for argument in arguments {
        command.arg(argument);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .output()
        .map_err(|_| "Cannot run a desktop helper".to_string())
}

/// PowerShell puts the message the script printed first, and its own frames after it.
pub fn failure(output: &Output, fallback: &str) -> String {
    let text = String::from_utf8_lossy(&output.stderr);
    text.lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with("At ")
                && !line.starts_with('+')
                && !line.starts_with("CategoryInfo")
                && !line.starts_with("FullyQualifiedErrorId")
        })
        .unwrap_or(fallback)
        .to_string()
}

/// Reads the path a helper printed, failing when it is not a file.
pub fn printed_path(output: &Output, message: &str) -> Result<PathBuf, String> {
    if !output.status.success() {
        return Err(failure(output, message));
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if !path.is_file() {
        return Err(message.to_string());
    }
    Ok(path)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    static ENVIRONMENT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A caller started from PowerShell 7 carries a module path Windows PowerShell cannot use.
    /// Helpers that need a Windows PowerShell module must still run.
    #[test]
    fn helpers_load_windows_powershell_modules_despite_the_callers_module_path() {
        let _guard = ENVIRONMENT.lock().unwrap();
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("runtime/desktop-tools");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("probe.ps1"),
            "(Get-Command Get-AuthenticodeSignature).Name",
        )
        .unwrap();
        let previous = std::env::var_os("PSModulePath");
        std::env::set_var("PSModulePath", r"C:\does-not-exist");
        let output = run(root.path(), "probe.ps1", &[]);
        match previous {
            Some(value) => std::env::set_var("PSModulePath", value),
            None => std::env::remove_var("PSModulePath"),
        }
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "Get-AuthenticodeSignature"
        );
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;

    /// An installation from before this folder existed has no helpers in it; the first run writes
    /// them, and a helper an older build left behind is replaced by the copy this build carries.
    #[test]
    fn every_helper_is_written_and_a_stale_one_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        write_all(root.path()).unwrap();
        for (name, body) in SCRIPTS {
            assert_eq!(std::fs::read_to_string(directory(root.path()).join(name)).unwrap(), body);
        }
        let stale = directory(root.path()).join("git-environment.ps1");
        std::fs::write(&stale, "old").unwrap();
        write_all(root.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&stale).unwrap(), SCRIPTS[0].1);
    }
}
