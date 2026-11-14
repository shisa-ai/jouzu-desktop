//! Session ownership for the host. One pi RPC runtime process per session, a
//! bounded event log, and an exclusive lifecycle independent of any page.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};

fn canonical_path(path: &str) -> String {
    path.strip_prefix("\\\\?\\").unwrap_or(path).to_string()
}

/// The folder a session file says it belongs to (its header's `cwd`), exactly as
/// written. Pi compares folders as text (resolved and lower-cased, but `\\?\C:\x`
/// and `C:\x` differ), and a runtime switched to a session whose folder differs
/// from its own loads every extension again; so the runtime starts in this form.
fn session_header(session_path: &str) -> Option<Value> {
    use std::io::BufRead;
    let file = std::fs::File::open(session_path).ok()?;
    let mut line = String::new();
    std::io::BufReader::new(file).read_line(&mut line).ok()?;
    let header: Value = serde_json::from_str(line.trim()).ok()?;
    (header.get("type").and_then(Value::as_str) == Some("session")).then_some(header)
}

/// The conversation id a session file carries. A copied file keeps it, and the
/// runtime lets only one attachment own a conversation at a time.
fn session_header_id(session_path: &str) -> Option<String> {
    session_header(session_path)?
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn session_header_cwd(session_path: &str) -> Option<String> {
    let header = session_header(session_path)?;
    let cwd = header.get("cwd").and_then(Value::as_str)?.to_string();
    Path::new(&cwd).is_dir().then_some(cwd)
}

/// The messages a saved session file holds, in the order they were written.
fn saved_messages(path: &Path) -> std::io::Result<Vec<Value>> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(std::io::Read::take(file, 32 * 1024 * 1024));
    let mut messages = Vec::new();
    for line in std::io::BufRead::lines(reader) {
        let Ok(line) = line else { break };
        let Ok(mut value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(message) = value.get_mut("message").map(Value::take) {
                messages.push(message);
            }
        }
    }
    Ok(messages)
}

fn is_scratch_workspace(path: &str) -> bool {
    path.split(|character| character == '\\' || character == '/')
        .any(|part| part.starts_with("jouzu-warm-"))
}
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::log;
use crate::runtime::adapter::pi::{self, DeltaKind, Record as PiRecord};
use crate::runtime::{same_place, RequestError, RuntimeEvent, RuntimeSupervisor, SpawnSpec, WarmPool};

#[derive(Debug, Default, Deserialize, Serialize)]
struct SessionPreference {
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    title: Option<String>,
}

use sha2::{Digest, Sha256};

pub const DEFAULT_REPLAY_LIMIT: usize = 5_000;
const MAX_TEXT_BYTES: usize = 32 * 1024;

#[derive(Clone)]
pub struct RuntimeSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl RuntimeSpec {
    /// The provisioned runtime rooted at the managed directory.
    pub fn from_managed(managed: &Path) -> Option<Self> {
        let node = std::env::var_os("JOUZU_HOST_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| managed.join("runtime").join("node").join("node.exe"));
        let bootstrap = managed.join("app").join("bootstrap.mjs");
        if !node.is_file() || !bootstrap.is_file() {
            return None;
        }
        Some(Self {
            program: node,
            args: vec![
                bootstrap.to_string_lossy().into_owned(),
                "--mode".to_string(),
                "rpc".to_string(),
            ],
            env: Vec::new(),
        })
    }

    pub fn node_script(script: &Path) -> Self {
        Self {
            program: find_program("node.exe").unwrap_or_else(|| PathBuf::from("node")),
            args: vec![script.to_string_lossy().into_owned()],
            env: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct SessionConfig {
    pub spec: RuntimeSpec,
    pub home: PathBuf,
    pub runtime_home: PathBuf,
    pub bash: Option<PathBuf>,
    pub replay_limit: usize,
    pub events: Option<Arc<crate::events::EventHub>>,
    /// The runtime started ahead of need, shared by every session.
    pub warm: Arc<std::sync::OnceLock<Arc<WarmPool>>>,
}

impl SessionConfig {
    /// The runtime's environment. Session-specific variables are left out for
    /// a warm runtime, which does not belong to a session yet.
    fn environment(
        &self,
        session_id: Option<&str>,
        session_path: Option<&str>,
    ) -> Vec<(OsString, OsString)> {
        let mut environment: HashMap<String, (OsString, OsString)> = std::env::vars_os()
            .filter(|(name, _)| {
                let text = name.to_string_lossy();
                !text.is_empty() && !text.contains('=') && !text.contains('\0')
            })
            .map(|(key, value)| (key.to_string_lossy().to_ascii_uppercase(), (key, value)))
            .collect();
        for name in ["NODE_OPTIONS", "NODE_PATH"] {
            environment.remove(name);
        }
        let mut set = |name: &str, value: OsString| {
            environment.insert(name.to_ascii_uppercase(), (OsString::from(name), value));
        };
        set("JOUZU_HOME", self.runtime_home.as_os_str().to_os_string());
        set("JOUZU_NO_UPDATE", OsString::from("1"));
        set("PI_SKIP_VERSION_CHECK", OsString::from("1"));
        set("JOUZU_TEXTGUARD_DESKTOP", OsString::from("1"));
        if let Some(id) = session_id {
            set("JOUZU_HOST_SESSION_ID", OsString::from(id));
        }
        if let Some(bash) = &self.bash {
            set("JOUZU_LAUNCHER_BASH", bash.as_os_str().to_os_string());
        }
        if let Some(path) = session_path {
            set("JOUZU_SESSION_PATH", OsString::from(path));
        }
        for (key, value) in &self.spec.env {
            set(key, OsString::from(value));
        }
        environment.into_values().collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Starting,
    Idle,
    Running,
    WaitingApproval,
    WaitingQuestion,
    Recovering,
    Cancelled,
    Stopped,
    Error,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Starting => "starting",
            Status::Idle => "idle",
            Status::Running => "running",
            Status::WaitingApproval => "waiting_approval",
            Status::WaitingQuestion => "waiting_question",
            Status::Recovering => "recovering",
            Status::Cancelled => "cancelled",
            Status::Stopped => "stopped",
            Status::Error => "error",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionEvent {
    pub id: u64,
    pub event: String,
    pub data: Value,
}

#[derive(Default)]
struct EventLog {
    next: u64,
    events: VecDeque<SessionEvent>,
    limit: usize,
    bytes: usize,
}

impl EventLog {
    fn new(limit: usize) -> Self {
        Self {
            next: 1,
            events: VecDeque::new(),
            limit: limit.max(1),
            bytes: 0,
        }
    }

    fn push(&mut self, session_id: &str, event: &str, mut data: Value) -> SessionEvent {
        let id = self.next;
        self.next += 1;
        if let Some(object) = data.as_object_mut() {
            object.insert(
                "sessionId".to_string(),
                Value::String(session_id.to_string()),
            );
        }
        let stored = SessionEvent {
            id,
            event: event.to_string(),
            data,
        };
        self.bytes += serde_json::to_vec(&stored).map(|value| value.len()).unwrap_or(0);
        self.events.push_back(stored.clone());
        while (self.events.len() > self.limit || self.bytes > 2 * 1024 * 1024)
            && self.events.len() > 1
        {
            if let Some(removed) = self.events.pop_front() {
                self.bytes = self.bytes.saturating_sub(
                    serde_json::to_vec(&removed)
                        .map(|value| value.len())
                        .unwrap_or(0),
                );
            }
        }
        stored
    }

    fn last_id(&self) -> u64 {
        self.next.saturating_sub(1)
    }

    fn oldest_id(&self) -> Option<u64> {
        self.events.front().map(|event| event.id)
    }

    fn after(&self, after: u64) -> Vec<SessionEvent> {
        self.events
            .iter()
            .filter(|event| event.id > after)
            .cloned()
            .collect()
    }
}

const FLOW_RELEASE_ID: &str = "host-flow-release";

/// A runtime message's content as host history blocks: words, reasoning and tool
/// calls. Live replies and replies read back from a saved file use this one
/// mapping, so a conversation has the same shape either way.
fn reply_blocks(message: &Value) -> Vec<Value> {
    let mut blocks = Vec::new();
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return blocks;
    };
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
            }
            Some("thinking") => {
                if let Some(text) = block
                    .get("thinking")
                    .or_else(|| block.get("text"))
                    .and_then(Value::as_str)
                {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "thinking", "text": text }));
                    }
                }
            }
            Some("toolCall") => {
                if let Some(id) = block
                    .get("toolCallId")
                    .or_else(|| block.get("id"))
                    .and_then(Value::as_str)
                {
                    blocks.push(json!({
                        "type": "toolCall",
                        "toolCallId": id,
                        "name": block.get("name").and_then(Value::as_str).unwrap_or("tool"),
                        "input": block.get("arguments").or_else(|| block.get("input")).cloned().unwrap_or(Value::Null),
                    }));
                }
            }
            _ => {}
        }
    }
    blocks
}

/// What a tool that never finished shows: it was cut off, not still running.
fn interrupted_result() -> Value {
    json!({ "content": [{ "type": "text", "text": "Interrupted" }] })
}

/// Adds a result for every tool call in `blocks` that has none.
fn close_unfinished_calls(blocks: &mut Vec<Value>) -> Vec<String> {
    let finished: std::collections::HashSet<String> = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("toolResult"))
        .filter_map(|block| block.get("toolCallId").and_then(Value::as_str).map(str::to_string))
        .collect();
    let open: Vec<String> = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("toolCall"))
        .filter_map(|block| block.get("toolCallId").and_then(Value::as_str).map(str::to_string))
        .filter(|id| !finished.contains(id))
        .collect();
    for id in &open {
        blocks.push(json!({
            "type": "toolResult",
            "toolCallId": id,
            "ok": false,
            "interrupted": true,
            "result": interrupted_result(),
        }));
    }
    open
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Handshake {
    Switch,
    Messages,
    Ready,
}

/// Where the running turn is: which step (one model call and the tools it asks
/// for) and what that step is doing. The host works this out from the runtime's
/// events in one place; clients show it as given.
struct StepState {
    n: u64,
    state: &'static str,
    since: String,
    since_at: Instant,
    started_at: Instant,
    first_output: bool,
    /// The history row of this step's finished reply, once the model is done
    /// writing it; the step's tool calls and results are added to it.
    row: Option<String>,
    tools: Vec<(String, String, Instant)>,
    retry: Option<Value>,
}

impl StepState {
    fn new() -> Self {
        Self {
            n: 0,
            state: "waiting_model",
            since: Session::now_iso(),
            since_at: Instant::now(),
            started_at: Instant::now(),
            first_output: false,
            row: None,
            tools: Vec::new(),
            retry: None,
        }
    }
}

/// Time from a prompt reaching the runtime to its first output, over this
/// host run. The runtime's own start is not in it.
#[derive(Default)]
struct FirstOutput {
    sent: Option<Instant>,
    count: u64,
    total_ms: u64,
    last_ms: Option<u64>,
}

struct SentMessage {
    message_id: String,
    text: String,
}

/// A message the user sent while a turn ran. The host keeps it until the
/// runtime has used it: delivered into the running turn (steer), or started as
/// the next turn. Nothing leaves this queue on a guess, so a message is never
/// lost or sent twice across reconnects, Stop, or a runtime restart.
struct Queued {
    turn: String,
    prompt: Value,
    /// The user's row, written to history when the runtime uses the message.
    /// A retried turn already has its row.
    row: Option<Value>,
    /// Handed to the runtime as `steer` (the clear generation it belongs to)
    /// and not yet delivered.
    steered: Option<u64>,
    /// The runtime would not take it as steer; it runs as its own turn.
    no_steer: bool,
}

impl Queued {
    fn client_message_id(&self) -> Option<&str> {
        self.prompt.get("id").and_then(Value::as_str)
    }

    fn text(&self) -> &str {
        self.prompt.get("message").and_then(Value::as_str).unwrap_or("")
    }
}

const STEER_ID_PREFIX: &str = "steer:";
const CLEAR_QUEUE_ID_PREFIX: &str = "clear-queue:";

struct PendingApproval {
    pi_id: String,
    data: Value,
}

struct PendingQuestion {
    pi_id: String,
    data: Value,
    question_ids: Vec<String>,
    options: std::collections::HashMap<String, Vec<String>>,
}

pub struct Session {
    pub id: String,
    pub workspace_path: String,
    pub session_path: Mutex<Option<String>>,
    pub key: String,
    status: Mutex<Status>,
    events: Mutex<EventLog>,
    tx: broadcast::Sender<SessionEvent>,
    runtime: Mutex<Option<Arc<RuntimeSupervisor>>>,
    runtime_generation: AtomicU64,
    restarts: crate::runtime::restart::RestartBudget,
    config: SessionConfig,
    lease_path: PathBuf,
    messages: Mutex<HashMap<String, SentMessage>>,
    queued_turns: Mutex<VecDeque<Queued>>,
    /// Steered messages up to this generation are being taken back (`clear_queue`).
    steer_generation: AtomicU64,
    /// The running turn's own prompt has not come back from the runtime yet;
    /// the first user message of a run is that prompt, not a steered one.
    prompt_echo: AtomicBool,
    first_output_turn: Mutex<Option<String>>,
    first_output: Mutex<FirstOutput>,
    /// Held while this session attaches to a runtime from the warm pool.
    warm_attach: Mutex<Option<(crate::runtime::warm::Attaching, Instant)>>,
    queue_paused: AtomicBool,
    pending_prompts: Mutex<Vec<Value>>,
    next_message: AtomicU64,
    next_request: AtomicU64,
    active_message: Mutex<Option<String>>,
    active_client_message: Mutex<Option<String>>,
    turn_started_at: Mutex<Option<String>>,
    cancelling: AtomicBool,
    turn_running: AtomicBool,
    /// A model request was cut off by a runtime exit. The runtime's Flow control
    /// withholds it (and any new input) until someone decides; the host already
    /// decided (the turn failed), so recovery releases the hold before going idle.
    release_flow_hold: AtomicBool,
    cancelled: Mutex<HashMap<String, Instant>>,
    failed_turn: Mutex<Option<Value>>,
    listed: Mutex<bool>,
    title: Mutex<String>,
    updated_at: Mutex<Option<String>>,
    handshake: Mutex<Handshake>,
    ready: tokio::sync::Notify,
    pending_approvals: Mutex<HashMap<String, PendingApproval>>,
    pending_questions: Mutex<HashMap<String, PendingQuestion>>,
    /// Extension status lines (`setStatus`), keyed by the extension's status key.
    ui_statuses: Mutex<BTreeMap<String, String>>,
    /// Extension widgets (`setWidget`), keyed by the extension's widget key.
    ui_widgets: Mutex<BTreeMap<String, Vec<String>>>,
    approval_outcomes: Mutex<HashMap<String, String>>,
    question_outcomes: Mutex<HashMap<String, String>>,
    next_prompt: AtomicU64,
    home: PathBuf,
    runtime_home: PathBuf,
    history: Mutex<Vec<Value>>,
    history_seq: AtomicU64,
    assistant_text: Mutex<String>,
    assistant_blocks: Mutex<Vec<Value>>,
    step: Mutex<StepState>,
    active_client: Mutex<Option<String>>,
    model: Mutex<Option<Value>>,
    pending_model: Mutex<Option<Value>>,
    /// The request that applies a model chosen before the runtime started; its
    /// failure is reported to the user, since nobody is waiting on it.
    pending_model_request: Mutex<Option<(String, Value)>>,
    pending_thinking: Mutex<Option<String>>,
    /// The reasoning level the runtime reports (or the one chosen and not yet applied).
    thinking_level: Mutex<Option<String>>,
    subscribers: AtomicU64,
    next_client: AtomicU64,
    last_activity: Mutex<Instant>,
}

