#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artifacts;
mod attachments;
mod active_app;
mod launcher_script;
mod terminal;
mod git_environment;
mod logs;
mod bug_report;
mod command_path;
mod managed_paths;
mod migration;
mod host_bootstrap;
mod recovery;
mod runtime_install;
mod runtime_policy;
mod model_catalog;
mod node_path;
mod renderer;
mod update_lock;
mod jouzu_update;
mod environment;
mod runtime;
mod image_tool;
mod update_channel;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Environment {
    kind: String,
}
#[derive(Serialize, Deserialize)]
struct Workspace {
    id: String,
    path: String,
    environment: Environment,
}
#[derive(Serialize, Deserialize)]
struct LauncherState {
    platform: String,
    ready: bool,
    bash: bool,
    bundled_git: bool,
    recent: Vec<Workspace>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPreference {
    schema_version: u32,
    remember: bool,
    folder: String,
}

fn platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn legacy_workspace(content: &str) -> Result<Option<Workspace>, String> {
    let preference: LegacyPreference = serde_json::from_str(content.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Cannot read remembered folder: {error}"))?;
    if preference.schema_version != 1 {
        return Err("Unsupported folder preference version".into());
    }
    if !preference.remember || preference.folder.is_empty() {
        return Ok(None);
    }
    Ok(Some(Workspace {
        id: format!("windows:{}", preference.folder),
        path: preference.folder,
        environment: Environment {
            kind: "windows".into(),
        },
    }))
}

fn read_legacy(path: &Path) -> Result<Vec<Workspace>, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(format!("Cannot read folder preferences: {error}")),
    };
    Ok(legacy_workspace(&content)?.into_iter().collect())
}

#[tauri::command]
/// What the System section shows about the previous run and where support material lives.
fn diagnostics() -> Result<serde_json::Value, String> {
    let managed = runtime::managed_root()?;
    Ok(serde_json::json!({
        "logs": logs::directory(&managed).to_string_lossy(),
        "crashes": logs::crash_records(&managed),
    }))
}

#[tauri::command]
fn crash_dismiss(path: String) -> Result<(), String> {
    let managed = runtime::managed_root()?;
    logs::dismiss_crash(&managed, &path)
}

#[tauri::command]
/// Build the report draft with the payload's own reporter, and answer what the Launcher knows about this
/// installation when that reporter is not there.
fn bug_report(
    app: tauri::AppHandle,
    description: String,
    expected: String,
    actual: String,
    reproduction: String,
) -> Result<serde_json::Value, String> {
    Ok(
        bug_report::draft(&app, &description, &expected, &actual, &reproduction).unwrap_or_else(|_| {
            serde_json::json!({
                "available": false,
                "title": "",
                "body": "",
                "issueUrl": bug_report::ISSUE_NEW_URL,
            })
        }),
    )
}

#[tauri::command]
/// Open a terminal in a folder with the environment this installation manages, without starting Jouzu.
/// The session itself is built by the script the installer carries, so the window, a terminal entry and
/// this button describe one environment in one place.
fn terminal_open(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    // A terminal opens in the folder the launcher already has; without one it opens in the user's home
    // rather than asking, because a terminal does not need a folder to be useful.
    let folder = path
        .filter(|value| Path::new(value).is_dir())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(std::path::PathBuf::from))
        .ok_or("Cannot find a folder to open the terminal in.")?;
    let root = runtime::application_root(&app)?;
    let managed = runtime::managed_root()?;
    let slot = active_app::resolve_app(&root, &managed)?;
    let bash = git_environment::find(&managed)?;
    let host = terminal::host(&root)
        .ok_or("Windows Terminal is unavailable. Install it from the launcher.")?;
    let status = std::process::Command::new(crate::runtime_install::node_executable(&root))
        .arg(root.join("runtime/launcher-update/open-terminal.mjs"))
        .arg(&slot)
        .arg(&managed)
        .arg(&host)
        .arg(&bash)
        .arg(runtime::effective_home()?)
        .arg(&folder)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("The terminal could not be opened.".into());
    }
    Ok(())
}

#[tauri::command]
fn command_entry_report(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    command_path::report(&runtime::application_root(&app)?, &runtime::managed_root()?)
}

#[tauri::command]
fn command_entry_use(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    command_path::use_jouzu(&runtime::application_root(&app)?, &runtime::managed_root()?)
}

#[tauri::command]
fn command_entry_repair(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    command_path::repair(&runtime::application_root(&app)?, &runtime::managed_root()?)
}

