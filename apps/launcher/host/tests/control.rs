//! Control exercised against the real adapter.
//!
//! These tests spawn the real `control.mjs` with the real Node. They need a real Jouzu
//! application directory for the adapter's module imports, which cannot live in the
//! repository; without `JOUZU_HOST_TEST_APP` they skip and say so instead of passing
//! silently. `JOUZU_HOST_TEST_HOME`, when set, is a real JOUZU_HOME to read instead of
//! an empty temporary one.

use std::{path::PathBuf, sync::Arc};

use jouzu_host::control::ControlManager;
use serde_json::json;

fn app_dir() -> Option<PathBuf> {
    let value = std::env::var_os("JOUZU_HOST_TEST_APP")?;
    let app = PathBuf::from(value);
    if !app.join("bootstrap.mjs").is_file() || !app.join("node_modules/jouzu/dist/cli.js").is_file()
    {
        eprintln!(
            "skipped: JOUZU_HOST_TEST_APP={} is not a Jouzu app directory",
            app.display()
        );
        return None;
    }
    Some(app)
}

fn manager(app: &PathBuf, home: &PathBuf) -> Arc<ControlManager> {
    let install = app.parent().expect("app has a parent");
    let runtime_home = home.join("data");
    std::fs::create_dir_all(&runtime_home).unwrap();
    // The bundled Node under the install, unless JOUZU_HOST_TEST_NODE names one.
    let node = std::env::var_os("JOUZU_HOST_TEST_NODE").map(PathBuf::from);
    Arc::new(ControlManager::new(install, install, node, &runtime_home, None).expect("control manager"))
}

async fn settled(manager: &ControlManager) -> serde_json::Value {
    for _ in 0..2000 {
        let view = manager.view();
        if view["config"]["running"].is_null() && view["config"]["queued"].as_array().is_some_and(Vec::is_empty) {
            return view;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the configuration queue did not settle: {}", manager.view());
}

#[tokio::test]
async fn status_runs_the_real_adapter() {
    let Some(app) = app_dir() else { return };
    let temp = tempfile::tempdir().unwrap();
    let home = match std::env::var_os("JOUZU_HOST_TEST_HOME") {
        Some(value) => PathBuf::from(value),
        None => temp.path().to_path_buf(),
    };
    let manager = manager(&app, &home);

    manager.enqueue("status", &json!({})).expect("queued");
    let view = settled(&manager).await;

    assert_eq!(view["config"]["lastResult"]["status"]["ok"], true, "{view}");
    let value = &view["settings"];
    assert_eq!(value["schemaVersion"], 1, "unexpected status payload: {value}");
    // Models are each runtime's answer, not configuration status.
    assert!(value.get("models").is_none(), "status lists models: {value}");
    assert!(value.get("modelReady").is_none(), "status guesses model readiness: {value}");
    assert!(value["providers"].is_array(), "providers is not an array: {value}");
}

#[tokio::test]
async fn an_unknown_kind_is_refused_without_queuing() {
    let temp = tempfile::tempdir().unwrap();
    let node = temp.path().join("node.exe");
    std::fs::write(&node, "").unwrap();
    let data = temp.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let manager = Arc::new(ControlManager::new(temp.path(), temp.path(), Some(node), &data, None).unwrap());

    let error = manager.enqueue("definitely-not-an-action", &json!({})).expect_err("unknown kind");

    assert_eq!(error.code, "config-unknown-kind");
    assert!(manager.view()["config"]["queued"].as_array().unwrap().is_empty());
    assert!(!manager.cancel("op-never-started"));
}
