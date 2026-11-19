//! Configuration operations, owned by the host.
//!
//! Every operation that reads or changes configuration (sign-in, keys, providers,
//! catalogs, default model, language, profile, saved environment variables) goes
//! through one queue here and runs serially. A request is validated per kind,
//! gets an operation id and its position at once, and never waits for the
//! operation itself. The result, what is running, what is queued and the current
//! settings are one snapshot, `AppView`, published as `app.updated` on every change.
//!
//! The values live in the runtime's own configuration files. They are read and
//! written through the control program (`control.mjs`) until the runtime offers a
//! supported configuration interface (runtime G5). The control program runs in its
//! own process per operation, inside a job that is terminated on cancel or after
//! a 190 second deadline.

mod adapter;
mod app;

use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use serde_json::{json, Map, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::Notify,
};

use crate::session::ApiError;

pub const TIMEOUT: Duration = Duration::from_secs(190);
const STDOUT_LIMIT: usize = 8 * 1024 * 1024;
/// Operations waiting at once. A client that floods the queue is refused, not
/// served late.
const QUEUE_LIMIT: usize = 64;

/// The shape of one request field.
#[derive(Clone, Copy)]
enum Field {
    /// A required string of at most this many bytes, not empty.
    Text(usize),
    /// An optional string of at most this many bytes.
    OptionalText(usize),
    Flag,
    OptionalFlag,
    OptionalInteger,
    /// An object of at most 8 string values of at most 32 bytes each.
    OptionalStrings,
}

/// One kind of operation: the fields it accepts and whether it changes anything.
struct Kind {
    name: &'static str,
    fields: &'static [(&'static str, Field)],
    /// Reads only: no runtime has to be replaced after it.
    reads: bool,
}

const KINDS: &[Kind] = &[
    Kind { name: "status", fields: &[], reads: true },
    Kind { name: "profile", fields: &[("profile", Field::Text(16))], reads: false },
    Kind { name: "import", fields: &[("accept", Field::Flag)], reads: false },
    Kind { name: "shisa-login", fields: &[], reads: false },
    Kind { name: "shisa-logout", fields: &[], reads: false },
    Kind { name: "refresh-catalogs", fields: &[], reads: false },
    Kind {
        name: "catalog-accept",
        fields: &[("revision", Field::Text(256)), ("digest", Field::Text(256)), ("sourceId", Field::OptionalText(256))],
        reads: false,
    },
    Kind {
        name: "catalog-reject",
        fields: &[("revision", Field::Text(256)), ("digest", Field::Text(256)), ("sourceId", Field::OptionalText(256))],
        reads: false,
    },
    Kind { name: "provider-oauth", fields: &[("provider", Field::Text(64))], reads: false },
    Kind { name: "provider-key", fields: &[("provider", Field::Text(64)), ("token", Field::Text(8192))], reads: false },
    Kind { name: "provider-remove", fields: &[("provider", Field::Text(64))], reads: false },
    Kind {
        name: "custom-provider",
        fields: &[
            ("provider", Field::Text(64)),
            ("url", Field::Text(2048)),
            ("model", Field::Text(256)),
            ("edit", Field::OptionalFlag),
            ("imageInput", Field::OptionalFlag),
            ("contextWindow", Field::OptionalInteger),
            ("maxTokens", Field::OptionalInteger),
        ],
        reads: false,
    },
    Kind { name: "default-model", fields: &[("provider", Field::Text(64)), ("model", Field::Text(256))], reads: false },
    Kind {
        name: "language",
        fields: &[
            ("uiLocale", Field::OptionalText(32)),
            ("responseLanguage", Field::OptionalText(32)),
            ("artifactPolicy", Field::OptionalStrings),
        ],
        reads: false,
    },
    // Saved environment variables: written by the host itself (`environment.rs`),
    // queued like the rest so a refresh queued after a save sees the new values.
    Kind { name: "environment", fields: &[], reads: false },
];

const ENVIRONMENT_ENTRIES: usize = 256;

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(axum::http::StatusCode::BAD_REQUEST, "config-invalid", message, false)
}

/// What one validated request carries to its operation.
#[derive(Clone)]
enum Payload {
    /// Forwarded to the control program: `action` plus the kind's own fields only.
    Adapter(Value),
    Environment(Vec<crate::environment::Entry>),
}