impl Session {
    pub fn status(&self) -> Status {
        *self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A runtime is up and answering. Starting, recovering or never started
    /// sessions have none, and questions about the runtime have no answer yet.
    pub fn has_runtime(&self) -> bool {
        !matches!(
            self.status(),
            Status::Pending | Status::Starting | Status::Recovering | Status::Stopped | Status::Error
        ) && self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }

    /// The session's own saved file, once the runtime has written one.
    pub fn saved_path(&self) -> Option<String> {
        self.session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn cursor(&self) -> u64 {
        self.events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .last_id()
    }

    fn touch(&self) {
        *self
            .last_activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
    }

    pub fn subscriber_count(&self) -> u64 {
        self.subscribers.load(Ordering::Relaxed)
    }

    pub fn last_activity(&self) -> Instant {
        *self
            .last_activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn join_client(&self, client_id: &str, capabilities: &[String]) -> u64 {
        let attach = self.next_client.fetch_add(1, Ordering::Relaxed) + 1;
        self.subscribers.fetch_add(1, Ordering::Relaxed);
        self.publish(
            "client.joined",
            json!({
                "attachId": attach,
                "clientId": client_id,
                "capabilities": capabilities,
            }),
        );
        attach
    }

    pub fn leave_client(&self, attach: u64, client_id: &str) {
        self.subscribers.fetch_sub(1, Ordering::Relaxed);
        self.publish(
            "client.left",
            json!({ "attachId": attach, "clientId": client_id }),
        );
    }

    fn active_client(&self) -> Option<String> {
        self.active_client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn history(&self, limit: usize, before: Option<u64>) -> Value {
        let limit = limit.clamp(1, 1000);
        let history = self
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut rows: Vec<&Value> = history
            .iter()
            .filter(|row| {
                before.is_none_or(|before| {
                    row.get("cursor").and_then(Value::as_u64).unwrap_or(0) < before
                })
            })
            .collect();
        rows.sort_by_key(|row| std::cmp::Reverse(row.get("cursor").and_then(Value::as_u64).unwrap_or(0)));
        let page: Vec<Value> = rows.into_iter().take(limit).cloned().collect();
        let next_before = if page.len() == limit {
            page.last().and_then(|row| row.get("cursor")).and_then(Value::as_u64)
        } else {
            None
        };
        let mut page = page;
        // A resync while a step is streaming must include what it has already
        // said. This row is synthetic: the step's reply is appended to history
        // when the runtime finishes writing it.
        let active = self
            .active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(turn) = active {
            let text = self
                .assistant_text
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let blocks = self
                .assistant_blocks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if !text.is_empty() || !blocks.is_empty() {
                let n = self.step_guard().n.max(1);
                let mut row = json!({
                    "kind": "assistant",
                    "id": format!("{turn}:assistant:{n}"),
                    "turnId": turn,
                    "step": n,
                    "text": text,
                    "blocks": if blocks.is_empty() { json!([{ "type": "text", "text": text }]) } else { json!(blocks) },
                    "createdAt": Self::now_iso(),
                    "partial": true,
                    "cursor": 0,
                });
                if let Some(model) = self
                    .model
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
                {
                    row["model"] = model
                        .get("name")
                        .or_else(|| model.get("id"))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                page.insert(0, row);
            }
        }
        json!({ "messages": page, "nextBefore": next_before })
    }

    fn push_history(&self, mut row: Value) {
        let cursor = self.history_seq.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(object) = row.as_object_mut() {
            object.insert("cursor".to_string(), json!(cursor));
        }
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(row);
    }

    /// A queued message the runtime has used: its row joins history now, where
    /// it happened in the conversation, and every client is told.
    fn deliver_user_row(&self, mut row: Value, turn: &str) {
        if let Some(object) = row.as_object_mut() {
            object.insert("turnId".to_string(), json!(turn));
            object.insert("createdAt".to_string(), json!(Self::now_iso()));
        }
        self.push_history(row.clone());
        let row = self
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .last()
            .cloned()
            .unwrap_or(row);
        self.publish("message.user", row);
    }

    /// Hand every waiting message to the running turn. The runtime delivers
    /// each one at its next step boundary, before the next model call.
    fn steer_queue(&self) {
        if self.queue_paused.load(Ordering::SeqCst)
            || self.cancelling.load(Ordering::SeqCst)
            || self.active_turn().is_none()
            || !matches!(
                self.status(),
                Status::Running | Status::WaitingApproval | Status::WaitingQuestion
            )
        {
            return;
        }
        let generation = self.steer_generation.load(Ordering::SeqCst);
        let commands: Vec<Value> = {
            let mut queue = self
                .queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue
                .iter_mut()
                .filter(|item| item.steered.is_none() && !item.no_steer)
                .map(|item| {
                    item.steered = Some(generation);
                    pi::command::with_id(
                        pi::command::as_steer(&item.prompt),
                        &format!("{STEER_ID_PREFIX}{}", item.client_message_id().unwrap_or_default()),
                    )
                })
                .collect()
        };
        for command in commands {
            if self.write_command(command).is_err() {
                break;
            }
        }
    }

    /// Take back steered messages the runtime has not delivered (a turn ended,
    /// Stop, or one was removed). They stay queued here; the runtime's answer
    /// says the take-back is done.
    fn reclaim_steered(&self) {
        let any = self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|item| item.steered.is_some());
        if any {
            self.clear_runtime_queue();
        }
    }

    fn clear_runtime_queue(&self) {
        let generation = self.steer_generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.write_command(pi::command::with_id(
            pi::command::clear_queue(),
            &format!("{CLEAR_QUEUE_ID_PREFIX}{generation}"),
        ));
    }

    /// A user message the runtime put into the running turn.
    fn user_message_started(&self, message: Option<&Value>) {
        let Some(turn) = self.active_turn() else { return };
        if self.prompt_echo.swap(false, Ordering::SeqCst) {
            return;
        }
        let text = message
            .and_then(|message| message.get("content"))
            .map(pi::content_text)
            .unwrap_or_default();
        let delivered = {
            let mut queue = self
                .queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // The runtime delivers what it was given; a slash command arrives expanded.
            let at = queue
                .iter()
                .position(|item| item.steered.is_some() && item.text() == text)
                .or_else(|| {
                    queue
                        .iter()
                        .position(|item| item.steered.is_some() && item.text().starts_with('/'))
                });
            at.and_then(|at| queue.remove(at))
        };
        let row = match delivered {
            Some(item) => item.row,
            None if text.is_empty() => None,
            // Not one of ours (taken back too late, or added by an extension):
            // the transcript has it, so history shows it.
            None => {
                let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
                Some(json!({
                    "kind": "user",
                    "id": format!("m-{counter}:user"),
                    "text": text,
                    "blocks": [{ "type": "text", "text": text }],
                }))
            }
        };
        if let Some(row) = row {
            self.deliver_user_row(row, &turn);
        }
        self.publish_summary();
    }

    /// The runtime answered a steer or a take-back.
    fn queue_response(self: &Arc<Self>, id: &str, value: &Value) {
        if let Some(client) = id.strip_prefix(STEER_ID_PREFIX) {
            let success = value.get("success").and_then(Value::as_bool) == Some(true);
            let handled = value.pointer("/data/disposition").and_then(Value::as_str) == Some("handled");
            if success && !handled {
                return;
            }
            let item = {
                let mut queue = self
                    .queued_turns
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(at) = queue
                    .iter()
                    .position(|item| item.client_message_id() == Some(client))
                else {
                    return;
                };
                if handled {
                    queue.remove(at)
                } else {
                    // Refused as steer (an extension command): it runs as its own
                    // turn after this one, where the runtime can answer it properly.
                    log(
                        &self.home,
                        "info",
                        "queue.steer_refused",
                        json!({ "session": self.id, "error": value.get("error") }),
                    );
                    queue[at].steered = None;
                    queue[at].no_steer = true;
                    None
                }
            };
            // Flow kept it: it was the user's message all the same.
            if let (Some(item), Some(turn)) = (item, self.active_turn()) {
                if let Some(row) = item.row {
                    self.deliver_user_row(row, &turn);
                }
            }
            self.publish_summary();
            return;
        }
        let Some(generation) = id
            .strip_prefix(CLEAR_QUEUE_ID_PREFIX)
            .and_then(|generation| generation.parse::<u64>().ok())
        else {
            return;
        };
        // Everything steered up to this take-back that was not delivered before
        // it (deliveries arrive first) is back in our hands.
        for item in self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter_mut()
        {
            if item.steered.is_some_and(|steered| steered <= generation) {
                item.steered = None;
            }
        }
        if self.active_turn().is_some() {
            self.steer_queue();
        }
        self.publish_summary();
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn remember_turn(&self, text: &str) {
        *self
            .listed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        *self
            .updated_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Self::now_iso());
        let mut title = self
            .title
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if title.is_empty() {
            let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
            *title = compact.chars().take(80).collect();
        }
        drop(title);
        self.publish_summary();
    }

    fn append_assistant_block(&self, kind: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut blocks = self
            .assistant_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(last) = blocks.last_mut() {
            if last.get("type").and_then(Value::as_str) == Some(kind) {
                let merged = format!(
                    "{}{}",
                    last.get("text").and_then(Value::as_str).unwrap_or(""),
                    text
                );
                last["text"] = Value::String(merged);
                return;
            }
        }
        blocks.push(json!({ "type": kind, "text": text }));
    }

    fn step_guard(&self) -> std::sync::MutexGuard<'_, StepState> {
        self.step.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn active_turn_id(&self) -> Option<String> {
        self.active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The turn in progress, as clients show it: which step and what it is doing.
    fn step_view(&self) -> Value {
        let step = self.step_guard();
        json!({
            "n": step.n,
            "state": step.state,
            "since": step.since,
            "tools": step.tools.iter().map(|(id, name, _)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
            "retry": step.retry,
        })
    }

    fn reset_step(&self) {
        *self.step_guard() = StepState::new();
    }

    fn set_step_state(&self, state: &'static str) {
        let changed = {
            let mut step = self.step_guard();
            if step.state == state {
                false
            } else {
                step.state = state;
                step.since = Self::now_iso();
                step.since_at = Instant::now();
                true
            }
        };
        if changed {
            self.publish_summary();
        }
    }

    fn log_step(&self, mark: &str, fields: Value) {
        let mut data = json!({
            "session": self.id,
            "mark": mark,
            "turnId": self.active_turn_id(),
            "clientMessageId": self
                .active_client_message
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
        });
        if let (Some(data), Some(fields)) = (data.as_object_mut(), fields.as_object()) {
            for (key, value) in fields {
                data.insert(key.clone(), value.clone());
            }
        }
        log(&self.home, "info", "timing", data);
    }

    /// A new step: the runtime is asking the model again. Whatever the previous
    /// step left unwritten is kept as its reply first.
    fn begin_step(&self) {
        let Some(turn) = self.active_turn_id() else {
            return;
        };
        self.finish_step_reply(&turn, None, false);
        let n = {
            let mut step = self.step_guard();
            step.n += 1;
            step.state = "waiting_model";
            step.since = Self::now_iso();
            step.since_at = Instant::now();
            step.started_at = Instant::now();
            step.first_output = false;
            step.row = None;
            step.tools.clear();
            step.retry = None;
            step.n
        };
        self.log_step("step.start", json!({ "step": n }));
        self.publish(
            "message.start",
            json!({ "messageId": turn, "turnId": turn, "step": n, "role": "assistant" }),
        );
        self.publish_summary();
    }

    /// Output that arrives with no step begun (a runtime that does not mark
    /// steps) starts the first one.
    fn ensure_step(&self) {
        if self.step_guard().n == 0 {
            self.begin_step();
        }
    }

    /// The step shows something: its first output is timed against the moment it
    /// asked the model.
    fn step_output(&self, state: &'static str) {
        let first = {
            let mut step = self.step_guard();
            if step.first_output {
                None
            } else {
                step.first_output = true;
                Some((step.n, step.started_at.elapsed().as_millis() as u64))
            }
        };
        if let Some((n, wait)) = first {
            self.log_step("step.first_output", json!({ "step": n, "waitMs": wait }));
        }
        self.set_step_state(state);
    }

    /// The step's reply is complete (or cut off): it becomes a history row of its
    /// own. `message` is the runtime's own record of the reply when it has one.
    fn finish_step_reply(&self, turn: &str, message: Option<&Value>, interrupted: bool) {
        let text = std::mem::take(
            &mut *self
                .assistant_text
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        let streamed = std::mem::take(
            &mut *self
                .assistant_blocks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        let mut blocks = message.map(reply_blocks).unwrap_or_default();
        if blocks.is_empty() {
            blocks = streamed;
        } else {
            // Calls and results the runtime reported apart from the reply.
            for block in streamed {
                let kind = block.get("type").and_then(Value::as_str);
                let id = block.get("toolCallId").and_then(Value::as_str);
                let known = blocks.iter().any(|known| {
                    known.get("type").and_then(Value::as_str) == kind
                        && known.get("toolCallId").and_then(Value::as_str) == id
                });
                if matches!(kind, Some("toolCall" | "toolResult")) && !known {
                    blocks.push(block);
                }
            }
        }
        if blocks.is_empty() && !text.is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
        // A reply with nothing in it is still a reply when it carries an error.
        let failed = message
            .and_then(|message| message.get("errorMessage"))
            .is_some_and(|error| !error.is_null());
        if blocks.is_empty() && !failed {
            return;
        }
        let n = self.step_guard().n.max(1);
        let id = format!("{turn}:assistant:{n}");
        let words = blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        let stop_reason = message
            .and_then(|message| message.get("stopReason"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| if interrupted { "aborted" } else { "stop" }.to_string());
        let mut row = json!({
            "kind": "assistant",
            "id": id,
            "turnId": turn,
            "step": n,
            "text": words,
            "blocks": blocks,
            "stopReason": stop_reason,
            "createdAt": Self::now_iso(),
        });
        if interrupted {
            row["interrupted"] = json!(true);
        }
        if let Some(message) = message {
            for field in ["model", "provider", "usage", "errorMessage"] {
                if let Some(value) = message.get(field).filter(|value| !value.is_null()) {
                    row[field] = value.clone();
                }
            }
        }
        if row.get("model").map(Value::is_null).unwrap_or(true) {
            if let Some(model) = self
                .model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                row["model"] = model
                    .get("name")
                    .or_else(|| model.get("id"))
                    .cloned()
                    .unwrap_or(Value::Null);
                if let Some(provider) = model.get("provider") {
                    row["provider"] = provider.clone();
                }
            }
        }
        self.push_history(row.clone());
        self.step_guard().row = Some(id);
        self.publish(
            "message.done",
            json!({
                "messageId": turn,
                "step": n,
                "stopReason": stop_reason,
                "blocks": row.get("blocks").cloned().unwrap_or_else(|| json!([])),
                "model": row.get("model").cloned().unwrap_or(Value::Null),
                "provider": row.get("provider").cloned().unwrap_or(Value::Null),
                "usage": row.get("usage").cloned().unwrap_or(Value::Null),
                "errorMessage": row.get("errorMessage").cloned().unwrap_or(Value::Null),
            }),
        );
    }

    /// A tool call or result belongs to the step's reply: in the history row once
    /// the reply is written, otherwise with what is still streaming.
    fn add_to_step_reply(&self, block: Value) {
        let row = self.step_guard().row.clone();
        if let Some(row) = row {
            let mut history = self
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(blocks) = history
                .iter_mut()
                .rev()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(row.as_str()))
                .and_then(|entry| entry.get_mut("blocks"))
                .and_then(Value::as_array_mut)
            {
                let kind = block.get("type").and_then(Value::as_str);
                let id = block.get("toolCallId").and_then(Value::as_str);
                let known = blocks.iter().any(|known| {
                    known.get("type").and_then(Value::as_str) == kind
                        && known.get("toolCallId").and_then(Value::as_str) == id
                });
                if !known {
                    blocks.push(block);
                }
                return;
            }
        }
        self.assistant_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(block);
    }

    /// When a turn ends, no tool of it is still at work: any without a result
    /// was cut off, and says so, live and in history.
    fn close_unfinished_tools(&self) {
        let mut closed = Vec::new();
        {
            let mut history = self
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for entry in history.iter_mut() {
                match entry.get("kind").and_then(Value::as_str) {
                    Some("tool") if entry["tool"]["status"] == "running" => {
                        entry["tool"]["status"] = json!("interrupted");
                        entry["result"] = interrupted_result();
                        if let Some(id) = entry["tool"]["callId"].as_str() {
                            closed.push(id.to_string());
                        }
                    }
                    Some("assistant") => {
                        if let Some(blocks) = entry.get_mut("blocks").and_then(Value::as_array_mut) {
                            closed.extend(close_unfinished_calls(blocks));
                        }
                    }
                    _ => {}
                }
            }
        }
        closed.sort();
        closed.dedup();
        for id in closed {
            self.publish(
                "tool.result",
                json!({ "toolCallId": id, "ok": false, "interrupted": true, "result": interrupted_result() }),
            );
        }
    }

    fn update_history_tool(&self, call_id: &str, status: &str, result: Value) {
        if call_id.is_empty() {
            return;
        }
        let id = format!("tool:{call_id}");
        let mut history = self
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = history.iter_mut().rev().find(|entry| entry["id"] == id) {
            entry["tool"]["status"] = Value::String(status.to_string());
            entry["result"] = result;
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.tx.subscribe()
    }

    pub fn snapshot_event(&self) -> SessionEvent {
        let cursor = self.cursor();
        SessionEvent {
            id: cursor,
            event: "session.snapshot".to_string(),
            data: json!({
                "sessionId": self.id,
                "status": self.status().as_str(),
                "activeTurn": self.active_turn(),
                "cursor": cursor,
                "workspacePath": canonical_path(&self.workspace_path),
                "sessionPath": self
                    .session_path
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                "pendingApprovals": self.pending_approvals(),
                "pendingQuestions": self.pending_questions(),
                "statuses": self.ui_statuses(),
                "widgets": self.ui_widgets(),
                "model": self
                    .model
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
                "thinkingLevel": self
                    .thinking_level
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone(),
            }),
        }
    }

    fn ui_statuses(&self) -> Value {
        json!(*self
            .ui_statuses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    fn ui_widgets(&self) -> Value {
        json!(*self
            .ui_widgets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    pub fn events_after(&self, after: u64) -> (Vec<SessionEvent>, u64) {
        let log = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let oldest = log.oldest_id();
        let stale = after == 0
            || oldest.is_none()
            || after > log.last_id()
            || oldest.is_some_and(|oldest| after < oldest.saturating_sub(1));
        if stale {
            drop(log);
            let snapshot = self.snapshot_event();
            let cursor = snapshot.id;
            return (vec![snapshot], cursor);
        }
        let events = log.after(after);
        let cursor = events.last().map(|event| event.id).unwrap_or(after);
        (events, cursor)
    }

    /// One `timing` line in host.log for each moment a user would notice: accepted,
    /// started, first output, done, and status changes. The same lines are written
    /// in every build, so a report from any installation can be timed afterwards.
    /// Content is never logged, only the event and its ids.
    fn record_timing(&self, event: &str, data: &Value) {
        // The prompt reaches the runtime when the turn runs: at its start, or when a
        // turn that waited for the runtime starts running.
        let running = (event == "turn.start" && data.get("phase").and_then(Value::as_str) == Some("running"))
            || (event == "session.status" && data.get("status").and_then(Value::as_str) == Some("running"));
        if running {
            let mut first = self
                .first_output
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if first.sent.is_none() {
                first.sent = Some(Instant::now());
            }
        }
        if event == "turn.end" {
            self.first_output
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .sent = None;
        }
        let mark = match event {
            "message.accepted" | "turn.start" | "message.done" | "turn.end" | "session.status" => event,
            // The first thing the reply shows: words, thinking, or a tool at work.
            "message.delta" | "tool.start" => {
                let id = data
                    .get("messageId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        self.active_message
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .clone()
                    })
                    .unwrap_or_default();
                let id = id.as_str();
                let mut last = self
                    .first_output_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if last.as_deref() == Some(id) {
                    return;
                }
                *last = Some(id.to_string());
                let mut first = self
                    .first_output
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(sent) = first.sent.take() {
                    let ms = sent.elapsed().as_millis() as u64;
                    first.count += 1;
                    first.total_ms += ms;
                    first.last_ms = Some(ms);
                }
                "message.first_output"
            }
            _ => return,
        };
        let turn = data
            .get("turnId")
            .or_else(|| data.get("messageId"))
            .cloned()
            .unwrap_or(Value::Null);
        let client_message = self
            .active_client_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        log(
            &self.home,
            "info",
            "timing",
            json!({
                "session": self.id,
                "mark": mark,
                "turnId": turn,
                "clientMessageId": client_message,
                "status": data.get("status").cloned().unwrap_or(Value::Null),
                "phase": data.get("phase").cloned().unwrap_or(Value::Null),
            }),
        );
    }

    fn publish(&self, event: &str, data: Value) -> SessionEvent {
        self.touch();
        self.record_timing(event, &data);
        let stored = {
            let mut log_guard = self
                .events
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            log_guard.push(&self.id, event, data)
        };
        let _ = self.tx.send(stored.clone());
        if let Some(hub) = &self.config.events {
            hub.publish_session(&self.id, stored.id, event, stored.data.clone());
        }
        stored
    }

    fn publish_summary(&self) {
        if let Some(hub) = &self.config.events {
            hub.publish_session(&self.id, self.cursor(), "session.updated", self.summary());
        }
    }

    fn set_status(&self, status: Status) {
        let changed = {
            let mut guard = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *guard == status {
                false
            } else {
                *guard = status;
                true
            }
        };
        if changed && !matches!(status, Status::Pending | Status::Starting | Status::Recovering) {
            // Attached (or given up): the pool may start the next runtime.
            let attach = self
                .warm_attach
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            if let Some((_attaching, since)) = attach {
                log(
                    &self.home,
                    "info",
                    "runtime.warm_attached",
                    json!({ "session": self.id, "status": status.as_str(), "elapsedMs": since.elapsed().as_millis() as u64 }),
                );
            }
        }
        if changed {
            if matches!(status, Status::Running) {
                self.turn_running.store(true, Ordering::SeqCst);
            }
            if let Some(runtime) = self
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
            {
                runtime.set_probe_enabled(matches!(status, Status::Idle));
            }
            self.ready.notify_waiters();
            self.publish("session.status", json!({ "status": status.as_str() }));
            self.publish_summary();
        }
    }

    fn request_id(&self) -> String {
        format!(
            "r-{}",
            self.next_request.fetch_add(1, Ordering::Relaxed) + 1
        )
    }

    fn write_command(&self, value: Value) -> Result<(), ApiError> {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "runtime-unavailable",
                    "The runtime is not ready",
                    true,
                )
            })?;
        runtime.enqueue(value).map_err(|message| {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime-unavailable",
                message,
                true,
            )
        })
    }

    fn request_messages(&self) {
        let id = self.request_id();
        if let Err(error) = self.write_command(pi::command::with_id(pi::command::get_messages(), &id)) {
            self.publish(
                "error",
                json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
            );
            self.set_status(Status::Error);
        }
    }

    fn request_state(&self) {
        let id = self.request_id();
        if let Err(error) = self.write_command(pi::command::with_id(pi::command::get_state(), &id)) {
            self.publish(
                "error",
                json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
            );
            self.set_status(Status::Error);
        }
    }

    fn start_handshake(&self) {
        let existing = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        match existing {
            Some(path) => {
                // How much history the runtime loads: a long session takes long to attach.
                log(
                    &self.home,
                    "info",
                    "session.attach",
                    json!({
                        "session": self.id,
                        "bytes": std::fs::metadata(&path).map(|meta| meta.len()).ok(),
                        "status": self.status().as_str(),
                    }),
                );
                let id = self.request_id();
                let result =
                    self.write_command(pi::command::with_id(pi::command::switch_session(&path), &id));
                if let Err(error) = result {
                    self.publish(
                        "error",
                        json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
                    );
                    self.set_status(Status::Error);
                    return;
                }
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Switch;
            }
            None => {
                self.request_messages();
                self.request_state();
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Messages;
            }
        }
    }

    fn handle_response(self: &Arc<Self>, value: &Value) {
        let command = value.get("command").and_then(Value::as_str).unwrap_or("");
        let response_id = value.get("id").and_then(Value::as_str).unwrap_or("");
        if response_id == FLOW_RELEASE_ID {
            log(
                &self.home,
                "info",
                "runtime.flow_released",
                json!({ "success": value.get("success"), "error": value.get("error") }),
            );
            if matches!(self.status(), Status::Starting | Status::Recovering) {
                self.finish_handshake();
            }
            return;
        }
        if response_id.starts_with(STEER_ID_PREFIX) || response_id.starts_with(CLEAR_QUEUE_ID_PREFIX) {
            self.queue_response(response_id, value);
            return;
        }
        let reply = pi::reply_to(value);
        if reply == pi::Reply::Prompt
            && value.get("success").and_then(Value::as_bool) == Some(true)
            && value.pointer("/data/disposition").and_then(Value::as_str) == Some("handled")
        {
            self.end_turn_without_run(response_id);
            return;
        }
        // A state answer that arrives while the runtime is switching to this
        // session's file describes the runtime before the switch: a warm runtime
        // reports its own blank file. Only answers after the switch are this session's.
        let switching = matches!(
            *self
                .handshake
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            Handshake::Switch
        );
        if reply == pi::Reply::GetState && !switching {
            if let Some(data) = value.get("data") {
                let state = pi::State::read(data);
                if let Some(path) = state.session_file.as_deref() {
                    *self
                        .session_path
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path.to_string());
                    // The first snapshot can precede the runtime's session file.
                    // Publish the attach once the path exists so every client can
                    // refresh its session index instead of waiting for a reload.
                    self.publish(
                        "session.attached",
                        json!({
                            "sessionPath": path,
                            "title": self
                                .title
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .clone(),
                        }),
                    );
                }
                // A choice made before the runtime started wins until it is applied.
                let choice_waiting = self
                    .pending_model
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_some();
                if let (Some(model), false) = (state.model.clone(), choice_waiting) {
                    self.set_model(Some(model));
                }
                let level_waiting = self
                    .pending_thinking
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_some();
                if let (Some(level), false) = (state.thinking_level.clone(), level_waiting) {
                    self.set_thinking_level(Some(level));
                }
            }
        }
        let success = value
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // A model chosen before the runtime started was shown as the session's
        // model; on failure say it was not applied and show the real one.
        let deferred_model = {
            let mut deferred = self
                .pending_model_request
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match deferred.as_ref() {
                Some((id, _)) if Some(id.as_str()) == value.get("id").and_then(Value::as_str) => {
                    deferred.take().map(|(_, model)| model)
                }
                _ => None,
            }
        };
        if !success {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("runtime request failed");
            log(
                &self.home,
                "warn",
                "runtime.response_failed",
                json!({ "command": command, "message": message }),
            );
            self.publish(
                "error",
                json!({ "code": "runtime-error", "message": message, "retryable": false }),
            );
            // Only a failed handshake makes the session unusable. Any other
            // command fails alone: its caller gets the error, and a failed
            // prompt ends its turn. A rejected model switch used to stop the
            // whole session, and every later message got "session-stopped".
            if let Some(model) = deferred_model {
                let name = model.get("model").and_then(Value::as_str).unwrap_or("the chosen model");
                self.publish(
                    "session.notice",
                    json!({
                        "level": "error",
                        "message": format!("Could not switch to {name}: {message}. This session keeps the runtime's current model."),
                    }),
                );
                self.set_model(None);
                self.request_state();
            }
            // A refused level leaves the runtime's own; ask which one that is.
            if reply == pi::Reply::SetThinkingLevel {
                self.request_state();
            }
            if reply.is_handshake() && matches!(self.status(), Status::Starting | Status::Recovering) {
                self.recovery_failed(message.to_string());
            } else if reply == pi::Reply::Prompt {
                self.end_turn(
                    response_id,
                    json!({ "aborted": true, "reason": "runtime-error", "message": message }),
                );
            }
            return;
        }
        match reply {
            pi::Reply::SwitchSession => {
                let cancelled = value
                    .get("data")
                    .and_then(|data| data.get("cancelled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if cancelled {
                    self.publish(
                        "error",
                        json!({ "code": "session-switch-cancelled", "message": "The runtime cancelled the session switch", "retryable": false }),
                    );
                    if matches!(self.status(), Status::Starting | Status::Recovering) {
                        self.recovery_failed("session switch cancelled".to_string());
                    } else {
                        self.set_status(Status::Error);
                    }
                    return;
                }
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Messages;
                self.request_messages();
            }
            pi::Reply::GetMessages => {
                // The host's history is the record. After a runtime restart it
                // already holds every row (including an interrupted reply the
                // runtime never saved), so only a fresh attach imports.
                // A saved conversation's history was read from its file on open
                // (`open_saved_history`); the runtime's copy would only renumber it.
                let keep_host_history = !self
                    .history
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_empty();
                if let (false, Some(data)) = (keep_host_history, value.get("data")) {
                    self.import_history(data);
                }
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Ready;
                self.ready.notify_waiters();
                if matches!(self.status(), Status::Starting | Status::Recovering) {
                    if self.release_flow_hold.swap(false, Ordering::SeqCst) {
                        // `/flow clear` releases the withheld request and keeps its
                        // receipts. Finish the handshake when the runtime answers.
                        let release = pi::command::with_id(
                            pi::command::prompt("/flow clear", &[]),
                            FLOW_RELEASE_ID,
                        );
                        if self.write_command(release).is_ok() {
                            return;
                        }
                    }
                    self.finish_handshake();
                }
            }
            _ => {}
        }
    }

    fn finish_handshake(self: &Arc<Self>) {
        self.recovery_succeeded();
        self.apply_pending_preferences();
        self.flush_pending_prompts();
        // Start the next warm runtime only now: on a busy machine a second
        // runtime booting beside this one would slow down the one the user waits for.
        if let Some(pool) = self.config.warm.get() {
            let pool = pool.clone();
            let workspace = PathBuf::from(self.runtime_cwd());
            tokio::spawn(async move { pool.aim(&workspace) });
        }
        // A cancelled starting turn has no prompt to flush. Complete the
        // handshake bookkeeping first, then go idle; never go idle while
        // an accepted turn still has an active message.
        if self.active_turn().is_none() && !matches!(self.status(), Status::Running) {
            if !self.start_queued_turn() {
                self.set_status(Status::Idle);
            }
        }
    }

    /// A prompt the runtime consumed without starting a run (a slash command, or
    /// input its Flow control retained). No agent events will follow, so the turn
    /// ends here instead of waiting for `agent_settled`.
    fn end_turn_without_run(self: &Arc<Self>, client_message_id: &str) {
        self.end_turn(client_message_id, json!({ "status": "handled" }));
    }

    /// End the active turn for this message without a runtime run.
    fn end_turn(self: &Arc<Self>, client_message_id: &str, outcome: Value) {
        let matches_active = self
            .active_client_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_deref()
            == Some(client_message_id);
        if !matches_active {
            return;
        }
        let turn = self
            .active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        *self
            .active_client_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .turn_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .active_client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.cancelling.store(false, Ordering::SeqCst);
        self.turn_running.store(false, Ordering::SeqCst);
        if let Some(turn) = turn {
            let mut data = json!({ "turnId": turn });
            if let (Some(data), Some(outcome)) = (data.as_object_mut(), outcome.as_object()) {
                data.extend(outcome.clone());
            }
            self.publish("turn.end", data);
        }
        self.prompt_echo.store(false, Ordering::SeqCst);
        self.reclaim_steered();
        if !self.start_queued_turn() {
            self.set_status(Status::Idle);
        }
        self.publish_summary();
    }

    /// Load the transcript of the session's saved file into the host history.
    pub(crate) fn open_saved_history(&self) {
        let Some(path) = self.saved_path() else { return };
        let started = Instant::now();
        let Ok(messages) = saved_messages(Path::new(&path)) else { return };
        let count = messages.len();
        self.import_history(&Value::Array(messages));
        // Last changed when the file was, as the saved-session list says.
        if let Ok(modified) = std::fs::metadata(&path).and_then(|meta| meta.modified()) {
            let mut updated = self.updated_at.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if updated.is_none() {
                *updated = Some(DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis, true));
            }
        }
        log(
            &self.home,
            "info",
            "session.history",
            json!({
                "session": self.id,
                "messages": count,
                "rows": self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len(),
                "elapsedMs": started.elapsed().as_millis() as u64,
            }),
        );
    }

    fn import_history(&self, data: &Value) {
        let messages = data
            .as_array()
            .or_else(|| data.get("messages").and_then(Value::as_array));
        let Some(messages) = messages else {
            return;
        };
        let mut rows = Vec::new();
        for (index, message) in messages.iter().enumerate() {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("");
            // A tool's result belongs on the reply that called it, as it does
            // when the turn streams live (`add_to_step_reply`).
            if role == "toolResult" {
                let call_id = message.get("toolCallId").and_then(Value::as_str);
                let reply = rows
                    .iter_mut()
                    .rev()
                    .find(|row: &&mut Value| row.get("kind").and_then(Value::as_str) == Some("assistant"));
                if let (Some(call_id), Some(blocks)) = (
                    call_id,
                    reply.and_then(|row| row.get_mut("blocks")).and_then(Value::as_array_mut),
                ) {
                    blocks.push(json!({
                        "type": "toolResult",
                        "toolCallId": call_id,
                        "ok": message.get("isError").and_then(Value::as_bool) != Some(true),
                        "result": {
                            "content": message.get("content").cloned().unwrap_or(Value::Null),
                            "details": message.get("details").cloned().unwrap_or(Value::Null),
                        },
                    }));
                }
                continue;
            }
            if role != "user" && role != "assistant" {
                continue;
            }
            let blocks = reply_blocks(message);
            let text = blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        block.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            if text.is_empty() && blocks.is_empty() {
                continue;
            }
            let blocks = if blocks.is_empty() {
                json!([{ "type": "text", "text": text }])
            } else {
                Value::Array(blocks)
            };
            rows.push(json!({
                "kind": role,
                "id": message
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("import-{index}")),
                "text": text,
                "blocks": blocks,
                "createdAt": message
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(Self::now_iso),
            }));
            if role == "assistant" {
                if let Some(row) = rows.last_mut() {
                    for field in ["model", "provider", "usage", "stopReason"] {
                        if let Some(value) = message.get(field).filter(|value| !value.is_null()) {
                            row[field] = value.clone();
                        }
                    }
                }
            }
        }
        if rows.is_empty() {
            return;
        }
        // A saved conversation is at rest: a tool call with no result was cut off
        // (the app closed, the runtime stopped). While a turn runs, its own calls
        // may still be at work, so they are left as they are.
        let resting = self
            .active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none();
        if resting {
            for row in rows.iter_mut() {
                if row.get("kind").and_then(Value::as_str) != Some("assistant") {
                    continue;
                }
                if let Some(blocks) = row.get_mut("blocks").and_then(Value::as_array_mut) {
                    close_unfinished_calls(blocks);
                }
            }
        }
        // Titled as the session list titles a saved file: by its first message.
        let first = rows
            .iter()
            .find(|row| row.get("kind").and_then(Value::as_str) == Some("user"))
            .and_then(|row| row.get("text").and_then(Value::as_str))
            .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "));
        if let Some(first) = first.filter(|text| !text.is_empty()) {
            let mut title = self.title.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if title.is_empty() {
                *title = first.chars().take(80).collect();
            }
        }
        let count = rows.len();
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.history_seq.store(0, Ordering::Relaxed);
        for row in rows {
            self.push_history(row);
        }
        // A client that read the history before this replaced it reads it again.
        self.publish("session.history", json!({ "rows": count }));
    }

    fn handle_runtime_line(self: &Arc<Self>, value: Value) {
        self.publish("runtime.event", value.clone());
        match pi::classify(&value) {
            PiRecord::Response => self.handle_response(&value),
            PiRecord::AgentStart => {
                self.set_status(Status::Running);
                self.steer_queue();
            }
            PiRecord::TurnStart => {
                if self.active_turn_id().is_some() {
                    self.begin_step();
                }
            }
            PiRecord::TurnEnd => {}
            PiRecord::MessageStart => {
                let role = value
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str);
                if role == Some("user") {
                    self.user_message_started(value.get("message"));
                    return;
                }
                let assistant = role == Some("assistant");
                if assistant && self.active_turn_id().is_some() {
                    // A second reply in one step is a step the runtime did not mark.
                    let (n, written) = {
                        let step = self.step_guard();
                        (step.n, step.row.is_some())
                    };
                    if n == 0 || written {
                        self.begin_step();
                    }
                }
            }
            PiRecord::MessageEnd => {
                let message = value.get("message");
                let assistant = message
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    == Some("assistant");
                if let (true, Some(turn)) = (assistant, self.active_turn_id()) {
                    self.ensure_step();
                    self.finish_step_reply(&turn, message, false);
                }
            }
            PiRecord::MessageUpdate => {
                let Some(_update) = value
                    .get("assistantMessageEvent")
                    .and_then(Value::as_object)
                else {
                    return;
                };
                let kind = pi::delta_kind(&value);
                let Some(message_id) = self.active_turn_id() else {
                    return;
                };
                match kind {
                    DeltaKind::Text => {
                        let text = pi::delta_text(&value);
                        if !text.is_empty() {
                            self.ensure_step();
                            self.assistant_text
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .push_str(text);
                            self.append_assistant_block("text", text);
                            self.step_output("writing");
                            self.publish(
                                "message.delta",
                                json!({ "messageId": message_id, "text": text }),
                            );
                        }
                    }
                    DeltaKind::Thinking => {
                        let text = pi::delta_text(&value);
                        if !text.is_empty() {
                            self.ensure_step();
                            self.append_assistant_block("thinking", text);
                            self.step_output("thinking");
                            self.publish(
                                "message.delta",
                                json!({ "messageId": message_id, "text": text, "kind": "thinking" }),
                            );
                        }
                    }
                    DeltaKind::ToolCall => {
                        self.ensure_step();
                        self.step_output("calling_tool");
                    }
                    DeltaKind::Other => {}
                }
            }
            PiRecord::ToolStart => {
                let call_id = value
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let name = value
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                if !call_id.is_empty() {
                    if self.active_turn_id().is_some() {
                        self.ensure_step();
                    }
                    self.add_to_step_reply(json!({
                        "type": "toolCall",
                        "toolCallId": call_id,
                        "name": name,
                        "input": value.get("args").cloned().unwrap_or(Value::Null),
                    }));
                    self.push_history(json!({
                        "kind": "tool",
                        "id": format!("tool:{call_id}"),
                        "turnId": self.active_turn_id(),
                        "tool": {
                            "name": name,
                            "callId": call_id,
                            "status": "running",
                        },
                        "args": value.get("args"),
                        "createdAt": Self::now_iso(),
                    }));
                    self.step_guard()
                        .tools
                        .push((call_id.clone(), name.clone(), Instant::now()));
                }
                self.publish(
                    "tool.start",
                    json!({
                        "toolCallId": value.get("toolCallId"),
                        "toolName": value.get("toolName"),
                        "args": value.get("args"),
                        "step": self.step_guard().n,
                    }),
                );
                self.step_output("tools");
                self.publish_summary();
            }
            PiRecord::ToolUpdate => {
                self.publish(
                    "tool.update",
                    json!({
                        "toolCallId": value.get("toolCallId"),
                        "partialResult": value.get("partialResult"),
                    }),
                );
            }
            PiRecord::ToolEnd => {
                let call_id = value
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let ok = value.get("isError").and_then(Value::as_bool) != Some(true);
                self.add_to_step_reply(json!({
                    "type": "toolResult",
                    "toolCallId": call_id,
                    "ok": ok,
                    "result": value.get("result").cloned().unwrap_or(Value::Null),
                }));
                self.update_history_tool(
                    &call_id,
                    if ok { "ok" } else { "error" },
                    value.get("result").cloned().unwrap_or(Value::Null),
                );
                let finished = {
                    let mut step = self.step_guard();
                    let at = step.tools.iter().position(|(id, _, _)| *id == call_id);
                    at.map(|at| step.tools.remove(at))
                };
                if let Some((_, name, started)) = finished {
                    self.log_step(
                        "tool.end",
                        json!({ "tool": name, "ok": ok, "elapsedMs": started.elapsed().as_millis() as u64 }),
                    );
                }
                self.publish(
                    "tool.result",
                    json!({
                        "toolCallId": value.get("toolCallId"),
                        "ok": ok,
                        "result": value.get("result"),
                    }),
                );
                self.publish_summary();
            }
            PiRecord::RetryStart => {
                let retry = json!({
                    "attempt": value.get("attempt"),
                    "maxAttempts": value.get("maxAttempts"),
                    "delayMs": value.get("delayMs"),
                    "error": value.get("errorMessage"),
                });
                self.log_step("retry.start", retry.clone());
                self.step_guard().retry = Some(retry);
                self.set_step_state("retrying");
                self.publish_summary();
            }
            PiRecord::RetryEnd => {
                self.log_step(
                    "retry.end",
                    json!({ "success": value.get("success"), "attempt": value.get("attempt") }),
                );
                self.step_guard().retry = None;
                self.set_step_state("waiting_model");
                self.publish_summary();
            }
            PiRecord::CompactionStart => {
                self.log_step("compaction.start", json!({ "reason": value.get("reason") }));
                self.set_step_state("compacting");
            }
            PiRecord::CompactionEnd => {
                self.log_step(
                    "compaction.end",
                    json!({ "reason": value.get("reason"), "aborted": value.get("aborted") }),
                );
                self.set_step_state("waiting_model");
            }
            PiRecord::CustomMessage => {
                let custom_type = value
                    .get("customType")
                    .and_then(Value::as_str)
                    .unwrap_or("custom");
                let text = value
                    .get("content")
                    .and_then(|content| {
                        content.as_str().map(str::to_string).or_else(|| {
                            content.as_array().map(|blocks| {
                                blocks
                                    .iter()
                                    .filter_map(|block| {
                                        block.get("text").and_then(Value::as_str)
                                    })
                                    .collect::<Vec<_>>()
                                    .join("")
                            })
                        })
                    })
                    .unwrap_or_default();
                self.publish(
                    "message.custom",
                    json!({
                        "customType": custom_type,
                        "display": value.get("display"),
                        "text": text,
                    }),
                );
            }
            PiRecord::AgentSettled => {
                let aborted = value
                    .get("aborted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let active = self
                    .active_message
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                self.active_client
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                if let Some(message_id) = active {
                    let stop_reason = if aborted { "interrupted" } else { "completed" };
                    // Whatever the last step had not finished writing is its reply.
                    self.finish_step_reply(&message_id, None, aborted);
                    self.close_unfinished_tools();
                    self.publish(
                        "turn.end",
                        json!({ "turnId": message_id, "status": stop_reason }),
                    );
                }
                self.cancel_pending("turn-ended");
                *self
                    .active_message
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                *self
                    .active_client_message
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                *self
                    .turn_started_at
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                self.cancelling.store(false, Ordering::SeqCst);
                self.turn_running.store(false, Ordering::SeqCst);
                self.prompt_echo.store(false, Ordering::SeqCst);
                // Steered messages the run did not reach are taken back before
                // anything else is sent, so the runtime cannot use them twice.
                self.reclaim_steered();
                if !self.start_queued_turn() {
                    self.set_status(Status::Idle);
                }
                self.publish_summary();
            }
            PiRecord::ExtensionUiRequest => self.handle_extension_ui_request(&value),
            PiRecord::ExtensionError => {
                let message = value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("extension error");
                // A replaced session can leave one extension holding its previous context.
                // That lifecycle race changes neither the transcript nor this session, so it
                // is not a session failure (the same rule the UI kept before the host).
                if message.to_lowercase().contains("extension ctx is stale") {
                    log(&self.home, "warn", "extension.stale_ctx", json!({ "session": self.id, "message": message }));
                    return;
                }
                self.publish(
                    "error",
                    json!({ "code": "extension-error", "message": message, "retryable": false }),
                );
            }
            PiRecord::Error => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("runtime error");
                self.publish(
                    "error",
                    json!({ "code": "runtime-error", "message": message, "retryable": false }),
                );
                self.set_status(Status::Error);
            }
            _ => {}
        }
    }

    fn handle_extension_ui_request(self: &Arc<Self>, value: &Value) {
        match value.get("method").and_then(Value::as_str).unwrap_or("") {
            "confirm" => self.request_approval(value),
            "select" | "input" | "editor" => self.request_question(value),
            // Fire-and-forget notices: the runtime's only channel for command replies
            // (`/flow`, `/textguard`) and for Flow holds. Dropping them leaves a held
            // message looking like an endless stall.
            "notify" => {
                let message = value.get("message").and_then(Value::as_str).unwrap_or("");
                if message.trim().is_empty() {
                    return;
                }
                let level = match value.get("notifyType").and_then(Value::as_str) {
                    Some("error") => "error",
                    Some("warning") => "warning",
                    _ => "info",
                };
                self.publish(
                    "session.notice",
                    json!({ "message": message, "level": level }),
                );
            }
            "setStatus" => {
                let Some(key) = value.get("statusKey").and_then(Value::as_str) else {
                    return;
                };
                let text = value
                    .get("statusText")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty());
                let changed = {
                    let mut statuses = self
                        .ui_statuses
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    match text {
                        Some(text) => {
                            statuses
                                .insert(key.to_string(), text.to_string())
                                .as_deref()
                                != Some(text)
                        }
                        None => statuses.remove(key).is_some(),
                    }
                };
                if changed {
                    self.publish_summary();
                }
            }
            "setWidget" => {
                let Some(key) = value.get("widgetKey").and_then(Value::as_str) else {
                    return;
                };
                let lines: Vec<String> = value
                    .get("widgetLines")
                    .and_then(Value::as_array)
                    .map(|lines| {
                        lines
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                let changed = {
                    let mut widgets = self
                        .ui_widgets
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if lines.is_empty() {
                        widgets.remove(key).is_some()
                    } else {
                        widgets.insert(key.to_string(), lines.clone()).as_ref() != Some(&lines)
                    }
                };
                if changed {
                    self.publish_summary();
                }
            }
            method => log(
                &self.home,
                "debug",
                "runtime.noninteractive_ui",
                json!({ "method": method }),
            ),
        }
    }

    fn prompt_timeout(value: &Value) -> (Duration, String) {
        let millis = value
            .get("timeout")
            .and_then(Value::as_u64)
            .filter(|timeout| *timeout > 0)
            .unwrap_or(120_000)
            .min(86_400_000);
        (
            Duration::from_millis(millis),
            (Utc::now() + chrono::Duration::milliseconds(millis as i64))
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        )
    }

    fn request_approval(self: &Arc<Self>, value: &Value) {
        let pi_id = value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if pi_id.is_empty() {
            return;
        }
        let (timeout, expires_at) = Self::prompt_timeout(value);
        let counter = self.next_prompt.fetch_add(1, Ordering::Relaxed) + 1;
        let approval_id = format!("a-{}-{counter}", self.id);
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Confirm");
        let message = value.get("message").and_then(Value::as_str).unwrap_or("");
        let mut data = json!({
            "approvalId": approval_id,
            "tool": title,
            "args": { "title": title, "message": message },
            "options": ["Approve", "Deny"],
            "expiresAt": expires_at,
        });
        if let Some(turn_id) = self.active_turn() {
            data["turnId"] = Value::String(turn_id);
        }
        if let Some(client) = self.active_client() {
            data["initiatorClientId"] = Value::String(client);
        }
        let entry = PendingApproval {
            pi_id,
            data: data.clone(),
        };
        self.pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(approval_id.clone(), entry);
        self.set_status(Status::WaitingApproval);
        self.publish("approval.requested", data);
        self.schedule_approval_expiry(approval_id, timeout);
    }

    fn request_question(self: &Arc<Self>, value: &Value) {
        let pi_id = value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if pi_id.is_empty() {
            return;
        }
        let (timeout, expires_at) = Self::prompt_timeout(value);
        let counter = self.next_prompt.fetch_add(1, Ordering::Relaxed) + 1;
        let question_id = format!("q-{}-{counter}", self.id);
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Question");
        let detail = value
            .get("placeholder")
            .or_else(|| value.get("prefill"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let options: Vec<String> = value
            .get("options")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let item_id = "q1".to_string();
        let mut item = json!({
            "id": item_id,
            "header": title,
            "question": title,
        });
        if !detail.is_empty() {
            item["detail"] = Value::String(detail.to_string());
        }
        if !options.is_empty() {
            item["options"] = json!(options);
        }
        let mut data = json!({
            "questionId": question_id,
            "questions": [item],
            "expiresAt": expires_at,
        });
        if let Some(turn_id) = self.active_turn() {
            data["turnId"] = Value::String(turn_id);
        }
        if let Some(client) = self.active_client() {
            data["initiatorClientId"] = Value::String(client);
        }
        let mut option_map = std::collections::HashMap::new();
        option_map.insert(item_id.clone(), options);
        let entry = PendingQuestion {
            pi_id,
            data: data.clone(),
            question_ids: vec![item_id],
            options: option_map,
        };
        self.pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(question_id.clone(), entry);
        self.set_status(Status::WaitingQuestion);
        self.publish("question.requested", data);
        self.schedule_question_expiry(question_id, timeout);
    }

    fn active_turn(&self) -> Option<String> {
        self.active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn schedule_approval_expiry(self: &Arc<Self>, approval_id: String, timeout: Duration) {
        let session = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            session.expire_approval(&approval_id);
        });
    }

    fn schedule_question_expiry(self: &Arc<Self>, question_id: String, timeout: Duration) {
        let session = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(timeout);
            session.expire_question(&question_id);
        });
    }

    fn expire_approval(&self, approval_id: &str) {
        let entry = self
            .pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(approval_id);
        let Some(entry) = entry else { return };
        self.approval_outcomes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(approval_id.to_string(), "expired".to_string());
        let mut data = entry.data;
        data["state"] = Value::String("expired".to_string());
        data["decision"] = Value::String("expired".to_string());
        data["answeredBy"] = Value::Null;
        let _ = self.write_command(pi::command::ui_cancelled(&entry.pi_id));
        self.publish("approval.resolved", data);
        self.restore_running_status();
    }

    fn expire_question(&self, question_id: &str) {
        let entry = self
            .pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(question_id);
        let Some(entry) = entry else { return };
        self.question_outcomes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(question_id.to_string(), "expired".to_string());
        let _ = self.write_command(pi::command::ui_cancelled(&entry.pi_id));
        self.publish(
            "question.cancelled",
            json!({ "questionId": question_id, "reason": "expired" }),
        );
        self.restore_running_status();
    }

    fn restore_running_status(&self) {
        if self.active_turn().is_some() {
            self.set_status(Status::Running);
        } else {
            self.set_status(Status::Idle);
        }
    }

    pub fn has_approval(&self, approval_id: &str) -> bool {
        self.pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(approval_id)
            || self
                .approval_outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(approval_id)
    }

    pub fn has_question(&self, question_id: &str) -> bool {
        self.pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(question_id)
            || self
                .question_outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .contains_key(question_id)
    }

    pub fn pending_approvals(&self) -> Vec<Value> {
        let pending = self
            .pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.values().map(|entry| entry.data.clone()).collect()
    }

    pub fn pending_questions(&self) -> Vec<Value> {
        let pending = self
            .pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending.values().map(|entry| entry.data.clone()).collect()
    }

    fn prompt_error(&self, id: &str, question: bool) -> ApiError {
        let outcome = if question {
            self.question_outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(id)
                .cloned()
        } else {
            self.approval_outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(id)
                .cloned()
        };
        match outcome.as_deref() {
            Some("expired") => ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "prompt-expired",
                "Prompt has expired",
                false,
            ),
            Some(_) => ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "prompt-resolved",
                "Prompt is already resolved",
                false,
            ),
            None => ApiError::new(
                axum::http::StatusCode::NOT_FOUND,
                "prompt-not-found",
                "Prompt does not exist",
                false,
            ),
        }
    }

    pub fn decide_approval(
        &self,
        approval_id: &str,
        client_id: &str,
        decision: &str,
    ) -> Result<Value, ApiError> {
        let entry = self
            .pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(approval_id);
        let Some(entry) = entry else {
            return Err(self.prompt_error(approval_id, false));
        };
        let options: Vec<String> = entry
            .data
            .get("options")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if !options.iter().any(|option| option == decision) {
            self.pending_approvals
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(approval_id.to_string(), entry);
            return Err(ApiError::bad_request(
                "decision must be one of the offered options",
            ));
        }
        let confirmed = decision == "Approve";
        let response = pi::command::ui_confirmed(&entry.pi_id, confirmed);
        if let Err(error) = self.write_command(response) {
            self.pending_approvals
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(approval_id.to_string(), entry);
            return Err(error);
        }
        let state = if confirmed { "allowed" } else { "denied" };
        self.approval_outcomes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(approval_id.to_string(), state.to_string());
        let mut data = entry.data;
        data["state"] = Value::String(state.to_string());
        data["decision"] = Value::String(decision.to_string());
        data["answeredBy"] = Value::String(client_id.to_string());
        self.publish("approval.resolved", data);
        self.restore_running_status();
        Ok(json!({
            "approvalId": approval_id,
            "state": state,
            "decision": decision,
            "answeredBy": client_id,
        }))
    }

    pub fn answer_question(
        &self,
        question_id: &str,
        client_id: &str,
        answers: &std::collections::HashMap<String, String>,
    ) -> Result<Value, ApiError> {
        let entry = self
            .pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(question_id);
        let Some(entry) = entry else {
            return Err(self.prompt_error(question_id, true));
        };
        for item_id in &entry.question_ids {
            let Some(answer) = answers.get(item_id) else {
                self.pending_questions
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(question_id.to_string(), entry);
                return Err(ApiError::bad_request("every question needs an answer"));
            };
            if let Some(options) = entry.options.get(item_id) {
                if !options.is_empty() && !options.iter().any(|option| option == answer) {
                    self.pending_questions
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .insert(question_id.to_string(), entry);
                    return Err(ApiError::bad_request(
                        "answer must be one of the offered options",
                    ));
                }
            }
        }
        let value = entry
            .question_ids
            .first()
            .and_then(|item_id| answers.get(item_id))
            .cloned()
            .unwrap_or_default();
        let response = pi::command::ui_value(&entry.pi_id, &value);
        if let Err(error) = self.write_command(response) {
            self.pending_questions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(question_id.to_string(), entry);
            return Err(error);
        }
        self.question_outcomes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(question_id.to_string(), "answered".to_string());
        self.publish(
            "question.answered",
            json!({
                "questionId": question_id,
                "answers": answers,
                "answeredBy": client_id,
            }),
        );
        self.restore_running_status();
        Ok(json!({
            "questionId": question_id,
            "state": "answered",
            "answers": answers,
            "answeredBy": client_id,
        }))
    }

    fn cancel_pending(&self, reason: &str) {
        let approvals: Vec<(String, PendingApproval)> = self
            .pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .collect();
        for (approval_id, entry) in approvals {
            self.approval_outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(approval_id.clone(), "expired".to_string());
            let mut data = entry.data;
            data["state"] = Value::String("expired".to_string());
            data["decision"] = Value::String("expired".to_string());
            data["answeredBy"] = Value::Null;
            self.publish("approval.resolved", data);
        }
        let questions: Vec<(String, PendingQuestion)> = self
            .pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .collect();
        for (question_id, _) in questions {
            self.question_outcomes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(question_id.clone(), "cancelled".to_string());
            self.publish(
                "question.cancelled",
                json!({ "questionId": question_id, "reason": reason }),
            );
        }
    }
    fn store_attachments(&self, attachments: &[Attachment]) -> Result<Vec<Value>, ApiError> {
        if attachments.is_empty() {
            return Ok(Vec::new());
        }
        let directory = self.runtime_home.join("state").join("attachments");
        std::fs::create_dir_all(&directory)
            .map_err(|error| ApiError::internal(format!("Could not store attachments: {error}")))?;
        let mut stored = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            let bytes = STANDARD.decode(&attachment.data).map_err(|_| {
                ApiError::bad_request("Attachment data must be canonical base64")
            })?;
            if bytes.is_empty() {
                return Err(ApiError::bad_request("Attachments must not be empty"));
            }
            let extension = match attachment.mime_type.as_str() {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "image/gif" => "gif",
                _ => "bin",
            };
            let id = format!("att-{}", random_id());
            let path = directory.join(format!("{id}.{extension}"));
            std::fs::write(&path, &bytes)
                .map_err(|error| ApiError::internal(format!("Could not store attachment: {error}")))?;
            stored.push(json!({
                "id": id,
                "name": attachment.name,
                "mimeType": attachment.mime_type,
                "bytes": bytes.len(),
                "path": path.to_string_lossy(),
            }));
        }
        Ok(stored)
    }

    pub fn send(self: &Arc<Self>, client_message_id: &str, text: &str) -> Result<Value, ApiError> {
        self.send_with_client(client_message_id, text, None, &[])
    }

    pub fn send_with_client(
        self: &Arc<Self>,
        client_message_id: &str,
        text: &str,
        client_id: Option<&str>,
        attachments: &[Attachment],
    ) -> Result<Value, ApiError> {
        if client_message_id.is_empty() || client_message_id.len() > 200 {
            return Err(ApiError::bad_request("clientMessageId is required"));
        }
        if text.is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(ApiError::bad_request("text must be 1..32 KiB"));
        }
        if attachments.len() > 4 {
            return Err(ApiError::bad_request("Attach at most 4 images"));
        }
        let total: usize = attachments.iter().map(|item| item.data.len()).sum();
        if total > 20 * 1024 * 1024 {
            return Err(ApiError::bad_request("Images must total 20 MB or less"));
        }
        match self.status() {
            Status::Stopped | Status::Error | Status::Cancelled => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "session-stopped",
                    "Session is not runnable",
                    false,
                ))
            }
            Status::Recovering => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "session-recovering",
                    "The runtime is recovering; retry in a moment",
                    true,
                ))
            }
            _ => {}
        }
        let now = Instant::now();
        let cancelled = {
            let mut tombstones = self
                .cancelled
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            tombstones.retain(|_, until| *until > now);
            tombstones.remove(client_message_id).is_some()
        };
        if cancelled {
            return Ok(json!({ "receipt": "cancelled" }));
        }
        let mut messages = self
            .messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(existing) = messages.get(client_message_id) {
            if existing.text != text {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "id-conflict",
                    "clientMessageId was already used with different text",
                    false,
                ));
            }
            let waiting = self
                .queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .iter()
                .any(|item| item.client_message_id() == Some(client_message_id));
            return Ok(json!({
                "messageId": existing.message_id.clone(),
                "receipt": "queued",
                "waiting": waiting,
            }));
        }
        if self.active_turn().is_some() {
            *self
                .failed_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            // A turn is already starting/running. The host owns the message, not
            // the composer: it waits in the queue (shown above the composer) and
            // is handed to the running turn as steer. It joins the transcript when
            // the runtime uses it, or starts the next turn if this one ends first.
            let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
            let message_id = format!("m-{counter}");
            let stored_attachments = self.store_attachments(attachments)?;
            let mut row = json!({
                "kind": "user",
                "id": format!("{message_id}:user"),
                "turnId": message_id,
                "clientMessageId": client_message_id,
                "text": text,
                "blocks": [{ "type": "text", "text": text }],
            });
            if !stored_attachments.is_empty() {
                row["attachments"] = json!(stored_attachments);
            }
            self.remember_turn(text);
            self.publish(
                "message.accepted",
                json!({ "messageId": message_id.clone(), "receipt": "queued", "waiting": true }),
            );
            let images: Vec<(&str, &str)> = attachments
                .iter()
                .map(|attachment| (attachment.mime_type.as_str(), attachment.data.as_str()))
                .collect();
            let prompt =
                pi::command::with_id(pi::command::prompt(text, &images), client_message_id);
            self.queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push_back(Queued {
                    turn: message_id.clone(),
                    prompt,
                    row: Some(row),
                    steered: None,
                    no_steer: false,
                });
            messages.insert(
                client_message_id.to_string(),
                SentMessage {
                    message_id: message_id.clone(),
                    text: text.to_string(),
                },
            );
            drop(messages);
            self.steer_queue();
            self.publish_summary();
            return Ok(json!({ "messageId": message_id, "receipt": "queued", "waiting": true }));
        }
        let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
        let message_id = format!("m-{counter}");
        *self
            .active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message_id.clone());
        *self
            .active_client
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = client_id.map(str::to_string);
        *self
            .active_client_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(client_message_id.to_string());
        *self
            .failed_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .turn_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Self::now_iso());
        *self
            .assistant_text
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = String::new();
        self.assistant_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.reset_step();
        self.prompt_echo.store(true, Ordering::SeqCst);
        let stored_attachments = self.store_attachments(attachments)?;
        let mut history_row = json!({
            "kind": "user",
            "id": format!("{message_id}:user"),
            "turnId": message_id,
            "text": text,
            "blocks": [{ "type": "text", "text": text }],
            "createdAt": Self::now_iso(),
        });
        if !stored_attachments.is_empty() {
            history_row["attachments"] = json!(stored_attachments);
        }
        self.push_history(history_row);
        self.remember_turn(text);
        if let Some(path) = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            self.publish(
                "session.attached",
                json!({
                    "sessionPath": path,
                    "title": self
                        .title
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                }),
            );
        }
        self.publish(
            "message.accepted",
            json!({ "messageId": message_id.clone(), "receipt": "queued" }),
        );
        // Running only once the runtime has the session, as the summary says.
        let starting = matches!(
            self.status(),
            Status::Pending | Status::Starting | Status::Recovering
        );
        self.publish(
            "turn.start",
            json!({
                "turnId": message_id.clone(),
                "phase": if starting { "starting" } else { "running" },
            }),
        );
        self.publish_summary();
        let images: Vec<(&str, &str)> = attachments
            .iter()
            .map(|attachment| (attachment.mime_type.as_str(), attachment.data.as_str()))
            .collect();
        let prompt = pi::command::with_id(pi::command::prompt(text, &images), client_message_id);
        if matches!(self.status(), Status::Pending) {
            self.set_status(Status::Starting);
            self.start(true);
            if matches!(self.status(), Status::Cancelled | Status::Error) {
                self.publish(
                    "turn.end",
                    json!({ "turnId": message_id, "aborted": true, "reason": "runtime-unavailable" }),
                );
                messages.remove(client_message_id);
                return Err(ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "runtime-unavailable",
                    "The runtime could not start",
                    true,
                ));
            }
        }
        if matches!(self.status(), Status::Starting | Status::Recovering) {
            self.pending_prompts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(prompt);
        } else {
            self.set_status(Status::Running);
            let result = self.write_command(prompt);
            if let Err(error) = result {
                self.publish(
                    "error",
                    json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
                );
                self.set_status(Status::Error);
                messages.remove(client_message_id);
                return Err(error);
            }
        }
        messages.insert(
            client_message_id.to_string(),
            SentMessage {
                message_id: message_id.clone(),
                text: text.to_string(),
            },
        );
        drop(messages);
        Ok(json!({ "messageId": message_id, "receipt": "queued" }))
    }

    pub fn cancel_message(&self, client_message_id: &str) -> Result<Value, ApiError> {
        let active = self
            .active_client_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if active.as_deref() == Some(client_message_id) {
            match self.status() {
                Status::Running | Status::WaitingApproval | Status::WaitingQuestion => {
                    self.cancelling.store(true, Ordering::SeqCst);
                    self.interrupt()?;
                    self.publish_summary();
                    return Ok(json!({ "status": "cancelling" }));
                }
                Status::Starting | Status::Recovering => {
                    self.interrupt()?;
                    self.publish_summary();
                    return Ok(json!({ "status": "cancelled" }));
                }
                _ => {}
            }
        }
        let removed = {
            let mut queue = self
                .queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue
                .iter()
                .position(|item| item.client_message_id() == Some(client_message_id))
                .and_then(|at| queue.remove(at))
        };
        if let Some(item) = removed {
            if item.steered.is_some() {
                // The runtime holds the removed message too: take its queue
                // back; the rest are handed over again once it has answered.
                self.clear_runtime_queue();
            }
            self.publish_summary();
            return Ok(json!({ "status": "cancelled" }));
        }
        let now = Instant::now();
        let mut cancelled = self
            .cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cancelled.retain(|_, until| *until > now);
        cancelled.insert(
            client_message_id.to_string(),
            now + std::time::Duration::from_secs(300),
        );
        Ok(json!({ "status": "tombstoned" }))
    }

    pub fn continue_queue(self: &Arc<Self>) -> Result<Value, ApiError> {
        self.queue_paused.store(false, Ordering::SeqCst);
        // Do not write a queued prompt until the replacement runtime has completed
        // its handshake. A Recovering session starts the queue from the handshake
        // path, not from this command.
        let started = if self.status() == Status::Idle && self.active_turn().is_none() {
            self.start_queued_turn()
        } else {
            self.steer_queue();
            false
        };
        self.publish_summary();
        Ok(json!({ "status": if started { "running" } else { "queued" } }))
    }

    pub fn retry_failed(self: &Arc<Self>) -> Result<Value, ApiError> {
        let Some(failed) = self
            .failed_turn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        else {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "no-failed-turn",
                "There is no failed turn to retry",
                false,
            ));
        };
        let client_message_id = failed
            .get("clientMessageId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let text = failed
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
        let turn = format!("m-{counter}");
        let prompt = pi::command::with_id(pi::command::prompt(&text, &[]), &client_message_id);
        self.queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_front(Queued { turn, prompt, row: None, steered: None, no_steer: true });
        self.queue_paused.store(false, Ordering::SeqCst);
        if self.active_turn().is_none() {
            self.start_queued_turn();
        }
        self.publish_summary();
        Ok(json!({ "status": "retrying" }))
    }

    pub fn discard_queue(&self) -> Result<Value, ApiError> {
        self.reclaim_steered();
        self.queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.queue_paused.store(false, Ordering::SeqCst);
        self.publish_summary();
        Ok(json!({ "status": "discarded" }))
    }

    pub fn interrupt(&self) -> Result<(), ApiError> {
        if !self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
        {
            self.queue_paused.store(true, Ordering::SeqCst);
            self.publish_summary();
        }
        // A pending turn can still be parked before the runtime handshake. There is
        // nothing in the runtime to abort yet, so remove the queued prompt and end
        // the turn here; otherwise a Stop during `starting` is a no-op.
        if matches!(self.status(), Status::Starting | Status::Recovering) {
            let removed = self
                .pending_prompts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .drain(..)
                .count();
            if removed > 0 {
                let turn = self
                    .active_message
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                    .unwrap_or_default();
                self.publish(
                    "turn.end",
                    json!({ "turnId": turn, "aborted": true, "phase": "starting" }),
                );
                // Keep Starting until the handshake completes so preferences and
                // recovery bookkeeping still run. The handshake path moves to Idle
                // once it sees no active turn.
                return Ok(());
            }
        }
        let id = self.request_id();
        self.write_command(pi::command::with_id(pi::command::abort(), &id))
    }

    pub async fn request(&self, mut command: Value, timeout: Duration) -> Result<Value, ApiError> {
        let kind = command
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad_request("type is required"))?;
        if !matches!(
            kind,
            "get_state"
                | "get_messages"
                | "get_available_models"
                | "get_available_thinking_levels"
                | "get_session_stats"
                | "get_fork_messages"
                | "set_model"
                | "set_thinking_level"
                | "compact"
                | "export_html"
                | "fork"
                | "switch_session"
        ) {
            return Err(ApiError::bad_request("Unsupported session command"));
        }
        if kind == "switch_session" {
            let path = command
                .get("sessionPath")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::bad_request("sessionPath is required"))?;
            let root = self
                .runtime_home
                .join("state")
                .join("sessions")
                .canonicalize()
                .map_err(|_| ApiError::bad_request("Unknown session path"))?;
            let candidate = std::path::Path::new(path)
                .canonicalize()
                .map_err(|_| ApiError::bad_request("Unknown session path"))?;
            if !candidate.starts_with(&root)
                || candidate.extension().and_then(|value| value.to_str()) != Some("jsonl")
            {
                return Err(ApiError::bad_request("Unknown session path"));
            }
            let current = self
                .session_path
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
                .and_then(|value| std::path::Path::new(&value).canonicalize().ok());
            if current.as_ref() != Some(&candidate) {
                return Err(ApiError::bad_request(
                    "Only the current saved session can be reloaded",
                ));
            }
        }
        if matches!(kind, "get_messages" | "get_state") {
            match self.status() {
                Status::Pending => {
                    if kind == "get_messages" {
                        return Ok(json!({ "messages": [] }));
                    }
                    return Ok(json!({
                        "sessionId": self.id,
                        "isStreaming": false,
                        "model": null,
                        "thinkingLevel": "off",
                        "sessionFile": null,
                    }));
                }
                Status::Starting | Status::Recovering => {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(10),
                        self.ready.notified(),
                    )
                    .await;
                }
                _ => {}
            }
        }
        let id = command
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| self.request_id());
        if command.get("id").is_none() {
            if let Some(object) = command.as_object_mut() {
                object.insert("id".to_string(), Value::String(id.clone()));
            }
        }
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "runtime-unavailable",
                    "The runtime is not ready",
                    true,
                )
            })?;
        match runtime.request(command, timeout).await {
            Ok(data) => Ok(data),
            Err(RequestError::Timeout) => Err(ApiError::new(
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                "runtime-timeout",
                "The runtime did not answer in time",
                true,
            )),
            Err(RequestError::Runtime(message)) => Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                "runtime-error",
                message,
                false,
            )),
            Err(RequestError::Closed(message)) => Err(ApiError::new(
                axum::http::StatusCode::BAD_GATEWAY,
                "runtime-unavailable",
                message,
                true,
            )),
        }
    }

    pub fn runtime_pid(&self) -> Option<u32> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|runtime| runtime.pid())
    }

    pub fn runtime_parse_errors(&self) -> u64 {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|runtime| runtime.parse_errors())
            .unwrap_or(0)
    }

    pub async fn select_model(&self, provider: &str, model: &str) -> Result<Value, ApiError> {
        if matches!(
            self.status(),
            Status::Pending | Status::Starting | Status::Recovering
        ) {
            *self
                .pending_model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some(json!({ "provider": provider, "model": model }));
            // The runtime applies it once started; the session's model is the
            // choice from now on, so every client shows the same one.
            let chosen = json!({ "provider": provider, "id": model });
            self.set_model(Some(chosen.clone()));
            return Ok(json!({ "provider": provider, "id": model, "name": model }));
        }
        self.request(
            pi::command::set_model(provider, model),
            Duration::from_secs(30),
        )
        .await?;
        let state = self
            .request(pi::command::get_state(), Duration::from_secs(10))
            .await?;
        let selected = state.get("model").cloned().unwrap_or(Value::Null);
        if !selected.is_null() {
            self.set_model(Some(selected.clone()));
        }
        Ok(selected)
    }

    /// A session with no model yet starts from the runtime's default.
    pub fn adopt_default_model(&self, model: Option<Value>) {
        let Some(model) = model else {
            return;
        };
        let unset = self
            .model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none();
        if !unset {
            return;
        }
        // The shown model is the one the runtime uses: apply it on start like a choice.
        if let (Some(provider), Some(id)) = (
            model.get("provider").and_then(Value::as_str),
            model.get("id").and_then(Value::as_str),
        ) {
            let mut pending = self
                .pending_model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if pending.is_none() {
                *pending = Some(json!({ "provider": provider, "model": id }));
            }
        }
        self.set_model(Some(model));
    }

    /// The reasoning level is part of the session summary; publish it when it changes.
    fn set_thinking_level(&self, level: Option<String>) {
        let changed = {
            let mut current = self
                .thinking_level
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let changed = *current != level;
            *current = level;
            changed
        };
        if changed {
            self.publish_summary();
        }
    }

    /// The model is part of the session summary; publish it when it changes.
    fn set_model(&self, model: Option<Value>) {
        let changed = {
            let mut current = self
                .model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if *current == model {
                false
            } else {
                *current = model;
                true
            }
        };
        if changed {
            self.publish_summary();
        }
    }

    pub async fn select_thinking(&self, level: &str) -> Result<Value, ApiError> {
        if matches!(
            self.status(),
            Status::Pending | Status::Starting | Status::Recovering
        ) {
            *self
                .pending_thinking
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(level.to_string());
            self.set_thinking_level(Some(level.to_string()));
            return Ok(json!({ "level": level }));
        }
        self.request(
            pi::command::set_thinking_level(level),
            Duration::from_secs(30),
        )
        .await?;
        self.set_thinking_level(Some(level.to_string()));
        Ok(json!({ "level": level }))
    }

    fn apply_pending_preferences(&self) {
        let model = self
            .pending_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(model) = model {
            let Some(provider) = model.get("provider").and_then(Value::as_str) else {
                return;
            };
            let Some(id) = model.get("model").and_then(Value::as_str) else {
                return;
            };
            let request = self.request_id();
            *self
                .pending_model_request
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                Some((request.clone(), model.clone()));
            let _ = self.write_command(pi::command::with_id(
                pi::command::set_model(provider, id),
                &request,
            ));
        }
        let level = self
            .pending_thinking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(level) = level {
            let request = self.request_id();
            let _ = self.write_command(pi::command::with_id(
                pi::command::set_thinking_level(&level),
                &request,
            ));
        }
    }

    pub fn stop(&self) {
        if matches!(self.status(), Status::Stopped | Status::Cancelled) {
            return;
        }
        let pending = matches!(self.status(), Status::Pending);
        self.set_status(if pending {
            Status::Cancelled
        } else {
            Status::Stopped
        });
        self.restarts.reset();
        self.cancel_pending("session-stopped");
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(runtime) = runtime {
            runtime.cancel_pending("session-stopped");
            runtime.terminate();
        }
        let _ = std::fs::remove_file(&self.lease_path);
    }

    pub fn info(&self) -> Value {
        json!({
            "sessionId": self.id,
            "workspacePath": canonical_path(&self.workspace_path),
            "sessionPath": self
                .session_path
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "title": self
                .title
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "updatedAt": self
                .updated_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "status": self.status().as_str(),
            "running": self.status() == Status::Running,
            "activeTurn": self.active_turn_view(self.status()),
            "runtimePid": self.runtime_pid(),
            "model": self
                .model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "runtimeParseErrors": self.runtime_parse_errors(),
            "cursor": self.cursor(),
            "pendingApprovals": self.pending_approvals(),
            "pendingQuestions": self.pending_questions(),
            "pendingApprovalCount": self.pending_approvals().len(),
            "pendingQuestionCount": self.pending_questions().len(),
        })
    }

    /// The turn in progress, as the session list and the session detail both show it.
    fn active_turn_view(&self, status: Status) -> Option<Value> {
        self.active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .map(|turn| {
                let phase = if self.cancelling.load(Ordering::Relaxed) {
                    "cancelling"
                } else {
                    match status {
                        Status::Pending | Status::Starting | Status::Recovering => "starting",
                        Status::Running | Status::WaitingApproval | Status::WaitingQuestion => "running",
                        _ => "accepted",
                    }
                };
                json!({
                    "turnId": turn,
                    "clientMessageId": self
                        .active_client_message
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                    "phase": phase,
                    "step": self.step_view(),
                    "startedAt": self
                        .turn_started_at
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone(),
                })
            })
    }

    pub fn summary(&self) -> Value {
        let status = self.status();
        let active_turn = self.active_turn_view(status);
        let queue: Vec<Value> = self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|item| {
                json!({
                    "turnId": item.turn,
                    "clientMessageId": item.client_message_id(),
                    "text": item.text(),
                    "images": item.prompt.get("images").and_then(Value::as_array).map_or(0, Vec::len),
                    "state": if self.queue_paused.load(Ordering::Relaxed) { "paused" } else { "queued" },
                })
            })
            .collect();
        let first_output = {
            let first = self
                .first_output
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            json!({
                "turns": first.count,
                "avgMs": (first.count > 0).then(|| first.total_ms / first.count),
                "lastMs": first.last_ms,
            })
        };
        json!({
            "sessionId": self.id,
            "sessionPath": self
                .session_path
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "sessionSeq": self.cursor(),
            "status": status.as_str(),
            "activeTurn": active_turn,
            "pendingApprovals": self.pending_approvals(),
            "pendingQuestions": self.pending_questions(),
            "statuses": self.ui_statuses(),
            "widgets": self.ui_widgets(),
            "queue": queue,
            "failedTurn": self
                .failed_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "listed": *self
                .listed
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
            "title": self
                .title
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "updatedAt": self
                .updated_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "model": self
                .model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "thinkingLevel": self
                .thinking_level
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "firstOutput": first_output,
            "runtime": {
                "attached": self.runtime_pid().is_some(),
                "recovering": status == Status::Recovering,
            },
        })
    }

    fn new(
        id: String,
        workspace_path: String,
        session_path: Option<String>,
        key: String,
        status: Status,
        config: &SessionConfig,
    ) -> Arc<Session> {
        let lease_path = config.home.join(format!("session-{id}.lease"));
        let (tx, _) = broadcast::channel(1024);
        Arc::new(Session {
            id,
            workspace_path,
            session_path: Mutex::new(session_path),
            key,
            status: Mutex::new(status),
            events: Mutex::new(EventLog::new(config.replay_limit)),
            tx,
            runtime: Mutex::new(None),
            runtime_generation: AtomicU64::new(0),
            restarts: Default::default(),
            config: config.clone(),
            lease_path,
            messages: Mutex::new(HashMap::new()),
            queued_turns: Mutex::new(VecDeque::new()),
            steer_generation: AtomicU64::new(0),
            prompt_echo: AtomicBool::new(false),
            queue_paused: AtomicBool::new(false),
            first_output_turn: Mutex::new(None),
            pending_prompts: Mutex::new(Vec::new()),
            next_message: AtomicU64::new(0),
            next_request: AtomicU64::new(0),
            active_message: Mutex::new(None),
            active_client_message: Mutex::new(None),
            turn_started_at: Mutex::new(None),
            cancelling: AtomicBool::new(false),
            turn_running: AtomicBool::new(false),
            release_flow_hold: AtomicBool::new(false),
            cancelled: Mutex::new(HashMap::new()),
            failed_turn: Mutex::new(None),
            listed: Mutex::new(false),
            title: Mutex::new(String::new()),
            updated_at: Mutex::new(None),
            handshake: Mutex::new(Handshake::Messages),
            ready: tokio::sync::Notify::new(),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_questions: Mutex::new(HashMap::new()),
            ui_statuses: Mutex::new(BTreeMap::new()),
            ui_widgets: Mutex::new(BTreeMap::new()),
            approval_outcomes: Mutex::new(HashMap::new()),
            question_outcomes: Mutex::new(HashMap::new()),
            next_prompt: AtomicU64::new(0),
            home: config.home.clone(),
            runtime_home: config.runtime_home.clone(),
            history: Mutex::new(Vec::new()),
            history_seq: AtomicU64::new(0),
            assistant_text: Mutex::new(String::new()),
            assistant_blocks: Mutex::new(Vec::new()),
            step: Mutex::new(StepState::new()),
            active_client: Mutex::new(None),
            model: Mutex::new(None),
            pending_model: Mutex::new(None),
            pending_model_request: Mutex::new(None),
            pending_thinking: Mutex::new(None),
            first_output: Mutex::new(FirstOutput::default()),
            warm_attach: Mutex::new(None),
            thinking_level: Mutex::new(None),
            subscribers: AtomicU64::new(0),
            next_client: AtomicU64::new(0),
            last_activity: Mutex::new(Instant::now()),
        })
    }

    fn start(self: &Arc<Self>, from_pending: bool) {
        if let Err(error) = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.lease_path)
        {
            self.set_status(Status::Error);
            self.publish(
                "error",
                json!({
                    "code": "internal",
                    "message": format!("Could not create the runtime lease: {error}"),
                    "retryable": false,
                }),
            );
            return;
        }
        self.spawn_runtime(true, from_pending);
    }

    /// The folder the runtime starts in: the session file's own folder text when
    /// it has one, so the handshake's switch keeps the loaded extensions.
    fn runtime_cwd(&self) -> String {
        self.session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .and_then(|path| session_header_cwd(&path))
            .unwrap_or_else(|| canonical_path(&self.workspace_path))
    }

    fn spawn_spec(&self) -> SpawnSpec {
        SpawnSpec {
            program: self.config.spec.program.clone(),
            args: self.config.spec.args.clone(),
            env: self.environment(),
            workspace: PathBuf::from(self.runtime_cwd()),
            low_priority: false,
        }
    }

    fn spawn_runtime(self: &Arc<Self>, initial: bool, from_pending: bool) -> bool {
        let (event_tx, event_rx) = tokio::sync::mpsc::channel(256);
        // A warm runtime is switched to this session's file by the handshake, so
        // only a session with a file can take one.
        let has_file = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some();
        if let (true, Some(pool)) = (has_file, self.config.warm.get()) {
            let before = pool.status();
            if let Some((runtime, matched, attaching)) =
                pool.take(event_tx.clone(), Path::new(&self.runtime_cwd()))
            {
                *self
                    .warm_attach
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((attaching, Instant::now()));
                log(
                    &self.home,
                    "info",
                    "runtime.warm_taken",
                    json!({
                        "session": self.id,
                        "pid": runtime.pid(),
                        "sameWorkspace": matched,
                        "warm": before,
                    }),
                );
                self.install_runtime(runtime, event_rx);
                return true;
            }
            pool.reset_failures();
            log(
                &self.home,
                "info",
                "runtime.cold_start",
                json!({ "session": self.id, "warm": before }),
            );
        }
        match RuntimeSupervisor::start(self.spawn_spec(), event_tx) {
            Ok(runtime) => {
                self.install_runtime(runtime, event_rx);
                true
            }
            Err(error) => {
                if initial {
                    self.set_status(if from_pending {
                        Status::Cancelled
                    } else {
                        Status::Error
                    });
                    let _ = std::fs::remove_file(&self.lease_path);
                    self.publish(
                        "error",
                        json!({
                            "code": "runtime-unavailable",
                            "message": format!("Could not start the runtime: {error}"),
                            "retryable": true,
                        }),
                    );
                } else {
                    self.recovery_failed(format!("Could not restart the runtime: {error}"));
                }
                false
            }
        }
    }

    fn install_runtime(
        self: &Arc<Self>,
        runtime: Arc<RuntimeSupervisor>,
        mut events: tokio::sync::mpsc::Receiver<RuntimeEvent>,
    ) {
        let generation = self.runtime_generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(runtime);
        self.restarts.settle();
        let session = self.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if session.runtime_generation.load(Ordering::SeqCst) != generation {
                    break;
                }
                session.handle_runtime_event(event);
            }
        });
        self.start_handshake();
    }

    fn schedule_recovery(self: &Arc<Self>, reason: String) {
        if matches!(self.status(), Status::Stopped | Status::Error) {
            return;
        }
        use crate::runtime::restart::Decision;
        let count = match self.restarts.decide() {
            Decision::AlreadyScheduled => return,
            Decision::Restart(count) => count,
            Decision::GiveUp => 0,
        };
        if count == 0 {
            self.set_status(Status::Error);
            self.publish(
                "error",
                json!({
                    "code": "runtime-crashed",
                    "message": "The runtime could not recover; restart it to continue.",
                    "retryable": true,
                }),
            );
            return;
        }
        log(
            &self.home,
            "warn",
            "runtime.recovering",
            json!({ "reason": reason, "attempts": count }),
        );
        self.set_status(Status::Recovering);
        let session = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            session.restart_runtime().await;
        });
    }

    async fn restart_runtime(self: &Arc<Self>) {
        if matches!(self.status(), Status::Stopped | Status::Error) {
            self.restarts.settle();
            return;
        }
        let previous = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(previous) = previous {
            previous.terminate();
        }
        // The Job Object must be gone before the replacement starts: Flow
        // allows one live attachment per session file.
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.spawn_runtime(false, false);
    }

    fn recovery_failed(self: &Arc<Self>, reason: String) {
        self.restarts.settle();
        let count = self.restarts.attempts();
        log(
            &self.home,
            "warn",
            "runtime.recovery_failed",
            json!({ "reason": reason, "attempts": count }),
        );
        if self.restarts.exhausted() {
            self.set_status(Status::Error);
            self.publish(
                "error",
                json!({
                    "code": "runtime-crashed",
                    "message": "The runtime could not recover; restart it to continue.",
                    "retryable": true,
                }),
            );
            return;
        }
        let session = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            session.schedule_recovery(reason);
        });
    }

    fn recovery_succeeded(&self) {
        // Attempts are kept for the five-minute window: a runtime that reaches
        // idle and dies again immediately is flapping, not healthy.
        self.restarts.settle();
    }

    fn start_queued_turn(self: &Arc<Self>) -> bool {
        if self.queue_paused.load(Ordering::Relaxed) {
            return false;
        }
        let Some(item) = self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front()
        else {
            return false;
        };
        let Queued { turn, prompt, row, .. } = item;
        if let Some(row) = row.clone() {
            self.deliver_user_row(row, &turn);
        }
        *self
            .active_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(turn.clone());
        *self
            .active_client_message
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
            Some(prompt.get("id").and_then(Value::as_str).unwrap_or_default().to_string());
        *self
            .turn_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Self::now_iso());
        *self
            .assistant_text
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = String::new();
        self.assistant_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.reset_step();
        self.prompt_echo.store(true, Ordering::SeqCst);
        self.publish(
            "turn.start",
            json!({ "turnId": turn, "phase": "running" }),
        );
        self.set_status(Status::Running);
        self.publish_summary();
        if let Err(error) = self.write_command(prompt.clone()) {
            self.queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push_front(Queued { turn: turn.clone(), prompt, row: None, steered: None, no_steer: true });
            *self
                .active_message
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            self.publish(
                "error",
                json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
            );
            self.set_status(Status::Error);
        }
        true
    }

    fn flush_pending_prompts(self: &Arc<Self>) {
        let prompts: Vec<Value> = self
            .pending_prompts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect();
        if prompts.is_empty() {
            return;
        }
        self.set_status(Status::Running);
        for prompt in prompts {
            if let Err(error) = self.write_command(prompt) {
                self.publish(
                    "error",
                    json!({ "code": error.code, "message": error.message, "retryable": error.retryable }),
                );
                self.set_status(Status::Error);
                return;
            }
        }
    }

    fn environment(&self) -> Vec<(OsString, OsString)> {
        let path = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        self.config.environment(Some(&self.id), path.as_deref())
    }

    fn handle_runtime_event(self: &Arc<Self>, event: RuntimeEvent) {
        match event {
            RuntimeEvent::Line(value) => self.handle_runtime_line(value),
            RuntimeEvent::Stderr(line) => {
                log(&self.home, "debug", "runtime.stderr", json!({ "line": line }));
            }
            RuntimeEvent::ParseError(message) => {
                log(
                    &self.home,
                    "warn",
                    "runtime.parse_error",
                    json!({ "message": message }),
                );
                self.publish(
                    "error",
                    json!({
                        "code": "runtime-error",
                        "message": message,
                        "retryable": true,
                    }),
                );
            }
            RuntimeEvent::IoError(message) => {
                if !matches!(self.status(), Status::Stopped) {
                    self.schedule_recovery(message);
                }
            }
            RuntimeEvent::Exited(code) => {
                log(
                    &self.home,
                    "info",
                    "runtime.exited",
                    json!({ "code": code }),
                );
                if !matches!(self.status(), Status::Stopped) {
                    let status = self.status();
                    let finalize = self.turn_running.load(Ordering::SeqCst)
                        || matches!(
                            status,
                            Status::Running
                                | Status::WaitingApproval
                                | Status::WaitingQuestion
                        );
                    if finalize {
                        self.release_flow_hold.store(true, Ordering::SeqCst);
                        let turn = self
                            .active_message
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .take();
                        if let Some(turn) = turn.clone() {
                            self.finish_step_reply(&turn, None, true);
                            self.close_unfinished_tools();
                        }
                        let client_id = self
                            .active_client_message
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .clone();
                        let failed_text = client_id.as_deref().and_then(|id| {
                            self.messages
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .get(id)
                                .map(|message| message.text.clone())
                        });
                        if let Some(id) = client_id {
                            *self
                                .failed_turn
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                                Some(json!({ "clientMessageId": id, "text": failed_text.unwrap_or_default() }));
                        }
                        *self
                            .active_client_message
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                        *self
                            .turn_started_at
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                        self.cancelling.store(false, Ordering::SeqCst);
                        self.turn_running.store(false, Ordering::SeqCst);
                        self.cancel_pending("runtime-exited");
                        *self
                            .active_client
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                        self.queue_paused.store(true, Ordering::SeqCst);
                        self.prompt_echo.store(false, Ordering::SeqCst);
                        // The runtime's own queue went with it.
                        for item in self
                            .queued_turns
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .iter_mut()
                        {
                            item.steered = None;
                        }
                        if let Some(turn) = turn {
                            self.publish(
                                "turn.end",
                                json!({
                                    "turnId": turn,
                                    "status": "failed",
                                    "reason": "runtime-exited",
                                }),
                            );
                        }
                        self.publish_summary();
                    }
                    // accepted/starting: nothing reached the model. Keep the
                    // active turn and parked prompt; recovery will run it.
                    self.schedule_recovery(format!("runtime exited with code {code:?}"));
                }
            }
        }
    }
}

