//! Jouzu configuration executed by the host.
//!
//! One operation at a time, a shared update lock, both pipes read concurrently, the
//! child in its own job object, device codes from stderr as events, and a cancel or a
//! 190 second deadline that terminates the tree. The shell no longer runs this code.

mod adapter;
mod app;

use std::{
    collections::VecDeque,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{broadcast, Notify},
};

use crate::session::ApiError;

pub const TIMEOUT: Duration = Duration::from_secs(190);
const REPLAY: usize = 100;
const STDOUT_LIMIT: usize = 8 * 1024 * 1024;

/// The actions the contract exposes to the UI.
const ACTIONS: &[&str] = &[
    "status",
    "refresh-catalogs",
    "catalog-accept",
    "catalog-reject",
    "profile",
    "import",
    "custom-provider",
    "provider-key",
    "provider-remove",
    "default-model",
    "shisa-login",
    "shisa-logout",
    "provider-oauth",
    "language",
];

#[derive(Debug, Clone, Serialize)]
pub struct ControlEvent {
    pub seq: u64,
    pub event: String,
    pub data: Value,
}

/// The event ring and its subscribers. Cloned into the pipe readers so a device line
/// can be published without borrowing the manager.
struct EventBus {
    seq: AtomicU64,
    sender: broadcast::Sender<ControlEvent>,
    history: Mutex<VecDeque<ControlEvent>>,
    hub: Option<Arc<crate::events::EventHub>>,
}

impl EventBus {
    fn new(hub: Option<Arc<crate::events::EventHub>>) -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            seq: AtomicU64::new(0),
            sender,
            history: Mutex::new(VecDeque::with_capacity(REPLAY)),
            hub,
        }
    }

    fn publish(&self, event: &str, data: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = ControlEvent {
            seq,
            event: event.to_string(),
            data,
        };
        {
            let mut history = self
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if history.len() == REPLAY {
                history.pop_front();
            }
            history.push_back(frame.clone());
        }
        if let Some(hub) = &self.hub {
            hub.publish_control(&frame.event, frame.data.clone());
        }
        let _ = self.sender.send(frame);
    }
}

struct Inflight {
    request_id: String,
    cancel: Arc<Notify>,
}

/// Releases the single control slot and cancels the running operation when the request
/// future is dropped, for example because the page navigated away.
struct InflightGuard<'a> {
    slot: &'a Mutex<Option<Inflight>>,
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        let mut slot = self
            .slot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(active) = slot.take() {
            active.cancel.notify_one();
        }
    }
}

