use std::{
    path::{Path, PathBuf},
    process::Command,
};

// The paths an installation resolves live on their own, so the console binary and a terminal entry
// read the same installation without pulling in the window.
pub use crate::managed_paths::{effective_home, managed_root};

/// Leftovers from replacing a running app executable are deleted once no session
/// holds them; anything still in use stays until a later start.
pub fn cleanup_superseded_executables(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.contains(".old-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub fn install_root_for_executable(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Executable has no parent directory".into())
}

/// A root is usable when the provisioned runtime and app are both there.
fn usable(root: &Path) -> bool {
    crate::runtime_install::node_executable(&root).is_file() && root.join("app/bootstrap.mjs").is_file()
}

/// Where the runtime lives. The desktop release carries no runtime (ADR 0003), so a normal
/// install keeps it under the managed root, which can be on a different drive than the
/// executable. A bundled app keeps it beside the executable; dev names its own root.
/// The directory the executable lives in; the console and its copies belong here.
pub fn install_root() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    install_root_for_executable(&executable)
}

pub fn application_root(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let install = install_root_for_executable(&executable)?;
    let mut candidates = Vec::new();
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("JOUZU_DESKTOP_DEV_RUNTIME") {
        candidates.push(PathBuf::from(root));
    }
    if let Ok(managed) = managed_root() {
        candidates.push(managed);
    }
    candidates.push(install);
    pick_root(candidates)
}

fn pick_root(candidates: Vec<PathBuf>) -> Result<PathBuf, String> {
    candidates
        .into_iter()
        .find(|root| usable(root))
        .ok_or_else(|| "Jouzu application files are missing. Please repair the installation.".into())
}

pub fn find_bash(_app: &tauri::AppHandle) -> Option<PathBuf> {
    let root = managed_root().ok()?;
    crate::git_environment::find(&root).ok()
}

pub fn launch(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    if !Path::new(path).is_dir() {
        return Err("This folder is unavailable. Choose another folder.".into());
    }
    let root = application_root(app)?;
    let bash = find_bash(app)
        .ok_or("Git Bash is missing. Repair the Jouzu installation.")?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let console = executable.with_file_name("console.exe");
    let managed = managed_root()?;
    // The console window's host decides how the terminal redraws. Windows Terminal renders it
    // correctly where the legacy console host damages a high-repaint interface, so it hosts the
    // window whenever one is available; otherwise the window keeps the standard console host.
    let mut command = match terminal_host(&root, path) {
        Some(host) => {
            let mut command = Command::new(host);
            command
                .args(["-w", "new", "new-tab", "--title", "Jouzu", "--startingDirectory", path, "--"])
                .arg(&console)
                .arg(&root)
                .arg(&managed);
            command
        }
        None => {
            let mut command = Command::new(&console);
            command.arg(&root).arg(&managed);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x00000010);
            }
            command
        }
    };
    command.env("JOUZU_HOME", effective_home()?);
    crate::environment::apply(&mut command)?;
    command.current_dir(path).env("JOUZU_LAUNCHER_BASH", bash);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Jouzu: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Windows Terminal treats a semicolon as a command separator, so a path carrying one keeps the
/// standard console host instead of being split into separate arguments.
fn terminal_host(root: &Path, project: &str) -> Option<PathBuf> {
    if root.to_string_lossy().contains(';') || project.contains(';') {
        return None;
    }
    crate::terminal::host(root)
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    #[test]
    fn removes_superseded_executables_but_keeps_others() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("console.exe"), "current").unwrap();
        std::fs::write(dir.path().join("console.exe.old-abc"), "superseded").unwrap();
        std::fs::write(dir.path().join("jouzu-desktop.exe.old-1"), "superseded").unwrap();
        cleanup_superseded_executables(dir.path());
        assert!(dir.path().join("console.exe").is_file());
        assert!(!dir.path().join("console.exe.old-abc").exists());
        assert!(!dir.path().join("jouzu-desktop.exe.old-1").exists());
    }
}

#[cfg(test)]
mod root_tests {
    use super::*;

    #[test]
    fn picks_the_root_that_holds_the_runtime() {
        let empty = tempfile::tempdir().unwrap();
        let provisioned = tempfile::tempdir().unwrap();
        let node = crate::runtime_install::node_executable(provisioned.path());
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(node, b"node").unwrap();
        std::fs::create_dir_all(provisioned.path().join("app")).unwrap();
        std::fs::write(provisioned.path().join("app/bootstrap.mjs"), b"bootstrap").unwrap();
        assert_eq!(
            pick_root(vec![empty.path().to_path_buf(), provisioned.path().to_path_buf()]).unwrap(),
            provisioned.path()
        );
        assert!(pick_root(vec![empty.path().to_path_buf()]).is_err());
    }
}

#[cfg(test)]
mod path_tests {
    use super::*;
    #[test]
    fn program_location_follows_executable_not_default_data_root() {
        let directory = std::env::temp_dir().join("custom Jouzu install");
        assert_eq!(
            install_root_for_executable(&directory.join("jouzu-desktop.exe")).unwrap(),
            directory
        );
    }
}