fn same_session_file(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub struct SessionManager {
    config: Option<SessionConfig>,
    home: PathBuf,
    runtime_home: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    clients: Mutex<HashMap<String, Vec<String>>>,
    /// What each client connected to the global event stream has open. A
    /// client opens one session at a time; that session is never reaped while
    /// the client's stream is connected. Other idle sessions are, so a window
    /// left open does not keep a runtime alive for every session it visited.
    holders: Mutex<HashMap<String, Holder>>,
    persisted_cache: Mutex<Option<Vec<Value>>>,
}

#[derive(Default)]
struct Holder {
    streams: usize,
    session: Option<String>,
}

/// One connected global stream. Dropping it releases the client's hold once
/// its last stream closes.
pub struct ClientStream {
    manager: Arc<SessionManager>,
    client_id: String,
}

impl Drop for ClientStream {
    fn drop(&mut self) {
        let mut holders = self
            .manager
            .holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Keep what the client had open: a stream that reconnects picks its
        // hold up again. With no stream connected it protects nothing.
        if let Some(holder) = holders.get_mut(&self.client_id) {
            holder.streams = holder.streams.saturating_sub(1);
        }
    }
}

impl SessionManager {
    /// The host home: host.json, host.log.
    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn new(
        spec: Option<RuntimeSpec>,
        home: PathBuf,
        runtime_home: PathBuf,
        bash: Option<PathBuf>,
        replay_limit: usize,
        events: Option<Arc<crate::events::EventHub>>,
    ) -> Self {
        let config = spec.map(|spec| SessionConfig {
            spec,
            home: home.clone(),
            runtime_home: runtime_home.clone(),
            bash,
            replay_limit,
            events,
            warm: Arc::new(std::sync::OnceLock::new()),
        });
        Self {
            config,
            home,
            runtime_home,
            sessions: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            holders: Mutex::new(HashMap::new()),
            persisted_cache: Mutex::new(None),
        }
    }

    pub fn runtime_home(&self) -> &Path {
        &self.runtime_home
    }

    pub fn node_executable(&self) -> Option<PathBuf> {
        self.config
            .as_ref()
            .map(|config| config.spec.program.clone())
    }

    fn preferences_path(&self) -> PathBuf {
        self.runtime_home.join("state").join("session-preferences.json")
    }

    fn recent_path(&self) -> PathBuf {
        self.home.join("recent.json")
    }

    fn default_workspace(&self) -> Option<PathBuf> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let base = if cfg!(windows) {
            PathBuf::from(home).join("Documents")
        } else {
            PathBuf::from(home)
        };
        let path = base.join("Jouzu").join("default-workspace");
        std::fs::create_dir_all(&path).ok()?;
        Some(path)
    }

    fn workspace_value(&self, path: &str) -> Value {
        json!({
            "id": format!("windows:{path}"),
            "path": path,
            "environment": { "kind": "windows" },
        })
    }

    fn session_file(&self, session_path: &str) -> Result<PathBuf, ApiError> {
        let root = self
            .runtime_home
            .join("state")
            .join("sessions")
            .canonicalize()
            .unwrap_or_else(|_| self.runtime_home.join("state").join("sessions"));
        let path = PathBuf::from(session_path)
            .canonicalize()
            .map_err(|_| ApiError::bad_request("Unknown session path"))?;
        if !path.starts_with(&root)
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            return Err(ApiError::bad_request("Unknown session path"));
        }
        Ok(path)
    }

    pub fn recover_session(&self, session_path: &str) -> Result<Option<String>, ApiError> {
        let source = self.session_file(session_path)?;
        let text = std::fs::read_to_string(&source)
            .map_err(|error| ApiError::internal(format!("Could not read the session: {error}")))?;
        let entries: Vec<Value> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line)
                    .map_err(|_| ApiError::bad_request("Invalid session entry"))
            })
            .collect::<Result<_, _>>()?;
        let Some(repaired) = recover_entries(&entries)? else {
            return Ok(None);
        };
        let directory = source
            .parent()
            .ok_or_else(|| ApiError::bad_request("Session directory unavailable"))?;
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ApiError::bad_request("Invalid session filename"))?;
        let prefix = format!("{stem}-recovered-");
        if let Ok(existing) = std::fs::read_dir(directory) {
            for entry in existing.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(&prefix) && name.ends_with(".jsonl") && entry.path().is_file() {
                    return Ok(Some(canonical_path(&entry.path().to_string_lossy())));
                }
            }
        }
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_err(|_| ApiError::internal("Clock unavailable"))?
            .as_millis();
        let mut destination = directory.join(format!("{stem}-recovered-{millis}.jsonl"));
        let mut counter = 1;
        while destination.exists() {
            destination = directory.join(format!("{stem}-recovered-{millis}-{counter}.jsonl"));
            counter += 1;
        }
        let mut output = String::new();
        for entry in repaired {
            output.push_str(
                &serde_json::to_string(&entry)
                    .map_err(|error| ApiError::internal(error.to_string()))?,
            );
            output.push('\n');
        }
        std::fs::write(&destination, output)
            .map_err(|error| ApiError::internal(format!("Could not write recovery: {error}")))?;
        Ok(Some(canonical_path(&destination.to_string_lossy())))
    }

    pub fn branch_session(&self, session_path: &str, message_index: usize) -> Result<String, ApiError> {
        let source = self.session_file(session_path)?;
        let text = std::fs::read_to_string(&source)
            .map_err(|error| ApiError::internal(format!("Could not read the session: {error}")))?;
        let mut lines = text.lines();
        let header_line = lines
            .next()
            .ok_or_else(|| ApiError::bad_request("Session is empty"))?;
        let header: Value = serde_json::from_str(header_line)
            .map_err(|_| ApiError::bad_request("Session header is invalid"))?;
        let cwd = header
            .get("cwd")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad_request("Session has no workspace"))?;
        let mut kept = Vec::new();
        let mut seen = 0usize;
        let mut found = false;
        for line in lines {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            kept.push(line);
            if entry.get("type").and_then(Value::as_str) == Some("message") {
                if seen == message_index {
                    found = true;
                    break;
                }
                seen += 1;
            }
        }
        if !found {
            return Err(ApiError::bad_request("Message not found in session"));
        }
        let directory = source
            .parent()
            .ok_or_else(|| ApiError::bad_request("Session directory is missing"))?;
        let timestamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let target = directory.join(format!(
            "{}_{}.jsonl",
            timestamp.replace([':', '.'], "-"),
            random_id()
        ));
        let mut output = String::new();
        output.push_str(
            &json!({
                "type": "session",
                "version": 3,
                "id": random_id(),
                "timestamp": timestamp,
                "cwd": cwd,
                "parentSession": source.to_string_lossy(),
            })
            .to_string(),
        );
        output.push('\n');
        for line in kept {
            output.push_str(line);
            output.push('\n');
        }
        std::fs::write(&target, output)
            .map_err(|error| ApiError::internal(format!("Session branch write failed: {error}")))?;
        Ok(canonical_path(&target.to_string_lossy()))
    }

    pub fn messages(
        &self,
        session_path: &str,
        limit: Option<usize>,
    ) -> Result<Vec<Value>, ApiError> {
        let path = self.session_file(session_path)?;
        let mut messages = saved_messages(&path)
            .map_err(|error| ApiError::internal(format!("Could not read the session: {error}")))?;
        if let Some(limit) = limit {
            if messages.len() > limit {
                messages.drain(..messages.len() - limit);
            }
        }
        Ok(messages)
    }

    pub fn timing(&self, session_path: &str) -> Result<Value, ApiError> {
        let path = self.session_file(session_path)?;
        let file = std::fs::File::open(path)
            .map_err(|error| ApiError::internal(format!("Could not read the session: {error}")))?;
        let reader = std::io::BufReader::new(std::io::Read::take(file, 32 * 1024 * 1024));
        let mut model_ms = 0u64;
        let mut tool_ms = 0u64;
        let mut turns = 0u64;
        let mut steps = 0u64;
        let mut output_tokens = 0u64;
        let mut previous: Option<i64> = None;
        for line in std::io::BufRead::lines(reader) {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let entry_ts = value
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.timestamp_millis());
            if value.get("type").and_then(Value::as_str) != Some("message") {
                if entry_ts.is_some() {
                    previous = entry_ts;
                }
                continue;
            }
            let Some(message) = value.get("message") else {
                continue;
            };
            let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
            if role == "toolResult" {
                if let (Some(started), Some(ended)) = (previous, entry_ts) {
                    tool_ms += ended.saturating_sub(started).max(0) as u64;
                }
            } else if role == "user" {
                turns += 1;
            } else if role == "assistant" {
                steps += 1;
                output_tokens += message
                    .get("usage")
                    .and_then(|usage| usage.get("output"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if let (Some(started), Some(ended)) = (
                    message.get("timestamp").and_then(Value::as_i64),
                    entry_ts,
                ) {
                    model_ms += ended.saturating_sub(started).max(0) as u64;
                }
            }
            if entry_ts.is_some() {
                previous = entry_ts;
            }
        }
        Ok(json!({
            "modelMs": model_ms,
            "toolMs": tool_ms,
            "turns": turns,
            "steps": steps,
            "outputTokens": output_tokens,
        }))
    }

    pub fn flow_reports(&self, session_path: &str) -> Result<Vec<Value>, ApiError> {        let path = self.session_file(session_path)?;
        let file = std::fs::File::open(path)
            .map_err(|error| ApiError::internal(format!("Could not read the session: {error}")))?;
        let reader = std::io::BufReader::new(std::io::Read::take(file, 32 * 1024 * 1024));
        let mut reports = Vec::new();
        for line in std::io::BufRead::lines(reader) {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) != Some("custom_message")
                || value.get("display").and_then(Value::as_bool) == Some(false)
            {
                continue;
            }
            let Some(custom_type) = value.get("customType").and_then(Value::as_str) else {
                continue;
            };
            if !custom_type.starts_with("jouzu-flow") {
                continue;
            }
            let Some(content) = value.get("content").and_then(Value::as_array) else {
                continue;
            };
            let text = content
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(kind) = parsed.get("kind").and_then(Value::as_str) else {
                continue;
            };
            reports.push(json!({ "kind": kind, "text": text }));
        }
        if reports.len() > 30 {
            reports.drain(0..reports.len() - 30);
        }
        Ok(reports)
    }

    pub fn status(&self) -> Value {
        let app_version = std::fs::read(self.home.join("app").join("package.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.get("version").and_then(Value::as_str).map(str::to_string));
        json!({
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "runtimeHome": self.runtime_home.to_string_lossy(),
            "appVersion": app_version,
            "node": self.home.join("runtime").join("node").join("node.exe").is_file(),
            "app": self.home.join("app").join("bootstrap.mjs").is_file(),
            "bash": self.home.join("runtime").join("git").join("bin").join("bash.exe").is_file(),
            "git": self.home.join("runtime").join("git").exists(),
            "terminal": self.home.join("runtime").join("terminal").exists(),
            "warmRuntime": self.warm_runtime().map(|pool| pool.status()),
        })
    }

    pub fn workspace_allowed(&self, path: &str) -> bool {
        let Ok(candidate) = Path::new(path).canonicalize() else {
            return false;
        };
        let allowed = self
            .workspaces()
            .into_iter()
            .filter_map(|value| value.get("path").and_then(Value::as_str).map(PathBuf::from))
            .chain(
                self.sessions
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .values()
                    .map(|session| PathBuf::from(&session.workspace_path)),
            )
            .filter_map(|path| path.canonicalize().ok())
            .any(|root| candidate.starts_with(root));
        allowed
    }

    pub fn workspaces(&self) -> Vec<Value> {        let mut values: Vec<Value> = std::fs::read(self.recent_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|value| {
                value
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| Path::new(path).is_dir())
            })
            .collect();
        if values.is_empty() {
            if let Some(path) = self.default_workspace() {
                values.push(self.workspace_value(&path.to_string_lossy()));
                let _ = self.write_workspaces(&values);
            }
        }
        values
    }

    fn write_workspaces(&self, workspaces: &[Value]) -> Result<(), ApiError> {
        if let Some(parent) = self.recent_path().parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        let bytes = serde_json::to_vec_pretty(workspaces)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        std::fs::write(self.recent_path(), bytes)
            .map_err(|error| ApiError::internal(error.to_string()))
    }

    pub fn add_workspaces(&self, paths: &[String]) -> Result<Vec<Value>, ApiError> {
        let mut workspaces = self.workspaces();
        for path in paths {
            let path = path.trim();
            if path.is_empty() || !Path::new(path).is_dir() {
                continue;
            }
            let lower = path.replace('\\', "/").to_lowercase();
            if workspaces.iter().any(|value| {
                value
                    .get("path")
                    .and_then(Value::as_str)
                    .map(|existing| existing.replace('\\', "/").to_lowercase() == lower)
                    .unwrap_or(false)
            }) {
                continue;
            }
            workspaces.push(self.workspace_value(path));
        }
        self.write_workspaces(&workspaces)?;
        Ok(workspaces)
    }

    pub fn forget_workspace(&self, id: &str) -> Result<Vec<Value>, ApiError> {
        let mut workspaces = self.workspaces();
        workspaces.retain(|value| value.get("id").and_then(Value::as_str) != Some(id));
        self.write_workspaces(&workspaces)?;
        Ok(workspaces)
    }

    fn read_preferences(&self) -> HashMap<String, SessionPreference> {
        let Ok(bytes) = std::fs::read(self.preferences_path()) else {
            return HashMap::new();
        };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    fn write_preferences(
        &self,
        preferences: &HashMap<String, SessionPreference>,
    ) -> Result<(), ApiError> {
        let path = self.preferences_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                ApiError::internal(format!("Could not write session preferences: {error}"))
            })?;
        }
        let bytes = serde_json::to_vec_pretty(preferences)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, bytes)
            .and_then(|_| std::fs::rename(&temp, &path))
            .map_err(|error| ApiError::internal(format!("Could not write session preferences: {error}")))
    }

    pub fn update_session(
        &self,
        session_path: &str,
        pinned: Option<bool>,
        archived: Option<bool>,
        title: Option<String>,
    ) -> Result<Value, ApiError> {
        let root = self
            .runtime_home
            .join("state")
            .join("sessions")
            .canonicalize()
            .unwrap_or_else(|_| self.runtime_home.join("state").join("sessions"));
        let path = PathBuf::from(session_path)
            .canonicalize()
            .map_err(|_| ApiError::bad_request("Unknown session path"))?;
        if !path.starts_with(&root) || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            return Err(ApiError::bad_request("Unknown session path"));
        }
        let key = canonical_path(&path.to_string_lossy());
        let mut preferences = self.read_preferences();
        let (pinned, archived, title) = {
            let preference = preferences.entry(key.clone()).or_default();
            if let Some(value) = pinned {
                preference.pinned = value;
            }
            if let Some(value) = archived {
                preference.archived = value;
            }
            if let Some(value) = title {
                let value = value.trim();
                preference.title = if value.is_empty() {
                    None
                } else {
                    Some(value.chars().take(80).collect())
                };
            }
            (preference.pinned, preference.archived, preference.title.clone())
        };
        self.write_preferences(&preferences)?;
        Ok(json!({
            "sessionPath": key,
            "pinned": pinned,
            "archived": archived,
            "title": title,
        }))
    }

    pub fn list(&self) -> Vec<Value> {
        let preferences = self.read_preferences();
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut values: Vec<Value> = sessions
            .values()
            .filter(|session| {
                !is_scratch_workspace(&session.workspace_path)
                    && !matches!(session.status(), Status::Pending | Status::Cancelled)
            })
            .map(|session| session.info())
            .collect();
        for value in &mut values {
            let Some(path) = value.get("sessionPath").and_then(Value::as_str) else {
                continue;
            };
            if let Some(preference) = preferences.get(&canonical_path(path)) {
                if let Some(title) = &preference.title {
                    value["title"] = Value::String(title.clone());
                }
                value["pinned"] = Value::Bool(preference.pinned);
                value["archived"] = Value::Bool(preference.archived);
            }
        }
        values.sort_by(|a, b| {
            a.get("sessionId")
                .and_then(Value::as_str)
                .cmp(&b.get("sessionId").and_then(Value::as_str))
        });
        values
    }

    /// Session files live in the runtime home owned by the host. This index is
    /// metadata-only: it never starts a runtime and never returns transcript
    /// bodies.
    pub fn reap_idle(&self, ttl: Duration) {
        let held: Vec<String> = self
            .holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .filter(|holder| holder.streams > 0)
            .filter_map(|holder| holder.session.clone())
            .collect();
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stale: Vec<String> = sessions
            .iter()
            .filter(|(id, session)| {
                let idle = session.status() == Status::Idle
                    && session.subscriber_count() == 0
                    && !held.contains(id)
                    && session.last_activity().elapsed() >= ttl;
                let pending = session.status() == Status::Pending
                    && !held.contains(id)
                    && session.last_activity().elapsed() >= ttl;
                idle || pending
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            if let Some(session) = sessions.remove(&id) {
                session.stop();
            }
        }
    }

    fn scan_persisted(&self) -> Vec<Value> {
        let preferences = self.read_preferences();
        let directory = self.runtime_home.join("state").join("sessions");
        let mut files: Vec<(PathBuf, std::time::SystemTime)> = std::fs::read_dir(&directory)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        let path = entry.path();
                        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                            return None;
                        }
                        let modified = entry.metadata().ok()?.modified().ok()?;
                        Some((path, modified))
                    })
                    .collect()
            })
            .unwrap_or_default();
        files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
        files
            .into_iter()
            .filter_map(|(path, modified)| {
                let file = std::fs::File::open(&path).ok()?;
                let reader = std::io::BufReader::new(file);
                let mut cwd = None;
                let mut title = None;
                for line in std::io::BufRead::lines(reader) {
                    let line = line.ok()?;
                    let value: Value = serde_json::from_str(&line).ok()?;
                    if value.get("type").and_then(Value::as_str) == Some("session") {
                        cwd = value
                            .get("cwd")
                            .and_then(Value::as_str)
                            .map(ToString::to_string);
                    }
                    if value.get("type").and_then(Value::as_str) == Some("message")
                        && value
                            .get("message")
                            .and_then(|message| message.get("role"))
                            .and_then(Value::as_str)
                            == Some("user")
                    {
                        if title.is_none() {
                            title = value
                            .get("message")
                            .and_then(|message| message.get("content"))
                            .and_then(|content| {
                                content.as_str().map(str::to_string).or_else(|| {
                                    content.as_array().and_then(|content| {
                                        content.iter().find_map(|block| {
                                            block
                                                .get("text")
                                                .and_then(Value::as_str)
                                                .map(str::to_string)
                                        })
                                    })
                                })
                            });
                        }
                    }
                }
                let cwd = cwd?;
                if is_scratch_workspace(&cwd) {
                    return None;
                }

                let normalized = cwd
                    .replace('\\', "/")
                    .trim_start_matches("//?/")
                    .trim_end_matches('/')
                    .to_lowercase();
                let _ = normalized;
                let key = canonical_path(&path.to_string_lossy());
                let preference = preferences.get(&key);
                // Nobody has written in it yet: a warm runtime's own file, or a new
                // session never used. Kept for the folder spelling, never listed.
                let blank = title.is_none()
                    && preference.and_then(|preference| preference.title.as_ref()).is_none();
                let title = preference
                    .and_then(|preference| preference.title.clone())
                    .unwrap_or_else(|| {
                        title.unwrap_or_else(|| {
                            path.file_stem()
                                .and_then(|value| value.to_str())
                                .unwrap_or("Session")
                                .to_string()
                        })
                    });
                let title = if title.trim().is_empty() {
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Session")
                        .to_string()
                } else {
                    title
                };
                Some(json!({
                    "sessionPath": key,
                    "workspacePath": canonical_path(&cwd),
                    "title": title.chars().take(120).collect::<String>(),
                    "updatedAt": DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis, true),
                    "status": "stopped",
                    "running": false,
                    "pinned": preference.map(|value| value.pinned).unwrap_or(false),
                    "archived": preference.map(|value| value.archived).unwrap_or(false),
                    "blank": blank,
                }))
            })
            // Blank files never count toward the list's limit.
            .scan(0usize, |listed, entry| {
                if entry.get("blank").and_then(Value::as_bool) != Some(true) {
                    *listed += 1;
                }
                Some((*listed <= 300).then_some(entry))
            })
            .flatten()
            .collect()
    }

    /// Saved conversations, most recent first (at most 300).
    pub fn persisted(&self, workspace: Option<&str>, refresh: bool) -> Vec<Value> {
        self.persisted_files(workspace, refresh)
            .into_iter()
            .filter(|entry| entry.get("blank").and_then(Value::as_bool) != Some(true))
            .map(|mut entry| {
                if let Some(object) = entry.as_object_mut() {
                    object.remove("blank");
                }
                entry
            })
            .collect()
    }

    /// Every saved session file, blank ones included.
    fn persisted_files(&self, workspace: Option<&str>, refresh: bool) -> Vec<Value> {
        let entries = {
            let mut cache = self
                .persisted_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if refresh || cache.is_none() {
                *cache = Some(self.scan_persisted());
            }
            cache.clone().unwrap_or_default()
        };
        let Some(wanted) = workspace else {
            return entries;
        };
        let wanted = wanted
            .replace('\\', "/")
            .trim_start_matches("//?/")
            .trim_end_matches('/')
            .to_lowercase();
        entries
            .into_iter()
            .filter(|entry| {
                entry
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .map(|path| {
                        path.replace('\\', "/")
                            .trim_start_matches("//?/")
                            .trim_end_matches('/')
                            .to_lowercase()
                            == wanted
                    })
                    .unwrap_or(false)
            })
            .collect()
    }

    pub fn register_client(&self, client_id: &str, capabilities: &[String]) {
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = clients.entry(client_id.to_string()).or_default();
        for capability in capabilities {
            if !entry.iter().any(|existing| existing == capability) {
                entry.push(capability.clone());
            }
        }
    }

    /// A client's global stream is open; keep what it holds until it closes.
    pub fn connect_client(self: &Arc<Self>, client_id: &str) -> ClientStream {
        self.holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(client_id.to_string())
            .or_default()
            .streams += 1;
        ClientStream {
            manager: Arc::clone(self),
            client_id: client_id.to_string(),
        }
    }

    /// The client opened or used this session; it replaces what it held.
    /// Only a client with a connected stream holds anything.
    pub fn hold(&self, client_id: &str, session_id: &str) {
        if let Some(holder) = self
            .holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(client_id)
        {
            holder.session = Some(session_id.to_string());
        }
    }

    /// The session this client shows now, if it has a connected stream.
    pub fn viewing(&self, client_id: &str) -> Option<String> {
        self.holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(client_id)
            .and_then(|holder| holder.session.clone())
    }

    pub fn client_can_prompt(&self, client_id: &str) -> bool {
        self.clients
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(client_id)
            .is_some_and(|capabilities| capabilities.iter().any(|value| value == "prompts"))
    }

    pub fn decide_approval(
        &self,
        approval_id: &str,
        client_id: &str,
        decision: &str,
    ) -> Result<Value, ApiError> {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for session in sessions {
            if session.has_approval(approval_id) {
                return session.decide_approval(approval_id, client_id, decision);
            }
        }
        Err(ApiError::new(
            axum::http::StatusCode::NOT_FOUND,
            "prompt-not-found",
            "Approval does not exist",
            false,
        ))
    }

    pub fn answer_question(
        &self,
        question_id: &str,
        client_id: &str,
        answers: &HashMap<String, String>,
    ) -> Result<Value, ApiError> {
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for session in sessions {
            if session.has_question(question_id) {
                return session.answer_question(question_id, client_id, answers);
            }
        }
        Err(ApiError::new(
            axum::http::StatusCode::NOT_FOUND,
            "prompt-not-found",
            "Question does not exist",
            false,
        ))
    }

    pub fn summaries(&self) -> Vec<Value> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .map(|session| session.summary())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }


    pub fn create(
        &self,
        workspace: &str,
        session_path: Option<String>,
        key: Option<String>,
    ) -> Result<Arc<Session>, ApiError> {
        self.create_with_status(workspace, session_path, key, Status::Starting)
    }

    pub fn create_pending(
        &self,
        workspace: &str,
        session_path: Option<String>,
        key: Option<String>,
    ) -> Result<Arc<Session>, ApiError> {
        self.create_with_status(workspace, session_path, key, Status::Pending)
    }

    fn create_with_status(
        &self,
        workspace: &str,
        session_path: Option<String>,
        key: Option<String>,
        status: Status,
    ) -> Result<Arc<Session>, ApiError> {
        // A saved conversation belongs to the folder its file names, whatever
        // folder the client happens to be showing: the runtime works there and
        // the sidebar must file it there.
        let workspace = session_path
            .as_deref()
            .and_then(session_header_cwd)
            .unwrap_or_else(|| workspace.to_string());
        let workspace = std::fs::canonicalize(&workspace)
            .map_err(|_| ApiError::bad_request("workspacePath is unavailable"))?;
        if !workspace.is_dir() {
            return Err(ApiError::bad_request("workspacePath must be a folder"));
        }
        let key = key.unwrap_or_else(|| {
            session_path.clone().unwrap_or_else(|| format!("new-{}", random_id()))
        });
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // One live host session per session file: a client that re-attaches
            // by path (after a reload, from the sidebar) joins the session that
            // already owns the file instead of starting a second runtime on it.
            let same_file = |session: &Arc<Session>| {
                let Some(requested) = session_path.as_deref() else {
                    return false;
                };
                let current = session
                    .session_path
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                current.is_some_and(|current| same_session_file(&current, requested))
            };
            // A different file carrying the same conversation (a copy) cannot be
            // open twice: the runtime refuses the second owner after loading for
            // seconds. Say so at once instead.
            if let Some(requested_id) = session_path.as_deref().and_then(session_header_id) {
                let twin = sessions.values().find(|session| {
                    if same_file(session)
                        || matches!(session.status(), Status::Stopped | Status::Cancelled | Status::Error)
                    {
                        return false;
                    }
                    let path = session
                        .session_path
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone();
                    path.and_then(|path| session_header_id(&path)).as_deref() == Some(requested_id.as_str())
                });
                if let Some(twin) = twin {
                    let other = twin
                        .session_path
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .clone()
                        .unwrap_or_default();
                    return Err(ApiError::new(
                        axum::http::StatusCode::CONFLICT,
                        "session-open-elsewhere",
                        format!("This conversation is already open from another file ({other}). Close that one first."),
                        false,
                    ));
                }
            }
            if let Some(existing) = sessions
                .values()
                .find(|session| session.key == key || same_file(session))
                .cloned()
            {
                if !matches!(
                    existing.status(),
                    Status::Stopped | Status::Cancelled | Status::Error
                ) {
                    return Ok(existing);
                }
                sessions.remove(&existing.id);
            }
        }
        let config = self.config.clone().ok_or_else(|| {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "runtime-unavailable",
                "No runtime is configured for the host",
                false,
            )
        })?;
        std::fs::create_dir_all(&config.home.join("data")).ok();
        // A new session gets its identity at creation, not after the runtime
        // handshake. The index and navigation can then show it before the first
        // reply, including when the turn is stopped during starting.
        let session_path = match session_path {
            Some(path) => Some(path),
            None if matches!(status, Status::Pending) => {
                let directory = self.runtime_home.join("state").join("sessions");
                std::fs::create_dir_all(&directory).ok();
                let file = directory.join(format!("{}.jsonl", random_id()));
                let header = json!({
                    "type": "session",
                    "version": 3,
                    "id": random_id(),
                    "timestamp": Session::now_iso(),
                    "cwd": self.folder_text(&workspace),
                });
                if std::fs::write(&file, format!("{header}\n")).is_ok() {
                    Some(file.to_string_lossy().into_owned())
                } else {
                    None
                }
            }
            None => None,
        };
        let id = match &session_path {
            Some(path) => session_id_for_path(path),
            None => format!("h-{}", random_id()),
        };
        let session = Session::new(
            id,
            workspace.to_string_lossy().into_owned(),
            session_path,
            key.clone(),
            status,
            &config,
        );
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions.insert(session.id.clone(), session.clone());
        }
        if matches!(status, Status::Starting) {
            // A saved conversation is readable the moment it is opened: its
            // history comes from its file, not from the runtime that attaches
            // to it seconds (or, on a busy machine, minutes) later.
            session.open_saved_history();
            let starting = session.clone();
            tokio::spawn(async move { starting.start(false) });
        } else if let Some(pool) = config.warm.get() {
            // A new session: the user is typing; warm for its folder meanwhile.
            pool.aim(Path::new(&session.runtime_cwd()));
            pool.hurry();
        }
        Ok(session)
    }

    /// Keep one runtime started ahead of need. Called once by the host binary;
    /// tests opt in explicitly.
    pub fn enable_warm_runtime(&self) -> Option<Arc<WarmPool>> {
        let config = self.config.clone()?;
        let scratch = WarmPool::scratch(&config.home);
        let events = config.events.clone();
        let spawn = config.clone();
        let memory = config.home.join("warm-workspace.txt");
        let log_home = config.home.clone();
        let pool = config.warm.get_or_init(|| {
            WarmPool::new(
                move |workspace| SpawnSpec {
                    program: spawn.spec.program.clone(),
                    args: spawn.spec.args.clone(),
                    env: spawn.environment(None, None),
                    workspace: workspace.map(Path::to_path_buf).unwrap_or_else(|| scratch.clone()),
                    low_priority: true,
                },
                Some(memory),
                move |status| {
                    // Each state change, so a slow or failed warm-up can be traced.
                    log(&log_home, "info", "runtime.warm", status.clone());
                    if let Some(events) = &events {
                        events.publish_control("runtime.warm", status);
                    }
                },
            )
        });
        pool.fill();
        log(&config.home, "info", "runtime.warm_start", pool.status());
        // The app is starting and its loading screen waits for this runtime.
        pool.hurry();
        Some(pool.clone())
    }

    /// How to spell `workspace` for a runtime and a new session header. Pi
    /// treats `\\?\C:\x` and `C:\x` as two folders, and a runtime switched across
    /// them loads every extension again. A folder keeps the spelling it already
    /// has: the warm runtime's, else its latest session's, else the plain form.
    pub fn folder_text(&self, workspace: &Path) -> String {
        if let Some(pool) = self.warm_runtime() {
            if let Some(known) = pool.folders().into_iter().find(|folder| same_place(folder, workspace)) {
                return known.to_string_lossy().into_owned();
            }
        }
        let plain = canonical_path(&workspace.to_string_lossy());
        let latest = self
            .persisted_files(Some(&plain), false)
            .into_iter()
            .filter_map(|entry| entry.get("sessionPath").and_then(Value::as_str).map(str::to_string))
            .find_map(|path| session_header_cwd(&path));
        match latest {
            Some(text) if same_place(Path::new(&text), workspace) => text,
            _ => plain,
        }
    }

    pub fn warm_runtime(&self) -> Option<Arc<WarmPool>> {
        self.config.as_ref().and_then(|config| config.warm.get().cloned())
    }

    pub fn stop_all(&self) {
        if let Some(pool) = self.warm_runtime() {
            pool.stop();
        }
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        for session in sessions {
            session.stop();
        }
    }
}