/// Check a request body against its kind. Unknown kinds, unknown fields, wrong
/// types and over-long values are refused here and never reach the control program.
fn validate(kind: &str, body: &Value) -> Result<(&'static Kind, Payload), ApiError> {
    let Some(spec) = KINDS.iter().find(|spec| spec.name == kind) else {
        return Err(ApiError::new(
            axum::http::StatusCode::NOT_FOUND,
            "config-unknown-kind",
            format!("Unknown configuration operation `{kind}`"),
            false,
        ));
    };
    let empty = Map::new();
    let object = match body {
        Value::Null => &empty,
        Value::Object(object) => object,
        _ => return Err(invalid("The request body must be a JSON object")),
    };
    if spec.name == "environment" {
        return validate_environment(object).map(|entries| (spec, Payload::Environment(entries)));
    }
    if let Some(unknown) = object.keys().find(|key| !spec.fields.iter().any(|(name, _)| name == key)) {
        return Err(invalid(format!("Unknown field `{unknown}` for `{kind}`")));
    }
    let mut payload = Map::new();
    payload.insert("action".into(), Value::String(spec.name.into()));
    for (name, field) in spec.fields {
        let value = object.get(*name).filter(|value| !value.is_null());
        let fine = match (field, value) {
            (Field::Text(limit), Some(Value::String(text))) => !text.is_empty() && text.len() <= *limit,
            (Field::Text(_), _) => false,
            (Field::OptionalText(_), None) => true,
            (Field::OptionalText(limit), Some(Value::String(text))) => text.len() <= *limit,
            (Field::Flag, Some(Value::Bool(_))) => true,
            (Field::OptionalFlag, None | Some(Value::Bool(_))) => true,
            (Field::OptionalInteger, None) => true,
            (Field::OptionalInteger, Some(Value::Number(number))) => number.as_i64().is_some(),
            (Field::OptionalStrings, None) => true,
            (Field::OptionalStrings, Some(Value::Object(map))) => {
                map.len() <= 8
                    && map.iter().all(|(key, value)| {
                        key.len() <= 32 && value.as_str().is_some_and(|text| text.len() <= 32)
                    })
            }
            _ => false,
        };
        if !fine {
            return Err(invalid(format!("Invalid or missing field `{name}` for `{kind}`")));
        }
        if let Some(value) = value {
            payload.insert((*name).into(), value.clone());
        }
    }
    if spec.name == "language" && payload.len() == 1 {
        return Err(invalid("`language` needs at least one setting"));
    }
    Ok((spec, Payload::Adapter(Value::Object(payload))))
}

fn validate_environment(object: &Map<String, Value>) -> Result<Vec<crate::environment::Entry>, ApiError> {
    if let Some(unknown) = object.keys().find(|key| key.as_str() != "entries") {
        return Err(invalid(format!("Unknown field `{unknown}` for `environment`")));
    }
    let Some(Value::Array(rows)) = object.get("entries") else {
        return Err(invalid("Invalid or missing field `entries` for `environment`"));
    };
    if rows.len() > ENVIRONMENT_ENTRIES {
        return Err(invalid("Too many environment variables"));
    }
    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(row) = row.as_object() else {
            return Err(invalid("Each environment entry must be an object"));
        };
        if let Some(unknown) = row.keys().find(|key| !["name", "value", "enabled"].contains(&key.as_str())) {
            return Err(invalid(format!("Unknown field `{unknown}` in an environment entry")));
        }
        let (Some(Value::String(name)), Some(Value::String(value)), Some(Value::Bool(enabled))) =
            (row.get("name"), row.get("value"), row.get("enabled"))
        else {
            return Err(invalid("An environment entry needs `name`, `value` and `enabled`"));
        };
        entries.push(crate::environment::Entry { name: name.clone(), value: value.clone(), enabled: *enabled });
    }
    crate::environment::validate(&entries).map_err(invalid)?;
    Ok(entries)
}

struct Operation {
    id: String,
    kind: &'static Kind,
    payload: Payload,
    /// The provider the operation is for (its key, sign-in, removal, default
    /// model or custom connection); its result names it, so a client shows
    /// the result at that provider only.
    provider: Option<String>,
    queued_at: String,
}

