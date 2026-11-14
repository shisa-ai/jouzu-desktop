use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
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
    let runtime_home = arg_value(&args, "--runtime-home")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("data"));
    let managed = runtime_home
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.clone());
    let runtime = arg_value(&args, "--runtime")
        .map(|program| RuntimeSpec {
            program: PathBuf::from(program),
            args: arg_values(&args, "--runtime-arg"),
            env: Vec::new(),
        })
        .or_else(|| RuntimeSpec::from_managed(&managed));
    let bash = arg_value(&args, "--bash")
        .map(PathBuf::from)
        .or_else(|| find_bash(&managed));
    let install = arg_value(&args, "--install")
        .map(PathBuf::from)
        .unwrap_or_else(|| managed.clone());
    let events = jouzu_host::events::EventHub::new();
    let control = match jouzu_host::control::ControlManager::new(
        &install,
        &managed,
        &home,
        &runtime_home,
        Some(events.clone()),
    ) {
        Ok(manager) => std::sync::Arc::new(manager),
        Err(error) => {
            eprintln!("control is unavailable: {error}");
            return ExitCode::FAILURE;
        }
    };
    let sessions = std::sync::Arc::new(SessionManager::new(
        runtime,
        home.clone(),
        runtime_home,
        bash,
        jouzu_host::session::DEFAULT_REPLAY_LIMIT,
        Some(events.clone()),
    ));
    // Start a runtime now, while the window shows loading, not when the user
    // sends the first message.
    sessions.enable_warm_runtime();
    {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                sessions.reap_idle(std::time::Duration::from_secs(15 * 60));
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

    if let Err(error) = write_host_file(&home, port, &token, VERSION) {
        eprintln!("cannot write host.json: {error}");
        return ExitCode::FAILURE;
    }
    log(
        &home,
        "info",
        "host.start",
        json!({ "port": port, "pid": std::process::id(), "dist": dist.to_string_lossy(), "version": env!("CARGO_PKG_VERSION"), "build": jouzu_host::BUILD_ID, "commit": jouzu_host::COMMIT }),
    );
    println!(
        "jouzu-host listening on http://127.0.0.1:{port}/ (token in host.json; open /?token=<token>)"
    );

    let state = AppState {
        token: std::sync::Arc::new(token.clone()),
        port,
        dist,
        started: Instant::now(),
        version: VERSION.to_string(),
        sessions: sessions.clone(),
        control,
        events,
        models: std::sync::Arc::new(jouzu_host::models::Models::new(&home)),
    };
    let app = router(state);

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;

    sessions.stop_all();
    remove_host_file(&home, &token);
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