/// Git Bash discovery for the runtime environment.
pub fn find_bash(managed: &Path) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("JOUZU_LAUNCHER_BASH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let candidates = [
        managed.join("runtime/git/installed/bin/bash.exe"),
        managed.join("runtime/git/PortableGit/bin/bash.exe"),
        managed.join("runtime/git/bin/bash.exe"),
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    #[serde(rename = "workspacePath")]
    pub workspace_path: String,
    #[serde(rename = "sessionPath")]
    pub session_path: Option<String>,
    pub key: Option<String>,
    /// The client opening the session; it holds the session (see `hold`).
    #[serde(rename = "clientId", default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Attachment {
    #[serde(default)]
    pub name: String,
    #[serde(rename = "mimeType", default)]
    pub mime_type: String,
    #[serde(default)]
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    #[serde(rename = "clientMessageId")]
    pub client_message_id: String,
    pub text: String,
    #[serde(rename = "clientId", default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: axum::http::StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ApiError {
    pub fn new(
        status: axum::http::StatusCode,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid-request",
            message,
            false,
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            message,
            false,
        )
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "runtime-unavailable",
            message,
            true,
        )
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            axum::Json(json!({
                "error": {
                    "code": self.code,
                    "message": self.message,
                    "retryable": self.retryable,
                }
            })),
        )
            .into_response()
    }
}