struct Running {
    id: String,
    kind: &'static str,
    started_at: String,
    /// A sign-in waiting for the person: the page and code the control program reported.
    device: Option<adapter::DeviceCode>,
    cancel: Arc<Notify>,
}

/// How an operation ended.
struct Outcome {
    ok: bool,
    code: Option<&'static str>,
    text: Option<String>,
}

impl Outcome {
    fn ok() -> Self {
        Self { ok: true, code: None, text: None }
    }

    fn render(&self, operation_id: &str, params: Value, provider: Option<&str>) -> Value {
        json!({
            "operationId": operation_id,
            "ok": self.ok,
            "code": self.code,
            "params": params,
            "provider": provider,
            "text": self.text,
            "finishedAt": now(),
        })
    }
}

/// What a finished operation leaves behind.
/// The providers whose credential is the Shisa.AI sign-in, as the settings'
/// account lists them.
fn shisa_providers(settings: Option<&Value>) -> Vec<String> {
    let mut ids = vec!["shisa".to_string()];
    let listed = settings.and_then(|settings| settings.pointer("/account/providers")).and_then(Value::as_array);
    ids.extend(listed.into_iter().flatten().filter_map(Value::as_str).map(str::to_string));
    ids
}

struct Done {
    /// Configuration changed: new runtimes must start with it.
    changed: bool,
    settings: Option<Value>,
    params: Value,
    outcome: Outcome,
    /// The settings could not be read after an operation that itself succeeded.
    read_failure: Option<Outcome>,
}

impl Done {
    fn failed(outcome: Outcome) -> Self {
        Self { changed: false, settings: None, params: json!({}), outcome, read_failure: None }
    }
}

#[derive(Default)]
struct Queue {
    running: Option<Running>,
    queued: VecDeque<Operation>,
    last: BTreeMap<&'static str, Value>,
    /// The control program's last full answer; `None` until one was read.
    settings: Option<Value>,
    /// Raised on every change, so a client keeps only the newest snapshot.
    revision: u64,
    draining: bool,
}

pub struct ControlManager {
    context: adapter::ControlContext,
    queue: Mutex<Queue>,
    hub: Option<Arc<crate::events::EventHub>>,
    /// Runs after an operation that changed configuration (the host recycles its
    /// warm runtime, so a new session starts with the new configuration).
    after_change: OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// What replies said about each provider's sign-in, shown with the settings.
    providers: OnceLock<Arc<crate::provider_answers::ProviderAnswers>>,
}

impl ControlManager {
    pub fn new(
        install: &Path,
        managed: &Path,
        node: Option<std::path::PathBuf>,
        runtime_home: &Path,
        events: Option<Arc<crate::events::EventHub>>,
    ) -> Result<Self, String> {
        let app = app::resolve_app(install, managed)?;
        // The runtime's own Node when the host was given one, else the bundled one.
        let node = node.unwrap_or_else(|| app::node_executable(managed));
        Ok(Self {
            context: adapter::ControlContext {
                node,
                root: managed.to_path_buf(),
                app,
                home: runtime_home.to_path_buf(),
                script: adapter::SCRIPT.to_string(),
            },
            queue: Mutex::new(Queue::default()),
            hub: events,
            after_change: OnceLock::new(),
            providers: OnceLock::new(),
        })
    }

    /// Tests: run this script in place of the control program.
    #[cfg(test)]
    pub(crate) fn with_script(mut self, script: &str) -> Self {
        self.context.script = script.to_string();
        self
    }

    /// Set once by the host when it starts: `AppView.providerAuth` follows it.
    pub fn watch_providers(self: &Arc<Self>, providers: Arc<crate::provider_answers::ProviderAnswers>) {
        let manager = Arc::downgrade(self);
        providers.on_change(move || {
            if let Some(manager) = manager.upgrade() {
                let mut queue = manager.lock();
                manager.publish(&mut queue);
            }
        });
        let _ = self.providers.set(providers);
    }

    fn provider_view(&self) -> Value {
        self.providers.get().map_or_else(|| json!({}), |providers| providers.view())
    }

