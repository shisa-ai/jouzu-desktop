// The console shares the app's modules rather than copying them, so a part the app uses and
// the console does not is not dead code: it is a part of the same source serving the other binary.
#![allow(dead_code)]

#[path = "../tool_script.rs"]
mod tool_script;
#[path = "../git_environment.rs"]
mod git_environment;
#[path = "../node_path.rs"]
mod node_path;
#[path = "../update_lock.rs"]
mod update_lock;
#[path = "../active_app.rs"]
mod active_app;
#[path = "../logs.rs"]
mod logs;
#[path = "../managed_paths.rs"]
mod runtime;
#[path = "../terminal.rs"]
mod terminal;
#[path = "../environment.rs"]
mod environment;
use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// A terminal that already draws the interface keeps the session. Anything else continues in Windows
/// Terminal, because the legacy console host damages a high-repaint interface and that is why the
/// installation carries a copy.
fn continue_in_host(wt_session: bool) -> bool {
    !wt_session
}

/// Which contract this copy answers. The app starts `console.exe` with the roots it resolved; a
/// copy named `jz` or `jouzu` is the terminal entry, which takes what the user typed. Any other name is
/// the app's own console.
fn entry_name(executable: &Path) -> Option<&'static str> {
    match executable.file_stem()?.to_str()?.to_ascii_lowercase().as_str() {
        "jz" => Some("jz"),
        "jouzu" => Some("jouzu"),
        _ => None,
    }
}

#[cfg(windows)]
fn bind_console() -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    unsafe extern "system" {
        fn SetStdHandle(which: u32, handle: *mut std::ffi::c_void) -> i32;
    }
    for (name, which, _read) in [
        ("CONIN$", -10i32, true),
        ("CONOUT$", -11, false),
        ("CONOUT$", -12, false),
    ] {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)?;
        if unsafe { SetStdHandle(which as u32, file.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        std::mem::forget(file);
    }
    Ok(())
}

/// The app's own console: it hands the roots it resolved, and the session stays visible in a
/// window that can hold its message open.
fn run_console(forwarded: &[OsString]) -> Result<i32, String> {
    let root = PathBuf::from(forwarded.first().ok_or("Missing application directory")?);
    let managed = match forwarded.get(1) {
        Some(value) => PathBuf::from(value),
        None => runtime::managed_root()?,
    };
    let _lease = update_lock::lock(&managed, false)?;
    let app = active_app::resolve_app(&root, &managed)?;
    let bash = git_environment::find(&root)?;
    logs::append(&managed, "session.log", &format!("start app={}", app.display()));
    let status = session(&root, &app, &bash).status().map_err(|e| e.to_string())?;
    let code = status.code().unwrap_or(1);
    logs::append(&managed, "session.log", &format!("end exit={code}"));
    Ok(code)
}

/// The terminal entry: the same session, started from a shell that keeps its prompt, with the
/// arguments the user typed forwarded to Jouzu.
fn run_entry(entry: &str, executable: &Path, forwarded: &[OsString], managed: &Path) -> Result<i32, String> {
    let root = executable.parent().ok_or("Cannot find the installation directory")?.to_path_buf();
    // The shell the user is in keeps the session when it draws the interface; otherwise the session
    // continues in Windows Terminal, in the window that is already open when there is one.
    if continue_in_host(std::env::var_os("WT_SESSION").is_some()) {
        if let Some(host) = terminal::host(&root) {
            continue_in(host, executable, forwarded)?;
            return Ok(0);
        }
    }
    let _lease = update_lock::lock(managed, false)?;
    let app = active_app::resolve_app(&root, managed)?;
    let bash = git_environment::find(&root)?;
    logs::append(managed, "session.log", &format!("start entry={entry} app={}", app.display()));
    let mut command = session(&root, &app, &bash);
    apply_saved_settings(&mut command, managed);
    let status = command.args(forwarded).status().map_err(|e| e.to_string())?;
    let code = status.code().unwrap_or(1);
    logs::append(managed, "session.log", &format!("end exit={code}"));
    Ok(code)
}