fn recover_entries(entries: &[Value]) -> Result<Option<Vec<Value>>, ApiError> {
    let Some(header) = entries.first() else {
        return Ok(None);
    };
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(ApiError::bad_request("Session header is invalid"));
    }
    let mut calls: Vec<(String, String)> = Vec::new();
    let mut results = std::collections::HashSet::new();
    for entry in entries {
        let Some(message) = entry.get("message") else {
            continue;
        };
        match message.get("role").and_then(Value::as_str) {
            Some("assistant") => {
                if let Some(content) = message.get("content").and_then(Value::as_array) {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("toolCall") {
                            if let (Some(id), Some(name)) = (
                                block.get("id").and_then(Value::as_str),
                                block.get("name").and_then(Value::as_str),
                            ) {
                                calls.push((id.to_string(), name.to_string()));
                            }
                        }
                    }
                }
            }
            Some("toolResult") => {
                if let Some(id) = message.get("toolCallId").and_then(Value::as_str) {
                    results.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    let pending: Vec<&(String, String)> = calls
        .iter()
        .filter(|(id, _)| !results.contains(id))
        .collect();
    if pending.is_empty() {
        return Ok(None);
    }
    let mut repaired = entries.to_vec();
    let original_id = header
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("session");
    let mut parent = entries
        .iter()
        .rev()
        .find_map(|entry| entry.get("id").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let mut used: std::collections::HashSet<String> = entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let base = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map_err(|_| ApiError::internal("Clock unavailable"))?
        .as_millis();
    for (index, (tool_call_id, tool_name)) in pending.iter().enumerate() {
        let mut serial = base + index as u128;
        let mut id = format!("{serial:08x}");
        while used.contains(&id) {
            serial += 1;
            id = format!("{serial:08x}");
        }
        used.insert(id.clone());
        let timestamp = entries
            .last()
            .and_then(|entry| entry.get("timestamp"))
            .cloned()
            .unwrap_or(Value::Null);
        repaired.push(json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": timestamp,
            "message": {
                "role": "toolResult",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "content": [{ "type": "text", "text": "Interrupted: this tool call had no result. The recovered copy continued without it." }],
                "details": {},
                "isError": true,
                "durationMs": 0,
                "timestamp": base as u64
            }
        }));
        parent = id;
    }
    let mut new_header = header.clone();
    if let Some(object) = new_header.as_object_mut() {
        object.insert(
            "id".into(),
            Value::String(format!("{original_id}-recovered-{base}")),
        );
    }
    repaired[0] = new_header;
    Ok(Some(repaired))
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A persisted session keeps the same id across host restarts.
pub fn session_id_for_path(path: &str) -> String {
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path));
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    format!("s-{}", hex::encode(&digest[..8]))
}

fn find_program(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}