pub struct ControlManager {
    context: adapter::ControlContext,
    inflight: Mutex<Option<Inflight>>,
    bus: Arc<EventBus>,
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
            },
            inflight: Mutex::new(None),
            bus: Arc::new(EventBus::new(events)),
        })
    }

    /// How the adapter is started for one request. The variables saved in
    /// Settings are read here, from the file Settings writes, for every request:
    /// a key saved a moment ago must reach the next refresh without a restart.
    pub fn launch_spec(&self) -> Result<adapter::LaunchSpec, ApiError> {
        let environment = crate::environment::enabled(&self.context.home).map_err(|message| {
            ApiError::internal(format!(
                "Saved environment variables could not be read: {message}. Open Settings > Environment and save them again."
            ))
        })?;
        adapter::spec(&self.context, &environment).map_err(|message| {
            ApiError::internal(format!("Configuration is unavailable: {message}"))
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ControlEvent> {
        self.bus.sender.subscribe()
    }

    /// Every event after `after`, for SSE resume.
    pub fn events_after(&self, after: u64) -> (Vec<ControlEvent>, u64) {
        let history = self
            .bus
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let events: Vec<ControlEvent> = history
            .iter()
            .filter(|event| event.seq > after)
            .cloned()
            .collect();
        let last = events.last().map(|event| event.seq).unwrap_or(after);
        (events, last)
    }

    /// Cancel the active operation, or the one with this id. An idle manager is a no-op.
    pub fn cancel(&self, request_id: Option<&str>) -> bool {
        let inflight = self
            .inflight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(active) = inflight.as_ref() else {
            return false;
        };
        if let Some(requested) = request_id {
            if requested != active.request_id {
                return false;
            }
        }
        active.cancel.notify_one();
        true
    }

    pub async fn request(&self, body: Value) -> Result<Value, ApiError> {
        let action = body
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("status")
            .to_string();
        if !ACTIONS.contains(&action.as_str()) {
            return Err(ApiError::bad_request("Unsupported configuration operation"));
        }
        let request_id = body
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 64)
            .map(ToString::to_string)
            .unwrap_or_else(new_request_id);

        let cancel = Arc::new(Notify::new());
        {
            let mut inflight = self
                .inflight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inflight.is_some() {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "control-busy",
                    "Another configuration operation is running",
                    true,
                ));
            }
            *inflight = Some(Inflight {
                request_id: request_id.clone(),
                cancel: cancel.clone(),
            });
        }
        // The slot is released on drop, including when the HTTP client goes away and
        // axum drops this future: a disconnected request must not wedge control forever.
        let _slot = InflightGuard { slot: &self.inflight };
        let started = Instant::now();
        self.bus.publish(
            "control.started",
            json!({ "requestId": request_id, "action": action, "startedAt": now() }),
        );

        let result = self
            .run(&request_id, &action, body, cancel, started)
            .await;

        match result {
            Ok(value) => {
                self.bus.publish(
                    "control.finished",
                    json!({
                        "requestId": request_id,
                        "action": action,
                        "ok": true,
                        "durationMs": started.elapsed().as_millis() as u64,
                    }),
                );
                Ok(value)
            }
            Err(error) => {
                self.bus.publish(
                    "control.error",
                    json!({
                        "requestId": request_id,
                        "action": action,
                        "code": error.code,
                        "message": error.message,
                        "retryable": error.retryable,
                    }),
                );
                Err(error)
            }
        }
    }

    async fn run(
        &self,
        request_id: &str,
        action: &str,
        body: Value,
        cancel: Arc<Notify>,
        _started: Instant,
    ) -> Result<Value, ApiError> {
        let spec = self.launch_spec()?;
        let mut command = tokio::process::Command::new(&spec.program);
        command
            .args(&spec.args)
            .envs(spec.env.iter().map(|(key, value)| (key, value)))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| ApiError::internal("Cannot start the configuration service"))?;
        let job = child.id().and_then(Job::adopt).ok_or_else(|| {
            ApiError::internal("Cannot own the configuration process")
        })?;

        if let Some(mut stdin) = child.stdin.take() {
            let payload = serde_json::to_vec(&request_payload(&body, action))
                .map_err(|_| ApiError::bad_request("Invalid configuration request"))?;
            let _ = stdin.write_all(&payload).await;
            let _ = stdin.shutdown().await;
            drop(stdin);
        }

        let mut stderr_task = None;
        if let Some(stderr) = child.stderr.take() {
            let bus = self.bus.clone();
            let request_id = request_id.to_string();
            stderr_task = Some(tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(device) = adapter::parse_event(&line) {
                        let mut data = json!({
                            "requestId": request_id,
                            "url": device.url,
                            "code": device.code,
                        });
                        if let Some(provider) = device.provider {
                            data["provider"] = Value::String(provider);
                        }
                        bus.publish("control.device", data);
                    }
                }
            }));
        }
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

        let deadline = tokio::time::sleep(TIMEOUT);
        tokio::pin!(deadline);
        enum Stop {
            Exited(std::io::Result<std::process::ExitStatus>),
            Cancelled,
            TimedOut,
        }
        let stop = tokio::select! {
            status = child.wait() => Stop::Exited(status),
            _ = cancel.notified() => Stop::Cancelled,
            _ = &mut deadline => Stop::TimedOut,
        };

        match stop {
            Stop::Exited(status) => {
                drop(job);
                if let Some(task) = stderr_task.take() {
                    let _ = task.await;
                }
                let stdout = match stdout_task {
                    Some(task) => task.await.unwrap_or_default(),
                    None => Vec::new(),
                };
                let status = status
                    .map_err(|_| ApiError::internal("Cannot check the configuration service"))?;
                let value: Value = serde_json::from_slice(&stdout).map_err(|_| {
                    ApiError::internal("Invalid configuration service response")
                })?;
                if !status.success() {
                    let message = value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Configuration operation failed")
                        .to_string();
                    return Err(ApiError::new(
                        axum::http::StatusCode::BAD_REQUEST,
                        "control-failed",
                        message,
                        true,
                    ));
                }
                Ok(value)
            }
            Stop::Cancelled | Stop::TimedOut => {
                // The adapter has no cancel channel of its own, so stopping means the
                // whole job goes. That is the documented loss in ADR 0012.
                job.terminate();
                let _ = child.start_kill();
                let _ = child.wait().await;
                drop(job);
                if let Some(task) = stderr_task.take() {
                    task.abort();
                }
                if let Some(task) = stdout_task {
                    task.abort();
                }
                let (code, message) = if matches!(stop, Stop::Cancelled) {
                    (
                        "control-cancelled",
                        "Configuration operation cancelled; refresh the status before retrying",
                    )
                } else {
                    (
                        "control-timeout",
                        "Configuration operation timed out; refresh the status before retrying",
                    )
                };
                Err(ApiError::new(
                    axum::http::StatusCode::REQUEST_TIMEOUT,
                    code,
                    message,
                    true,
                ))
            }
        }
    }
}