    /// Set once by the host when it starts.
    pub fn on_change(&self, action: impl Fn() + Send + Sync + 'static) {
        let _ = self.after_change.set(Box::new(action));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// How the adapter is started for one request. The variables saved in
    /// Settings are read here, from the file Settings writes, for every request:
    /// a key saved a moment ago must reach the next refresh without a restart.
    pub fn launch_spec(&self) -> Result<adapter::LaunchSpec, String> {
        let environment = crate::environment::enabled(&self.context.home).map_err(|message| {
            format!("Saved environment variables could not be read: {message}. Open Settings > Environment and save them again.")
        })?;
        adapter::spec(&self.context, &environment)
            .map_err(|message| format!("Configuration is unavailable: {message}"))
    }

    /// The configuration part of `AppView`: what runs, what waits, the last result
    /// of each kind, and the current settings.
    pub fn view(&self) -> Value {
        Self::render(&self.lock(), self.provider_view())
    }

    fn render(queue: &Queue, providers: Value) -> Value {
        let running = queue.running.as_ref().map(|running| {
            let mut value = json!({
                "operationId": running.id,
                "kind": running.kind,
                "startedAt": running.started_at,
            });
            if let Some(device) = &running.device {
                value["device"] = json!({ "url": device.url, "code": device.code });
                if let Some(provider) = &device.provider {
                    value["device"]["provider"] = Value::String(provider.clone());
                }
            }
            value
        });
        let ahead = usize::from(queue.running.is_some());
        let queued: Vec<Value> = queue
            .queued
            .iter()
            .enumerate()
            .map(|(index, operation)| {
                json!({
                    "operationId": operation.id,
                    "kind": operation.kind.name,
                    "position": index + ahead,
                    "queuedAt": operation.queued_at,
                })
            })
            .collect();
        json!({
            "revision": queue.revision,
            "config": { "running": running, "queued": queued, "lastResult": queue.last },
            "settings": queue.settings,
            // Providers whose latest reply refused the stored key or sign-in.
            "providerAuth": providers,
        })
    }

    fn publish(&self, queue: &mut Queue) {
        queue.revision += 1;
        if let Some(hub) = &self.hub {
            hub.publish_control("app.updated", Self::render(queue, self.provider_view()));
        }
    }

    /// Queue one operation. Answers at once with its id and position (how many
    /// operations run before it); the outcome arrives in `AppView.config.lastResult`.
    pub fn enqueue(self: &Arc<Self>, kind: &str, body: &Value) -> Result<Value, ApiError> {
        let (kind, payload) = validate(kind, body)?;
        let id = format!("op-{:016x}", rand::random::<u64>());
        let (position, start) = {
            let mut queue = self.lock();
            if queue.queued.len() >= QUEUE_LIMIT {
                return Err(ApiError::new(
                    axum::http::StatusCode::TOO_MANY_REQUESTS,
                    "config-queue-full",
                    "Too many configuration operations are waiting",
                    true,
                ));
            }
            let provider = match &payload {
                Payload::Adapter(fields) => fields.get("provider").and_then(Value::as_str).map(str::to_string),
                Payload::Environment(_) => None,
            };
            queue.queued.push_back(Operation { id: id.clone(), kind, payload, provider, queued_at: now() });
            // How many operations run before this one.
            let position = queue.queued.len() - 1 + usize::from(queue.running.is_some());
            let start = !queue.draining;
            queue.draining = true;
            self.publish(&mut queue);
            (position, start)
        };
        if start {
            let manager = self.clone();
            tokio::spawn(async move { manager.drain().await });
        }
        Ok(json!({ "operationId": id, "position": position }))
    }

    /// Read the settings once when the host starts.
    pub fn start(self: &Arc<Self>) {
        let _ = self.enqueue("status", &Value::Null);
    }

    /// Cancel a queued or running operation. `false` when no such operation waits
    /// or runs (it may have finished just now).
    pub fn cancel(&self, id: &str) -> bool {
        let mut queue = self.lock();
        if let Some(running) = queue.running.as_ref().filter(|running| running.id == id) {
            running.cancel.notify_one();
            return true;
        }
        let Some(index) = queue.queued.iter().position(|operation| operation.id == id) else {
            return false;
        };
        let operation = queue.queued.remove(index).expect("index is in range");
        let result = Outcome { ok: false, code: Some("config-cancelled"), text: None }.render(&operation.id, json!({}), operation.provider.as_deref());
        queue.last.insert(operation.kind.name, result);
        self.publish(&mut queue);
        true
    }

    async fn drain(self: Arc<Self>) {
        loop {
            let (operation, cancel) = {
                let mut queue = self.lock();
                let Some(operation) = queue.queued.pop_front() else {
                    queue.draining = false;
                    return;
                };
                let cancel = Arc::new(Notify::new());
                queue.running = Some(Running {
                    id: operation.id.clone(),
                    kind: operation.kind.name,
                    started_at: now(),
                    device: None,
                    cancel: cancel.clone(),
                });
                self.publish(&mut queue);
                (operation, cancel)
            };
            let id = operation.id.clone();
            let kind = operation.kind;
            let operation_payload_provider = operation.provider.clone();
            // Each operation runs in a task of its own: a panic in it ends that
            // operation with a result, never the queue.
            let manager = self.clone();
            let done = match tokio::spawn(async move { manager.execute(&operation, cancel).await }).await {
                Ok(done) => done,
                Err(_) => Done::failed(Outcome {
                    ok: false,
                    code: Some("config-failed"),
                    text: Some("The configuration operation stopped unexpectedly".into()),
                }),
            };
            // A new runtime must see the change before anyone reads the result.
            if done.changed {
                if let Some(action) = self.after_change.get() {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(action)).is_err() {
                        eprintln!("configuration: replacing the warm runtime failed");
                    }
                }
            }
            // A new sign-in, key or removal replaces what earlier replies said.
            if done.outcome.ok {
                if let Some(providers) = self.providers.get() {
                    match (kind.name, &operation_payload_provider) {
                        // The sign-in is the credential of every provider the
                        // account lists (the Shisa API catalog's).
                        ("shisa-login" | "shisa-logout", _) => {
                            let known = done.settings.clone().or_else(|| self.lock().settings.clone());
                            for id in shisa_providers(known.as_ref()) {
                                providers.forget(&id);
                            }
                        }
                        ("provider-oauth" | "provider-key" | "provider-remove", Some(provider)) => providers.forget(provider),
                        _ => {}
                    }
                }
            }
            let mut queue = self.lock();
            queue.running = None;
            if let Some(settings) = done.settings {
                queue.settings = Some(settings);
            }
            if let Some(read) = done.read_failure {
                queue.last.insert("status", read.render(&id, json!({}), None));
            }
            queue.last.insert(kind.name, done.outcome.render(&id, done.params, operation_payload_provider.as_deref()));
            self.publish(&mut queue);
        }
    }

