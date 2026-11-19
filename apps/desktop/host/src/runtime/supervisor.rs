//! One supervisor per runtime process.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

use super::job::Job;
use super::{process, SpawnSpec};

pub enum RuntimeEvent {
    Line(Value),
    Stderr(String),
    ParseError(String),
    IoError(String),
    Exited(Option<i32>),
}

#[derive(Debug)]
pub enum RequestError {
    Timeout,
    Closed(String),
    Runtime(String),
}

pub struct RuntimeSupervisor {
    command_tx: mpsc::Sender<Value>,
    job: Arc<Job>,
    pid: u32,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    parse_errors: AtomicU64,
    probe_id: AtomicU64,
    probe_enabled: AtomicBool,
}

impl RuntimeSupervisor {
    pub fn start(spec: SpawnSpec, events: mpsc::Sender<RuntimeEvent>) -> Result<Arc<Self>, String> {
        let mut spawned = process::spawn(&spec).map_err(|error| error.to_string())?;
        let stdin = spawned
            .child
            .stdin
            .take()
            .ok_or_else(|| "runtime stdin is unavailable".to_string())?;
        let stdout = spawned
            .child
            .stdout
            .take()
            .ok_or_else(|| "runtime stdout is unavailable".to_string())?;
        let stderr = spawned
            .child
            .stderr
            .take()
            .ok_or_else(|| "runtime stderr is unavailable".to_string())?;
        let (command_tx, command_rx) = mpsc::channel(256);
        let supervisor = Arc::new(Self {
            command_tx,
            job: spawned.job,
            pid: spawned.pid,
            pending: Mutex::new(HashMap::new()),
            parse_errors: AtomicU64::new(0),
            probe_id: AtomicU64::new(0),
            probe_enabled: AtomicBool::new(false),
        });

        let writer = supervisor.clone();
        let writer_events = events.clone();
        tokio::spawn(async move { writer_loop(stdin, command_rx, writer, writer_events).await });

        let reader = supervisor.clone();
        let reader_events = events.clone();
        tokio::spawn(async move { stdout_loop(stdout, reader, reader_events).await });

        let stderr_events = events.clone();
        tokio::spawn(async move { stderr_loop(stderr, stderr_events).await });

        let wait = supervisor.clone();
        let wait_events = events;
        tokio::spawn(async move {
            let status = spawned.child.wait().await;
            wait.fail_pending("runtime exited");
            let code = status.ok().and_then(|status| status.code());
            let _ = wait_events.send(RuntimeEvent::Exited(code)).await;
        });

        // A runtime that stops reading stdin or stops answering is otherwise
        // indistinguishable from an idle one. Probe it while it lives; a timeout
        // terminates the job and the ordinary exit path starts recovery.
        let monitor = supervisor.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                // The handshake can take several seconds. Starting, running and
                // recovering turns are not probed; the child exit still reaches the
                // supervisor wait. Only an idle runtime gets the liveness probe.
                if !monitor.probe_enabled.load(Ordering::Relaxed) {
                    continue;
                }
                let id = format!(
                    "health-{}",
                    monitor.probe_id.fetch_add(1, Ordering::Relaxed) + 1
                );
                if monitor
                    .request(
                        json!({ "id": id, "type": "get_state" }),
                        Duration::from_secs(3),
                    )
                    .await
                    .is_err()
                {
                    monitor.job.terminate();
                    break;
                }
            }
        });

        Ok(supervisor)
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn parse_errors(&self) -> u64 {
        self.parse_errors.load(Ordering::Relaxed)
    }

    pub fn set_probe_enabled(&self, enabled: bool) {
        self.probe_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn enqueue(&self, value: Value) -> Result<(), String> {
        self.command_tx
            .try_send(value)
            .map_err(|_| "runtime queue is full".to_string())
    }

    pub async fn request(
        &self,
        value: Value,
        timeout: Duration,
    ) -> Result<Value, RequestError> {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RequestError::Closed("runtime request has no id".to_string()))?
            .to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), tx);
        if self.command_tx.try_send(value).is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            return Err(RequestError::Closed("runtime queue is full".to_string()));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(RequestError::Runtime(message)),
            Ok(Err(_)) => Err(RequestError::Closed(
                "runtime response was dropped".to_string(),
            )),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&id);
                Err(RequestError::Timeout)
            }
        }
    }

    pub fn terminate(&self) {
        self.fail_pending("runtime stopped");
        self.job.terminate();
    }

    pub fn cancel_pending(&self, reason: &str) {
        self.fail_pending(reason);
    }

    fn fail_pending(&self, reason: &str) {
        let pending = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            pending.drain().map(|(_, sender)| sender).collect::<Vec<_>>()
        };
        for sender in pending {
            let _ = sender.send(Err(reason.to_string()));
        }
    }

    fn resolve_response(&self, value: &Value) {
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return;
        };
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        let Some(sender) = sender else {
            return;
        };
        let success = value
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let result = if success {
            Ok(value.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("runtime request failed")
                .to_string())
        };
        let _ = sender.send(result);
    }
}

async fn writer_loop(
    mut stdin: tokio::process::ChildStdin,
    mut commands: mpsc::Receiver<Value>,
    supervisor: Arc<RuntimeSupervisor>,
    events: mpsc::Sender<RuntimeEvent>,
) {
    while let Some(value) = commands.recv().await {
        let mut line = match serde_json::to_vec(&value) {
            Ok(line) => line,
            Err(error) => {
                let _ = events
                    .send(RuntimeEvent::IoError(format!(
                        "runtime command could not be encoded: {error}"
                    )))
                    .await;
                continue;
            }
        };
        line.push(b'\n');
        if let Err(error) = stdin.write_all(&line).await {
            supervisor.fail_pending("runtime input is closed");
            supervisor.job.terminate();
            let _ = events
                .send(RuntimeEvent::IoError(format!(
                    "runtime input is closed: {error}"
                )))
                .await;
            return;
        }
        if let Err(error) = stdin.flush().await {
            supervisor.fail_pending("runtime input is closed");
            supervisor.job.terminate();
            let _ = events
                .send(RuntimeEvent::IoError(format!(
                    "runtime input is closed: {error}"
                )))
                .await;
            return;
        }
    }
}

async fn stdout_loop(
    stdout: tokio::process::ChildStdout,
    supervisor: Arc<RuntimeSupervisor>,
    events: mpsc::Sender<RuntimeEvent>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => {
                        supervisor.resolve_response(&value);
                        if events.send(RuntimeEvent::Line(value)).await.is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        supervisor.parse_errors.fetch_add(1, Ordering::Relaxed);
                        if events
                            .send(RuntimeEvent::ParseError(format!(
                                "unparseable runtime line: {error}"
                            )))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            Ok(None) => return,
            Err(error) => {
                let _ = events
                    .send(RuntimeEvent::IoError(format!(
                        "runtime stdout failed: {error}"
                    )))
                    .await;
                return;
            }
        }
    }
}

async fn stderr_loop(stderr: tokio::process::ChildStderr, events: mpsc::Sender<RuntimeEvent>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() && events.send(RuntimeEvent::Stderr(line)).await.is_err() {
            return;
        }
    }
}
