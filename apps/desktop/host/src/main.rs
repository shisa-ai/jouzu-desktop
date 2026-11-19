use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::ExitCode,
    time::Instant,
};

use jouzu_host::{
    host_home, log, new_token, remove_host_file, router, session::find_bash, session::RuntimeSpec,
    session::SessionManager, write_host_file, AppState, HostLock,
};
use serde_json::json;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn arg_values(args: &[String], name: &str) -> Vec<String> {
    args.iter()
        .enumerate()
        .filter(|(_, value)| value.as_str() == name)
        .filter_map(|(index, _)| args.get(index + 1).cloned())
        .collect()
}

/// The Jouzu home: `JOUZU_HOME` when set, else `data` under the host home, the
/// location every Desktop release since 1.0 has used. It must stay where it is
/// and is never copied: a session only continues in the home it was created in
/// (#112).
fn jouzu_home(home: &std::path::Path, user: Option<std::ffi::OsString>) -> PathBuf {
    user.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("data"))
}

fn usage() {
    eprintln!(
        "jouzu-host — runtime host phase 1\n\n\
         Usage: jouzu-host [--dist <path>] [--home <path>]\n\n\
         --dist  built SPA directory (default: ./dist)\n\
         --home  directory for host.json and logs (default: JOUZU_HOST_HOME,\n\
                 then %LOCALAPPDATA%\\Shisa.ai\\JouzuDesktop)"
    );
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|value| value == "--help" || value == "-h") {
        usage();
        return ExitCode::SUCCESS;
    }

    let dist = PathBuf::from(arg_value(&args, "--dist").unwrap_or_else(|| "dist".to_string()));
    let dist = match dist.canonicalize() {
        Ok(path) if path.join("index.html").is_file() => path,
        Ok(path) => {
            eprintln!("dist has no index.html: {}", path.display());
            return ExitCode::FAILURE;
        }
        Err(error) => {
            eprintln!("dist is unavailable ({}): {error}", dist.display());
            return ExitCode::FAILURE;
        }
    };

    let home = match arg_value(&args, "--home") {
        Some(path) => PathBuf::from(path),
        None => match host_home() {
            Ok(path) => path,
            Err(error) => {
                eprintln!("host home is unavailable: {error}");
                return ExitCode::FAILURE;
            }
        },
    };
    if let Err(error) = std::fs::create_dir_all(&home) {
        eprintln!("cannot create host home ({}): {error}", home.display());
        return ExitCode::FAILURE;
    }

    // One live host per home. Refuse before binding or touching host.json.
    let _lock = match HostLock::acquire(&home) {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    // The shell passes the Jouzu home; on its own the host resolves it the same way.
    let runtime_home = arg_value(&args, "--runtime-home")
        .map(PathBuf::from)
        .unwrap_or_else(|| jouzu_home(&home, std::env::var_os("JOUZU_HOME")));
    // The installation (Node, app, Git) lives under the host home, wherever
    // Jouzu's data is.
    let managed = home.clone();
    // An explicit `--runtime` is used as given. Otherwise the runtime is the
    // managed install, which the desktop's first-run preparation creates after
    // this host has started: it is looked for on use, not decided here (#87).
    let runtime = arg_value(&args, "--runtime").map(|program| RuntimeSpec {
        program: PathBuf::from(program),
        args: arg_values(&args, "--runtime-arg"),
        env: Vec::new(),
    });
    let bash = arg_value(&args, "--bash").map(PathBuf::from);
    let install = arg_value(&args, "--install")
        .map(PathBuf::from)
        .unwrap_or_else(|| managed.clone());
    let events = jouzu_host::events::EventHub::new();
    let control_node = runtime
        .as_ref()
        .map(|spec| spec.program.clone())
        .unwrap_or_else(|| RuntimeSpec::managed_node(&managed));
    let control = match jouzu_host::control::ControlManager::new(
        &install,
        &managed,
        Some(control_node),
        &runtime_home,
        Some(events.clone()),
    ) {
        Ok(manager) => std::sync::Arc::new(manager),
        Err(error) => {
            eprintln!("control is unavailable: {error}");
            return ExitCode::FAILURE;
        }
    };
    let sessions = std::sync::Arc::new(match runtime {
        Some(spec) => SessionManager::new(
            Some(spec),
            home.clone(),
            runtime_home,
            bash.or_else(|| find_bash(&managed)),
            jouzu_host::session::DEFAULT_REPLAY_LIMIT,
            Some(events.clone()),
        ),
        None => SessionManager::managed(
            managed.clone(),
            home.clone(),
            runtime_home,
            bash,
            jouzu_host::session::DEFAULT_REPLAY_LIMIT,
            Some(events.clone()),
        ),
    });
    // Start a runtime now, while the window shows loading, not when the user
    // sends the first message.
    sessions.enable_warm_runtime();
    {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            // A session nobody shows gives its runtime back within about a
            // minute: reopening it takes a warm runtime for its folder (a switch
            // of about a second), while every runtime kept costs ~150 MB (#93).
            // A new session never started holds no runtime and waits longer; a
            // window whose stream dropped (sleep) keeps its session (#111).
            let limits = jouzu_host::session::IdleLimits {
                idle: std::time::Duration::from_secs(60),
                pending: std::time::Duration::from_secs(15 * 60),
                released_hold: std::time::Duration::from_secs(15 * 60),
            };
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                sessions.reap_idle(limits);
            }
        });
    }

    let token = new_token();
    let listener =
        match tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("cannot bind 127.0.0.1: {error}");
                return ExitCode::FAILURE;
            }
        };
    let port = match listener.local_addr() {
        Ok(address) => address.port(),
        Err(error) => {
            eprintln!("cannot read the bound port: {error}");
            return ExitCode::FAILURE;
        }
    };

    if let Err(error) = write_host_file(&home, port, VERSION) {
        eprintln!("cannot write host.json: {error}");
        return ExitCode::FAILURE;
    }
    log(
        &home,
        "info",
        "host.start",
        json!({ "port": port, "pid": std::process::id(), "dist": dist.to_string_lossy(), "version": env!("CARGO_PKG_VERSION"), "build": jouzu_host::BUILD_ID, "commit": jouzu_host::COMMIT }),
    );
    // The token is handed to whoever started the host, here and nowhere else (#130).
    println!("{}", jouzu_host::ready_line(port, &token));

    let state = AppState {
        token: std::sync::Arc::new(token.clone()),
        port,
        dist,
        started: Instant::now(),
        version: VERSION.to_string(),
        sessions: sessions.clone(),
        control,
        events,
        web: std::sync::Arc::new(jouzu_host::web_access::WebAccess::load(&home)),
    };
    // A configuration change reaches new sessions through a fresh warm runtime.
    // Live sessions keep what they started with until the runtime can reload (G2).
    {
        let sessions = sessions.clone();
        state.control.on_change(move || jouzu_host::recycle_warm_runtime(&sessions));
    }
    // Settings show what replies said about each provider's sign-in.
    state.control.watch_providers(sessions.providers());
    state.control.start();
    // Web access listeners follow the saved scope; addresses can change (DHCP,
    // Tailscale reconnect), so re-check them periodically.
    jouzu_host::reconcile_web_access(&state).await;
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                jouzu_host::reconcile_web_access(&state).await;
            }
        });
    }
    let app = router(state);

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;

    sessions.shutdown();
    remove_host_file(&home, port);
    log(
        &home,
        "info",
        "host.stop",
        json!({ "port": port, "result": if result.is_ok() { "ok" } else { "error" } }),
    );
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("host stopped with an error: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Existing sessions live here. Moving the default strands them (#112).
    #[test]
    fn the_default_jouzu_home_is_data_under_the_host_home() {
        let home = PathBuf::from("C:/Shisa.ai/JouzuDesktop");
        assert_eq!(jouzu_home(&home, None), home.join("data"));
        assert_eq!(jouzu_home(&home, Some("".into())), home.join("data"));
    }

    #[test]
    fn a_user_jouzu_home_is_followed() {
        let home = PathBuf::from("C:/Shisa.ai/JouzuDesktop");
        assert_eq!(jouzu_home(&home, Some("D:/jouzu".into())), PathBuf::from("D:/jouzu"));
    }
}