#[tauri::command]
fn command_entry_remove(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    command_path::remove(&runtime::application_root(&app)?, &runtime::managed_root()?)
}

#[tauri::command]
/// The transcript owns the URL policy: only ordinary http(s) URLs without
/// embedded credentials leave the app, for any host.
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = external_http_url(&url)?;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(parsed.to_string(), None::<&str>)
        .map_err(|_| "Could not open link.".to_string())
}

fn external_http_url(value: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(value).map_err(|_| "This link cannot be opened externally.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("This link cannot be opened externally.".into());
    }
    Ok(parsed)
}

#[tauri::command]
/// The log folder is where a report's evidence lives; the folder opens, and the interface names no path.
fn open_logs(app: tauri::AppHandle) -> Result<(), String> {
    let directory = logs::directory(&runtime::managed_root()?);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(directory.to_string_lossy().to_string(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
/// The interface watches the Launcher's own update through a plugin, which no command sees, and a
/// silent check has to leave a trace somewhere, so both hand one line here.
fn log_event(message: String) -> Result<(), String> {
    logs::note(&runtime::managed_root()?, &message);
    Ok(())
}

fn default_workspace_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("The user profile is unavailable")?;
    let base = if cfg!(target_os = "windows") {
        std::path::PathBuf::from(home).join("Documents")
    } else {
        std::path::PathBuf::from(home)
    };
    let path = base.join("Jouzu").join("default-workspace");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
fn launcher_state(app: tauri::AppHandle) -> Result<LauncherState, String> {
    let history = runtime::managed_root()?.join("recent.json");
    let recent = if cfg!(target_os = "windows") {
        match std::env::var_os("LOCALAPPDATA") {
            Some(root) => {
                read_legacy(&Path::new(&root).join("JouzuDesktop").join("launcher.json"))?
            }
            None => vec![],
        }
    } else {
        vec![]
    };
    let mut recent: Vec<Workspace> = if history.exists() {
        serde_json::from_slice(&std::fs::read(&history).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Cannot read history: {e}"))?
    } else {
        recent
    };
    recent.retain(|workspace| Path::new(&workspace.path).is_dir());
    if recent.is_empty() {
        if let Ok(path) = default_workspace_path() {
            recent.push(Workspace {
                id: format!("{}:{}", platform(), path.display()),
                path: path.display().to_string(),
                environment: Environment { kind: platform().into() },
            });
            if let Ok(data) = runtime::managed_root() {
                let _ = std::fs::create_dir_all(&data);
                if let Ok(mut file) = tempfile::NamedTempFile::new_in(&data) {
                    if serde_json::to_writer(&mut file, &recent).is_ok() {
                        let _ = file.persist(data.join("recent.json"));
                    }
                }
            }
        }
    }
    Ok(LauncherState {
        platform: platform().into(),
        ready: runtime::application_root(&app).is_ok(),
        bash: runtime::find_bash(&app).is_some(),
        bundled_git: runtime::application_root(&app)
            .map(|root| root.join("runtime/git/PortableGit.exe").is_file())
            .unwrap_or(false),
        recent,
    })
}

#[tauri::command]
fn launch_jouzu(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if let Err(error) = runtime::launch(&app, &path) {
        if let Ok(managed) = runtime::managed_root() {
            logs::append(&managed, "launcher.log", &format!("launch failed folder={path} error={error}"));
        }
        return Err(error);
    }
    if let Ok(managed) = runtime::managed_root() {
        logs::append(&managed, "launcher.log", &format!("launch folder={path}"));
    }
    let mut state = launcher_state(app.clone())?;
    if !state.recent.iter().any(|item| item.path == path) {
        state.recent.push(Workspace {
            id: format!("{}:{}", platform(), path),
            path,
            environment: Environment {
                kind: platform().into(),
            },
        });
    }

    let data = runtime::managed_root()?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&data).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &state.recent).map_err(|e| e.to_string())?;
    file.persist(data.join("recent.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_workspaces(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > 1000 {
        return Err("Too many folders in one operation".into());
    }
    let mut state = launcher_state(app)?;
    for path in &paths {
        if !Path::new(path).is_dir() {
            return Err("Only existing folders can be added".into());
        }
    }
    for path in paths {
        let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if state.recent.iter().any(|item| {
            std::fs::canonicalize(&item.path)
                .map(|p| p == canonical)
                .unwrap_or(item.path == path)
        }) {
            continue;
        }
        state.recent.push(Workspace {
            id: format!("{}:{}", platform(), path),
            path,
            environment: Environment {
                kind: platform().into(),
            },
        });
    }
    let data = runtime::managed_root()?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&data).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &state.recent).map_err(|e| e.to_string())?;
    file.persist(data.join("recent.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn forget_workspace(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut state = launcher_state(app)?;
    state.recent.retain(|item| item.id != id);
    let data = runtime::managed_root()?;
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&data).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &state.recent).map_err(|e| e.to_string())?;
    file.persist(data.join("recent.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn hidden_node_version(node: &std::path::Path) -> Option<String> {
    let mut command = std::process::Command::new(node);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.output().ok().map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn runtime_report(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = runtime::application_root(&app)?;
    let managed = runtime::managed_root()?;
    let app_path = active_app::resolve_app(&root, &managed)?;
    let metadata: serde_json::Value = serde_json::from_slice(
        &std::fs::read(app_path.join("node_modules/jouzu/package.json"))
            .map_err(|_| "Runtime metadata is unavailable")?,
    )
    .map_err(|_| "Runtime metadata is invalid")?;
    let version = metadata
        .get("version")
        .and_then(|value| value.as_str())
        .ok_or("Runtime version is missing")?;
    Ok(serde_json::json!({
        "version": version,
        "expectedVersion": crate::runtime_install::expected_version(),
        "versionCurrent": crate::runtime_policy::is_current(version),
        "minimumVersion": crate::runtime_policy::MINIMUM_VERSION,
        "verifiedVersions": crate::runtime_policy::VERIFIED_VERSIONS,
        "mandatory": crate::runtime_policy::is_mandatory(version),
        "root": root.to_string_lossy(),
        "app": app_path.to_string_lossy(),
        "node": crate::runtime_install::node_executable(&root).is_file(),
        "nodeVersion": hidden_node_version(&crate::runtime_install::node_executable(&root)),
        "nodeCurrent": crate::runtime_install::node_version_ok(&root),
        "git": root.join("runtime/git").exists(),
        "terminal": root.join("runtime/terminal").exists(),
    }))
}

#[tauri::command]
fn model_catalog() -> Result<serde_json::Value, String> {
    crate::model_catalog::load()
}

#[tauri::command]
async fn runtime_install(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let managed = runtime::managed_root()?;
    // An update replaces node_modules underneath every live runtime. Stop the
    // sessions first; otherwise the old process keeps the old files mapped and
    // the user has to quit the whole app before a session can start again.
    host_bootstrap::stop_sessions()?;
    let handle = app.clone();
    let version = tauri::async_runtime::spawn_blocking(move || {
        let emit = |value: serde_json::Value| { let _ = tauri::Emitter::emit(&handle, "runtime-install-progress", value); };
        runtime_install::install(&managed, &emit)
    })
    .await
    .map_err(|_| "Runtime installation failed".to_string())??;
    Ok(serde_json::json!({ "version": version }))
}

#[tauri::command]
fn mcp_config() -> Result<serde_json::Value, String> {
    let path = runtime::effective_home()?.join("agent/mcp.json");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let value = serde_json::from_str::<serde_json::Value>(&text)
        .unwrap_or_else(|_| serde_json::json!({ "mcpServers": {} }));
    let servers = value
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(name, config)| {
                    let url = config.get("url").and_then(serde_json::Value::as_str);
                    let command = config.get("command").and_then(serde_json::Value::as_str);
                    let target = url.or(command).unwrap_or("Unknown target");
                    serde_json::json!({
                        "name": name,
                        "transport": if url.is_some() { "HTTP" } else if command.is_some() { "Local" } else { "Unknown" },
                        "target": target,
                        "description": config.get("description").and_then(serde_json::Value::as_str),
                        "exposure": config.get("exposure").and_then(serde_json::Value::as_str).unwrap_or("deferred"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "exists": path.is_file(),
        "servers": servers,
    }))
}

#[tauri::command]
fn component_versions(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // The updater flags describe the shell. A missing, broken or outdated runtime must not
    // disable them; that is the only way a broken install can still update itself.
    let launcher_updater = app
        .config()
        .plugins
        .0
        .get("updater")
        .map(|value| {
            value["pubkey"].as_str().is_some_and(|s| !s.is_empty())
                && value["endpoints"].as_array().is_some_and(|a| !a.is_empty())
        })
        .unwrap_or(false);
    let root = runtime::application_root(&app).ok();
    let value = root
        .as_ref()
        .and_then(|root| {
            let managed = runtime::managed_root().ok()?;
            active_app::resolve_app(root, &managed).ok()
        })
        .and_then(|path| std::fs::read(path.join("node_modules/jouzu/package.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or(serde_json::Value::Null);
    let jouzu_updater = root.as_ref().is_some_and(|root| {
        root.join("jouzu-update.json").is_file()
            && root.join("runtime/launcher-update/update-service.mjs").is_file()
    });
    Ok(serde_json::json!({
        "jouzuUpdaterConfigured": jouzu_updater,
        "jouzu": value.get("version").and_then(|v| v.as_str()),
        "development": cfg!(debug_assertions),
        "launcherUpdaterConfigured": launcher_updater,
        "build": env!("JOUZU_BUILD_ID"),
        "commit": env!("JOUZU_COMMIT"),
    }))
}

#[tauri::command]
fn console_repair_needed(app: tauri::AppHandle) -> Result<bool, String> {
    let root = runtime::application_root(&app)?;
    // The console is drawn by the terminal Jouzu ships, so a machine that does not have that copy yet
    // installs it before Jouzu starts, whatever terminal it already has.
    Ok(!terminal::bundled_copy(&root))
}

#[tauri::command]
fn terminal(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    terminal::report(&runtime::application_root(&app)?)
}

#[tauri::command]
async fn terminal_install(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = runtime::application_root(&app)?;
    let outcome = tauri::async_runtime::spawn_blocking(move || terminal::install(&root)).await;
    if let Ok(managed) = runtime::managed_root() {
        let result = match &outcome {
            Ok(Ok(path)) => format!("installed {}", path.display()),
            Ok(Err(error)) => format!("failed {error}"),
            Err(_) => "failed task".to_string(),
        };
        logs::append(&managed, "launcher.log", &format!("windows terminal install {result}"));
    }
    outcome.map_err(|_| "Windows Terminal installation failed".to_string())??;
    terminal::report(&runtime::application_root(&app)?)
}

#[tauri::command]
fn git_bash(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    git_environment::report(&runtime::application_root(&app)?)
}

#[tauri::command]
async fn git_bash_install(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = runtime::application_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || git_environment::install(&root))
        .await
        .map_err(|_| "Git Bash installation failed".to_string())??;
    git_environment::report(&runtime::application_root(&app)?)
}

/// The webview loads a development server when the frontend is not embedded, and a user runs no such
/// server. `--production-build-check` reports that state through the exit code, which the packaging
/// step refuses to accept.
fn production_build_check(mut arguments: impl Iterator<Item = String>) -> Option<i32> {
    arguments
        .any(|argument| argument == "--production-build-check")
        .then(|| i32::from(tauri::is_dev()))
}

fn main() {
    if let Some(code) = production_build_check(std::env::args()) {
        std::process::exit(code);
    }
    // A panic in the Launcher would otherwise close the window and leave nothing behind.
    if let Ok(managed) = runtime::managed_root() {
        logs::install_panic_hook(managed, env!("CARGO_PKG_VERSION"));
    }
    tauri::Builder::default()
        // The launcher is one window for one installation: a second start hands its wish to the window
        // that is open and leaves, so two launchers never work on the same update or the same session.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update_channel::Pending::default())
        .setup(|app| {
            migration::migrate_legacy_launcher_data()
                .map_err(std::io::Error::other)?;
            if let Ok(managed) = runtime::managed_root() {
                logs::append(
                    &managed,
                    "launcher.log",
                    &format!(
                        "launcher start version={} build={} commit={} channel={:?}",
                        env!("CARGO_PKG_VERSION"),
                        env!("JOUZU_BUILD_ID"),
                        env!("JOUZU_COMMIT"),
                        update_channel::read(&managed)
                    ),
                );
            }
            if let Ok(executable) = std::env::current_exe() {
                if let Ok(root) = runtime::install_root_for_executable(&executable) {
                    runtime::cleanup_superseded_executables(&root);
                }
            }
            let data = runtime::managed_root()
                .map_err(std::io::Error::other)?
                .join("cache/webview");
            std::fs::create_dir_all(&data)?;
            let host_url = host_bootstrap::start(app.handle()).map_err(|error| {
                if let Ok(managed) = runtime::managed_root() {
                    logs::append(
                        &managed,
                        "launcher.log",
                        &format!("host start failed: {error}"),
                    );
                }
                host_bootstrap::show_start_failure(&error);
                std::io::Error::other(error)
            })?;
            let host_url: url::Url = host_url
                .parse()
                .map_err(|error| std::io::Error::other(format!("Invalid host URL: {error}")))?;
            let host_base = {
                let mut base = host_url.clone();
                base.set_query(None);
                base.set_path("");
                base.to_string()
            };
            let host_token = host_url
                .query_pairs()
                .find(|(key, _)| key == "token")
                .map(|(_, value)| value.into_owned())
                .unwrap_or_default();
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("Missing window configuration")?;
            // The window loads the local build; the host is only the data API. The
            // endpoint and token are handed to the page before its own scripts run, so
            // the UI has one data source and needs no remote IPC permission.
            let endpoint_script = format!(
                "window.__JOUZU_HOST__ = {{ baseUrl: {}, token: {} }};",
                serde_json::to_string(&host_base)?,
                serde_json::to_string(&host_token)?
            );
            let window = tauri::WebviewWindowBuilder::from_config(app, config)?
                .data_directory(data)
                .initialization_script(&endpoint_script)
                .build()?;
            renderer::watch(&window, runtime::managed_root().ok());
            let close_window = window.clone();
            window.on_window_event(move |event| {
                // Closing hides the window: the runtime and its warm session stay alive in the tray.
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = close_window.hide();
                }
            });
            let show = tauri::menu::MenuItem::with_id(app, "show", "Show Jouzu", true, None::<&str>)?;
            let new_session = tauri::menu::MenuItem::with_id(app, "new", "New Session", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit Jouzu", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &new_session, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("Missing application icon")?;
            tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "new" => {
                        show_main(app);
                        let _ = tauri::Emitter::emit(app, "new-session", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            attachments::read_dropped_image,
            attachments::read_local_image,
            attachments::reveal_path,
            attachments::save_copy,
            attachments::workspace_list,
            attachments::workspace_snapshot,
            attachments::workspace_read,
            launcher_state,
            launch_jouzu,
            forget_workspace,
            add_workspaces,
            component_versions,
            update_channel::update_channel,
            update_channel::update_channel_set,
            update_channel::update_check,
            update_channel::update_install,
            model_catalog,
            runtime_report,
            runtime_install,
            mcp_config,
            image_tool::tools_settings_read,
            image_tool::tools_settings_save,
            image_tool::image_providers,
            image_tool::image_models,
            image_tool::image_tool_ensure,
            artifacts::artifact_list,
            artifacts::artifact_read,
            artifacts::artifact_delete,
            artifacts::artifact_store_copy,
            artifacts::artifact_counts,
            recovery::repair_jouzu,
            diagnostics,
            crash_dismiss,
            log_event,
            bug_report,
            terminal_open,
            open_logs,
            open_external_url,
            command_entry_report,
            command_entry_use,
            command_entry_remove,
            command_entry_repair,
            jouzu_update::jouzu_update,
                            terminal,
            terminal_install,
            git_bash,
            git_bash_install,
            console_repair_needed,
            environment::environment_read,
            environment::environment_save,

        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Jouzu Desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                host_bootstrap::stop(app);
            }
        });
}

fn show_main(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_remembered_folder() {
        let w = legacy_workspace(r#"{"schemaVersion":1,"remember":true,"folder":"project"}"#)
            .unwrap()
            .unwrap();
        assert_eq!(w.path, "project");
    }
    #[test]
    fn respects_forgetting() {
        assert!(
            legacy_workspace(r#"{"schemaVersion":1,"remember":false,"folder":"old"}"#)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn rejects_invalid_preferences() {
        assert!(legacy_workspace("not json").is_err());
        assert!(legacy_workspace(r#"{"schemaVersion":2,"remember":true,"folder":"x"}"#).is_err());
    }
    #[test]
    fn external_links_allow_any_http_host() {
        assert!(external_http_url("http://localhost:8100").is_ok());
        assert!(external_http_url("https://example.com/a?b=1").is_ok());
    }
    #[test]
    fn external_links_reject_other_schemes_and_credentials() {
        assert!(external_http_url("file:///C:/Windows/notepad.exe").is_err());
        assert!(external_http_url("javascript:alert(1)").is_err());
        assert!(external_http_url("https://user:pass@example.com/").is_err());
        assert!(external_http_url("http://").is_err());
    }
}

#[cfg(test)]
mod build_check_tests {
    use super::production_build_check;

    fn arguments(values: &[&str]) -> std::vec::IntoIter<String> {
        values
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn the_production_build_check_reports_the_embedded_frontend() {
        assert_eq!(
            production_build_check(arguments(&["jouzu-desktop.exe", "--production-build-check"])),
            Some(i32::from(tauri::is_dev()))
        );
        assert_eq!(production_build_check(arguments(&["jouzu-desktop.exe"])), None);
    }
}



