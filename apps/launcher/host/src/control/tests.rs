use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

/// A manager whose runtime home is `<root>/data`, as the shell starts the host.
fn manager_with(root: &Path, node: std::path::PathBuf) -> Arc<ControlManager> {
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    Arc::new(ControlManager::new(root, root, Some(node), &data, None).expect("control manager"))
}

fn manager(root: &Path) -> Arc<ControlManager> {
    let node = root.join("node.exe");
    std::fs::write(&node, "").unwrap();
    manager_with(root, node)
}

/// Every operation the configuration service implements must be a kind the host
/// accepts, or the UI's request is refused before it runs.
#[test]
fn every_operation_the_service_handles_is_a_kind() {
    let mut handled = Vec::new();
    for quote in ['\'', '"'] {
        let marker = format!("action === {quote}");
        let mut rest = adapter::SCRIPT;
        while let Some(index) = rest.find(&marker) {
            rest = &rest[index + marker.len()..];
            if let Some(end) = rest.find(quote) {
                handled.push(rest[..end].to_string());
            }
        }
    }
    assert!(handled.iter().any(|action| action == "language"), "{handled:?}");
    for action in &handled {
        assert!(KINDS.iter().any(|kind| kind.name == action), "the host refuses `{action}`, which control.mjs handles");
    }
}

#[test]
fn a_request_is_checked_per_kind_before_it_reaches_the_service() {
    let code = |kind: &str, body: Value| validate(kind, &body).err().map(|error| error.code);
    assert_eq!(code("nope", json!({})), Some("config-unknown-kind"));
    assert_eq!(code("provider-key", json!({ "provider": "openai" })), Some("config-invalid"));
    assert_eq!(code("provider-key", json!({ "provider": "openai", "token": 5 })), Some("config-invalid"));
    assert_eq!(code("provider-key", json!({ "provider": "openai", "token": "k", "url": "x" })), Some("config-invalid"));
    assert_eq!(code("provider-key", json!({ "provider": "x".repeat(65), "token": "k" })), Some("config-invalid"));
    assert_eq!(code("provider-key", json!([1])), Some("config-invalid"));
    assert_eq!(code("language", json!({})), Some("config-invalid"));
    assert_eq!(code("language", json!({ "artifactPolicy": { "comments": 1 } })), Some("config-invalid"));
    assert_eq!(code("custom-provider", json!({ "provider": "p", "url": "u", "model": "m", "maxTokens": 1.5 })), Some("config-invalid"));
    assert_eq!(code("environment", json!({ "entries": [{ "name": "A B", "value": "", "enabled": true }] })), Some("config-invalid"));
    assert_eq!(code("environment", json!({ "entries": [{ "name": "A", "value": "", "enabled": true, "x": 1 }] })), Some("config-invalid"));
    assert_eq!(code("status", json!({ "action": "provider-key" })), Some("config-invalid"));

    // Only the kind's own fields are forwarded, with the action set by the host.
    let (_, payload) = validate("provider-key", &json!({ "provider": "openai", "token": "k" })).unwrap();
    let Payload::Adapter(payload) = payload else { panic!() };
    assert_eq!(payload, json!({ "action": "provider-key", "provider": "openai", "token": "k" }));
    let (_, payload) = validate("status", &Value::Null).unwrap();
    let Payload::Adapter(payload) = payload else { panic!() };
    assert_eq!(payload, json!({ "action": "status" }));
    assert!(validate("language", &json!({ "artifactPolicy": { "comments": "en" } })).is_ok());
    assert!(validate("environment", &json!({ "entries": [{ "name": "SHISA_API_KEY", "value": "v", "enabled": true }] })).is_ok());
}

#[test]
fn an_unreadable_saved_file_fails_the_request_with_a_reason() {
    let root = tempfile::tempdir().unwrap();
    let control = manager(root.path());
    std::fs::write(root.path().join("data").join("launcher-environment.bin"), b"broken").unwrap();
    let error = control.launch_spec().unwrap_err();
    assert!(error.contains("Saved environment variables could not be read"), "{error}");
}

