use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use serde_json::Value;
use tauri::Manager;

pub struct HostProcess(pub Mutex<Option<(Child, isize)>>);

/// Where this app's host listens and the token that opens its API. The host
/// hands the token only to this process (its first stdout line); it is never in
/// a file the agent's tools could read (#130).
static HOST_API: Mutex<Option<(u64, String)>> = Mutex::new(None);

pub fn start(app: &tauri::AppHandle) -> Result<String, String> {
    let managed = crate::runtime::managed_root()?;
    let runtime_home = crate::runtime::effective_home()?;
    let dist = dist_dir(app)?;
    let binary = host_binary(app)?;
    let info_path = managed.join("host.json");
    // A previous host may have left discovery behind. Never navigate to that
    // stale port while the new host is starting.
    let _ = std::fs::remove_file(&info_path);
    let mut command = Command::new(&binary);
    command
        .arg("--dist")
        .arg(&dist)
        .arg("--home")
        .arg(&managed)
        .arg("--runtime-home")
        .arg(&runtime_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The host is a console program; without this flag Windows opens an empty
    // console window next to the app.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the host: {error}"))?;
    let job = match create_job(child.id()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

    // The host's first stdout line says where it listens and gives the token.
    // Whatever it writes after that is read and dropped so it never blocks.
    let (ready, line) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let mut reader = BufReader::new(stdout);
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            let _ = ready.send(first);
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
    }
    let failed = |child: &mut Child, error: String| -> Result<String, String> {
        let _ = child.kill();
        let _ = child.wait();
        close_job(job);
        Err(error)
    };
    let first = match line.recv_timeout(Duration::from_secs(15)) {
        Ok(first) => first,
        Err(_) => return failed(&mut child, "The host did not start in time".into()),
    };
    let value = serde_json::from_str::<Value>(first.trim()).unwrap_or(Value::Null);
    let port = value.get("port").and_then(Value::as_u64);
    let token = value.get("token").and_then(Value::as_str).map(str::to_string);
    let (Some(port), Some(token)) = (port, token) else {
        return failed(&mut child, "The host stopped before it was ready".into());
    };
    if let Err(error) = check_build(value.get("build").and_then(Value::as_str)) {
        return failed(&mut child, error);
    }
    *HOST_API.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((port, token.clone()));
    app.manage(HostProcess(Mutex::new(Some((child, job)))));
    Ok(format!("http://127.0.0.1:{port}/?token={token}"))
}

pub fn stop(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<HostProcess>() {
        let mut child = state
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some((child, job)) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
            close_job(*job);
        }
    }
}

#[cfg(windows)]
fn create_job(pid: u32) -> Result<isize, String> {
    use std::mem::size_of;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        let job = CreateJobObjectW(None, None)
            .map_err(|error| format!("Could not create the host job: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|error| format!("Could not configure the host job: {error}"))?;
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
            .map_err(|error| format!("Could not open the host process: {error}"))?;
        let assigned = AssignProcessToJobObject(job, process);
        let _ = CloseHandle(process);
        assigned.map_err(|error| format!("Could not assign the host to its job: {error}"))?;
        Ok(job.0 as isize)
    }
}

#[cfg(windows)]
fn close_job(job: isize) {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    unsafe {
        let _ = CloseHandle(HANDLE(job as *mut std::ffi::c_void));
    }
}

#[cfg(not(windows))]
fn create_job(_pid: u32) -> Result<isize, String> {
    Ok(0)
}

#[cfg(not(windows))]
fn close_job(_job: isize) {}

/// The app cannot open without its host, and it closes as soon as setup fails,
/// so say why in a native message box rather than vanishing.
#[cfg(windows)]
pub fn show_start_failure(message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let text = wide(message);
    let caption = wide("Jouzu Desktop could not start");
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(caption.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
pub fn show_start_failure(message: &str) {
    eprintln!("Jouzu Desktop could not start: {message}");
}

/// The UI the host serves. A development build serves the repository's `dist`;
/// a release serves only the copy installed with it, so it never picks up
/// whatever happens to be built on the machine that compiled it.
fn dist_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
        if dev.join("index.html").is_file() {
            return Ok(dev);
        }
    }
    let installed = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("dist");
    if installed.join("index.html").is_file() {
        return Ok(installed);
    }
    Err("This installation has no UI files. Reinstall Jouzu Desktop.".into())
}

/// A release shell runs only the host built with it (see scripts/build-app.mjs).
/// A host from another build speaks an older contract and fails in ways that
/// look like ordinary bugs, so refuse it plainly instead.
fn check_build(host_build: Option<&str>) -> Result<(), String> {
    let expected = env!("JOUZU_BUILD_ID");
    if cfg!(debug_assertions) || expected == "dev" {
        return Ok(());
    }
    match host_build {
        Some(found) if found == expected => Ok(()),
        found => Err(format!(
            "This installation is mixed: the app is build {expected} but its host is build {}. Reinstall Jouzu Desktop.",
            found.unwrap_or("unknown")
        )),
    }
}

fn host_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("JOUZU_HOST_BIN") {
        if Path::new(&value).is_file() {
            return Ok(PathBuf::from(value));
        }
    }
    #[cfg(debug_assertions)]
    {
        // cargo names the binary `jouzu-host` on Unix and `jouzu-host.exe`
        // on Windows; prefer the platform name so a stale copy under the
        // other name can never shadow a fresh build.
        let debug = Path::new(env!("CARGO_MANIFEST_DIR")).join("../host/target/debug");
        let names = if cfg!(windows) {
            ["jouzu-host.exe", "jouzu-host"]
        } else {
            ["jouzu-host", "jouzu-host.exe"]
        };
        for name in names {
            let dev = debug.join(name);
            if dev.is_file() {
                return Ok(dev);
            }
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        let packaged = resource.join("host/jouzu-host.exe");
        if packaged.is_file() {
            return Ok(packaged);
        }
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            let beside = parent.join("jouzu-host.exe");
            if beside.is_file() {
                return Ok(beside);
            }
        }
    }
    Err("Could not find jouzu-host.exe".into())
}

/// Ask the running host to stop every session before an update swaps the runtime.
pub fn stop_sessions() -> Result<(), String> {
    let (port, token) = HOST_API
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .ok_or("The host is not running.")?;
    reqwest::blocking::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/sessions/stop-all"))
        .bearer_auth(token)
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    Ok(())
}