    /// Run one operation.
    async fn execute(self: &Arc<Self>, operation: &Operation, cancel: Arc<Notify>) -> Done {
        match &operation.payload {
            Payload::Environment(entries) => {
                if let Err(message) = crate::environment::save(&self.context.home, entries) {
                    return Done::failed(Outcome { ok: false, code: Some("config-failed"), text: Some(message) });
                }
                // Saved: that is this operation's result. The settings as the
                // control program now sees them are a read of their own; if it
                // fails, it is reported as the read's failure, not the save's.
                let read = self.run(&operation.id, &json!({ "action": "status" }), cancel).await;
                let (settings, read_failure) = match read {
                    Ok(answer) => (Some(split_answer(answer).0), None),
                    Err(outcome) => (None, Some(outcome)),
                };
                Done { changed: true, settings, params: json!({}), outcome: Outcome::ok(), read_failure }
            }
            Payload::Adapter(payload) => match self.run(&operation.id, payload, cancel).await {
                Ok(answer) => {
                    let (settings, params) = split_answer(answer);
                    Done {
                        changed: !operation.kind.reads,
                        settings: Some(settings),
                        params,
                        outcome: Outcome::ok(),
                        read_failure: None,
                    }
                }
                Err(outcome) => Done::failed(outcome),
            },
        }
    }