fn request_payload(body: &Value, action: &str) -> Value {
    let mut payload = body.clone();
    if let Some(object) = payload.as_object_mut() {
        object.insert("action".to_string(), Value::String(action.to_string()));
        object.remove("requestId");
    }
    payload
}

fn new_request_id() -> String {
    format!("c-{:016x}", rand::random::<u64>())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A job object that owns the control child. `Drop` closes the job, which terminates
/// whatever remains because the limit is KILL_ON_JOB_CLOSE.
struct Job {
    handle: isize,
}

impl Job {
    #[cfg(windows)]
    fn adopt(pid: u32) -> Option<Job> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, TerminateJobObject,
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            },
        };
        unsafe {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid).ok()?;
            let assigned = AssignProcessToJobObject(job, process).is_ok();
            let _ = CloseHandle(process);
            if !assigned {
                let _ = CloseHandle(job);
                return None;
            }
            let _ = TerminateJobObject;
            Some(Job {
                handle: job.0 as isize,
            })
        }
    }

    #[cfg(not(windows))]
    fn adopt(_pid: u32) -> Option<Job> {
        None
    }

    #[cfg(windows)]
    fn terminate(&self) {
        use windows::Win32::{Foundation::HANDLE, System::JobObjects::TerminateJobObject};
        unsafe {
            let _ = TerminateJobObject(HANDLE(self.handle as *mut _), 1);
        }
    }

    #[cfg(not(windows))]
    fn terminate(&self) {}
}

impl Drop for Job {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.handle as *mut _,
            ));
        }
    }
}



#[cfg(test)]
mod tests {
    use super::*;

    /// A manager whose runtime home is `<root>/data`, as the shell starts the host.
    fn manager(root: &Path) -> ControlManager {
        let node = root.join("node.exe");
        std::fs::write(&node, "").unwrap();
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        ControlManager::new(root, root, Some(node), &data, None).expect("control manager")
    }

    /// Issue #72: every operation the configuration service implements must be
    /// one the host lets through, or the UI's request is refused before it runs.
    #[test]
    fn every_operation_the_service_handles_is_allowed() {
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
            assert!(ACTIONS.contains(&action.as_str()), "the host refuses `{action}`, which control.mjs handles");
        }
    }

    fn value(spec: &adapter::LaunchSpec, name: &str) -> Option<String> {
        spec.env.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }

    #[test]
    fn an_unreadable_saved_file_fails_the_request_with_a_reason() {
        let root = tempfile::tempdir().unwrap();
        let control = manager(root.path());
        std::fs::write(root.path().join("data").join("launcher-environment.bin"), b"broken").unwrap();
        let error = control.launch_spec().unwrap_err();
        assert!(format!("{error:?}").contains("Saved environment variables could not be read"), "{error:?}");
    }

    /// Issue #63: the configuration service reads the file Settings writes
    /// (`<runtime home>/launcher-environment.bin`) at each request, so a key saved
    /// after the host started reaches the next model refresh.
    #[cfg(windows)]
    #[test]
    fn a_key_saved_after_start_reaches_the_next_request() {
        let root = tempfile::tempdir().unwrap();
        let control = manager(root.path());
        assert_eq!(value(&control.launch_spec().unwrap(), "SHISA_API_KEY"), None);
        let data = root.path().join("data");
        let entry = |value: &str| crate::environment::Entry { name: "SHISA_API_KEY".into(), value: value.into(), enabled: true };
        crate::environment::save(&data, &[entry("first")]).unwrap();
        assert_eq!(value(&control.launch_spec().unwrap(), "SHISA_API_KEY").as_deref(), Some("first"));
        crate::environment::save(&data, &[entry("second")]).unwrap();
        assert_eq!(value(&control.launch_spec().unwrap(), "SHISA_API_KEY").as_deref(), Some("second"));
    }
}