/// The configuration service reads the file Settings writes
/// (`<runtime home>/launcher-environment.bin`) at each request, so a key saved
/// after the host started reaches the next model refresh (#63).
#[cfg(windows)]
#[test]
fn a_key_saved_after_start_reaches_the_next_request() {
    let root = tempfile::tempdir().unwrap();
    let control = manager(root.path());
    let value = |spec: &adapter::LaunchSpec| spec.env.iter().find(|(key, _)| key == "SHISA_API_KEY").map(|(_, value)| value.clone());
    assert_eq!(value(&control.launch_spec().unwrap()), None);
    let data = root.path().join("data");
    let entry = |value: &str| crate::environment::Entry { name: "SHISA_API_KEY".into(), value: value.into(), enabled: true };
    crate::environment::save(&data, &[entry("first")]).unwrap();
    assert_eq!(value(&control.launch_spec().unwrap()).as_deref(), Some("first"));
    crate::environment::save(&data, &[entry("second")]).unwrap();
    assert_eq!(value(&control.launch_spec().unwrap()).as_deref(), Some("second"));
}

/// Node from PATH, for the queue tests: they run a stand-in for the control
/// program, not jouzu. `None` (and the test skips, saying so) where there is none.
fn node() -> Option<std::path::PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["node.exe"] } else { &["node"] };
    let found = std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file());
    if found.is_none() {
        eprintln!("skipped: no node on PATH");
    }
    found
}

/// A manager running a stand-in with the control program's stdin/stdout
/// contract: one JSON request in, the settings (or `{error}` and exit code 1)
/// out. It logs each action it ran. A token `sleep:N` waits N ms; `fail` fails;
/// `shisa-login` reports a device code and waits to be cancelled.
fn fake_service(root: &Path) -> Option<Arc<ControlManager>> {
    let node = node()?;
    let log = root.join("actions.log");
    let script = format!(
        r#"import {{ readFileSync, appendFileSync }} from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const token = request.token ?? '';
appendFileSync({log:?}, request.action + ':' + token + '\n');
if (token.startsWith('sleep:')) await new Promise(resolve => setTimeout(resolve, Number(token.slice(6))));
if (token === 'fail') {{ console.log(JSON.stringify({{ error: 'Could not save the provider key.' }})); process.exit(1); }}
if (request.action === 'shisa-login') {{
  process.stderr.write(JSON.stringify({{ type: 'device', url: 'https://platform.shisa.ai/connect', code: 'ABCD' }}) + '\n');
  await new Promise(() => setInterval(() => {{}}, 1000));
}}
const settings = {{ schemaVersion: 1, last: request.action, key: process.env.SHISA_API_KEY ?? null }};
if (request.action === 'refresh-catalogs') settings.catalog = {{ status: 'quarantined', sources: [], held: {{ revision: 'r1' }} }};
console.log(JSON.stringify(settings));
"#
    );
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    Some(Arc::new(
        ControlManager::new(root, root, Some(node), &data, None).expect("control manager").with_script(&script),
    ))
}

async fn settled(control: &ControlManager) -> Value {
    for _ in 0..400 {
        let view = control.view();
        if view["config"]["running"].is_null() && view["config"]["queued"].as_array().unwrap().is_empty() {
            return view;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the queue did not settle: {}", control.view());
}

fn actions(root: &Path) -> Vec<String> {
    std::fs::read_to_string(root.join("actions.log")).unwrap_or_default().lines().map(str::to_string).collect()
}

/// Saving a key while the catalog refreshes: both complete, in order, no refusal
/// (host-layer step 6).
#[tokio::test]
async fn operations_sent_together_all_run_in_order() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = changes.clone();
    control.on_change(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    let first = control.enqueue("provider-key", &json!({ "provider": "a", "token": "sleep:300" })).unwrap();
    let second = control.enqueue("refresh-catalogs", &json!({})).unwrap();
    let third = control.enqueue("status", &json!({})).unwrap();
    assert_eq!(first["position"], 0);
    assert_eq!(second["position"], 1);
    assert_eq!(third["position"], 2);
    let view = settled(&control).await;
    assert_eq!(actions(root.path()), ["provider-key:sleep:300", "refresh-catalogs:", "status:"]);
    let last = &view["config"]["lastResult"];
    for (kind, reply) in [("provider-key", &first), ("refresh-catalogs", &second), ("status", &third)] {
        assert_eq!(last[kind]["ok"], true, "{view}");
        assert_eq!(last[kind]["operationId"], reply["operationId"]);
    }
    assert_eq!(view["settings"]["last"], "status");
    // A held revision is the refresh's own outcome, not a setting.
    assert_eq!(last["refresh-catalogs"]["params"]["catalog"]["held"]["revision"], "r1");
    assert!(view["settings"].get("catalog").is_none(), "{view}");
    // Two changes, one read.
    assert_eq!(changes.load(Ordering::SeqCst), 2);
}

/// A failed save shows only on its own kind; the settings stay as they were and
/// the next operation runs.
#[tokio::test]
async fn a_failure_is_recorded_on_its_kind_only() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    control.start();
    settled(&control).await;
    control.enqueue("provider-key", &json!({ "provider": "a", "token": "fail" })).unwrap();
    control.enqueue("language", &json!({ "uiLocale": "ja" })).unwrap();
    let view = settled(&control).await;
    let last = &view["config"]["lastResult"];
    assert_eq!(last["provider-key"]["ok"], false);
    assert_eq!(last["provider-key"]["code"], "config-failed");
    assert_eq!(last["provider-key"]["text"], "Could not save the provider key.");
    assert_eq!(last["language"]["ok"], true);
    assert_eq!(view["settings"]["last"], "language");
}

#[tokio::test]
async fn a_queued_operation_can_be_cancelled_and_the_rest_continue() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    control.enqueue("provider-key", &json!({ "provider": "a", "token": "sleep:300" })).unwrap();
    let doomed = control.enqueue("provider-remove", &json!({ "provider": "a" })).unwrap();
    control.enqueue("status", &json!({})).unwrap();
    assert!(control.cancel(doomed["operationId"].as_str().unwrap()));
    assert!(!control.cancel("op-unknown"));
    let view = settled(&control).await;
    assert_eq!(actions(root.path()), ["provider-key:sleep:300", "status:"]);
    assert_eq!(view["config"]["lastResult"]["provider-remove"]["code"], "config-cancelled");
}

