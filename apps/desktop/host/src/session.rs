//! Session ownership for the host. One pi RPC runtime process per session, a
//! bounded event log, and an exclusive lifecycle independent of any page.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};

pub(crate) fn canonical_path(path: &str) -> String {
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
/// Every message of a saved session file, oldest first. The whole file is read:
/// a long session's newest messages are at its end (#20).
fn saved_messages(path: &Path) -> std::io::Result<Vec<Value>> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);
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

/// The model a saved conversation last used, as its file records it: the last
/// model change or assistant reply. Only shown until a runtime reports.
fn saved_last_model(path: &Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut last = None;
    for line in std::io::BufRead::lines(reader) {
        let Ok(line) = line else { break };
        if !line.contains("\"model_change\"") && !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        let pick = match value.get("type").and_then(Value::as_str) {
            Some("model_change") => value.get("provider").zip(value.get("modelId")),
            Some("message") => value
                .get("message")
                .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
                .and_then(|message| message.get("provider").zip(message.get("model"))),
            _ => None,
        };
        if let Some((Value::String(provider), Value::String(id))) = pick {
            last = Some(json!({ "provider": provider, "id": id }));
        }
    }
    last
}

fn is_scratch_workspace(path: &str) -> bool {
    path.split(|character| character == '\\' || character == '/')
        .any(|part| part.starts_with("jouzu-warm-"))
}
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::awake::AwakeInstant;
use crate::log;
use crate::runtime::adapter::pi::{self, DeltaKind, Record as PiRecord};
use crate::known_models::{is_model, KnownModels};
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

/// The Node executable inside a bundled distribution: `node.exe` on Windows,
/// `bin/node` in the official Unix tarballs.
pub fn node_executable_path(node_root: &Path) -> PathBuf {
    if cfg!(windows) {
        node_root.join("node.exe")
    } else {
        node_root.join("bin").join("node")
    }
}

/// The bundled Node under a managed directory (its `runtime/node` folder).
pub fn managed_node_path(managed: &Path) -> PathBuf {
    node_executable_path(&managed.join("runtime").join("node"))
}

#[derive(Clone)]
pub struct RuntimeSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl RuntimeSpec {
    /// The Node the managed runtime runs on: `JOUZU_HOST_NODE` when set, else
    /// the bundled one under the managed directory. It may not exist yet.
    pub fn managed_node(managed: &Path) -> PathBuf {
        std::env::var_os("JOUZU_HOST_NODE")
            .map(PathBuf::from)
            .unwrap_or_else(|| managed_node_path(managed))
    }

    /// The provisioned runtime rooted at the managed directory.
    pub fn from_managed(managed: &Path) -> Option<Self> {
        let node = Self::managed_node(managed);
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
            program: find_program(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })),
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
    /// The managed install the runtime came from. Without a fixed `bash`, Git
    /// Bash is looked up under it at each spawn: the first-run install adds Git
    /// after Node and the app, so a lookup when the runtime is found can be too early.
    pub managed: Option<PathBuf>,
    pub replay_limit: usize,
    pub events: Option<Arc<crate::events::EventHub>>,
    /// The runtime started ahead of need, shared by every session.
    pub warm: Arc<std::sync::OnceLock<Arc<WarmPool>>>,
    /// The runtimes' latest answers about models (`known_models`).
    pub known: Arc<KnownModels>,
    /// What replies said about each provider's sign-in (`provider_answers`).
    pub providers: Arc<crate::provider_answers::ProviderAnswers>,
}

impl SessionConfig {
    /// The runtime's environment. Session-specific variables are left out for
    /// a warm runtime, which does not belong to a session yet.
    ///
    /// Order: the host's own environment, then the variables saved in Settings
    /// (read from disk now, so a saved key reaches the next runtime without a
    /// host restart), then the variables the host manages, which always win.
    /// A saved file that cannot be read is an error, never an empty list.
    fn environment(
        &self,
        session_id: Option<&str>,
        session_path: Option<&str>,
    ) -> Result<Vec<(OsString, OsString)>, String> {
        let saved = crate::environment::enabled(&self.runtime_home).map_err(|message| {
            format!(
                "saved environment variables could not be read ({message}). Open Settings > Environment and save them again"
            )
        })?;
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
        for (name, value) in saved {
            set(&name, OsString::from(value));
        }
        set("JOUZU_HOME", self.runtime_home.as_os_str().to_os_string());
        set("JOUZU_NO_UPDATE", OsString::from("1"));
        set("PI_SKIP_VERSION_CHECK", OsString::from("1"));
        set("JOUZU_TEXTGUARD_DESKTOP", OsString::from("1"));
        if let Some(id) = session_id {
            set("JOUZU_HOST_SESSION_ID", OsString::from(id));
        }
        let bash = self
            .bash
            .clone()
            .or_else(|| self.managed.as_deref().and_then(find_bash));
        if let Some(bash) = bash {
            set("JOUZU_LAUNCHER_BASH", bash.into_os_string());
        }
        if let Some(path) = session_path {
            set("JOUZU_SESSION_PATH", OsString::from(path));
        }
        for (key, value) in &self.spec.env {
            set(key, OsString::from(value));
        }
        Ok(environment.into_values().collect())
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
    // A message's content may be plain text instead of blocks (the runtime's
    // message format allows it; older versions wrote it that way).
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
        return blocks;
    }
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

/// Where a history image's bytes are: a file the host stored when the message
/// was sent, or the image block of the saved session file it was read from.
#[derive(Clone)]
enum AttachmentSource {
    File { path: PathBuf, mime_type: String },
    Saved { mime_type: String, data: Arc<str> },
}

/// The images of a saved user message, with the ids its history row gives them.
/// The id is the message's place in the file, so it is the same on every import.
fn saved_images(message: &Value, index: usize) -> Vec<(String, String, String)> {
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|block| {
            let mime_type = block.get("mimeType").and_then(Value::as_str)?;
            let data = block.get("data").and_then(Value::as_str)?;
            (mime_type.starts_with("image/") && !data.is_empty())
                .then(|| (mime_type.to_string(), data.to_string()))
        })
        .enumerate()
        .map(|(number, (mime_type, data))| (format!("saved-{index}-{number}"), mime_type, data))
        .collect()
}

/// Decoded size of base64 data.
fn base64_len(data: &str) -> usize {
    let padding = data.bytes().rev().take_while(|byte| *byte == b'=').count().min(2);
    (data.len() / 4 * 3).saturating_sub(padding)
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
    /// An extension (Flow) took the steer and holds it; it releases it into the
    /// runtime's queue later. Still the user's, still not delivered: never sent
    /// again by the host while held.
    held: bool,
    /// Written as a prompt while the runtime started a run of its own; the
    /// runtime has not answered it yet. It refuses it (the message is then
    /// steered) or, if that run ended first, starts a run with it.
    prompted: bool,
}

impl Queued {
    fn client_message_id(&self) -> Option<&str> {
        self.prompt.get("id").and_then(Value::as_str)
    }

    fn text(&self) -> &str {
        self.prompt.get("message").and_then(Value::as_str).unwrap_or("")
    }
}

/// Who started a run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunOrigin {
    /// A message the user sent.
    User,
    /// The runtime itself (Flow continuing its work, an extension).
    Runtime,
}