/// The session itself: the managed Node runs the slot's starter, which prepares Jouzu's home and hands
/// the arguments on. One command serves both contracts, so an entry behaves like the window.
fn session(root: &Path, app: &Path, bash: &Path) -> Command {
    let mut command = Command::new(root.join("runtime/node/node.exe"));
    command.arg(node_path::node_path(&app.join("bootstrap.mjs")));
    command.env("JOUZU_LAUNCHER_BASH", bash);
    command.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    command
}

/// The window applies the saved environment overrides to every session it starts, and a session started
/// from a terminal is one of those, so the same settings apply either way. The window's own session
/// already received them before this program started.
fn apply_saved_settings(command: &mut Command, managed: &Path) {
    if let Ok(home) = runtime::effective_home() {
        command.env("JOUZU_HOME", home);
    }
    if let Err(error) = environment::apply(command) {
        logs::append(managed, "session.log", &format!("environment overrides not applied error={error}"));
    }
}

/// The command line Windows Terminal is asked for: a tab in the window that is already open when there
/// is one, from the directory the user is standing in, running this entry with what it was given.
fn host_line(host: &Path, executable: &Path, directory: &Path, forwarded: &[OsString]) -> Command {
    let mut command = Command::new(host);
    command
        .args(["-w", "0", "new-tab", "--title", "Jouzu", "--startingDirectory"])
        .arg(directory)
        .arg("--")
        .arg(executable);
    command.args(forwarded);
    command
}

/// Continue this entry in the given host.
fn continue_in(host: PathBuf, executable: &Path, forwarded: &[OsString]) -> Result<(), String> {
    let directory = std::env::current_dir().map_err(|error| error.to_string())?;
    host_line(&host, executable, &directory, forwarded)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start {}: {error}", host.display()))
}

fn main() {
    #[cfg(windows)]
    let _ = bind_console();
    let executable = std::env::current_exe().ok();
    let entry = executable.as_deref().and_then(entry_name);
    let forwarded: Vec<OsString> = std::env::args_os().skip(1).collect();
    // The managed root may arrive as an argument or be the default location; the log line uses the
    // same path the session does.
    let managed_hint = if entry.is_some() {
        runtime::managed_root().ok()
    } else {
        forwarded.get(1).map(PathBuf::from).or_else(|| runtime::managed_root().ok())
    };
    let result = match (entry, executable.as_deref()) {
        (Some(name), Some(path)) => match managed_hint.clone() {
            Some(managed) => run_entry(name, path, &forwarded, &managed),
            None => Err("Missing managed directory".into()),
        },
        _ => run_console(&forwarded),
    };
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            if let Some(managed) = &managed_hint {
                logs::append(managed, "session.log", &format!("end exit=1 error={error}"));
            }
            eprintln!("Jouzu: {error}");
            1
        }
    };
    // A shell that started an entry gets its prompt back; the pause belongs to the window that would
    // otherwise close before its message was read.
    if entry.is_none() && code != 0 {
        eprintln!("Jouzu exited with code {code}. Press Enter to close.");
        let _ = io::stdin().read_line(&mut String::new());
    }
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_continuation_asks_for_a_tab_and_forwards_what_it_was_given() {
        let line = host_line(
            Path::new("C:/wt.exe"),
            Path::new("C:/app/jz.exe"),
            Path::new("C:/work"),
            &[OsString::from("--version")],
        );
        let arguments: Vec<String> = line
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            arguments,
            ["-w", "0", "new-tab", "--title", "Jouzu", "--startingDirectory", "C:/work", "--", "C:/app/jz.exe", "--version"]
        );
    }

    #[test]
    fn a_host_that_already_draws_the_interface_keeps_the_session() {
        assert!(continue_in_host(false));
        assert!(!continue_in_host(true));
    }

    #[test]
    fn a_copy_named_jz_or_jouzu_answers_the_terminal_contract() {
        assert_eq!(entry_name(Path::new("C:/app/jz.exe")), Some("jz"));
        assert_eq!(entry_name(Path::new("C:/app/Jouzu.exe")), Some("jouzu"));
        assert_eq!(entry_name(Path::new("C:/app/console.exe")), None);
        assert_eq!(entry_name(Path::new("C:/app/jouzu-desktop.exe")), None);
    }

}