/// A sign-in shows its device code on the running operation, and cancelling it
/// ends the process and lets the queue go on.
#[tokio::test]
async fn a_running_sign_in_shows_its_code_and_can_be_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    let login = control.enqueue("shisa-login", &json!({})).unwrap();
    control.enqueue("status", &json!({})).unwrap();
    let mut shown = false;
    for _ in 0..200 {
        if control.view()["config"]["running"]["device"]["code"] == "ABCD" {
            shown = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(shown, "{}", control.view());
    assert!(control.cancel(login["operationId"].as_str().unwrap()));
    let view = settled(&control).await;
    assert_eq!(view["config"]["lastResult"]["shisa-login"]["code"], "config-cancelled");
    assert_eq!(view["config"]["lastResult"]["status"]["ok"], true);
}

#[tokio::test]
async fn a_full_queue_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    control.enqueue("provider-key", &json!({ "provider": "a", "token": "sleep:2000" })).unwrap();
    let mut accepted = 1;
    let error = loop {
        match control.enqueue("status", &json!({})) {
            Ok(_) => accepted += 1,
            Err(error) => break error,
        }
        assert!(accepted <= QUEUE_LIMIT + 1, "the queue grows without limit");
    };
    assert_eq!(error.code, "config-queue-full");
    assert!(accepted >= QUEUE_LIMIT);
}

/// Saved variables are queued like the rest: a read queued after the save sees
/// them (#63). Off Windows there is no secure storage, and the save fails on
/// its own card without stopping the queue.
#[tokio::test]
async fn a_saved_variable_reaches_the_next_operation() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    let changes = Arc::new(AtomicUsize::new(0));
    let counted = changes.clone();
    control.on_change(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    });
    control
        .enqueue("environment", &json!({ "entries": [{ "name": "SHISA_API_KEY", "value": "saved", "enabled": true }] }))
        .unwrap();
    control.enqueue("status", &json!({})).unwrap();
    let view = settled(&control).await;
    let last = &view["config"]["lastResult"];
    if cfg!(windows) {
        assert_eq!(last["environment"]["ok"], true, "{view}");
        assert_eq!(view["settings"]["key"], "saved");
        assert_eq!(changes.load(Ordering::SeqCst), 1);
    } else {
        assert_eq!(last["environment"]["code"], "config-failed", "{view}");
        assert_eq!(changes.load(Ordering::SeqCst), 0);
    }
    assert_eq!(last["status"]["ok"], true);
}

/// A failure while replacing the warm runtime does not stop the queue.
#[tokio::test]
async fn a_panic_after_an_operation_does_not_stop_the_queue() {
    let root = tempfile::tempdir().unwrap();
    let Some(control) = fake_service(root.path()) else { return };
    control.on_change(|| panic!("recycle failed"));
    control.enqueue("language", &json!({ "uiLocale": "ja" })).unwrap();
    control.enqueue("status", &json!({})).unwrap();
    let view = settled(&control).await;
    assert_eq!(view["config"]["lastResult"]["language"]["ok"], true, "{view}");
    assert_eq!(view["config"]["lastResult"]["status"]["ok"], true, "{view}");
}