    async fn run(self: &Arc<Self>, operation_id: &str, payload: &Value, cancel: Arc<Notify>) -> Result<Value, Outcome> {
        let unavailable = |text: String| Outcome { ok: false, code: Some("config-unavailable"), text: Some(text) };
        let spec = self.launch_spec().map_err(unavailable)?;
        let mut command = tokio::process::Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(spec.env.iter().map(|(key, value)| (key, value)))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| unavailable("Cannot start the configuration service".into()))?;
        // The child's tree belongs to a job on Windows; elsewhere the child itself
        // is killed (`kill_on_drop`, `start_kill`).
        let job = crate::runtime::job::Job::new()
            .map_err(|_| unavailable("Cannot own the configuration process".into()))?;
        #[cfg(windows)]
        {
            let handle = child
                .raw_handle()
                .ok_or_else(|| unavailable("Cannot own the configuration process".into()))?;
            job.assign(handle)
                .map_err(|_| unavailable("Cannot own the configuration process".into()))?;
        }

        // Written beside the wait below, so a child that never reads its input
        // still meets the deadline and Cancel.
        let stdin_task = child.stdin.take().map(|mut stdin| {
            let bytes = serde_json::to_vec(payload).unwrap_or_default();
            tokio::spawn(async move {
                let _ = stdin.write_all(&bytes).await;
                let _ = stdin.shutdown().await;
            })
        });

        let stderr_task = child.stderr.take().map(|stderr| {
            let id = operation_id.to_string();
            let manager = self.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(device) = adapter::parse_event(&line) {
                        manager.show_device(&id, device);
                    }
                }
            })
        });
        let stdout_task = child.stdout.take().map(|mut stream| {
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if buffer.len() + count > STDOUT_LIMIT {
                                break;
                            }
                            buffer.extend_from_slice(&chunk[..count]);
                        }
                    }
                }
                buffer
            })
        });

        enum Stop {
            Exited(std::io::Result<std::process::ExitStatus>),
            Cancelled,
            TimedOut,
        }
        let stop = tokio::select! {
            status = child.wait() => Stop::Exited(status),
            _ = cancel.notified() => Stop::Cancelled,
            _ = tokio::time::sleep(TIMEOUT) => Stop::TimedOut,
        };

        let status = match stop {
            Stop::Exited(status) => status,
            Stop::Cancelled | Stop::TimedOut => {
                // The adapter has no cancel channel of its own, so stopping means the
                // whole job goes. That is the documented loss in ADR 0012.
                job.terminate();
                let _ = child.start_kill();
                let _ = child.wait().await;
                if let Some(task) = stderr_task {
                    task.abort();
                    let _ = task.await;
                }
                if let Some(task) = stdout_task {
                    task.abort();
                }
                if let Some(task) = stdin_task {
                    task.abort();
                }
                return Err(if matches!(stop, Stop::Cancelled) {
                    Outcome { ok: false, code: Some("config-cancelled"), text: None }
                } else {
                    Outcome {
                        ok: false,
                        code: Some("config-timeout"),
                        text: Some("The configuration operation timed out".into()),
                    }
                });
            }
        };
        drop(job);
        if let Some(task) = stdin_task {
            task.abort();
        }
        if let Some(task) = stderr_task {
            let _ = task.await;
        }
        let stdout = match stdout_task {
            Some(task) => task.await.unwrap_or_default(),
            None => Vec::new(),
        };
        let failed = |text: &str| Outcome { ok: false, code: Some("config-failed"), text: Some(text.into()) };
        let status = status.map_err(|_| failed("Cannot check the configuration service"))?;
        let value: Value =
            serde_json::from_slice(&stdout).map_err(|_| failed("Invalid configuration service response"))?;
        if !status.success() {
            let text = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Configuration operation failed");
            return Err(failed(text));
        }
        Ok(value)
    }

    fn show_device(&self, operation_id: &str, device: adapter::DeviceCode) {
        let mut queue = self.lock();
        let Some(running) = queue.running.as_mut().filter(|running| running.id == operation_id) else {
            return;
        };
        running.device = Some(device);
        self.publish(&mut queue);
    }
}

/// Split the control program's answer: the settings, and what belongs to the
/// operation that produced it (a catalog refresh's or decision's outcome, with
/// a held revision), which goes with that operation's result.
fn split_answer(mut answer: Value) -> (Value, Value) {
    let catalog = answer.as_object_mut().and_then(|object| object.remove("catalog"));
    let params = match catalog {
        Some(catalog) => json!({ "catalog": catalog }),
        None => json!({}),
    };
    (answer, params)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