impl RunOrigin {
    fn as_str(self) -> &'static str {
        match self {
            RunOrigin::User => "user",
            RunOrigin::Runtime => "runtime",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunPhase {
    /// The prompt waits for the runtime's handshake; the run keeps it.
    Starting,
    /// Claimed for a message whose prompt is about to be written.
    Claimed,
    /// The prompt was written; the runtime has not answered it yet.
    Sent,
    /// The runtime accepted the prompt; its run is about to start. The runtime
    /// answers a prompt before that run's `agent_start`, and after it always
    /// ends the run with `agent_settled`.
    Accepted,
    /// Between the runtime's `agent_start` and `agent_settled`.
    Streaming,
}

impl RunPhase {
    /// The runtime has (or is about to have) a run for it: only `agent_settled` ends it.
    fn started(self) -> bool {
        matches!(self, RunPhase::Accepted | RunPhase::Streaming)
    }
}

/// The run in progress: the one answer to "is this session busy", and
/// everything that belongs to that run. The host opens it when it hands the
/// runtime a prompt, or on the runtime's `agent_start` when the runtime
/// started it itself; it ends on `agent_settled`, whoever started it, or when
/// a failure ends it. Every change to it happens under its lock, and every
/// change checks that the run is still the one it means.
#[derive(Clone)]
struct Run {
    id: String,
    origin: RunOrigin,
    phase: RunPhase,
    /// The user's message that started it.
    client_message_id: Option<String>,
    /// The client that sent that message.
    client: Option<String>,
    /// The prompt for that message and its history row, kept until the run
    /// starts: if the runtime starts a run of its own first, the message goes
    /// back to the queue with both.
    prompt: Option<Value>,
    row: Option<Value>,
    started_at: String,
    /// Stop was asked for this run.
    stopping: bool,
    /// The runtime refused the last Stop: its words, shown at Stop until it is pressed again.
    stop_error: Option<String>,
    /// Its first reply has started. The runtime takes waiting steers once more
    /// just before its first model call, so a steer handed over earlier would
    /// be merged into the message that started it.
    replying: bool,
    /// Its own prompt has not come back from the runtime yet: the first user
    /// message of the run is that prompt, not a steered one.
    echo_pending: bool,
}

impl Run {
    fn user(id: &str, client_message_id: &str, client: Option<String>, prompt: Value, row: Option<Value>, phase: RunPhase) -> Self {
        Self {
            id: id.to_string(),
            origin: RunOrigin::User,
            phase,
            client_message_id: Some(client_message_id.to_string()),
            client,
            prompt: Some(prompt),
            row,
            started_at: Session::now_iso(),
            stopping: false,
            stop_error: None,
            replying: false,
            echo_pending: true,
        }
    }

    fn runtime(id: String) -> Self {
        Self {
            id,
            origin: RunOrigin::Runtime,
            phase: RunPhase::Streaming,
            client_message_id: None,
            client: None,
            prompt: None,
            row: None,
            started_at: Session::now_iso(),
            stopping: false,
            stop_error: None,
            replying: false,
            echo_pending: false,
        }
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
    /// Steers written to the runtime and not answered yet. The runtime queues
    /// a steer only after its extensions' input handlers ran, handling other
    /// commands meanwhile: until it answers, a take-back would miss it.
    steers_in_flight: AtomicUsize,
    /// A take-back is due once every steer in flight has been answered.
    reclaim_waiting: AtomicBool,
    /// Created as a new conversation, not opened from a saved file. Its
    /// runtime starts on the runtime's own model; a saved one gets the model
    /// the runtime restores when it opens the file.
    fresh: AtomicBool,
    /// A client with a stream showed it: leaving it untouched hands its runtime back.
    shown: AtomicBool,
    /// Clients that show it now (a client shows one session at a time; one whose
    /// stream dropped keeps showing it until it opens another).
    viewers: AtomicUsize,
    first_output_turn: Mutex<Option<String>>,
    first_output: Mutex<FirstOutput>,
    /// Held while this session attaches to a runtime from the warm pool.
    warm_attach: Mutex<Option<(crate::runtime::warm::Attaching, Instant)>>,
    queue_paused: AtomicBool,
    next_message: AtomicU64,
    next_request: AtomicU64,
    run: Mutex<Option<Run>>,
    /// A model request was cut off by a runtime exit. The runtime's Flow control
    /// withholds it (and any new input) until someone decides; the host already
    /// decided (the turn failed), so recovery releases the hold before going idle.
    release_flow_hold: AtomicBool,
    /// Slash commands written to the runtime and not yet answered, oldest first.
    /// A command's replies are notices the runtime emits before it answers, so a
    /// notice published while one is open is tagged with it (see `notice_origin`).
    commands: Mutex<Vec<(String, String)>>,
    cancelled: Mutex<HashMap<String, Instant>>,
    failed_turn: Mutex<Option<Value>>,
    /// Why the session ended, set only by `fail`: the one session-level error.
    failure: Mutex<Option<Value>>,
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
    /// Where the images of the user's messages in `history` are: a history row
    /// names an image by id only, and clients fetch it by that id (#119).
    attachments: Mutex<HashMap<String, AttachmentSource>>,
    assistant_text: Mutex<String>,
    assistant_blocks: Mutex<Vec<Value>>,
    step: Mutex<StepState>,
    /// The model the session's runtime reports (`get_state`, `set_model`).
    /// The host never chooses, guesses or holds a model of its own.
    model: Mutex<Option<Value>>,
    /// Whether the runtime has answered `get_state` yet: until then the
    /// session's model is `resolving`; after it, `ready` or `none`.
    model_answered: AtomicBool,
    /// The runtime's `get_available_models`, as it answered.
    models: Mutex<Vec<Value>>,
    /// The runtime refused to list its models: its words, until a list arrives.
    model_list_error: Mutex<Option<String>>,
    /// The model the client asked a new conversation to use (its last pick),
    /// not yet handed to the runtime. It is the client's choice, relayed: the
    /// runtime gets it with `set_model` once its own list offers it.
    requested_model: Mutex<Option<(String, String)>>,
    /// A requested model is on its way to the runtime: the model stays
    /// `resolving`, so nothing is sent on the model it replaces.
    pick_pending: AtomicBool,
    /// The runtime being installed opened this session's file itself (a new
    /// conversation took over its blank session): the handshake does not switch.
    runtime_owns_file: AtomicBool,
    /// How a new conversation's folder is spelled for its runtime: the way the
    /// warm pool and the folder's earlier sessions spell it (`folder_text`), so
    /// it takes that folder's warm runtime and its file records the same text.
    start_folder: Mutex<Option<String>>,
    /// The model a saved conversation's file says it last used.
    saved_model: Mutex<Option<Value>>,
    /// The configuration changed since this session's runtime read it: it
    /// re-reads it (`switch_session` to its own file) once it is idle.
    reload_due: AtomicBool,
    /// That re-read is under way: its answers refresh the model lists.
    reloading: AtomicBool,
    /// The configuration generation the current runtime started under: its
    /// answers about models are kept only while that is still current.
    known_generation: AtomicU64,
    /// The runtime's `get_available_thinking_levels`, as it answered.
    thinking_levels: Mutex<Vec<Value>>,
    /// The reasoning level the runtime reports.
    thinking_level: Mutex<Option<String>>,
    subscribers: AtomicU64,
    next_client: AtomicU64,
    /// Awake time, so a machine that slept does not count as idle (issue #111).
    last_activity: Mutex<AwakeInstant>,
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
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = AwakeInstant::now();
    }

    pub fn subscriber_count(&self) -> u64 {
        self.subscribers.load(Ordering::Relaxed)
    }

    pub fn last_activity(&self) -> AwakeInstant {
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
        // when the runtime finishes writing it. It is the newest row, so only
        // the newest page carries it, never an earlier one.
        let active = if before.is_some() { None } else { self.run_id() };
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
        let mut history = self
            .history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Which user turn of the conversation a row belongs to (1 = the first
        // user message). The saved file counts user messages the same way, so a
        // client that loaded only some pages can still name a turn to branch at.
        let previous = history
            .last()
            .and_then(|row| row.get("turn"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let user = row.get("kind").and_then(Value::as_str) == Some("user");
        if let Some(object) = row.as_object_mut() {
            object.insert("cursor".to_string(), json!(cursor));
            object.insert("turn".to_string(), json!(previous + u64::from(user)));
        }
        history.push(row);
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

    /// Whether the run in progress takes the user's waiting messages now, as
    /// steer. The one place this is decided.
    ///
    /// It follows the runtime's rule for input during a run, whoever started
    /// the run (the user or the runtime itself, such as Flow): a streaming run
    /// takes steer once its first reply has started (the runtime would put an
    /// earlier one into the request beside the message that started the run),
    /// not while it is being stopped, and not during a provider retry or a
    /// compaction, when the runtime does not take input; the messages then wait
    /// in the host queue and go in once those end. Whether a message sent
    /// during a run the runtime started should be a steer is still a product
    /// decision; changing it changes only this function.
    fn run_takes_steer(&self) -> bool {
        let ready = self
            .run_guard()
            .as_ref()
            .is_some_and(|run| run.phase == RunPhase::Streaming && run.replying && !run.stopping);
        ready && !matches!(self.step_guard().state, "retrying" | "compacting")
    }

    /// Hand every waiting message to the running turn. The runtime delivers
    /// each one at its next step boundary, before the next model call. Not
    /// before the run's first reply has started: the runtime would put it in
    /// the first request beside the message that started the run.
    fn steer_queue(&self) {
        if self.queue_paused.load(Ordering::SeqCst) || !self.run_takes_steer() {
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
                .filter(|item| item.steered.is_none() && !item.no_steer && !item.held && !item.prompted)
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
            log(
                &self.home,
                "info",
                "queue.steer_sent",
                json!({ "session": self.id, "clientMessageId": command.get("id").and_then(Value::as_str).and_then(|id| id.strip_prefix(STEER_ID_PREFIX)) }),
            );
            self.steers_in_flight.fetch_add(1, Ordering::SeqCst);
            if self.write_command(command).is_err() {
                self.steers_in_flight.fetch_sub(1, Ordering::SeqCst);
                break;
            }
        }
    }

    /// Take back steered messages the runtime has not delivered (a turn ended,
    /// Stop, or one was removed). They stay queued here; the runtime's answer
    /// says the take-back is done.
    ///
    /// Returns whether a take-back is under way: the next queued turn then
    /// starts from its answer, never beside it, or the runtime could use a
    /// message both as that turn's prompt and as a steer it still holds.
    fn reclaim_steered(&self) -> bool {
        let any = self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|item| item.steered.is_some());
        if !any {
            return false;
        }
        if self.steers_in_flight.load(Ordering::SeqCst) > 0 {
            // A steer still on its way would land after an empty take-back.
            // Take back once the runtime has answered them all.
            self.reclaim_waiting.store(true, Ordering::SeqCst);
        } else {
            self.clear_runtime_queue();
        }
        true
    }

    /// A run ended: take back what it did not use, then start the next
    /// waiting message (at once, or from the take-back's answer).
    fn run_finished(self: &Arc<Self>) {
        if !self.reclaim_steered() {
            self.start_queued_turn();
        }
        self.sync_status();
        self.publish_summary();
        self.reload_if_due();
    }

    /// The configuration changed (a catalog refresh, a key, a provider, a model
    /// limit). The runtime read it when it opened this session and keeps that
    /// copy; opening the session again (`switch_session` to its own file)
    /// makes it read the configuration anew, models included. Done at once
    /// when the session is idle, else when its run ends.
    pub fn reload_configuration(self: &Arc<Self>) {
        self.reload_due.store(true, Ordering::SeqCst);
        self.reload_if_due();
    }

    fn reload_if_due(self: &Arc<Self>) {
        if !self.reload_due.load(Ordering::SeqCst)
            || self.status() != Status::Idle
            || self.run_id().is_some()
            || !self.queue_guard().is_empty()
            || !matches!(
                *self.handshake.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
                Handshake::Ready
            )
        {
            return;
        }
        let Some(path) = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return;
        };
        if self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_none()
        {
            return;
        }
        self.reload_due.store(false, Ordering::SeqCst);
        log(&self.home, "info", "session.reload_configuration", json!({ "session": self.id }));
        // A new conversation nothing was said in may have no model recorded in
        // its file yet: it keeps the model it shows, if the new list offers it.
        if self.untouched() {
            let current = self
                .model
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if let Some(model) = current {
                if let (Some(provider), Some(id)) = (
                    model.get("provider").and_then(Value::as_str),
                    model.get("id").and_then(Value::as_str),
                ) {
                    *self
                        .requested_model
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((provider.to_string(), id.to_string()));
                    self.pick_pending.store(true, Ordering::SeqCst);
                }
            }
        }
        self.reloading.store(true, Ordering::SeqCst);
        self.known_generation
            .store(self.config.known.generation(), Ordering::SeqCst);
        // A message sent meanwhile waits for the handshake, as at start.
        self.set_status(Status::Starting);
        *self
            .handshake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Switch;
        let id = self.request_id();
        if let Err(error) =
            self.write_command(pi::command::with_id(pi::command::switch_session(&path), &id))
        {
            self.fail(error.code, &error.message, error.retryable);
        }
    }

    fn clear_runtime_queue(&self) {
        let generation = self.steer_generation.fetch_add(1, Ordering::SeqCst);
        log(&self.home, "info", "queue.take_back", json!({ "session": self.id, "generation": generation }));
        let _ = self.write_command(pi::command::with_id(
            pi::command::clear_queue(),
            &format!("{CLEAR_QUEUE_ID_PREFIX}{generation}"),
        ));
    }

    /// A held message released into the runtime's queue after its run ended
    /// waits there with nothing to run it: take it back, and it runs as the next turn.
    fn runtime_queue_changed(self: &Arc<Self>, value: &Value) {
        let waiting = value
            .get("steering")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        let held = self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|item| item.held);
        if waiting && held && self.run_id().is_none() {
            self.clear_runtime_queue();
        }
    }

    /// A user message the runtime put into the running turn.
    fn user_message_started(&self, message: Option<&Value>) {
        let Some(turn) = self.run_id() else { return };
        let echo = self
            .run_guard()
            .as_mut()
            .is_some_and(|run| std::mem::replace(&mut run.echo_pending, false));
        if echo {
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
                .position(|item| (item.steered.is_some() || item.held) && item.text() == text)
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
            let _ = self.steers_in_flight.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
            if self.steers_in_flight.load(Ordering::SeqCst) == 0
                && self.reclaim_waiting.swap(false, Ordering::SeqCst)
            {
                // Its run ended while it was on its way: now the take-back sees it.
                self.clear_runtime_queue();
            }
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
                if handled && queue[at].text().starts_with('/') {
                    // An extension command answered in place: it is done.
                    queue.remove(at)
                } else if handled {
                    // Taken but not delivered (Flow holds it until its gate opens). It
                    // stays the user's waiting message until the runtime starts it.
                    log(
                        &self.home,
                        "info",
                        "queue.steer_held",
                        json!({ "session": self.id, "clientMessageId": client }),
                    );
                    queue[at].steered = None;
                    queue[at].held = true;
                    None
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
            // A command the runtime ran in place: the user's row all the same.
            if let (Some(item), Some(turn)) = (item, self.run_id()) {
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
        // it (deliveries arrive first) is back in our hands. So is a held message
        // its extension had released into the runtime's queue: the answer lists it.
        let mut released: Vec<String> = value
            .pointer("/data/steering")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        for item in self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter_mut()
        {
            if item.steered.is_some_and(|steered| steered <= generation) {
                item.steered = None;
            }
            if item.held {
                if let Some(at) = released.iter().position(|text| *text == item.text()) {
                    released.remove(at);
                    item.held = false;
                }
            }
        }
        if !self.start_queued_turn() {
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
            "turnId": self.run_id(),
            "clientMessageId": self.run_client_message(),
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
        let Some(turn) = self.run_id() else {
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
        if let Some(error) = row.get("errorMessage").and_then(Value::as_str) {
            row["errorCode"] = json!(crate::provider_error::code(error));
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
        // A reply the provider ended says whether it takes the stored sign-in.
        if !interrupted {
            if let Some(provider) = row.get("provider").and_then(Value::as_str) {
                let at = Self::now_iso();
                match (row.get("errorCode").and_then(Value::as_str), row.get("errorMessage").and_then(Value::as_str)) {
                    (Some("auth"), Some(text)) => self.config.providers.reply(provider, Some(text), &at),
                    (None, _) => self.config.providers.reply(provider, None, &at),
                    _ => {}
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
                "errorCode": row.get("errorCode").cloned().unwrap_or(Value::Null),
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

    /// Everything a client needs to show the session from scratch: the same
    /// fields as `session.updated` (queue, failed message, turn, prompts), plus
    /// where the stream resumes. One builder, so the two cannot drift apart.
    pub fn snapshot_event(&self) -> SessionEvent {
        let cursor = self.cursor();
        let mut data = self.summary();
        data["cursor"] = json!(cursor);
        data["workspacePath"] = json!(canonical_path(&self.workspace_path));
        SessionEvent {
            id: cursor,
            event: "session.snapshot".to_string(),
            data,
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
        // turn that waited for the runtime starts running. A run the runtime started
        // itself had no prompt to wait for.
        let running = (event == "turn.start" && data.get("phase").and_then(Value::as_str) == Some("running"))
            || (event == "session.status" && data.get("status").and_then(Value::as_str) == Some("running"));
        let prompted = self.run_guard().as_ref().is_some_and(|run| run.origin == RunOrigin::User);
        if running && prompted {
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
                    .or_else(|| self.run_id())
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
        // An event about one message (a waiting one is accepted while another runs) names
        // that message; otherwise the mark belongs to the running turn's message.
        let client_message = data
            .get("clientMessageId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| self.run_client_message());
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
        let command = matches!(value.get("type").and_then(Value::as_str), Some("prompt" | "steer"))
            .then(|| (value.get("id").and_then(Value::as_str), value.get("message").and_then(Value::as_str)))
            .and_then(|(id, text)| Some((id?.to_string(), text?.trim().to_string())))
            .filter(|(_, text)| text.starts_with('/'));
        if let Some(command) = command.clone() {
            self.commands
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(command);
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
        runtime.enqueue(value).map_err(|message| {
            if let Some((id, _)) = &command {
                self.command_answered(id);
            }
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
            self.fail(error.code, &error.message, error.retryable);
        }
    }

    fn request_state(&self) {
        let id = self.request_id();
        if let Err(error) = self.write_command(pi::command::with_id(pi::command::get_state(), &id)) {
            self.fail(error.code, &error.message, error.retryable);
        }
    }

    fn start_handshake(&self) {
        // A runtime whose own session this is has it open already.
        let existing = if self.runtime_owns_file.swap(false, Ordering::SeqCst) {
            None
        } else {
            self.session_path
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        };
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
                // Switching before the command goes out: nothing the runtime
                // answers from here on describes this session until it switched.
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Switch;
                let id = self.request_id();
                let result =
                    self.write_command(pi::command::with_id(pi::command::switch_session(&path), &id));
                if let Err(error) = result {
                    self.fail(error.code, &error.message, error.retryable);
                    return;
                }
            }
            None => {
                // The runtime's state first: its model is known before the
                // session is ready.
                self.request_state();
                self.request_messages();
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Messages;
            }
        }
    }

    /// The slash command open while a notice arrived: the newest one. The
    /// runtime runs a command's handler to the end before it answers, so every
    /// reply of a command carries it, and its last reply comes last. Notices the
    /// runtime raises on its own (a recovery announcement) can land in the same
    /// window; they carry it too, which is why only the last reply settles state.
    fn notice_origin(&self) -> Option<Value> {
        let commands = self.commands.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        commands.last().map(|(id, text)| {
            json!({ "id": id, "text": text, "origin": if id == FLOW_RELEASE_ID { "host" } else { "user" } })
        })
    }

    /// A slash command was answered: every reply it had is published. Tell
    /// clients, so state its replies settle (a Flow hold) can be settled.
    fn command_answered(&self, id: &str) -> Option<Value> {
        let done = {
            let mut commands = self.commands.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let at = commands.iter().position(|(open, _)| open == id)?;
            commands.remove(at)
        };
        Some(json!({ "id": done.0, "text": done.1, "origin": if done.0 == FLOW_RELEASE_ID { "host" } else { "user" } }))
    }

    fn handle_response(self: &Arc<Self>, value: &Value) {
        let command = value.get("command").and_then(Value::as_str).unwrap_or("");
        let response_id = value.get("id").and_then(Value::as_str).unwrap_or("");
        if let Some(mut done) = self.command_answered(response_id) {
            done["success"] = value.get("success").cloned().unwrap_or(Value::Null);
            // A refused command's words go with its answer, to the control that ran it.
            if let Some(error) = value.get("error").filter(|_| value.get("success") == Some(&Value::Bool(false))) {
                done["error"] = error.clone();
            }
            self.publish("session.command_done", done);
        }
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
        if reply == pi::Reply::Prompt && self.displaced_prompt_answered(response_id, value) {
            return;
        }
        if reply == pi::Reply::Prompt
            && value.get("success").and_then(Value::as_bool) == Some(true)
            && value.pointer("/data/disposition").and_then(Value::as_str) == Some("handled")
        {
            self.end_turn_without_run(response_id);
            return;
        }
        if reply == pi::Reply::Prompt && value.get("success").and_then(Value::as_bool) == Some(true) {
            self.run_accepted(response_id);
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
        // Only this session's own state requests carry its facts: the warm
        // pool's and the liveness probe's answers say only that it lives.
        let own = response_id.starts_with("r-");
        if reply == pi::Reply::GetState && own && !switching {
            if let Some(data) = value.get("data") {
                let state = pi::State::read(data);
                let moved = state.session_file.as_deref().filter(|path| {
                    let mut current = self
                        .session_path
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let moved = current.as_deref() != Some(*path);
                    *current = Some(path.to_string());
                    moved
                });
                if let Some(path) = moved {
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
                // The runtime's own answer, whatever it is: its model (or none)
                // and level. The lists come from the same runtime.
                let first = !self.model_answered.swap(true, Ordering::SeqCst);
                if first && self.fresh.load(Ordering::SeqCst) {
                    // A new conversation's runtime is blank: the model it starts
                    // on is what the next new conversation will see first.
                    self.config.known.remember_start_model(
                        self.known_generation.load(Ordering::SeqCst),
                        state.model.as_ref(),
                    );
                }
                let changed = self.set_model(state.model.clone());
                if let Some(level) = state.thinking_level.clone() {
                    self.set_thinking_level(Some(level));
                }
                let reloaded = self.reloading.swap(false, Ordering::SeqCst);
                if first || changed || reloaded {
                    self.request_model_lists();
                }
                // What waited for a model can go now.
                if first && self.model_state() == "ready" {
                    self.start_queued_turn();
                }
            }
        }
        let success = value
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
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
            // A live runtime that refuses to open the session file (Flow
            // storage, ownership, a damaged file) answers the same way to any
            // runtime started after it: restarting cannot help, so the session
            // fails at once with the runtime's reason.
            if reply.is_handshake() && matches!(self.status(), Status::Starting | Status::Recovering) {
                self.fail("session-attach-failed", message, true);
                return;
            }
            // Only a failed handshake makes the session unusable. Any other
            // command fails in its own scope: a command a client waits on
            // answers that client (its request carries the runtime's text), a
            // refused prompt is that message's failure, and the commands the
            // host sends on its own (Stop's abort, the model lists) keep the
            // runtime's words where their control reads them. Nothing is
            // reported to the whole session.
            match reply {
                // A refused level leaves the runtime's own; ask which one that is.
                pi::Reply::SetThinkingLevel => self.request_state(),
                pi::Reply::Prompt => self.turn_refused(response_id, "prompt-refused", message),
                pi::Reply::Abort => self.stop_refused(message),
                pi::Reply::AvailableModels => {
                    *self
                        .model_list_error
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(message.to_string());
                    self.publish_summary();
                    // No list to check a requested model against: the session
                    // stays on the runtime's own.
                    self.requested_model
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .take();
                    self.pick_settled();
                }
                // A requested model the runtime refused: the session keeps the
                // runtime's own (a client's own pick answers that client).
                pi::Reply::SetModel => self.pick_settled(),
                _ => {}
            }
            return;
        }
        match reply {
            pi::Reply::SetModel => {
                // The runtime answers with the model it now uses.
                if let Some(model) = value.get("data").filter(|data| data.get("id").is_some()) {
                    self.set_model(Some(model.clone()));
                }
                self.request_model_lists();
                self.pick_settled();
            }
            pi::Reply::AvailableModels => {
                let models = value
                    .pointer("/data/models")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                *self
                    .model_list_error
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                self.config
                    .known
                    .remember_list(self.known_generation.load(Ordering::SeqCst), &models);
                self.set_list(&self.models, models);
                self.apply_requested_model();
            }
            pi::Reply::AvailableThinkingLevels => {
                let levels = value
                    .pointer("/data/levels")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.set_list(&self.thinking_levels, levels);
            }
            pi::Reply::SwitchSession => {
                let cancelled = value
                    .get("data")
                    .and_then(|data| data.get("cancelled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if cancelled {
                    // An extension refused the switch: the same refusal awaits
                    // any restarted runtime.
                    self.fail(
                        "session-switch-cancelled",
                        "The runtime cancelled the session switch",
                        true,
                    );
                    return;
                }
                *self
                    .handshake
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Handshake::Messages;
                // The model it restored for this file, before the session is ready.
                self.request_state();
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
        self.flush_parked_prompt();
        // Start the next warm runtime only now: on a busy machine a second
        // runtime booting beside this one would slow down the one the user waits for.
        if let Some(pool) = self.config.warm.get() {
            // This runtime answered, so its start-up work is done (#94).
            pool.converged();
            let pool = pool.clone();
            let workspace = PathBuf::from(self.runtime_cwd());
            tokio::spawn(async move { pool.aim(&workspace) });
        }
        // The session is up: its status now follows its run (a prompt flushed
        // above, a run the runtime started itself, or none), and a waiting
        // message starts when there is none.
        self.set_status(self.run_status());
        self.start_queued_turn();
        self.sync_status();
        // A configuration change that came while it started: read it now.
        self.reload_if_due();
    }

    /// A prompt the runtime consumed without starting a run (a slash command, or
    /// input its Flow control retained). No agent events will follow, so the turn
    /// ends here instead of waiting for `agent_settled`.
    fn end_turn_without_run(self: &Arc<Self>, client_message_id: &str) {
        // A message (not a command) the runtime took without a run: an
        // extension holds it (Flow, until its gate opens) and delivers it
        // later itself. It stays the user's waiting message, held, exactly as
        // when the same answer comes to a queued message (its row joins the
        // transcript when the runtime uses it); it is never left without a
        // state. The runtime gives no reason (runtime G7), so none is made up.
        let held = self
            .run_guard()
            .as_ref()
            .filter(|run| run.client_message_id.as_deref() == Some(client_message_id) && !run.phase.started())
            .and_then(|run| run.prompt.clone().map(|prompt| (run.id.clone(), prompt)))
            .filter(|(_, prompt)| {
                !prompt
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim_start()
                    .starts_with('/')
            });
        // Its row leaves the transcript before the turn ends: the next waiting
        // message may start a run (and add its own row) as this one ends.
        let held = held.map(|(turn, prompt)| {
            let row = self.take_user_row(&turn);
            (turn, prompt, row)
        });
        self.end_turn(client_message_id, json!({ "status": "handled" }));
        if let Some((turn, prompt, row)) = held {
            self.queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push_front(Queued { turn, prompt, row, steered: None, no_steer: true, held: true, prompted: false });
            self.publish_summary();
        }
    }

    /// The runtime refused a prompt. A message gets no reply: it becomes the
    /// session's failed message (Retry sends it again) with the runtime's own
    /// text, and the messages waiting behind it wait for Continue instead of
    /// being refused one by one. A slash command's refusal is that command's
    /// answer (`session.command_done`), never a failed message.
    fn turn_refused(self: &Arc<Self>, client_message_id: &str, code: &str, message: &str) {
        // One lock decides and takes the run, so a Stop in between cannot
        // leave a failed message that is never published.
        let turn = {
            let mut run = self.run_guard();
            let ours = run.as_ref().is_some_and(|run| {
                run.client_message_id.as_deref() == Some(client_message_id) && !run.phase.started()
            });
            if !ours {
                return;
            }
            run.take().map(|run| run.id)
        };
        let text = self
            .messages
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(client_message_id)
            .map(|message| message.text.clone())
            .unwrap_or_default();
        if !text.trim_start().starts_with('/') {
            *self
                .failed_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(json!({
                "clientMessageId": client_message_id,
                "text": text,
                "error": { "code": code, "text": message },
            }));
            if !self.queue_guard().is_empty() {
                self.queue_paused.store(true, Ordering::SeqCst);
            }
        }
        if let Some(turn) = turn {
            self.publish(
                "turn.end",
                json!({ "turnId": turn, "clientMessageId": client_message_id, "reason": code, "message": message }),
            );
        }
        self.run_finished();
        self.publish_summary();
    }

    /// The runtime refused Stop: the run goes on, and Stop says why.
    fn stop_refused(&self, message: &str) {
        let changed = {
            let mut run = self.run_guard();
            match run.as_mut() {
                Some(current) if current.stopping => {
                    current.stopping = false;
                    current.stop_error = Some(message.to_string());
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.publish_summary();
        }
    }

    /// End the active turn for this message without a runtime run.
    fn end_turn(self: &Arc<Self>, client_message_id: &str, outcome: Value) {
        let turn = {
            let mut run = self.run_guard();
            // Only a run that has not started: once the runtime runs it, its
            // `agent_settled` ends it.
            let ours = run.as_ref().is_some_and(|run| {
                run.client_message_id.as_deref() == Some(client_message_id) && !run.phase.started()
            });
            if !ours {
                return;
            }
            run.take().map(|run| run.id)
        };
        if let Some(turn) = turn {
            let mut data = json!({ "turnId": turn, "clientMessageId": client_message_id });
            if let (Some(data), Some(outcome)) = (data.as_object_mut(), outcome.as_object()) {
                data.extend(outcome.clone());
            }
            self.publish("turn.end", data);
        }
        self.run_finished();
        self.publish_summary();
    }

    /// Load the transcript of the session's saved file into the host history.
    pub(crate) fn open_saved_history(&self) {
        let Some(path) = self.saved_path() else { return };
        let started = Instant::now();
        let Ok(messages) = saved_messages(Path::new(&path)) else { return };
        *self
            .saved_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = saved_last_model(Path::new(&path));
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
        let mut saved_attachments = Vec::new();
        let mut attachment_refs = Vec::new();
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
            let images = if role == "user" { saved_images(message, index) } else { Vec::new() };
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
            // A message of only an image is still a message (#119).
            if text.is_empty() && blocks.is_empty() && images.is_empty() {
                continue;
            }
            let blocks = if blocks.is_empty() {
                json!([{ "type": "text", "text": text }])
            } else {
                Value::Array(blocks)
            };
            if !images.is_empty() {
                // Same shape as a row the host wrote when the message was sent.
                let refs: Vec<Value> = images
                    .iter()
                    .enumerate()
                    .map(|(number, (id, mime_type, data))| {
                        json!({
                            "id": id,
                            "name": format!("image-{}", number + 1),
                            "mimeType": mime_type,
                            "bytes": base64_len(data),
                        })
                    })
                    .collect();
                saved_attachments.extend(images.into_iter().map(|(id, mime_type, data)| {
                    (id, AttachmentSource::Saved { mime_type, data: Arc::from(data) })
                }));
                attachment_refs.push((rows.len(), refs));
            }
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
                    for field in ["model", "provider", "usage", "stopReason", "errorMessage"] {
                        if let Some(value) = message.get(field).filter(|value| !value.is_null()) {
                            row[field] = value.clone();
                        }
                    }
                    if let Some(error) = row.get("errorMessage").and_then(Value::as_str) {
                        row["errorCode"] = json!(crate::provider_error::code(error));
                    }
                }
            }
        }
        if rows.is_empty() {
            return;
        }
        for (row, refs) in attachment_refs {
            rows[row]["attachments"] = json!(refs);
        }
        {
            // The saved file's images replace those of an earlier import; images
            // sent in this run stay, as their rows may still be on screen.
            let mut attachments = self.attachments.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            attachments.retain(|_, source| matches!(source, AttachmentSource::File { .. }));
            attachments.extend(saved_attachments);
        }
        // A saved conversation is at rest: a tool call with no result was cut off
        // (the app closed, the runtime stopped). While a turn runs, its own calls
        // may still be at work, so they are left as they are.
        let resting = self.run_guard().is_none();
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
            PiRecord::AgentStart => self.run_started(),
            PiRecord::TurnStart => {
                if self.run_id().is_some() {
                    self.begin_step();
                }
            }
            PiRecord::TurnEnd => {}
            PiRecord::QueueUpdate => self.runtime_queue_changed(&value),
            PiRecord::ThinkingLevelChanged => {
                if let Some(level) = value.get("level").and_then(Value::as_str) {
                    self.set_thinking_level(Some(level.to_string()));
                }
            }
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
                let first_reply = assistant
                    && self
                        .run_guard()
                        .as_mut()
                        .is_some_and(|run| !std::mem::replace(&mut run.replying, true));
                if first_reply {
                    self.steer_queue();
                }
                if assistant && self.run_id().is_some() {
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
                if let (true, Some(turn)) = (assistant, self.run_id()) {
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
                let Some(message_id) = self.run_id() else {
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
                    if self.run_id().is_some() {
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
                        "turnId": self.run_id(),
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
                    "code": value.get("errorMessage").and_then(Value::as_str).map(crate::provider_error::code),
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
                // Messages that waited out the retry go in now.
                self.steer_queue();
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
                // Messages that waited out the compaction go in now.
                self.steer_queue();
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
                self.run_settled(aborted);
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
                // An extension's handler failed; the runtime carries on (the
                // run is not interrupted). It is the runtime telling the person
                // something, like any other notice, not a session error.
                log(&self.home, "warn", "extension.error", json!({ "session": self.id, "message": message }));
                self.publish(
                    "session.notice",
                    json!({ "message": message, "level": "error", "source": "extension" }),
                );
            }
            PiRecord::Error => {
                let message = value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("runtime error");
                self.fail("runtime-error", message, false);
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
                let mut notice = json!({ "message": message, "level": level });
                if let Some(command) = self.notice_origin() {
                    notice["command"] = command;
                }
                self.publish("session.notice", notice);
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
        if let Some(turn_id) = self.run_id() {
            data["turnId"] = Value::String(turn_id);
        }
        if let Some(client) = self.run().and_then(|run| run.client) {
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
        self.sync_status();
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
        if let Some(turn_id) = self.run_id() {
            data["turnId"] = Value::String(turn_id);
        }
        if let Some(client) = self.run().and_then(|run| run.client) {
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
        self.sync_status();
        self.publish("question.requested", data);
        self.schedule_question_expiry(question_id, timeout);
    }

    fn run_guard(&self) -> std::sync::MutexGuard<'_, Option<Run>> {
        self.run.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn queue_guard(&self) -> std::sync::MutexGuard<'_, VecDeque<Queued>> {
        self.queued_turns.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The run in progress, if any.
    fn run(&self) -> Option<Run> {
        self.run_guard().clone()
    }

    /// The id of the run in progress: its rows and events carry it.
    fn run_id(&self) -> Option<String> {
        self.run_guard().as_ref().map(|run| run.id.clone())
    }

    /// The user's message that started the run in progress.
    fn run_client_message(&self) -> Option<String> {
        self.run_guard().as_ref().and_then(|run| run.client_message_id.clone())
    }

    /// The prompt of the run in progress has reached the runtime.
    fn run_reached_runtime(&self) -> bool {
        self.run_guard()
            .as_ref()
            .is_some_and(|run| !matches!(run.phase, RunPhase::Starting | RunPhase::Claimed))
    }

    fn take_run(&self) -> Option<Run> {
        self.run_guard().take()
    }

    /// Whether a new run may start for a message: none is in progress, and no
    /// prompt of ours is still with the runtime unanswered (it may yet start one).
    fn free_for_run(run: &Option<Run>, queue: &VecDeque<Queued>) -> bool {
        // A steer the last run did not use is still in the runtime's queue
        // until it is taken back; a prompt written before then would take it.
        run.is_none() && !queue.iter().any(|item| item.prompted || item.steered.is_some())
    }

    /// The session's status while it is up, from its run and what it waits on.
    fn run_status(&self) -> Status {
        if !self
            .pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
        {
            Status::WaitingApproval
        } else if !self
            .pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
        {
            Status::WaitingQuestion
        } else if self.run_guard().is_some() {
            Status::Running
        } else {
            Status::Idle
        }
    }

    /// Bring running/idle in line with the run. Starting, recovering, stopped
    /// and failed sessions keep their status: their own paths end those.
    fn sync_status(&self) {
        if matches!(
            self.status(),
            Status::Idle | Status::Running | Status::WaitingApproval | Status::WaitingQuestion
        ) {
            self.set_status(self.run_status());
        }
    }

    fn clear_reply(&self) {
        self.assistant_text
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.assistant_blocks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.reset_step();
    }

    /// A user row as history keeps it once the runtime has the message.
    fn stamped_row(mut row: Value, turn: &str) -> Value {
        if let Some(object) = row.as_object_mut() {
            object.insert("turnId".to_string(), json!(turn));
            object.insert("createdAt".to_string(), json!(Self::now_iso()));
        }
        row
    }

    /// Take the user row of `turn` out of history when it is the newest row
    /// (the message was displaced before anything followed it). Clients reload.
    fn take_user_row(&self, turn: &str) -> Option<Value> {
        let row = {
            let mut history = self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let last = history.last()?;
            if last.get("id").and_then(Value::as_str) != Some(&format!("{turn}:user")) {
                return None;
            }
            history.pop()
        };
        self.publish("session.history", json!({ "rows": self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len() }));
        row.map(|mut row| {
            if let Some(object) = row.as_object_mut() {
                object.remove("cursor");
                object.remove("turn");
            }
            row
        })
    }

    /// Write the prompt of the run `id`, if that run is still the one in
    /// progress and its prompt was not written yet. Checked and written under
    /// the run's lock, so a run the runtime starts meanwhile cannot get it too.
    /// Returns whether it was written.
    fn write_prompt(&self, id: &str) -> Result<bool, ApiError> {
        let mut run = self.run_guard();
        let Some(current) = run.as_mut().filter(|run| {
            run.id == id && matches!(run.phase, RunPhase::Claimed | RunPhase::Starting)
        }) else {
            return Ok(false);
        };
        let Some(prompt) = current.prompt.clone() else {
            return Ok(false);
        };
        current.phase = RunPhase::Sent;
        // write_command takes no run state: holding the lock is safe.
        self.write_command(prompt).map(|_| true)
    }

    /// The runtime accepted the prompt of the run in progress.
    fn run_accepted(&self, client_message_id: &str) {
        if let Some(run) = self.run_guard().as_mut().filter(|run| {
            run.phase == RunPhase::Sent && run.client_message_id.as_deref() == Some(client_message_id)
        }) {
            run.phase = RunPhase::Accepted;
        }
    }

    /// The runtime started a run (`agent_start`): the one the host's accepted
    /// prompt asked for, or one of its own (Flow, an extension).
    fn run_started(self: &Arc<Self>) {
        enum Started {
            Ours { stop: bool },
            Own { displaced: Option<Run>, id: String },
        }
        let started = {
            let mut run = self.run_guard();
            match run.as_mut() {
                Some(current) if current.phase.started() => {
                    current.phase = RunPhase::Streaming;
                    current.replying = false;
                    current.prompt = None;
                    current.row = None;
                    Started::Ours { stop: current.stopping }
                }
                _ => {
                    let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
                    let id = format!("m-{counter}");
                    let displaced = run.replace(Run::runtime(id.clone()));
                    Started::Own { displaced, id }
                }
            }
        };
        match started {
            Started::Ours { stop } => {
                // The runtime runs its input handlers before the agent run exists,
                // and an abort that lands then finds nothing to stop. The host
                // already answered that Stop with "cancelling", so it stops this run.
                if stop {
                    let id = self.request_id();
                    // A failed write means the runtime is gone; its exit ends the run.
                    let _ = self.write_command(pi::command::with_id(pi::command::abort(), &id));
                }
            }
            Started::Own { displaced, id } => {
                if let Some(mine) = displaced {
                    self.displace_prompt(mine);
                }
                self.clear_reply();
                log(&self.home, "info", "run.runtime_started", json!({ "session": self.id, "turnId": id }));
                self.publish("turn.start", json!({ "turnId": id, "phase": "running", "origin": "runtime" }));
            }
        }
        self.sync_status();
        self.publish_summary();
    }

    /// The runtime started a run of its own before it took the user's prompt.
    /// That prompt did not start this run: the message goes back to the front
    /// of the queue with its row. Written already, the runtime will refuse it
    /// (it is then steered into this run) or, if this run ends first, start a
    /// run with it (`displaced_prompt_answered`). Not written yet, it is never
    /// written as a prompt now.
    fn displace_prompt(&self, mine: Run) {
        let Some(prompt) = mine.prompt else { return };
        let client = mine.client_message_id.clone().unwrap_or_default();
        let prompted = mine.phase == RunPhase::Sent;
        // Its row joined history when it was claimed. Taken back only while it
        // is the newest row; otherwise it stays where it is and the queue
        // carries none, so it is never in history twice.
        let row = self.take_user_row(&mine.id);
        log(
            &self.home,
            "info",
            "run.prompt_displaced",
            json!({ "session": self.id, "turnId": mine.id, "clientMessageId": client, "prompted": prompted, "stopped": mine.stopping }),
        );
        self.publish("turn.end", json!({ "turnId": mine.id, "clientMessageId": client, "status": "queued" }));
        if mine.stopping {
            // Stop was asked for this message: it does not run. A prompt the
            // runtime still has is dropped when it answers.
            self.tombstone(&client);
            if !prompted {
                return;
            }
        }
        self.queue_guard().push_front(Queued {
            turn: mine.id,
            prompt,
            row,
            steered: None,
            no_steer: false,
            held: false,
            prompted,
        });
    }

    /// The runtime's run ended (`agent_settled`), whoever started it. A prompt
    /// still waiting for its answer is not what ended.
    fn run_settled(self: &Arc<Self>, aborted: bool) {
        let ended = {
            let mut run = self.run_guard();
            if run.as_ref().is_some_and(|run| run.phase.started()) {
                run.take()
            } else {
                None
            }
        };
        if let Some(run) = ended {
            let stop_reason = if aborted { "interrupted" } else { "completed" };
            // Whatever the last step had not finished writing is its reply.
            self.finish_step_reply(&run.id, None, aborted);
            self.close_unfinished_tools();
            self.publish(
                "turn.end",
                json!({ "turnId": run.id, "clientMessageId": run.client_message_id, "status": stop_reason }),
            );
            self.cancel_pending("turn-ended");
            // Steered messages the run did not reach are taken back before
            // anything else is sent, so the runtime cannot use them twice.
            self.run_finished();
        }
        self.sync_status();
        self.publish_summary();
    }

    /// The runtime answered a prompt a run of its own displaced (see
    /// `displace_prompt`). Returns whether the answer was for one.
    fn displaced_prompt_answered(self: &Arc<Self>, client_message_id: &str, value: &Value) -> bool {
        enum Answer {
            Steer,
            Dropped,
            Done(Option<Value>),
            Held,
            Started { turn: String, row: Option<Value> },
            Overlap,
        }
        let success = value.get("success").and_then(Value::as_bool) == Some(true);
        let disposition = value.pointer("/data/disposition").and_then(Value::as_str);
        let stopped = self.tombstoned(client_message_id);
        let answer = {
            let mut queue = self.queue_guard();
            let Some(at) = queue
                .iter()
                .position(|item| item.prompted && item.client_message_id() == Some(client_message_id))
            else {
                return false;
            };
            if !success {
                if stopped {
                    queue.remove(at);
                    Answer::Dropped
                } else {
                    // Refused while the runtime's own run streams: it is steered into it.
                    queue[at].prompted = false;
                    Answer::Steer
                }
            } else if disposition == Some("handled") {
                if queue[at].text().starts_with('/') {
                    // An extension command answered in place: it is done.
                    Answer::Done(queue.remove(at).and_then(|item| item.row))
                } else {
                    // Flow took it and holds it; it delivers it later itself.
                    queue[at].prompted = false;
                    queue[at].held = true;
                    Answer::Held
                }
            } else {
                // The runtime's run ended before it took the prompt: it starts a run with it.
                let mut run = self.run_guard();
                if run.is_some() {
                    // Should not happen: the host already has a run. Never
                    // dropped and never sent again on its own: it is returned
                    // to the user, who continues or discards it.
                    queue[at].prompted = false;
                    self.queue_paused.store(true, Ordering::SeqCst);
                    Answer::Overlap
                } else {
                    let item = queue.remove(at).expect("position is in the queue");
                    let row = item.row.map(|row| Self::stamped_row(row, &item.turn));
                    let mut opened = Run::user(&item.turn, client_message_id, None, item.prompt, None, RunPhase::Accepted);
                    opened.stopping = stopped;
                    *run = Some(opened);
                    if let Some(row) = row.clone() {
                        self.push_history(row);
                    }
                    Answer::Started { turn: item.turn, row }
                }
            }
        };
        log(
            &self.home,
            if matches!(answer, Answer::Overlap) { "warn" } else { "info" },
            if matches!(answer, Answer::Overlap) { "run.overlap" } else { "run.displaced_answered" },
            json!({ "session": self.id, "clientMessageId": client_message_id, "success": success, "disposition": disposition, "stopped": stopped }),
        );
        match answer {
            Answer::Steer => self.steer_queue(),
            Answer::Done(Some(row)) => {
                let turn = self.run_id().unwrap_or_default();
                self.deliver_user_row(row, &turn);
            }
            Answer::Started { turn, row } => {
                self.clear_reply();
                if let Some(row) = row {
                    self.publish("message.user", row);
                }
                self.publish("turn.start", json!({ "turnId": turn, "phase": "running" }));
            }
            Answer::Dropped | Answer::Done(None) | Answer::Held | Answer::Overlap => {}
        }
        self.start_queued_turn();
        self.sync_status();
        self.publish_summary();
        true
    }

    /// Stop the run in progress, whoever started it. The host decides how:
    /// a prompt still parked for the handshake is removed; anything else is
    /// aborted, and a run that only starts after this is aborted when it does.
    pub fn interrupt(&self) -> Result<Value, ApiError> {
        if !self.queue_guard().is_empty() {
            self.queue_paused.store(true, Ordering::SeqCst);
        }
        enum Stop {
            Nothing,
            Parked(Run),
            Abort,
        }
        let stop = {
            let mut run = self.run_guard();
            match run.as_mut() {
                None => Stop::Nothing,
                Some(current) if current.phase == RunPhase::Starting => Stop::Parked(run.take().expect("checked")),
                Some(current) => {
                    current.stopping = true;
                    current.stop_error = None;
                    Stop::Abort
                }
            }
        };
        match stop {
            Stop::Nothing => {
                self.publish_summary();
                Ok(json!({ "status": "idle" }))
            }
            Stop::Parked(parked) => {
                // Nothing in the runtime to abort yet. The handshake still
                // completes (preferences, recovery bookkeeping) and then goes idle.
                let client = parked.client_message_id.clone().unwrap_or_default();
                self.publish(
                    "turn.end",
                    json!({ "turnId": parked.id, "clientMessageId": client, "aborted": true, "phase": "starting" }),
                );
                self.publish_summary();
                Ok(json!({ "status": "cancelled" }))
            }
            Stop::Abort => {
                self.publish_summary();
                let id = self.request_id();
                self.write_command(pi::command::with_id(pi::command::abort(), &id))?;
                Ok(json!({ "status": "cancelling" }))
            }
        }
    }

    fn tombstone(&self, client_message_id: &str) {
        let now = Instant::now();
        let mut cancelled = self
            .cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cancelled.retain(|_, until| *until > now);
        cancelled.insert(client_message_id.to_string(), now + Duration::from_secs(300));
    }

    fn tombstoned(&self, client_message_id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(client_message_id)
            .is_some_and(|until| *until > Instant::now())
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
        self.sync_status();
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
        self.sync_status();
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
        self.sync_status();
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
        self.sync_status();
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
            // The row names the image by id; where it is stored stays in the host.
            stored.push(json!({
                "id": id,
                "name": attachment.name,
                "mimeType": attachment.mime_type,
                "bytes": bytes.len(),
            }));
            self.attachments
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(id, AttachmentSource::File { path, mime_type: attachment.mime_type.clone() });
        }
        Ok(stored)
    }

    /// An image of a user message in this session's history, by the id its
    /// history row gives it: its type and base64 data.
    pub fn attachment(&self, id: &str) -> Result<(String, String), ApiError> {
        let source = self
            .attachments
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(axum::http::StatusCode::NOT_FOUND, "attachment-not-found", "No such attachment", false)
            })?;
        match source {
            AttachmentSource::File { path, mime_type } => {
                let bytes = std::fs::read(&path).map_err(|error| {
                    ApiError::internal(format!("Could not read attachment: {error}"))
                })?;
                Ok((mime_type, STANDARD.encode(bytes)))
            }
            AttachmentSource::Saved { mime_type, data } => Ok((mime_type, data.to_string())),
        }
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
        // No length limit of the host's own: what fits is the runtime's and the
        // model's to decide (#62).
        if text.is_empty() {
            return Err(ApiError::bad_request("text is required"));
        }
        if attachments.len() > 4 {
            return Err(ApiError::bad_request("Attach at most 4 images"));
        }
        let total: usize = attachments.iter().map(|item| item.data.len()).sum();
        if total > 20 * 1024 * 1024 {
            return Err(ApiError::bad_request("Images must total 20 MB or less"));
        }
        // The session owns its messages whatever its runtime does: a stopped
        // session starts a runtime again for this message, and one whose runtime
        // is being replaced (recovering) holds it like one that is starting.
        // Only a session that failed waits for the user's Restart.
        let resume = match self.status() {
            Status::Error => {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "session-stopped",
                    "Session is not runnable",
                    false,
                ))
            }
            Status::Stopped | Status::Cancelled => true,
            _ => false,
        };
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
        // Refused only when the runtime reported no model; a model still
        // resolving holds the message until it is ready.
        self.model_for_turn()?;
        let counter = self.next_message.fetch_add(1, Ordering::Relaxed) + 1;
        let message_id = format!("m-{counter}");
        let images: Vec<(&str, &str)> = attachments
            .iter()
            .map(|attachment| (attachment.mime_type.as_str(), attachment.data.as_str()))
            .collect();
        let prompt = pi::command::with_id(pi::command::prompt(text, &images), client_message_id);
        // A new message replaces the failed one; a slash command (such as the
        // Flow command that rescues it) leaves it, with its Retry, in place.
        if !text.trim_start().starts_with('/') {
            *self
                .failed_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
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
        // Whether the runtime is still being started: the prompt is parked
        // until its handshake ends (`flush_parked_prompt`).
        let starting = resume
            || matches!(self.status(), Status::Pending | Status::Starting | Status::Recovering)
            || self.model_state() != "ready";
        // The message starts a run only when none is in progress, whoever
        // started that one. Decided and claimed at once, under the same locks
        // a run's end takes, so a message never waits behind a run that ended.
        let claimed = {
            let mut queue = self.queue_guard();
            let mut run = self.run_guard();
            if Self::free_for_run(&run, &queue) {
                let row = Self::stamped_row(row, &message_id);
                self.push_history(row.clone());
                let phase = if starting { RunPhase::Starting } else { RunPhase::Claimed };
                *run = Some(Run::user(
                    &message_id,
                    client_message_id,
                    client_id.map(str::to_string),
                    prompt,
                    Some(row),
                    phase,
                ));
                true
            } else {
                // A run is in progress, whoever started it. The host owns the
                // message, not the composer: it waits in the queue and is handed
                // to the run as steer when the run takes it (`run_takes_steer`),
                // or starts the next run if this one ends first.
                queue.push_back(Queued {
                    turn: message_id.clone(),
                    prompt,
                    row: Some(row),
                    steered: None,
                    no_steer: false,
                    held: false,
                    prompted: false,
                });
                false
            }
        };
        if !claimed {
            self.publish(
                "message.accepted",
                json!({ "messageId": message_id.clone(), "receipt": "queued", "waiting": true, "clientMessageId": client_message_id }),
            );
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
        self.clear_reply();
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
        self.publish(
            "turn.start",
            json!({
                "turnId": message_id.clone(),
                "phase": if starting { "starting" } else { "running" },
            }),
        );
        self.sync_status();
        self.publish_summary();
        if resume || matches!(self.status(), Status::Pending) {
            self.set_status(Status::Starting);
            self.start();
            if matches!(self.status(), Status::Cancelled | Status::Error) {
                self.end_active_turn(json!({ "aborted": true, "reason": "runtime-unavailable" }));
                messages.remove(client_message_id);
                return Err(ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "runtime-unavailable",
                    "The runtime could not start",
                    true,
                ));
            }
        }
        // Once the runtime is up, the prompt goes out now. While it starts, its
        // handshake writes it; a handshake that ended since `starting` was read
        // has already looked, so it is written here (at most once either way).
        let mut waiting = false;
        if !matches!(self.status(), Status::Starting | Status::Recovering) && self.model_state() == "ready" {
            match self.write_prompt(&message_id) {
                // A run the runtime started took its place: the message waits in the queue.
                Ok(written) => waiting = !written && self.run_id().as_deref() != Some(message_id.as_str()),
                Err(error) => {
                    self.fail(error.code, &error.message, error.retryable);
                    messages.remove(client_message_id);
                    return Err(error);
                }
            }
            self.sync_status();
            self.publish_summary();
        }
        messages.insert(
            client_message_id.to_string(),
            SentMessage {
                message_id: message_id.clone(),
                text: text.to_string(),
            },
        );
        drop(messages);
        if waiting {
            Ok(json!({ "messageId": message_id, "receipt": "queued", "waiting": true }))
        } else {
            Ok(json!({ "messageId": message_id, "receipt": "queued" }))
        }
    }

    pub fn cancel_message(&self, client_message_id: &str) -> Result<Value, ApiError> {
        if self.run_client_message().as_deref() == Some(client_message_id) {
            // The message is the run in progress: cancelling it is a Stop.
            return self.interrupt();
        }
        let removed = {
            let mut queue = self
                .queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let at = queue
                .iter()
                .position(|item| item.client_message_id() == Some(client_message_id));
            if at.is_some_and(|at| queue[at].prompted) {
                // The runtime has it as a prompt and has not answered: it is
                // stopped when the runtime answers (`displaced_prompt_answered`).
                drop(queue);
                self.tombstone(client_message_id);
                return Ok(json!({ "status": "cancelling" }));
            }
            if at.is_some_and(|at| queue[at].held) {
                // Flow has it and will deliver it; removing it here would not stop that.
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "message-held",
                    "Flow control is holding this message",
                    false,
                ));
            }
            at.and_then(|at| queue.remove(at))
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

    /// A turn is refused only when the runtime reported that it has no model.
    /// While the model is `resolving` the message is accepted and waits: it
    /// reaches the runtime once the model is `ready` (`flush_parked_prompt`).
    fn model_for_turn(&self) -> Result<(), ApiError> {
        match self.model_state() {
            "none" => Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "no-model",
                "The session has no model",
                false,
            )),
            _ => Ok(()),
        }
    }

    pub fn continue_queue(self: &Arc<Self>) -> Result<Value, ApiError> {
        self.model_for_turn()?;
        self.queue_paused.store(false, Ordering::SeqCst);
        // Do not write a queued prompt until the replacement runtime has completed
        // its handshake. A Recovering session starts the queue from the handshake
        // path, not from this command.
        let started = self.start_queued_turn();
        if !started {
            self.steer_queue();
        }
        self.publish_summary();
        Ok(json!({ "status": if started { "running" } else { "queued" } }))
    }

    pub fn retry_failed(self: &Arc<Self>) -> Result<Value, ApiError> {
        self.model_for_turn()?;
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
            .push_front(Queued { turn, prompt, row: None, steered: None, no_steer: true, held: false, prompted: false });
        self.queue_paused.store(false, Ordering::SeqCst);
        self.start_queued_turn();
        self.publish_summary();
        Ok(json!({ "status": "retrying" }))
    }

    pub fn discard_queue(&self) -> Result<Value, ApiError> {
        self.reclaim_steered();
        let prompted: Vec<String> = {
            let mut queue = self.queue_guard();
            let prompted = queue
                .iter()
                .filter(|item| item.prompted)
                .filter_map(|item| item.client_message_id().map(str::to_string))
                .collect();
            queue.clear();
            prompted
        };
        // The runtime still has these as prompts: dropped when it answers.
        for client_message_id in prompted {
            self.tombstone(&client_message_id);
        }
        self.queue_paused.store(false, Ordering::SeqCst);
        self.publish_summary();
        Ok(json!({ "status": "discarded" }))
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
                // A new conversation whose runtime is not started has no history.
                Status::Pending if kind == "get_messages" => {
                    return Ok(json!({ "messages": [] }));
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

    /// Whether the runtime can take a model or level command now. Before the
    /// runtime has answered for this session there is nothing to change: the
    /// caller sees `resolving` and must not ask (typed refusal, no waiting).
    /// The same fact gates a send (`model_state`), so the two cannot disagree.
    fn model_command_ready(&self) -> Result<(), ApiError> {
        let live = !matches!(
            self.status(),
            Status::Pending | Status::Error | Status::Stopped | Status::Cancelled
        );
        if live && self.model_answered.load(Ordering::SeqCst) {
            return Ok(());
        }
        Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "model-resolving",
            "The session's runtime has not reported its model yet",
            true,
        ))
    }

    /// Change this session's model: the runtime's `set_model`, nothing else.
    /// A refusal is this command's result only; the session keeps its model.
    pub async fn select_model(self: &Arc<Self>, provider: &str, model: &str) -> Result<Value, ApiError> {
        // Before the runtime answered, the choice waits for it like the pick a
        // new conversation was created with.
        if !self.model_answered.load(Ordering::SeqCst) || !self.runtime_live() {
            self.request_model(provider, model);
            return Ok(json!({ "provider": provider, "id": model, "pending": true }));
        }
        self.model_command_ready()?;
        // A newer choice replaces a pick still on its way.
        self.requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        let selected = self
            .request(
                pi::command::set_model(provider, model),
                Duration::from_secs(30),
            )
            .await
            .map_err(|error| {
                if error.code == "runtime-error" {
                    ApiError::new(
                        axum::http::StatusCode::BAD_REQUEST,
                        "model-unavailable",
                        error.message,
                        false,
                    )
                } else {
                    error
                }
            })?;
        // The response already updated the session (`Reply::SetModel`).
        Ok(selected)
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
    fn set_model(&self, model: Option<Value>) -> bool {
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
        changed
    }

    /// Replace one of the runtime's lists; publish when it changed.
    fn set_list(&self, list: &Mutex<Vec<Value>>, value: Vec<Value>) {
        let changed = {
            let mut current = list.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let changed = *current != value;
            *current = value;
            changed
        };
        if changed {
            self.publish_summary();
        }
    }

    /// Ask the runtime which models and levels it offers this session.
    fn request_model_lists(&self) {
        for command in [
            pi::command::get_available_models(),
            pi::command::get_available_thinking_levels(),
        ] {
            let id = self.request_id();
            let _ = self.write_command(pi::command::with_id(command, &id));
        }
    }

    /// `resolving` until the runtime answers (and has the model the client
    /// asked for, when it offers it), then `ready` or `none`.
    fn model_state(&self) -> &'static str {
        if self.pick_pending.load(Ordering::SeqCst) || !self.model_answered.load(Ordering::SeqCst) {
            "resolving"
        } else if self
            .model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
        {
            "ready"
        } else {
            "none"
        }
    }

    /// Whether a runtime is working for this session now (starting, recovering
    /// or up). Only then can anything about the model still be on its way.
    fn runtime_live(&self) -> bool {
        !matches!(
            self.status(),
            Status::Pending | Status::Stopped | Status::Cancelled | Status::Error
        )
    }

    /// The session's runtime is gone (stopped, failed, exited). What it was
    /// asked and never answered ends with it: the session keeps the model that
    /// runtime last reported, and a pick it never applied stays on the session
    /// for the next runtime (`install_runtime`). Nothing waits on it any more.
    fn runtime_gone(&self) {
        self.pick_pending.store(false, Ordering::SeqCst);
        self.model_answered.store(false, Ordering::SeqCst);
    }

    /// The model a session without a runtime shows: the user's pick waiting for
    /// the next runtime, else the model its last runtime reported, else the one
    /// its runtimes' earlier words lead to expect.
    fn resting_model(&self) -> Option<Value> {
        let requested = self
            .requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some((provider, id)) = requested {
            return Some(
                self.config
                    .known
                    .find(&provider, &id)
                    .unwrap_or_else(|| json!({ "provider": provider, "id": id })),
            );
        }
        let current = self
            .model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        current.or_else(|| self.expected_model())
    }

    /// The session's model as clients see it: the runtime's report and its state.
    fn model_view(&self) -> Value {
        let model = self
            .model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if !self.runtime_live() {
            // No runtime, so nothing is on its way: the session shows its model.
            return match self.resting_model() {
                Some(Value::Object(mut object)) => {
                    object.insert("state".into(), json!("ready"));
                    Value::Object(object)
                }
                _ => json!({ "state": "resolving" }),
            };
        }
        let mut view = match model {
            Some(Value::Object(object)) => Value::Object(object),
            _ => json!({}),
        };
        let state = self.model_state();
        view["state"] = json!(state);
        if state == "resolving" {
            if let Some(expected) = self.expected_model() {
                view["expected"] = expected;
            }
        }
        view
    }

    /// While the runtime has not answered: the model it is expected to report,
    /// from the runtime's own earlier words. The pick the client asked for when
    /// the runtimes list it; for a new conversation, the model a blank runtime
    /// last started on; for a saved one, the model its last reply used. Only
    /// shown; nothing is decided by it.
    fn expected_model(&self) -> Option<Value> {
        let known = &self.config.known;
        let requested = self
            .requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some((provider, id)) = requested {
            if let Some(model) = known.find(&provider, &id) {
                return Some(model);
            }
            // Kept across a configuration re-read: the model it already had.
            let current = self.model.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
            if let Some(model) = current.filter(|model| is_model(model, &provider, &id)) {
                return Some(model);
            }
        }
        if self.fresh.load(Ordering::SeqCst) {
            return known.start_model();
        }
        let history = self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        history
            .iter()
            .rev()
            .find_map(|row| {
                let id = row.get("model").and_then(Value::as_str)?;
                let provider = row.get("provider").and_then(Value::as_str)?;
                Some((provider.to_string(), id.to_string()))
            })
            .or_else(|| {
                let saved = self.saved_model.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()?;
                Some((saved.get("provider")?.as_str()?.to_string(), saved.get("id")?.as_str()?.to_string()))
            })
            .map(|(provider, id)| known.find(&provider, &id).unwrap_or_else(|| json!({ "provider": provider, "id": id })))
            // A saved file that names no model (written by an older version) is
            // opened on the model a runtime starts with, as the runtimes last answered.
            .or_else(|| known.start_model())
    }

    /// The session's runtime's list once it answered; until then the latest
    /// list any runtime answered (every runtime reads the same configuration).
    fn models_view(&self) -> Vec<Value> {
        let own = self.models.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        if own.is_empty() && !self.model_answered.load(Ordering::SeqCst) {
            return self.config.known.list();
        }
        own
    }

    /// A new conversation should use the client's last pick. It goes to the
    /// runtime with `set_model` as soon as the runtime's own list offers it;
    /// until then the model is `resolving`, so no message goes out on the model
    /// it replaces. A pick the runtime does not list is dropped: the session
    /// keeps the runtime's model.
    pub fn request_model(self: &Arc<Self>, provider: &str, id: &str) {
        *self
            .requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((provider.to_string(), id.to_string()));
        // Without a runtime the pick waits on the session; the next runtime
        // takes it (`install_runtime`).
        if self.runtime_live() {
            self.pick_pending.store(true, Ordering::SeqCst);
        }
        self.publish_summary();
        if self.model_answered.load(Ordering::SeqCst) {
            self.apply_requested_model();
        }
    }

    /// Hand the requested model to the runtime, once its list has arrived.
    fn apply_requested_model(self: &Arc<Self>) {
        // During a configuration re-read, only lists answered after it count.
        if !self.pick_pending.load(Ordering::SeqCst)
            || !self.model_answered.load(Ordering::SeqCst)
            || self.reloading.load(Ordering::SeqCst)
        {
            return;
        }
        let Some((provider, id)) = self
            .requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return;
        };
        let listed = self
            .models
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|model| is_model(model, &provider, &id));
        let current = self
            .model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .is_some_and(|model| is_model(model, &provider, &id));
        if !listed || current {
            self.pick_settled();
            return;
        }
        let request = self.request_id();
        if self
            .write_command(pi::command::with_id(pi::command::set_model(&provider, &id), &request))
            .is_err()
        {
            self.pick_settled();
        }
    }

    /// The requested model was applied, refused or not offered: the session's
    /// model is the runtime's answer now, and what waited for it can go.
    fn pick_settled(self: &Arc<Self>) {
        if !self.pick_pending.swap(false, Ordering::SeqCst) {
            return;
        }
        self.requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        self.publish_summary();
        // While the handshake runs, its end sends what waited.
        if matches!(self.status(), Status::Starting | Status::Recovering) {
            return;
        }
        self.flush_parked_prompt();
        self.sync_status();
        self.start_queued_turn();
    }

    /// Change this session's reasoning level. The runtime clamps it to the
    /// model and reports the result (`thinking_level_changed`).
    pub async fn select_thinking(&self, level: &str) -> Result<Value, ApiError> {
        // Nothing is echoed: the level in effect arrives as the runtime reports it.
        self.model_command_ready()?;
        self.request(
            pi::command::set_thinking_level(level),
            Duration::from_secs(30),
        )
        .await?;
        Ok(json!({}))
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
        self.runtime_gone();
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

    /// The host is done with this session for good: it was reaped, or the host
    /// is shutting down. A new conversation nobody ever wrote in also leaves no
    /// file behind (#92): the host wrote its header at creation, so the host
    /// removes it, unless the file holds a conversation after all.
    pub fn discard(&self) {
        let unused = self.untouched();
        self.stop();
        if !unused {
            return;
        }
        let Some(path) = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return;
        };
        let path = PathBuf::from(path);
        if !session_file_unused(&path) {
            return;
        }
        if std::fs::remove_file(&path).is_ok() {
            log(&self.home, "info", "session.discarded", json!({ "session": self.id }));
            return;
        }
        // The runtime was just terminated; on Windows its handle can outlive
        // the call for a moment.
        let home = self.home.clone();
        let id = self.id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                for _ in 0..10 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    if !session_file_unused(&path) {
                        return;
                    }
                    if std::fs::remove_file(&path).is_ok() {
                        log(&home, "info", "session.discarded", json!({ "session": id }));
                        return;
                    }
                }
            });
        }
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
            // Busy while a run is in progress, whoever started it (also while
            // it waits for an approval or an answer).
            "running": self.run_guard().is_some(),
            "activeTurn": self.active_turn_view(),
            "runtimePid": self.runtime_pid(),
            "model": self.model_view(),
            "runtimeParseErrors": self.runtime_parse_errors(),
            "cursor": self.cursor(),
            "pendingApprovals": self.pending_approvals(),
            "pendingQuestions": self.pending_questions(),
            "pendingApprovalCount": self.pending_approvals().len(),
            "pendingQuestionCount": self.pending_questions().len(),
            // What only the host holds for this session, idle or not: messages
            // waiting (queued, held, returned by Stop) and a failed message to
            // retry. A client opens such a session live, not from its file.
            "queued": self.queue_guard().len(),
            "hasFailedTurn": self
                .failed_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some(),
        })
    }

    /// The turn in progress, as the session list and the session detail both show it.
    fn active_turn_view(&self) -> Option<Value> {
        self.run().map(|run| {
            let phase = if run.stopping {
                "cancelling"
            } else if run.phase == RunPhase::Starting {
                "starting"
            } else {
                "running"
            };
            json!({
                "turnId": run.id,
                "origin": run.origin.as_str(),
                "clientMessageId": run.client_message_id,
                "phase": phase,
                "step": self.step_view(),
                "startedAt": run.started_at,
                "stopError": run.stop_error,
            })
        })
    }

    pub fn summary(&self) -> Value {
        let status = self.status();
        let active_turn = self.active_turn_view();
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
                    "state": if item.prompted { "delivering" } else if item.held { "held" } else if self.queue_paused.load(Ordering::Relaxed) { "returned" } else { "queued" },
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
            "failure": self
                .failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            "modelListError": self
                .model_list_error
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
            "model": self.model_view(),
            "models": self.models_view(),
            "thinkingLevels": self
                .thinking_levels
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
            steers_in_flight: AtomicUsize::new(0),
            reclaim_waiting: AtomicBool::new(false),
            fresh: AtomicBool::new(false),
            shown: AtomicBool::new(false),
            viewers: AtomicUsize::new(0),
            queue_paused: AtomicBool::new(false),
            first_output_turn: Mutex::new(None),
            next_message: AtomicU64::new(0),
            next_request: AtomicU64::new(0),
            run: Mutex::new(None),
            release_flow_hold: AtomicBool::new(false),
            commands: Mutex::new(Vec::new()),
            cancelled: Mutex::new(HashMap::new()),
            failed_turn: Mutex::new(None),
            failure: Mutex::new(None),
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
            attachments: Mutex::new(HashMap::new()),
            assistant_text: Mutex::new(String::new()),
            assistant_blocks: Mutex::new(Vec::new()),
            step: Mutex::new(StepState::new()),
            model: Mutex::new(None),
            model_answered: AtomicBool::new(false),
            models: Mutex::new(Vec::new()),
            model_list_error: Mutex::new(None),
            requested_model: Mutex::new(None),
            pick_pending: AtomicBool::new(false),
            runtime_owns_file: AtomicBool::new(false),
            start_folder: Mutex::new(None),
            saved_model: Mutex::new(None),
            reload_due: AtomicBool::new(false),
            reloading: AtomicBool::new(false),
            known_generation: AtomicU64::new(0),
            thinking_levels: Mutex::new(Vec::new()),
            first_output: Mutex::new(FirstOutput::default()),
            warm_attach: Mutex::new(None),
            thinking_level: Mutex::new(None),
            subscribers: AtomicU64::new(0),
            next_client: AtomicU64::new(0),
            last_activity: Mutex::new(AwakeInstant::now()),
        })
    }

    /// A new conversation gets its runtime as soon as it is created (a warm one
    /// when ready): the session's model is the runtime's, so nothing can be sent
    /// until that runtime has answered, and the first send only hands over the
    /// prompt (#117). An untouched session gives its runtime back once no client
    /// shows it.
    pub fn attach_early(self: &Arc<Self>) {
        if !matches!(self.status(), Status::Pending) || !self.fresh.load(Ordering::SeqCst) {
            return;
        }
        log(&self.home, "info", "session.attach_early", json!({ "session": self.id }));
        self.set_status(Status::Starting);
        self.start();
    }

    /// A new conversation nothing was said in yet.
    pub fn untouched_new(&self) -> bool {
        self.untouched()
    }

    /// Nothing was ever said in it: a new conversation the user left before
    /// sending. It keeps no runtime once no client shows it.
    fn untouched(&self) -> bool {
        self.fresh.load(Ordering::SeqCst)
            && self.run_id().is_none()
            && self
                .history
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
            && self
                .queued_turns
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
    }

    fn start(self: &Arc<Self>) {
        if let Err(error) = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.lease_path)
        {
            self.fail("internal", &format!("Could not create the runtime lease: {error}"), false);
            return;
        }
        self.spawn_runtime(true);
    }

    /// The folder the runtime starts in: the session file's own folder text when
    /// it has one, so the handshake's switch keeps the loaded extensions.
    fn runtime_cwd(&self) -> String {
        self.session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .and_then(|path| session_header_cwd(&path))
            .or_else(|| {
                self.start_folder
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            })
            .unwrap_or_else(|| canonical_path(&self.workspace_path))
    }

    fn spawn_spec(&self) -> Result<SpawnSpec, String> {
        Ok(SpawnSpec {
            program: self.config.spec.program.clone(),
            args: self.config.spec.args.clone(),
            env: self.environment()?,
            workspace: PathBuf::from(self.runtime_cwd()),
            low_priority: false,
        })
    }

    fn spawn_runtime(self: &Arc<Self>, initial: bool) -> bool {
        // Stopped before its start ran (the start is spawned): a runtime started
        // now would belong to nobody and live until the host exits (#93).
        if matches!(self.status(), Status::Stopped | Status::Cancelled) {
            return false;
        }
        let (event_tx, event_rx) = tokio::sync::mpsc::channel(256);
        // A session with a file takes any warm runtime: the handshake switches
        // it to that file. A new conversation without one takes over the blank
        // session a runtime warmed for its folder opened by itself, as it is:
        // no switch, no second file.
        let has_file = self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some();
        if let Some(pool) = self.config.warm.get() {
            let before = pool.status();
            if let Some(crate::runtime::warm::Taken { runtime, matched, attaching, state }) =
                pool.take(event_tx.clone(), Path::new(&self.runtime_cwd()), !has_file)
            {
                if !has_file {
                    self.adopt_runtime_session(state.as_ref());
                }
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
        }
        let mut booting = None;
        if let Some(pool) = self.config.warm.get() {
            // Nothing to take, but the pool is spawning one or another session's
            // runtime is booting, and none has answered yet: this runtime may
            // have to apply its profile, which fails at once when another
            // runtime holds the lock (#94). Wait for that one, then try again.
            if pool.must_wait() {
                log(
                    &self.home,
                    "info",
                    "runtime.start_deferred",
                    json!({ "session": self.id, "warm": pool.status() }),
                );
                let session = self.clone();
                let pool = pool.clone();
                tokio::spawn(async move {
                    pool.wait_turn(Duration::from_secs(300)).await;
                    if matches!(session.status(), Status::Starting | Status::Recovering) {
                        session.spawn_runtime(initial);
                    }
                });
                return true;
            }
            log(
                &self.home,
                "info",
                "runtime.cold_start",
                json!({ "session": self.id, "warm": pool.status() }),
            );
            // The pool starts nothing beside this runtime until it has attached.
            booting = Some(pool.booting());
        }
        match self
            .spawn_spec()
            .and_then(|spec| RuntimeSupervisor::start(spec, event_tx))
        {
            Ok(runtime) => {
                if let Some(booting) = booting {
                    *self
                        .warm_attach
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((booting, Instant::now()));
                }
                self.install_runtime(runtime, event_rx);
                true
            }
            Err(error) => {
                let message = format!("Could not start the runtime: {error}");
                if initial {
                    self.fail("runtime-unavailable", &message, true);
                } else {
                    self.recovery_failed(format!("Could not restart the runtime: {error}"));
                }
                false
            }
        }
    }

    /// A new conversation takes over the blank session its runtime opened at
    /// start (the runtime's `get_state`): that file is the conversation's from
    /// now on, and clients learn it at once. A runtime still starting reports
    /// it in the handshake instead.
    fn adopt_runtime_session(&self, state: Option<&Value>) {
        let Some(path) = state
            .and_then(|state| state.get("sessionFile"))
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
        else {
            return;
        };
        *self
            .session_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path.to_string());
        self.runtime_owns_file.store(true, Ordering::SeqCst);
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

    fn install_runtime(
        self: &Arc<Self>,
        runtime: Arc<RuntimeSupervisor>,
        mut events: tokio::sync::mpsc::Receiver<RuntimeEvent>,
    ) {
        let generation = self.runtime_generation.fetch_add(1, Ordering::SeqCst) + 1;
        // A runtime the host restarts for this session (recovery) must not
        // change the session's model: the model it had is handed to the new
        // runtime like a pick, once that runtime lists it.
        let previous = self
            .model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(model) = previous {
            if let (Some(provider), Some(id)) = (
                model.get("provider").and_then(Value::as_str),
                model.get("id").and_then(Value::as_str),
            ) {
                let mut requested = self
                    .requested_model
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if requested.is_none() {
                    *requested = Some((provider.to_string(), id.to_string()));
                }
            }
        }
        // The new runtime has its own model and answers for it: until then the
        // session's model is `resolving` (it keeps showing the one it had), and
        // a pick waiting on the session goes to this runtime.
        self.model_answered.store(false, Ordering::SeqCst);
        if self
            .requested_model
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
        {
            self.pick_pending.store(true, Ordering::SeqCst);
        }
        self.known_generation.store(self.config.known.generation(), Ordering::SeqCst);
        self.set_list(&self.models, Vec::new());
        self.set_list(&self.thinking_levels, Vec::new());
        *self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(runtime.clone());
        // `stop` sets the status before it reads the runtime; this reads the
        // status after setting it. A stop in between is seen by one of the two,
        // so the runtime never outlives its session (#93).
        if matches!(self.status(), Status::Stopped | Status::Cancelled) {
            runtime.terminate();
            // Its hold on the pool goes with it.
            self.warm_attach
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            return;
        }
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
            self.fail("runtime-crashed", &reason, true);
            return;
        }
        log(
            &self.home,
            "warn",
            "runtime.recovering",
            json!({ "reason": reason, "attempts": count }),
        );
        self.runtime_gone();
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
        self.spawn_runtime(false);
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
            self.fail("runtime-crashed", &reason, true);
            return;
        }
        let session = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            session.schedule_recovery(reason);
        });
    }

    /// The session cannot run any more: the one way into `Error`. Nothing may
    /// be left waiting on a runtime that will not answer, so the turn in
    /// progress ends as failed, prompts parked for the handshake are dropped,
    /// open approvals and questions expire, and the runtime is let go (a Stop
    /// has nothing left to reach). Reopening the session starts a new one.
    fn fail(&self, code: &str, message: &str, retryable: bool) {
        if matches!(self.status(), Status::Error | Status::Stopped | Status::Cancelled) {
            return;
        }
        log(
            &self.home,
            "warn",
            "session.failed",
            json!({ "session": self.id, "code": code, "message": message }),
        );
        // The one session-level error: the reason, the runtime's own text, and
        // the way back. Clients read it from the snapshot; it is never also an
        // event, so it cannot be shown twice or stacked.
        *self
            .failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(json!({
            "code": code,
            "text": message,
            "retryable": retryable,
            "recovery": "restart",
        }));
        self.set_status(Status::Error);
        self.runtime_gone();
        self.queue_paused.store(true, Ordering::SeqCst);
        self.steers_in_flight.store(0, Ordering::SeqCst);
        for item in self
            .queued_turns
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter_mut()
        {
            item.steered = None;
            item.held = false;
            item.prompted = false;
        }
        self.end_active_turn(json!({ "status": "failed", "reason": code }));
        self.cancel_pending(code);
        self.commands.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
        // Events of the released runtime (its exit) must not reach a failed session.
        self.runtime_generation.fetch_add(1, Ordering::SeqCst);
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(runtime) = runtime {
            runtime.cancel_pending(code);
            runtime.terminate();
        }
        let _ = std::fs::remove_file(&self.lease_path);
        self.restarts.settle();
        self.publish_summary();
    }

    /// End the turn in progress, whatever stage it reached, without a run
    /// ending it. A reply cut off mid-stream keeps what arrived.
    fn end_active_turn(&self, outcome: Value) {
        let Some(run) = self.take_run() else {
            return;
        };
        self.finish_step_reply(&run.id, None, true);
        self.close_unfinished_tools();
        {
            let mut data = json!({ "turnId": run.id, "clientMessageId": run.client_message_id });
            if let (Some(data), Some(outcome)) = (data.as_object_mut(), outcome.as_object()) {
                data.extend(outcome.clone());
            }
            self.publish("turn.end", data);
        }
        self.publish_summary();
    }

    fn recovery_succeeded(&self) {
        // Attempts are kept for the five-minute window: a runtime that reaches
        // idle and dies again immediately is flapping, not healthy.
        self.restarts.settle();
    }

    /// Start the next waiting message as a run, when the session is up, the
    /// queue is not paused after a Stop, and nothing else may run. Checked and
    /// claimed at once.
    fn start_queued_turn(self: &Arc<Self>) -> bool {
        // Without a model the turn would only fail at the runtime: it waits.
        if self.queue_paused.load(Ordering::Relaxed)
            || self.model_state() != "ready"
            || !matches!(
                self.status(),
                Status::Idle | Status::Running | Status::WaitingApproval | Status::WaitingQuestion
            )
        {
            return false;
        }
        let started = {
            let mut queue = self.queue_guard();
            let mut run = self.run_guard();
            if !Self::free_for_run(&run, &queue) {
                None
            } else {
                // A held message is its extension's to release; sending it too would send it twice.
                let at = queue.iter().position(|item| !item.held && !item.prompted);
                at.and_then(|at| queue.remove(at)).map(|item| {
                    let client = item.client_message_id().unwrap_or_default().to_string();
                    let row = item.row.map(|row| Self::stamped_row(row, &item.turn));
                    if let Some(row) = row.clone() {
                        self.push_history(row);
                    }
                    *run = Some(Run::user(&item.turn, &client, None, item.prompt, row.clone(), RunPhase::Claimed));
                    (item.turn, row.is_some())
                })
            }
        };
        let Some((turn, delivered)) = started else {
            return false;
        };
        self.clear_reply();
        if delivered {
            if let Some(row) = self.history_row(&format!("{turn}:user")) {
                self.publish("message.user", row);
            }
        }
        self.publish("turn.start", json!({ "turnId": turn, "phase": "running" }));
        self.sync_status();
        self.publish_summary();
        if let Err(error) = self.write_prompt(&turn) {
            // Lock order is queue, then run: take the run first, on its own.
            let taken = self.run_guard().take_if(|run| run.id == turn);
            if let Some(prompt) = taken.and_then(|run| run.prompt) {
                self.queue_guard().push_front(Queued { turn, prompt, row: None, steered: None, no_steer: true, held: false, prompted: false });
            }
            self.fail(error.code, &error.message, error.retryable);
        }
        true
    }

    /// The newest history row with this id.
    fn history_row(&self, id: &str) -> Option<Value> {
        self.history
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .rev()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
            .cloned()
    }

    /// Write the prompt parked while the runtime started.
    fn flush_parked_prompt(self: &Arc<Self>) {
        let Some((id, client_message_id)) = self
            .run_guard()
            .as_ref()
            .filter(|run| run.phase == RunPhase::Starting)
            .map(|run| (run.id.clone(), run.client_message_id.clone()))
        else {
            return;
        };
        match self.model_state() {
            // The model is still on its way: it is sent once it is settled.
            "resolving" => return,
            // The runtime has no model: the message fails where it was sent.
            "none" => {
                if let Some(client_message_id) = client_message_id {
                    self.turn_refused(&client_message_id, "no-model", "The session has no model");
                }
                return;
            }
            _ => {}
        }
        if let Err(error) = self.write_prompt(&id) {
            self.fail(error.code, &error.message, error.retryable);
        }
    }

    fn environment(&self) -> Result<Vec<(OsString, OsString)>, String> {
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
                // The hold on the warm pool was for this runtime attaching, and it
                // went down with it. Kept, it would make the runtime this session
                // starts next wait for the pool, that is, for itself, forever.
                self.warm_attach.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
                // Commands still open went down with the runtime: none of them
                // will answer, and none of their effects can be assumed.
                self.commands.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
                // A runtime is started for a session someone uses. One that dies
                // after it came up (it answered) while its session waits for
                // nobody (idle, nothing queued, no client shows or follows it) is
                // not replaced now: the session stops, and starts a runtime again
                // for its next message or when it is opened. Replacing every such
                // runtime at once competes with the one session the user is in
                // (all of a machine's runtimes can go down together). A runtime
                // that dies before it answered is a failed start: recovery runs,
                // and a start that keeps failing ends the session in error.
                if self.status() == Status::Idle
                    && self.model_answered.load(Ordering::SeqCst)
                    && self.run().is_none()
                    && self.queue_guard().is_empty()
                    && self.viewers.load(Ordering::SeqCst) == 0
                    && self.subscriber_count() == 0
                {
                    log(
                        &self.home,
                        "info",
                        "runtime.not_replaced",
                        json!({ "session": self.id, "reason": "exited while nobody uses the session" }),
                    );
                    self.stop();
                    return;
                }
                if !matches!(self.status(), Status::Stopped) {
                    let status = self.status();
                    let finalize = self.run_reached_runtime()
                        || matches!(
                            status,
                            Status::Running
                                | Status::WaitingApproval
                                | Status::WaitingQuestion
                        );
                    if finalize {
                        self.release_flow_hold.store(true, Ordering::SeqCst);
                        let run = self.take_run();
                        let turn = run.as_ref().map(|run| run.id.clone());
                        if let Some(turn) = turn.clone() {
                            self.finish_step_reply(&turn, None, true);
                            self.close_unfinished_tools();
                        }
                        let client_id = run.and_then(|run| run.client_message_id);
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
                        self.cancel_pending("runtime-exited");
                        self.queue_paused.store(true, Ordering::SeqCst);
                        self.steers_in_flight.store(0, Ordering::SeqCst);
                        self.reclaim_waiting.store(false, Ordering::SeqCst);
                        // The runtime's own queue went with it.
                        for item in self
                            .queued_turns
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .iter_mut()
                        {
                            item.steered = None;
                            // Whatever an extension held, or a prompt the runtime had not
                            // answered, went down with the runtime too; the paused queue
                            // gives it back to the user.
                            item.held = false;
                            item.prompted = false;
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

/// A session file with nothing said in it: a header and setup entries (model,
/// thinking level, extension state), no message of any kind.
fn session_file_unused(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    text.lines().filter(|line| !line.trim().is_empty()).all(|line| {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        !matches!(
            value.get("type").and_then(Value::as_str),
            Some("message" | "custom_message" | "compaction" | "branch_summary" | "session_info")
        )
    })
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
    /// What replies said about each provider's sign-in, for Settings.
    providers: Arc<crate::provider_answers::ProviderAnswers>,
    /// How runtimes are started. Kept from the moment the runtime is found; see
    /// `config()`.
    config: std::sync::OnceLock<SessionConfig>,
    /// Set when the runtime is the managed install, which the desktop's first-run
    /// preparation creates after the host has started. `config()` then looks for
    /// it on use instead of the host deciding once, at start, that it is missing.
    managed: Option<ManagedRuntime>,
    /// `enable_warm_runtime` was asked for; the pool starts when the runtime is found.
    warm_wanted: AtomicBool,
    home: PathBuf,
    runtime_home: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    clients: Mutex<HashMap<String, Vec<String>>>,
    /// What each client connected to the global event stream has open. A
    /// client opens one session at a time; that session is never reaped while
    /// the client's stream is connected, nor for the idle timeout after it
    /// closes (a sleeping machine drops it). Other idle sessions are, so a window
    /// left open does not keep a runtime alive for every session it visited.
    holders: Mutex<HashMap<String, Holder>>,
    persisted_cache: Mutex<Option<Vec<Value>>>,
    /// Configuration changes so far: only the latest one's re-read runs.
    reload_epoch: Arc<AtomicU64>,
}

/// How long after a configuration change open sessions wait before they
/// re-read it, so a run of changes is read once.
const RELOAD_SETTLE: Duration = Duration::from_millis(800);

struct ManagedRuntime {
    root: PathBuf,
    bash: Option<PathBuf>,
    replay_limit: usize,
    events: Option<Arc<crate::events::EventHub>>,
}

/// How long, in awake time, the idle reaper waits before it stops a session.
#[derive(Clone, Copy, Debug)]
pub struct IdleLimits {
    /// An idle session nobody shows or follows.
    pub idle: Duration,
    /// A session created but never started.
    pub pending: Duration,
    /// How long a client whose event stream closed still holds the session it shows.
    pub released_hold: Duration,
}

impl IdleLimits {
    /// The same limit for everything.
    pub fn all(ttl: Duration) -> Self {
        Self { idle: ttl, pending: ttl, released_hold: ttl }
    }
}

#[derive(Default)]
struct Holder {
    streams: usize,
    session: Option<String>,
    /// When the client's last stream closed (awake time). A stream drops when the
    /// machine sleeps or the window reloads; the client keeps its hold for the
    /// idle timeout after that, so it finds the session it shows still running
    /// when it reconnects (issue #111).
    released: Option<AwakeInstant>,
}

impl Holder {
    /// The session this client still holds: its stream is connected, or closed
    /// less than `ttl` of awake time ago.
    fn holds(&self, ttl: Duration) -> Option<&String> {
        let connected = self.streams > 0;
        let recent = self.released.is_some_and(|at| at.elapsed() < ttl);
        if connected || recent {
            self.session.as_ref()
        } else {
            None
        }
    }
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
        // hold up again. With no stream connected the hold lasts one idle timeout.
        if let Some(holder) = holders.get_mut(&self.client_id) {
            holder.streams = holder.streams.saturating_sub(1);
            if holder.streams == 0 {
                holder.released = Some(AwakeInstant::now());
            }
        }
    }
}

impl SessionManager {
    /// The host home: host.json, host.log.
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// What replies said about each provider's sign-in.
    pub fn providers(&self) -> Arc<crate::provider_answers::ProviderAnswers> {
        self.providers.clone()
    }

    pub fn new(
        spec: Option<RuntimeSpec>,
        home: PathBuf,
        runtime_home: PathBuf,
        bash: Option<PathBuf>,
        replay_limit: usize,
        events: Option<Arc<crate::events::EventHub>>,
    ) -> Self {
        let providers = Arc::new(crate::provider_answers::ProviderAnswers::new());
        let config = std::sync::OnceLock::new();
        if let Some(spec) = spec {
            let _ = config.set(SessionConfig {
                spec,
                home: home.clone(),
                runtime_home: runtime_home.clone(),
                bash,
                managed: None,
                replay_limit,
                events,
                warm: Arc::new(std::sync::OnceLock::new()),
                known: Arc::new(KnownModels::new()),
                providers: providers.clone(),
            });
        }
        Self {
            providers,
            config,
            managed: None,
            warm_wanted: AtomicBool::new(false),
            home,
            runtime_home,
            sessions: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            holders: Mutex::new(HashMap::new()),
            persisted_cache: Mutex::new(None),
            reload_epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    /// A manager for the managed runtime under `managed` (`runtime\node` and
    /// `app\bootstrap.mjs`). On a first launch the desktop starts the host
    /// before it installs that runtime, so the runtime is looked for on use and
    /// picked up as soon as it exists, without a host restart (issue #87). A
    /// fixed `bash` is used as given; otherwise Git Bash is looked up at each spawn.
    pub fn managed(
        managed: PathBuf,
        home: PathBuf,
        runtime_home: PathBuf,
        bash: Option<PathBuf>,
        replay_limit: usize,
        events: Option<Arc<crate::events::EventHub>>,
    ) -> Self {
        let mut manager = Self::new(None, home, runtime_home, None, replay_limit, None);
        manager.managed = Some(ManagedRuntime { root: managed, bash, replay_limit, events });
        manager
    }

    /// How runtimes are started, or `None` while the managed runtime is not
    /// installed. Once found it is kept for the life of the host: an update
    /// replaces the files in place (after stopping sessions), it does not move them.
    fn config(&self) -> Option<&SessionConfig> {
        if let Some(config) = self.config.get() {
            return Some(config);
        }
        let managed = self.managed.as_ref()?;
        let spec = RuntimeSpec::from_managed(&managed.root)?;
        let mut found = false;
        let config = self.config.get_or_init(|| {
            found = true;
            SessionConfig {
                spec,
                home: self.home.clone(),
                runtime_home: self.runtime_home.clone(),
                bash: managed.bash.clone(),
                managed: Some(managed.root.clone()),
                replay_limit: managed.replay_limit,
                events: managed.events.clone(),
                warm: Arc::new(std::sync::OnceLock::new()),
                known: Arc::new(KnownModels::new()),
                providers: self.providers.clone(),
            }
        });
        if found {
            log(
                &self.home,
                "info",
                "runtime.found",
                json!({ "program": config.spec.program.to_string_lossy() }),
            );
            if self.warm_wanted.load(Ordering::SeqCst) {
                Self::start_warm(config);
            }
        }
        Some(config)
    }

    pub fn runtime_home(&self) -> &Path {
        &self.runtime_home
    }

    /// The directory of the runtime app this host starts (the folder of its
    /// `bootstrap.mjs`), for tools that load the runtime's own packages.
    pub fn runtime_app(&self) -> Option<PathBuf> {
        let script = PathBuf::from(self.config()?.spec.args.first()?);
        (script.file_name()? == "bootstrap.mjs").then(|| script.parent().map(Path::to_path_buf)).flatten()
    }

    pub fn node_executable(&self) -> Option<PathBuf> {
        self.config()
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

    /// Copy a saved conversation through the end of its user turn `turn` (1 = the
    /// first user message) into a new saved session. A turn ends where the next
    /// user message starts, so its replies and tool results come along. Clients
    /// name the turn from the `turn` of a history row, which counts user
    /// messages the same way, so it is right whatever part of the history they
    /// loaded.
    pub fn branch_session(&self, session_path: &str, turn: usize) -> Result<String, ApiError> {
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
        let mut users = 0usize;
        for line in lines {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let user = entry.get("type").and_then(Value::as_str) == Some("message")
                && entry
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    == Some("user");
            if user {
                if users == turn {
                    break;
                }
                users += 1;
            }
            kept.push(line);
        }
        if turn == 0 || users < turn {
            return Err(ApiError::bad_request("Turn not found in session"));
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

    /// A page of a saved session's messages, read from its file: the `limit`
    /// messages before position `before` (the newest when absent). `nextBefore`
    /// reads the page before this one, null at the first message; `turn` is the
    /// user turn the page starts in (user messages before it), so a client can
    /// number turns without the earlier pages (#20).
    pub fn messages(
        &self,
        session_path: &str,
        limit: Option<usize>,
        before: Option<usize>,
    ) -> Result<Value, ApiError> {
        let path = self.session_file(session_path)?;
        let mut messages = saved_messages(&path)
            .map_err(|error| ApiError::internal(format!("Could not read the session: {error}")))?;
        let end = before.unwrap_or(messages.len()).min(messages.len());
        let start = limit.map_or(0, |limit| end.saturating_sub(limit.max(1)));
        let turn = messages[..start]
            .iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
            .count();
        messages.truncate(end);
        let page = messages.split_off(start);
        Ok(json!({
            "messages": page,
            "nextBefore": if start > 0 { json!(start) } else { Value::Null },
            "turn": turn,
        }))
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
            "node": managed_node_path(&self.home).is_file(),
            "app": self.home.join("app").join("bootstrap.mjs").is_file(),
            // The bash sessions start with: the one given to the host, else the
            // same lookup each spawn makes (bundled Git Bash on Windows, the
            // system bash on macOS and Linux).
            "bash": self
                .config
                .get()
                .and_then(|config| config.bash.clone())
                .or_else(|| self.managed.as_ref().and_then(|managed| managed.bash.clone()))
                .filter(|bash| bash.is_file())
                .or_else(|| find_bash(&self.home))
                .is_some(),
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

    /// Pins, archives and titles by session, keyed in one form (`canonical_path`)
    /// whatever form the file stores them in.
    fn read_preferences(&self) -> HashMap<String, SessionPreference> {
        self.stored_preferences()
            .into_iter()
            .map(|(key, preference)| (canonical_path(&key), preference))
            .collect()
    }

    /// The file as stored. Its keys are what `std::fs::canonicalize` gives (on
    /// Windows `\\?\C:\…`): the app before the host wrote them that way and
    /// still reads them that way, and the file is shared with it across the
    /// stable and QA channels. So entries keep their stored key.
    fn stored_preferences(&self) -> HashMap<String, SessionPreference> {
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
        let mut preferences = self.stored_preferences();
        // Update the entry already stored for this session, in whatever form its
        // key was written; a new one is stored in the app's form.
        let stored = preferences
            .keys()
            .find(|stored| canonical_path(stored) == key)
            .cloned()
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let (pinned, archived, title) = {
            let preference = preferences.entry(stored).or_default();
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
    pub fn reap_idle(&self, limits: IdleLimits) {
        let held: Vec<String> = self
            .holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .filter_map(|holder| holder.holds(limits.released_hold).cloned())
            .collect();
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stale: Vec<String> = sessions
            .iter()
            .filter(|(id, session)| {
                // A new conversation a client showed and left untouched gives
                // its runtime back as soon as no client shows it. One no client
                // ever showed (an API caller) follows the idle rule below.
                let untouched = session.status() == Status::Idle
                    && !held.contains(id)
                    && session.shown.load(Ordering::SeqCst)
                    && session.untouched();
                // A session in error that nobody shows can still own a live
                // runtime; it is released like an idle one (#93). Opening it
                // again starts it afresh.
                // A stopped one nobody shows holds nothing but its entry: a
                // client that opens it again gets it from its file.
                let idle = untouched
                    || matches!(
                        session.status(),
                        Status::Idle | Status::Error | Status::Stopped | Status::Cancelled
                    )
                        && session.subscriber_count() == 0
                        && !held.contains(id)
                        && session.last_activity().elapsed() >= limits.idle;
                let pending = session.status() == Status::Pending
                    && !held.contains(id)
                    && session.last_activity().elapsed() >= limits.pending;
                idle || pending
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut left = false;
        for id in stale {
            if let Some(session) = sessions.remove(&id) {
                session.discard();
                left = true;
            }
        }
        drop(sessions);
        // The saved-session index stands for everything not in the table. A
        // session leaving it may have written its file this run (a new one, or
        // a newer time); the index read at start knows neither, so it is read
        // again on its next use.
        if left {
            self.forget_persisted();
        }
    }

    fn forget_persisted(&self) {
        *self
            .persisted_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
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
                    // A line cut off (the app or the computer stopped while it was
                    // written) loses that line only, never the session (#150).
                    let Ok(line) = line else { break };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
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
            .and_modify(|holder| holder.released = None)
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
        let held = match self
            .holders
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_mut(client_id)
        {
            Some(holder) => Some(holder.session.replace(session_id.to_string())),
            None => None,
        };
        // Only a client with a connected stream holds anything.
        let Some(before) = held else { return };
        if let Some(session) = self.get(session_id) {
            session.shown.store(true, Ordering::SeqCst);
            if before.as_deref() != Some(session_id) {
                session.viewers.fetch_add(1, Ordering::SeqCst);
            }
        }
        if let Some(left) = before.filter(|before| before != session_id).and_then(|before| self.get(&before)) {
            let _ = left.viewers.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| count.checked_sub(1));
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
        // What only the host knew about the conversation's last message (it got
        // no reply) is not in the file; a session that replaces an ended one
        // for the same conversation keeps it.
        let mut carried_failure = None;
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
                // A session in error can still own a live runtime; one that
                // leaves the table without a stop keeps it until the host exits.
                carried_failure = existing
                    .failed_turn
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                existing.stop();
                sessions.remove(&existing.id);
            }
        }
        let config = self.config().cloned().ok_or_else(|| {
            // Without a `--runtime`, the host runs the bundled Node and app; say
            // which one is missing rather than falling back to anything else.
            // The installation is under the host home; Jouzu's data may be elsewhere.
            let node = managed_node_path(&self.home);
            let message = if !node.is_file() {
                format!("Jouzu's bundled Node.js is missing ({}). Reinstall Jouzu to restore it.", node.display())
            } else {
                "Jouzu's bundled runtime is missing. Reinstall Jouzu to restore it.".to_string()
            };
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                // Not retryable, and not the generic "try again" text: the
                // message says what is missing.
                "runtime-missing",
                message,
                false,
            )
        })?;
        std::fs::create_dir_all(&config.runtime_home).ok();
        // A new session gets its identity at creation, not after the runtime
        // handshake. The index and navigation can then show it before the first
        // reply, including when the turn is stopped during starting.
        let fresh = session_path.is_none();
        // A new conversation's file is the runtime's own: the blank session a
        // runtime opens at start, taken over when the conversation gets its
        // runtime (a warm one at once). The host writes no file of its own.
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
        session.fresh.store(fresh, Ordering::SeqCst);
        if let Some(failure) = carried_failure {
            *session
                .failed_turn
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(failure);
        }
        if fresh {
            *session
                .start_folder
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(self.folder_text(&workspace));
        }
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions.insert(session.id.clone(), session.clone());
        }
        if !matches!(status, Status::Starting) {
            if let Some(path) = session.saved_path() {
                // Not opened yet: its model is still on screen from its file.
                *session
                    .saved_model
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = saved_last_model(Path::new(&path));
            }
        }
        if matches!(status, Status::Starting) {
            // A saved conversation is readable the moment it is opened: its
            // history comes from its file, not from the runtime that attaches
            // to it seconds (or, on a busy machine, minutes) later.
            session.open_saved_history();
            let starting = session.clone();
            tokio::spawn(async move { starting.start() });
        } else if let Some(pool) = config.warm.get() {
            // A new session: the user is typing; warm for its folder meanwhile.
            pool.aim(Path::new(&session.runtime_cwd()));
            pool.hurry();
        }
        Ok(session)
    }

    /// Keep one runtime started ahead of need. Called once by the host binary;
    /// tests opt in explicitly. While the managed runtime is not installed, the
    /// pool starts as soon as it is found (see `config()`).
    pub fn enable_warm_runtime(&self) -> Option<Arc<WarmPool>> {
        let known = self.config.get().is_some();
        self.warm_wanted.store(true, Ordering::SeqCst);
        if !known {
            // Finding the runtime starts the pool.
            return self.config().and_then(|config| config.warm.get().cloned());
        }
        Some(Self::start_warm(self.config.get()?))
    }

    fn start_warm(config: &SessionConfig) -> Arc<WarmPool> {
        let config = config.clone();
        let scratch = WarmPool::scratch(&config.home);
        let events = config.events.clone();
        let spawn = config.clone();
        let memory = config.home.join("warm-workspace.txt");
        let log_home = config.home.clone();
        let pool = config.warm.get_or_init(|| {
            WarmPool::new(
                move |workspace| {
                    Ok(SpawnSpec {
                        program: spawn.spec.program.clone(),
                        args: spawn.spec.args.clone(),
                        env: spawn.environment(None, None)?,
                        workspace: workspace.map(Path::to_path_buf).unwrap_or_else(|| scratch.clone()),
                        low_priority: true,
                    })
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
        pool.keep_models_in(config.known.clone());
        pool.fill();
        log(&config.home, "info", "runtime.warm_start", pool.status());
        // The app is starting and its loading screen waits for this runtime.
        pool.hurry();
        pool.clone()
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

    /// A configuration change: the runtimes' earlier answers about models no
    /// longer hold.
    pub fn forget_known_models(&self) {
        if let Some(config) = self.config.get() {
            config.known.forget();
        }
    }

    /// A configuration change: every open session's runtime reads it again
    /// (idle ones now, busy ones when their run ends). Changes in a row are
    /// read once, after the last one, and one session at a time: runtimes
    /// re-reading their profile together race for its lock (#94).
    pub fn reload_configuration(&self) {
        let epoch = self.reload_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let latest = self.reload_epoch.clone();
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            for session in sessions {
                session.reload_configuration();
            }
            return;
        };
        handle.spawn(async move {
            tokio::time::sleep(RELOAD_SETTLE).await;
            for session in sessions {
                if latest.load(Ordering::SeqCst) != epoch {
                    // A newer change reads everything again.
                    return;
                }
                session.reload_configuration();
                let deadline = Instant::now() + Duration::from_secs(20);
                while session.status() == Status::Starting && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        });
    }

    /// The models the runtimes registered (`get_available_models`): the warm
    /// runtime's answer when one is ready, else the latest answer any runtime
    /// gave since the configuration last changed. `None` while there is neither.
    pub async fn runtime_models(&self) -> Option<Result<Value, ApiError>> {
        // Only the warm runtime is asked: every settings change restarts it, so
        // its list is the current one. A session's runtime may predate the change.
        let known = self.config.get().map(|config| config.known.clone());
        let Some(runtime) = self.warm_runtime().and_then(|pool| pool.ready_runtime()) else {
            let models = known.map(|known| known.list()).unwrap_or_default();
            return (!models.is_empty()).then(|| Ok(json!({ "models": models })));
        };
        let configured = known.as_ref().map(|known| known.generation());
        let id = format!("models-{}", random_id());
        let answer = runtime
            .request(
                pi::command::with_id(pi::command::get_available_models(), &id),
                Duration::from_secs(10),
            )
            .await;
        if let (Some(known), Some(configured), Ok(answer)) = (&known, configured, &answer) {
            if let Some(models) = answer.get("models").and_then(Value::as_array) {
                known.remember_list(configured, models);
            }
        }
        Some(answer.map_err(|error| {
            let message = match error {
                RequestError::Timeout => "The runtime did not answer".to_string(),
                RequestError::Closed(message) | RequestError::Runtime(message) => message,
            };
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "models-unavailable",
                message,
                true,
            )
        }))
    }

    pub fn warm_runtime(&self) -> Option<Arc<WarmPool>> {
        self.config.get().and_then(|config| config.warm.get().cloned())
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

    /// The host is exiting: stop everything, and leave no file for a new
    /// conversation nobody wrote in (#92).
    pub fn shutdown(&self) {
        if let Some(pool) = self.warm_runtime() {
            pool.stop();
        }
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in sessions {
            session.discard();
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
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            managed.join("runtime/git/installed/bin/bash.exe"),
            managed.join("runtime/git/PortableGit/bin/bash.exe"),
            managed.join("runtime/git/bin/bash.exe"),
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        ]
    } else {
        // No bundled Git on Unix; the system shell is the runtime's bash.
        vec![
            managed.join("runtime/git/bin/bash"),
            PathBuf::from("/bin/bash"),
            PathBuf::from("/usr/bin/bash"),
        ]
    };
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
    /// A new conversation only: the model the client wants it on (its last
    /// pick). Handed to the runtime once its list offers it (`request_model`).
    #[serde(default)]
    pub model: Option<ModelPick>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelPick {
    pub provider: String,
    pub id: String,
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

#[cfg(test)]
mod environment_tests {
    use super::*;

    fn config(runtime_home: &Path) -> SessionConfig {
        SessionConfig {
            spec: RuntimeSpec { program: PathBuf::from("node"), args: Vec::new(), env: Vec::new() },
            home: runtime_home.to_path_buf(),
            runtime_home: runtime_home.to_path_buf(),
            bash: None,
            managed: None,
            replay_limit: DEFAULT_REPLAY_LIMIT,
            events: None,
            warm: Arc::new(std::sync::OnceLock::new()),
            known: Arc::new(KnownModels::new()),
            providers: Arc::new(crate::provider_answers::ProviderAnswers::new()),
        }
    }

    fn value(environment: &[(OsString, OsString)], name: &str) -> Option<String> {
        environment
            .iter()
            .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
            .map(|(_, value)| value.to_string_lossy().into_owned())
    }

    #[test]
    fn an_unreadable_saved_file_stops_the_spawn_with_a_reason() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("launcher-environment.bin"), b"broken").unwrap();
        let error = config(home.path()).environment(None, None).unwrap_err();
        assert!(error.contains("saved environment variables could not be read"), "{error}");
    }

    /// Issue #63: warm and session runtimes carry the variables saved in
    /// Settings, read at spawn; host-managed variables still win.
    #[cfg(windows)]
    #[test]
    fn saved_variables_reach_the_next_runtime() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        assert_eq!(value(&config.environment(None, None).unwrap(), "SHISA_API_KEY"), None);
        let entry = |name: &str, value: &str| crate::environment::Entry { name: name.into(), value: value.into(), enabled: true };
        crate::environment::save(home.path(), &[entry("SHISA_API_KEY", "saved"), entry("JOUZU_NO_UPDATE", "0")]).unwrap();
        let environment = config.environment(Some("s1"), None).unwrap();
        assert_eq!(value(&environment, "SHISA_API_KEY").as_deref(), Some("saved"));
        assert_eq!(value(&environment, "JOUZU_NO_UPDATE").as_deref(), Some("1"));
        assert_eq!(value(&environment, "JOUZU_HOME"), Some(home.path().to_string_lossy().into_owned()));
    }
}
