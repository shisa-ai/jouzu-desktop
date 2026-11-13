//! Phase 1 of the runtime host: HTTP/SPA skeleton only.
//!
//! The contract lives in `docs/contracts/host-ui-v1.md` of the docs repository.
//! This crate deliberately owns no chat session yet; the old Tauri commands stay
//! untouched until the host can take them over.

use std::{
    collections::HashMap,
    convert::Infallible,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

mod artifacts;
pub mod control;
mod environment;
pub mod events;
mod files;
pub mod models;
pub mod runtime;
pub mod sessions_repair;
pub mod session;

use session::{ApiError, CreateRequest, SendRequest, SessionManager};

use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    middleware::Next,
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Redirect, Response,
    },
    routing::get,
    Json, Router,
};
use chrono::{DateTime, SecondsFormat, Utc};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{io::AsyncReadExt, sync::broadcast};

pub const COOKIE_NAME: &str = "jouzu_host";
pub const HOST_SCHEMA: u32 = 1;

#[derive(Clone)]
pub struct AppState {
    pub token: Arc<String>,
    pub port: u16,
    pub dist: PathBuf,
    pub started: Instant,
    pub version: String,
    pub sessions: Arc<SessionManager>,
    pub control: Arc<control::ControlManager>,
    pub events: Arc<events::EventHub>,
    pub models: Arc<models::Models>,
}

#[derive(Debug, Serialize)]
pub struct HostInfo {
    pub schema: u32,
    #[serde(rename = "hostVersion")]
    pub host_version: String,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
}

/// The directory the host writes `host.json` and logs into.
pub fn host_home() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("JOUZU_HOST_HOME") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok(PathBuf::from(local).join("Shisa.ai").join("JouzuDesktop"))
}

pub fn host_lock_path(home: &Path) -> PathBuf {
    home.join("host.lock")
}

/// An exclusively held marker for the process lifetime. The handle is opened
/// without read/write sharing on Windows, so a second host cannot acquire it;
/// FILE_SHARE_DELETE lets this process remove the file on clean exit.
#[derive(Debug)]
pub struct HostLock {
    path: PathBuf,
    file: Option<std::fs::File>,
}

impl HostLock {
    pub fn acquire(home: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(home)
            .map_err(|error| format!("Cannot create host home: {error}"))?;
        let path = host_lock_path(home);
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_SHARE_DELETE only: no other process may read or write it.
            options.share_mode(0x00000004);
        }
        match options.open(&path) {
            Ok(file) => Ok(Self {
                path,
                file: Some(file),
            }),
            Err(error) if is_locked(&error) => Err(live_host_message(home)),
            Err(error) => Err(format!("Cannot lock {}: {error}", path.display())),
        }
    }
}

impl Drop for HostLock {
    fn drop(&mut self) {
        // The file is open with FILE_SHARE_DELETE, so removing it while held is safe.
        let _ = std::fs::remove_file(&self.path);
        self.file.take();
    }
}

fn is_locked(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        matches!(error.raw_os_error(), Some(32) | Some(33))
    }
    #[cfg(not(windows))]
    {
        let _ = error;
        false
    }
}

fn live_host_message(home: &Path) -> String {
    let info = std::fs::read(host_file_path(home))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    match info {
        Some(value) => format!(
            "Another jouzu-host is already running (pid {}, port {}). Stop it before starting a new one.",
            value.get("pid").and_then(Value::as_u64).unwrap_or(0),
            value.get("port").and_then(Value::as_u64).unwrap_or(0)
        ),
        None => "Another jouzu-host is already starting. Stop it before starting a new one.".to_string(),
    }
}
pub fn host_file_path(home: &Path) -> PathBuf {
    home.join("host.json")
}

pub fn write_host_file(
    home: &Path,
    port: u16,
    token: &str,
    version: &str,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(home).map_err(|error| format!("Cannot create host home: {error}"))?;
    let info = HostInfo {
        schema: HOST_SCHEMA,
        host_version: version.to_string(),
        pid: std::process::id(),
        port,
        token: token.to_string(),
        started_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let path = host_file_path(home);
    let bytes = serde_json::to_vec_pretty(&info).map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| format!("Cannot write host.json: {error}"))?;
    Ok(path)
}

/// Removes the discovery file only when it still names this process and token.
pub fn remove_host_file(home: &Path, token: &str) {
    let path = host_file_path(home);
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    if value.get("pid").and_then(Value::as_u64) != Some(std::process::id() as u64) {
        return;
    }
    if value.get("token").and_then(Value::as_str) != Some(token) {
        return;
    }
    let _ = std::fs::remove_file(path);
}

/// One JSON line per event. Callers never pass secrets (the token is not logged).
pub fn log(home: &Path, level: &str, event: &str, fields: Value) {
    let path = home.join("logs");
    if std::fs::create_dir_all(&path).is_err() {
        return;
    }
    let record = json!({
        "ts": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "level": level,
        "event": event,
        "fields": fields,
    });
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.join("host.log"))
    {
        let _ = writeln!(file, "{record}");
    }
}

pub fn new_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/status", get(host_status))
        .route(
            "/environment",
            get(read_environment).put(save_environment),
        )
        .route("/capabilities", get(capabilities))
        .route("/control", axum::routing::post(control_request))
        .route("/control/cancel", axum::routing::post(control_cancel))
        .route("/control/events", get(control_events))
        .route("/events", get(global_events))
        .route("/models", get(models))
        .route("/models/refresh", axum::routing::post(refresh_models))
        .route("/tools", get(tools_snapshot).put(update_tools))
        .route("/tools/providers", get(tool_providers))
        .route("/tools/models", get(tool_models))
        .route("/mcp", get(mcp_snapshot))
        .route(
            "/workspaces",
            get(list_workspaces).post(add_workspaces),
        )
        .route(
            "/workspaces/forget",
            axum::routing::post(forget_workspace),
        )
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/persisted", get(persisted_sessions))
        .route("/sessions/flow", get(session_flow))
        .route("/sessions/timing", get(session_timing))
        .route("/sessions/history", get(history_preview))
        .route(
            "/sessions/branch",
            axum::routing::post(branch_session),
        )
        .route(
            "/sessions/recover",
            axum::routing::post(recover_session),
        )
        .route(
            "/sessions/update",
            axum::routing::post(update_session),
        )
        .route("/artifacts", get(list_artifacts))
        .route("/artifacts/counts", get(artifact_counts))
        .route(
            "/artifacts/{id}",
            get(read_artifact).delete(delete_artifact),
        )
        .route("/files", get(list_files))
        .route("/files/snapshot", get(snapshot_files))
        .route("/files/read", get(read_file))
        .route("/sessions/sanitize-images", axum::routing::post(sanitize_session_images))
        .route("/sessions/stop-all", axum::routing::post(stop_all_sessions))
        .route("/sessions/{id}", get(get_session))
        .route(
            "/sessions/{id}/messages",
            get(history).post(send_message),
        )
        .route(
            "/sessions/{id}/model",
            axum::routing::post(select_session_model),
        )
        .route(
            "/sessions/{id}/thinking",
            axum::routing::post(select_session_thinking),
        )
        .route(
            "/sessions/{id}/interrupt",
            axum::routing::post(interrupt_session),
        )
        .route(
            "/sessions/{id}/cancel",
            axum::routing::post(cancel_session),
        )
        .route(
            "/sessions/{id}/queue",
            axum::routing::post(queue_session),
        )
        .route("/sessions/{id}/stop", axum::routing::post(stop_session))
        .route(
            "/sessions/{id}/command",
            axum::routing::post(session_command),
        )
        .route("/sessions/{id}/events", get(session_events))
        .route(
            "/approvals/{id}/decision",
            axum::routing::post(decide_approval),
        )
        .route(
            "/questions/{id}/answer",
            axum::routing::post(answer_question),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ));

    Router::new()
        .route("/", get(root))
        .nest("/v1", api)
        .fallback(get(static_file))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            desktop_cors,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            host_origin_guard,
        ))
        .with_state(state)
}

#[derive(Deserialize)]
struct ArtifactQuery {
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

async fn list_artifacts(
    State(state): State<AppState>,
    Query(query): Query<ArtifactQuery>,
) -> Json<Value> {
    Json(artifacts::list(
        state.sessions.runtime_home(),
        query.kind.as_deref(),
        query.session_id.as_deref(),
    ))
}

async fn artifact_counts(State(state): State<AppState>) -> Json<Value> {
    Json(artifacts::counts(state.sessions.runtime_home()))
}

async fn read_artifact(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    artifacts::read(state.sessions.runtime_home(), &id)
        .map(Json)
        .map_err(|message| ApiError::new(StatusCode::NOT_FOUND, "artifact-not-found", message, false))
}

async fn delete_artifact(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    artifacts::delete(state.sessions.runtime_home(), &id)
        .map(|()| Json(json!({ "status": "deleted" })))
        .map_err(|message| ApiError::new(StatusCode::NOT_FOUND, "artifact-not-found", message, false))
}

#[derive(Deserialize)]
struct FilesQuery {
    path: String,
}

async fn snapshot_files(
    Query(query): Query<FilesQuery>,
) -> Result<Json<Value>, ApiError> {
    files::snapshot(&query.path).map(Json).map_err(|message| {
        ApiError::bad_request(message)
    })
}

async fn list_files(
    State(state): State<AppState>,
    Query(query): Query<FilesQuery>,
) -> Result<Json<Value>, ApiError> {
    if !state.sessions.workspace_allowed(&query.path) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "That folder is outside the allowed workspaces",
            false,
        ));
    }
    files::list(&query.path)
        .map(Json)
        .map_err(|message| ApiError::bad_request(message))
}

async fn read_file(
    Query(query): Query<FilesQuery>,
) -> Result<Json<Value>, ApiError> {
    files::read(&query.path)
        .map(Json)
        .map_err(|message| ApiError::bad_request(message))
}

#[derive(serde::Deserialize)]
struct SessionFilePath {
    sessionPath: String,
}

async fn sanitize_session_images(
    Json(body): Json<SessionFilePath>,
) -> Result<Json<Value>, ApiError> {
    sessions_repair::sanitize_images(&body.sessionPath)
        .map(Json)
        .map_err(|message| ApiError::bad_request(message))
}

async fn stop_all_sessions(State(state): State<AppState>) -> Json<Value> {
    state.sessions.stop_all();
    Json(json!({ "stopped": true }))
}

async fn list_workspaces(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "workspaces": state.sessions.workspaces() }))
}

#[derive(Deserialize)]
struct AddWorkspacesRequest {
    #[serde(default)]
    paths: Vec<String>,
}

async fn add_workspaces(
    State(state): State<AppState>,
    Json(request): Json<AddWorkspacesRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "workspaces": state.sessions.add_workspaces(&request.paths)?,
    })))
}

#[derive(Deserialize)]
struct ForgetWorkspaceRequest {
    id: String,
}

async fn forget_workspace(
    State(state): State<AppState>,
    Json(request): Json<ForgetWorkspaceRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "workspaces": state.sessions.forget_workspace(&request.id)?,
    })))
}

async fn list_sessions(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "sessions": state.sessions.list() }))
}

#[derive(Deserialize)]
struct PersistedQuery {
    #[serde(rename = "workspacePath")]
    workspace_path: Option<String>,
    #[serde(default)]
    refresh: Option<String>,
}

async fn persisted_sessions(
    State(state): State<AppState>,
    Query(query): Query<PersistedQuery>,
) -> Json<Value> {
    let refresh = query
        .refresh
        .as_deref()
        .is_some_and(|value| value == "1" || value == "true");
    Json(json!({
        "sessions": state
            .sessions
            .persisted(query.workspace_path.as_deref(), refresh),
    }))
}

#[derive(Deserialize)]
struct UpdateSessionRequest {
    #[serde(rename = "sessionPath")]
    session_path: String,
    pinned: Option<bool>,
    archived: Option<bool>,
    title: Option<String>,
}

async fn update_session(
    State(state): State<AppState>,
    Json(request): Json<UpdateSessionRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(state.sessions.update_session(
        &request.session_path,
        request.pinned,
        request.archived,
        request.title,
    )?))
}

#[derive(Deserialize)]
struct SessionPathQuery {
    #[serde(rename = "sessionPath")]
    session_path: String,
}

async fn session_flow(
    State(state): State<AppState>,
    Query(query): Query<SessionPathQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "reports": state.sessions.flow_reports(&query.session_path)?,
    })))
}

async fn session_timing(
    State(state): State<AppState>,
    Query(query): Query<SessionPathQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "timing": state.sessions.timing(&query.session_path)?,
    })))
}

#[derive(Deserialize)]
struct MessagesQuery {
    #[serde(rename = "sessionPath")]
    session_path: String,
    limit: Option<usize>,
}

async fn history_preview(
    State(state): State<AppState>,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "messages": state
            .sessions
            .messages(&query.session_path, query.limit)?,
    })))
}

#[derive(Deserialize)]
struct BranchRequest {
    #[serde(rename = "sessionPath")]
    session_path: String,
    #[serde(rename = "messageIndex")]
    message_index: usize,
}

async fn branch_session(
    State(state): State<AppState>,
    Json(request): Json<BranchRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "sessionPath": state
            .sessions
            .branch_session(&request.session_path, request.message_index)?,
    })))
}

#[derive(Deserialize)]
struct RecoverRequest {
    #[serde(rename = "sessionPath")]
    session_path: String,
}

async fn recover_session(
    State(state): State<AppState>,
    Json(request): Json<RecoverRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "sessionPath": state.sessions.recover_session(&request.session_path)?,
    })))
}

async fn create_session(
    State(state): State<AppState>,
    Json(request): Json<CreateRequest>,
) -> Result<Response, ApiError> {
    let session = if request.session_path.is_none() {
        state.sessions.create_pending(
            &request.workspace_path,
            request.session_path,
            request.key,
        )?
    } else {
        state
            .sessions
            .create(&request.workspace_path, request.session_path, request.key)?
    };
    let mut response = (
        StatusCode::ACCEPTED,
        Json(json!({
            "sessionId": session.id,
            "status": session.status().as_str(),
            "cursor": session.cursor(),
        })),
    )
        .into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&format!("/v1/sessions/{}", session.id))
            .unwrap_or_else(|_| HeaderValue::from_static("/v1/sessions")),
    );
    Ok(response)
}

async fn get_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    Ok(Json(session.info()))
}

async fn send_message(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<SendRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let value = session.send_with_client(
        &request.client_message_id,
        &request.text,
        request.client_id.as_deref(),
        &request.attachments,
    )?;
    Ok((StatusCode::ACCEPTED, Json(value)))
}

#[derive(Deserialize)]
struct SessionModelRequest {
    provider: String,
    model: String,
}

async fn select_session_model(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<SessionModelRequest>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let model = session
        .select_model(&request.provider, &request.model)
        .await?;
    Ok(Json(json!({ "model": model })))
}

#[derive(Deserialize)]
struct SessionThinkingRequest {
    level: String,
}

async fn select_session_thinking(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<SessionThinkingRequest>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    session.select_thinking(&request.level).await?;
    Ok(Json(json!({ "level": request.level })))
}

async fn session_command(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(command): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let data = session
        .request(command, Duration::from_secs(30))
        .await?;
    Ok(Json(json!({ "data": data })))
}

async fn interrupt_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    session.interrupt()?;
    Ok(Json(json!({ "status": session.status().as_str() })))
}

async fn cancel_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<CancelRequest>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    Ok(Json(session.cancel_message(&request.client_message_id)?))
}

async fn queue_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<QueueRequest>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    match request.action.as_str() {
        "continue" => Ok(Json(session.continue_queue()?)),
        "discard" => Ok(Json(session.discard_queue()?)),
        "retry" => Ok(Json(session.retry_failed()?)),
        _ => Err(ApiError::bad_request("queue action must be continue, discard or retry")),
    }
}

#[derive(Deserialize)]
struct QueueRequest {
    action: String,
}

#[derive(Deserialize)]
struct CancelRequest {
    #[serde(rename = "clientMessageId")]
    client_message_id: String,
}

async fn stop_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    session.stop();
    Ok(Json(json!({ "status": "stopped" })))
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(rename = "clientId")]
    client_id: Option<String>,
    capabilities: Option<String>,
    after: Option<u64>,
}

#[derive(Deserialize)]
struct DecisionRequest {
    #[serde(rename = "clientId")]
    client_id: String,
    decision: String,
}

#[derive(Deserialize)]
struct AnswerRequest {
    #[serde(rename = "clientId")]
    client_id: String,
    answers: HashMap<String, String>,
}

async fn decide_approval(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<DecisionRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.client_id.trim().is_empty() {
        return Err(ApiError::bad_request("clientId is required"));
    }
    if !state.sessions.client_can_prompt(&request.client_id) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "prompt-forbidden",
            "Client lacks the prompts capability",
            false,
        ));
    }
    let value = state
        .sessions
        .decide_approval(&id, &request.client_id, &request.decision)?;
    Ok(Json(value))
}

async fn answer_question(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<AnswerRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.client_id.trim().is_empty() {
        return Err(ApiError::bad_request("clientId is required"));
    }
    if !state.sessions.client_can_prompt(&request.client_id) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "prompt-forbidden",
            "Client lacks the prompts capability",
            false,
        ));
    }
    let value = state
        .sessions
        .answer_question(&id, &request.client_id, &request.answers)?;
    Ok(Json(value))
}

struct SseClientGuard {
    session: Arc<session::Session>,
    attach: u64,
    client_id: String,
}

impl Drop for SseClientGuard {
    fn drop(&mut self) {
        self.session.leave_client(self.attach, &self.client_id);
    }
}

async fn session_events(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let client_id = query
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("clientId is required"))?
        .to_string();
    let capabilities: Vec<String> = query
        .capabilities
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect();
    state.sessions.register_client(&client_id, &capabilities);
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let attach = session.join_client(&client_id, &capabilities);
    let guard = SseClientGuard {
        session: session.clone(),
        attach,
        client_id: client_id.clone(),
    };
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .or(query.after)
        .unwrap_or(0);
    let mut receiver = session.subscribe();
    let (initial, mut last) = session.events_after(after);
    let stream = async_stream::stream! {
        let _guard = guard;
        for event in initial {
            last = event.id;
            yield Ok::<_, Infallible>(sse_event(event));
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event.id > last => {
                    last = event.id;
                    yield Ok::<_, Infallible>(sse_event(event));
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let snapshot = session.snapshot_event();
                    last = snapshot.id;
                    yield Ok::<_, Infallible>(sse_event(snapshot));
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}

fn sse_event(event: session::SessionEvent) -> SseEvent {
    SseEvent::default()
        .id(event.id.to_string())
        .event(event.event)
        .data(serde_json::to_string(&event.data).unwrap_or_else(|_| "{}".to_string()))
}

async fn control_request(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    state.control.request(body).await.map(Json)
}

#[derive(Deserialize)]
struct ControlCancelRequest {
    #[serde(rename = "requestId")]
    request_id: Option<String>,
}

async fn control_cancel(
    State(state): State<AppState>,
    body: Option<Json<ControlCancelRequest>>,
) -> StatusCode {
    let requested = body.and_then(|Json(body)| body.request_id);
    state.control.cancel(requested.as_deref());
    StatusCode::NO_CONTENT
}

/// Control progress and cancel results. Same envelope as session events so one client
/// reader can consume both.
async fn control_events(
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Response {
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .or(query.after)
        .unwrap_or(0);
    let mut receiver = state.control.subscribe();
    let (initial, mut last) = state.control.events_after(after);
    let control = state.control.clone();
    let stream = async_stream::stream! {
        for event in initial {
            last = event.seq;
            yield Ok::<_, Infallible>(control_sse_event(event));
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event.seq > last => {
                    last = event.seq;
                    yield Ok::<_, Infallible>(control_sse_event(event));
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let (missed, _) = control.events_after(last);
                    for event in missed {
                        last = event.seq;
                        yield Ok::<_, Infallible>(control_sse_event(event));
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

fn control_sse_event(event: control::ControlEvent) -> SseEvent {
    SseEvent::default()
        .id(event.seq.to_string())
        .event(event.event)
        .data(serde_json::to_string(&event.data).unwrap_or_else(|_| "{}".to_string()))
}

/// One stream for every session and control event. The UI no longer opens a
/// connection per session; `Last-Event-ID` resumes from the hub ring.
async fn global_events(
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Response {
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .or(query.after)
        .unwrap_or(0);
    // The global stream is the production path for every client: register the
    // client's capabilities here too, or prompt answers are refused (403).
    if let Some(client_id) = query
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let capabilities: Vec<String> = query
            .capabilities
            .as_deref()
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect();
        state.sessions.register_client(client_id, &capabilities);
    }
    let global_guard = state.sessions.enter_global_client();
    let latest = state.events.latest_seq();
    let summaries = state.sessions.summaries();
    let sessions = state.sessions.clone();
    let mut receiver = state.events.subscribe();
    let events = state.events.clone();
    let stream = async_stream::stream! {
        let _global_guard = global_guard;
        let mut last = after;
        if after == 0 {
            // A fresh client gets current summaries, not the entire history ring.
            for mut summary in summaries {
                if let Some(object) = summary.as_object_mut() {
                    object.insert("seq".to_string(), json!(latest));
                }
                yield Ok::<_, Infallible>(sse_data("session.updated", latest, summary));
            }
            last = latest;
        } else {
            let (replay, resync, latest) = events.replay_after(after);
            if resync {
                last = latest;
                yield Ok::<_, Infallible>(sse_data(
                    "resync",
                    latest,
                    json!({ "reason": "event-gap", "latestSeq": latest }),
                ));
                for mut summary in sessions.summaries() {
                    if let Some(object) = summary.as_object_mut() {
                        object.insert("seq".to_string(), json!(latest));
                    }
                    yield Ok::<_, Infallible>(sse_data("session.updated", latest, summary));
                }
            } else {
                for event in replay {
                    last = event.seq;
                    yield Ok::<_, Infallible>(hub_sse_event(event));
                }
            }
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event.seq > last => {
                    last = event.seq;
                    yield Ok::<_, Infallible>(hub_sse_event(event));
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let latest = events.latest_seq();
                    last = latest;
                    yield Ok::<_, Infallible>(sse_data(
                        "resync",
                        latest,
                        json!({ "reason": "slow-client", "latestSeq": latest }),
                    ));
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

fn hub_sse_event(event: events::HubEvent) -> SseEvent {
    sse_data(&event.event, event.seq, event.data)
}

fn sse_data(event: &str, seq: u64, data: Value) -> SseEvent {
    SseEvent::default()
        .id(seq.to_string())
        .event(event)
        .data(serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string()))
}

fn session_not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "session-not-found",
        "No such session",
        false,
    )
}

async fn root(State(state): State<AppState>, uri: Uri) -> Response {
    let query = query_map(uri.query().unwrap_or(""));
    if let Some(token) = query.get("token").filter(|value| !value.is_empty()) {
        if token == state.token.as_str() {
            let cookie = format!("{COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/");
            let target = if query.get("ui").map(String::as_str) == Some("host") {
                "/host"
            } else {
                "/"
            };
            let mut response = Redirect::to(target).into_response();
            match HeaderValue::from_str(&cookie) {
                Ok(value) => {
                    response.headers_mut().insert(header::SET_COOKIE, value);
                    response
                }
                Err(_) => unauthorized("Invalid token").into_response(),
            }
        } else {
            unauthorized("Invalid token").into_response()
        }
    } else {
        serve_index(&state).await
    }
}

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "hostVersion": state.version,
        "uptimeSeconds": state.started.elapsed().as_secs(),
    }))
    .into_response()
}

async fn host_status(State(state): State<AppState>) -> Json<Value> {
    Json(state.sessions.status())
}

async fn read_environment(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    environment::read(state.sessions.runtime_home())
        .map(|entries| Json(json!({ "entries": entries })))
        .map_err(ApiError::bad_request)
}

async fn save_environment(
    State(state): State<AppState>,
    Json(entries): Json<Vec<environment::Entry>>,
) -> Result<Json<Value>, ApiError> {
    environment::save(state.sessions.runtime_home(), &entries)
        .map(|()| Json(json!({ "entries": entries })))
        .map_err(ApiError::bad_request)
}

async fn models(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.models.get(&state.control).await.map(Json)
}

/// Jouzu refreshes its catalog, then the host re-reads the snapshot. A failure keeps
/// the previous snapshot and marks it stale.
async fn refresh_models(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state.models.refresh(&state.control).await.map(Json)
}

async fn tools_snapshot(State(state): State<AppState>) -> Json<Value> {
    let path = state.sessions.runtime_home().join("agent").join("tools.json");
    let value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "reviewTools": ["generate_image"] }));
    Json(json!({
        "path": path.to_string_lossy(),
        "exists": path.is_file(),
        "settings": value,
    }))
}

fn normalize_image_tool(value: &Value) -> Result<Value, ApiError> {
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let provider = value
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .ok_or_else(|| ApiError::bad_request("provider is required"))?;
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("");
    if model.len() > 128
        || !model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '/'))
    {
        return Err(ApiError::bad_request("model is invalid"));
    }
    let size = value
        .get("size")
        .and_then(Value::as_str)
        .filter(|size| matches!(*size, "1K" | "2K" | "4K"))
        .unwrap_or("1K");
    let max_images = value
        .get("maxImages")
        .and_then(Value::as_u64)
        .map(|max| max.clamp(1, 10))
        .unwrap_or(3);
    Ok(json!({
        "enabled": enabled,
        "provider": provider,
        "model": model,
        "size": size,
        "maxImages": max_images,
    }))
}

async fn update_tools(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let image = body.get("image").unwrap_or(&body);
    let image = normalize_image_tool(image)?;
    let path = state.sessions.runtime_home().join("agent").join("tools.json");
    let current = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));
    let review = current
        .get("reviewTools")
        .cloned()
        .unwrap_or_else(|| json!(["generate_image"]));
    let value = json!({ "image": image, "reviewTools": review });
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| ApiError::internal(format!("Could not create the tools folder: {error}")))?;
    }
    std::fs::write(&path, format!("{}\n", value))
        .map_err(|error| ApiError::internal(format!("Could not save tools: {error}")))?;
    Ok(Json(value))
}

async fn mcp_snapshot(State(state): State<AppState>) -> Json<Value> {
    let path = state.sessions.runtime_home().join("agent").join("mcp.json");
    let value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "mcpServers": {} }));
    let servers = value
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(name, config)| {
                    let url = config.get("url").and_then(Value::as_str);
                    let command = config.get("command").and_then(Value::as_str);
                    json!({
                        "name": name,
                        "transport": if url.is_some() { "HTTP" } else if command.is_some() { "Local" } else { "Unknown" },
                        "target": url.or(command).unwrap_or("Unknown target"),
                        "description": config.get("description").and_then(Value::as_str),
                        "exposure": config.get("exposure").and_then(Value::as_str).unwrap_or("deferred"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Json(json!({
        "path": path.to_string_lossy(),
        "exists": path.is_file(),
        "servers": servers,
    }))
}

async fn run_image_cli(state: &AppState, args: &[&str]) -> Result<Value, ApiError> {
    let node = state.sessions.node_executable().ok_or_else(|| {
        ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "runtime-unavailable",
            "The runtime is not installed yet",
            true,
        )
    })?;
    let home = state.sessions.runtime_home().to_path_buf();
    let script = home
        .join("agent")
        .join("extensions")
        .join("jouzu-image")
        .join("index.js");
    if !script.is_file() {
        return Err(ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "tools-unavailable",
            "The image tool is not installed yet",
            true,
        ));
    }
    let mut command = tokio::process::Command::new(node);
    command
        .arg(&script)
        .args(args)
        .env("JOUZU_HOME", &home)
        .env("PI_CODING_AGENT_DIR", home.join("agent"))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), command.output())
        .await
        .map_err(|_| {
            ApiError::new(
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                "tools-timeout",
                "The image tool did not answer in time",
                true,
            )
        })?
        .map_err(|_| ApiError::internal("The image tool could not be started"))?;
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "tools-error",
            "The image tool returned an unexpected answer",
            true,
        )
    })?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "tools-error",
            error,
            true,
        ));
    }
    Ok(value)
}

async fn tool_providers(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    run_image_cli(&state, &["--providers"]).await.map(Json)
}

#[derive(Deserialize)]
struct ToolProviderQuery {
    provider: String,
}

async fn tool_models(
    State(state): State<AppState>,
    Query(query): Query<ToolProviderQuery>,
) -> Result<Json<Value>, ApiError> {
    run_image_cli(&state, &["--models", &query.provider])
        .await
        .map(Json)
}

async fn capabilities(State(state): State<AppState>) -> Json<Value> {
    let default_workspace = default_workspace();
    Json(json!({
        "contract": "2026-11-12",
        "hostVersion": state.version,
        "runtimeKind": crate::runtime::adapter::pi::KIND,
        "features": ["chat", "sse", "replay", "prompts", "history-paging", "history-blocks", "models", "control", "tools", "mcp", "recovery", "deferred-sessions"],
        "scopes": ["loopback"],
        "limits": { "maxMessageBytes": 32768, "maxUploadBytes": 26214400 },
        "defaultWorkspace": default_workspace,
    }))
}

fn default_workspace() -> Option<String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let base = if cfg!(windows) {
        PathBuf::from(home).join("Documents")
    } else {
        PathBuf::from(home)
    };
    let path = base.join("Jouzu").join("default-workspace");
    std::fs::create_dir_all(&path).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
struct HistoryQuery {
    limit: Option<usize>,
    before: Option<u64>,
}

async fn history(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    Ok(Json(session.history(query.limit.unwrap_or(200), query.before)))
}

async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if authorized(&state, request.headers()) {
        next.run(request).await
    } else {
        unauthorized("A valid host token is required").into_response()
    }
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(token) = value.strip_prefix("Bearer ") {
            if token == state.token.as_str() {
                return true;
            }
        }
    }
    cookie_token(headers).is_some_and(|token| token == *state.token)
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookies.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix(&format!("{COOKIE_NAME}=")) {
            return Some(value.to_string());
        }
    }
    None
}

async fn host_origin_guard(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if allowed_host(&state, request.headers()) && allowed_origin(&state, request.headers()) {
        next.run(request).await
    } else {
        (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": { "code": "forbidden", "message": "Unknown Host or Origin", "retryable": false }
            })),
        )
            .into_response()
    }
}

fn allowed_host(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == format!("127.0.0.1:{}", state.port)
        || host == format!("localhost:{}", state.port)
        || host == format!("[::1]:{}", state.port)
}

fn allowed_origin(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    let origin = origin.to_ascii_lowercase();
    let allowed = [
        format!("http://127.0.0.1:{}", state.port),
        format!("http://localhost:{}", state.port),
        format!("http://[::1]:{}", state.port),
    ];
    allowed.iter().any(|value| value == &origin) || desktop_origin(&origin)
}

/// The desktop webview loads a local build; its origin is trusted for the data API
/// and nothing else. Remote pages are never trusted here.
fn desktop_origin(origin: &str) -> bool {
    matches!(origin, "tauri://localhost" | "http://tauri.localhost")
        // The dev shell loads Vite from 1420 while the host keeps its own origin.
        // Only debug builds accept that extra loopback origin.
        || (cfg!(debug_assertions)
            && matches!(
                origin,
                "http://localhost:1420"
                    | "http://127.0.0.1:1420"
                    | "http://localhost:1430"
                    | "http://127.0.0.1:1430"
            ))
}

fn apply_cors(response: &mut Response, origin: String) {
    if let Ok(value) = HeaderValue::from_str(&origin) {
        response.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    response.headers_mut().insert(header::VARY, HeaderValue::from_static("origin"));
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type, last-event-id"),
    );
}

/// Answer the desktop webview preflight and label its responses. The host guard and
/// the token still decide every request.
async fn desktop_cors(
    _state: State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| desktop_origin(value));
    if request.method() == axum::http::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        if let Some(origin) = origin {
            apply_cors(&mut response, origin);
        }
        return response;
    }
    let mut response = next.run(request).await;
    if let Some(origin) = origin {
        apply_cors(&mut response, origin);
    }
    response
}

struct Unauthorized(&'static str);

impl IntoResponse for Unauthorized {
    fn into_response(self) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": { "code": "unauthorized", "message": self.0, "retryable": true }
            })),
        )
            .into_response()
    }
}

fn unauthorized(message: &'static str) -> Unauthorized {
    Unauthorized(message)
}

async fn serve_index(state: &AppState) -> Response {
    match tokio::fs::read(state.dist.join("index.html")).await {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            [(header::CACHE_CONTROL, "no-cache")],
            bytes,
        )
            .into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "index.html is missing from the dist directory",
        )
            .into_response(),
    }
}

async fn static_file(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path();
    let relative = percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    if relative.is_empty() || relative.ends_with('/') {
        return serve_index(&state).await;
    }
    let Some(file) = safe_join(&state.dist, &relative) else {
        // A client-side route has no extension; anything with one must be a real file.
        if Path::new(&relative).extension().is_none() {
            return serve_index(&state).await;
        }
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    };
    if let Ok(mut handle) = tokio::fs::File::open(&file).await {
        let mut bytes = Vec::new();
        if handle.read_to_end(&mut bytes).await.is_ok() {
            return (
                [(header::CONTENT_TYPE, content_type(&file))],
                [(header::CACHE_CONTROL, "no-cache")],
                bytes,
            )
                .into_response();
        }
    }
    if Path::new(&relative).extension().is_none() {
        serve_index(&state).await
    } else {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

fn safe_join(base: &Path, relative: &str) -> Option<PathBuf> {
    let candidate = Path::new(relative);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    let file = base.join(candidate);
    let base = base.canonicalize().ok()?;
    let file = file.canonicalize().ok()?;
    file.starts_with(&base).then_some(file)
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn query_map(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter_map(|part| {
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            Some((
                percent_decode_str(key).decode_utf8_lossy().into_owned(),
                percent_decode_str(value).decode_utf8_lossy().into_owned(),
            ))
        })
        .collect()
}

/// RFC3339 timestamp for the discovery file; exported for tests.
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[allow(dead_code)]
fn _keep_imports(_: DateTime<Utc>, _: Body) {}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn control_manager(home: &Path) -> Arc<control::ControlManager> {
        Arc::new(
            control::ControlManager::new(home, home, home, &home.join("data"), None)
                .expect("control manager"),
        )
    }

    fn state(dist: PathBuf) -> AppState {
        AppState {
            token: Arc::new("a".repeat(64)),
            port: 40123,
            dist: dist.clone(),
            started: Instant::now(),
            version: "0.1.0".to_string(),
            sessions: Arc::new(SessionManager::new(
                None,
                dist.clone(),
                dist.clone(),
                None,
                10,
                None,
            )),
            control: control_manager(&dist),
            events: events::EventHub::new(),
            models: Arc::new(models::Models::new(&dist)),
        }
    }

    fn dist() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<html>Jouzu Host</html>").unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/app.js"), "console.log(1)").unwrap();
        dir
    }

    async fn call(app: Router, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    fn get(path: &str, host: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn api_requires_a_token() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let (status, _, body) = call(app, get("/v1/health", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("unauthorized"));
    }

    #[tokio::test]
    async fn bearer_and_cookie_are_accepted() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let request = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, _, body) = call(app.clone(), request).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("\"status\":\"ok\""));

        let request = Request::builder()
            .uri("/v1/sessions")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::COOKIE, format!("{COOKIE_NAME}={}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, _, body) = call(app, request).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("\"sessions\":[]"));
    }

    #[tokio::test]
    async fn token_is_exchanged_for_a_cookie_and_redirect() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let path = format!("/?token={}", "a".repeat(64));
        let (status, headers, _) = call(app.clone(), get(&path, "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(headers.get(header::LOCATION).unwrap(), "/");
        let cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));

        let bad = call(app, get("/?token=wrong", "127.0.0.1:40123")).await;
        assert_eq!(bad.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn spa_and_assets_are_served() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let (status, headers, body) = call(app.clone(), get("/", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Jouzu Host"));
        assert!(headers
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html"));

        let (status, headers, body) =
            call(app.clone(), get("/assets/app.js", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("console.log"));
        assert!(headers
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/javascript"));

        let (status, _, body) =
            call(app, get("/sessions/some-client-route", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Jouzu Host"));
    }

    #[tokio::test]
    async fn unknown_host_and_origin_are_rejected() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let (status, _, body) = call(app.clone(), get("/", "evil.example:40123")).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("forbidden"));

        let request = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::ORIGIN, "http://evil.example")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, _, _) = call(app.clone(), request).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let request = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::ORIGIN, "http://localhost:1420")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, headers, _) = call(app.clone(), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|value| value.to_str().ok()),
            Some("http://localhost:1420")
        );

        let request = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::ORIGIN, "http://127.0.0.1:1430")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, headers, _) = call(app.clone(), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|value| value.to_str().ok()),
            Some("http://127.0.0.1:1430")
        );

        let request = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::ORIGIN, "http://127.0.0.1:40123")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, _, _) = call(app, request).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[test]
    fn host_file_has_the_contract_shape_and_replaces_a_stale_file() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            host_file_path(home.path()),
            r#"{"schema":1,"hostVersion":"0.0.0","pid":1,"port":1,"token":"old","startedAt":"x"}"#,
        )
        .unwrap();
        let path = write_host_file(home.path(), 40123, &"a".repeat(64), "0.1.0").unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(value["schema"], 1);
        assert_eq!(value["hostVersion"], "0.1.0");
        assert_eq!(value["port"], 40123);
        assert_eq!(value["token"], "a".repeat(64));
        assert!(value["startedAt"].as_str().unwrap().contains('T'));

        remove_host_file(home.path(), &"a".repeat(64));
        assert!(!host_file_path(home.path()).exists());
    }

    #[test]
    fn logging_never_contains_the_token() {
        let home = tempfile::tempdir().unwrap();
        log(home.path(), "info", "start", json!({ "port": 40123 }));
        let text = std::fs::read_to_string(home.path().join("logs/host.log")).unwrap();
        assert!(text.contains("\"event\":\"start\""));
        assert!(!text.contains(&"a".repeat(64)));
    }

    #[tokio::test]
    async fn wrong_bearer_is_rejected() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let request = Request::builder()
            .uri("/v1/health")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::AUTHORIZATION, format!("Bearer {}", "b".repeat(64)))
            .body(Body::empty())
            .unwrap();
        let (status, _, body) = call(app, request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains("unauthorized"));
    }

    #[tokio::test]
    async fn a_bad_query_token_sets_no_cookie() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let (status, headers, _) = call(app, get("/?token=wrong", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(headers.get(header::SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn path_traversal_never_serves_files_outside_dist() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        for path in [
            "/../host.json",
            "/%2e%2e/host.json",
            "/assets/%2e%2e/%2e%2e/host.json",
            "/assets/..%2f..%2fhost.json",
        ] {
            let (status, _, body) = call(app.clone(), get(path, "127.0.0.1:40123")).await;
            assert!(
                status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN,
                "{path} returned {status}"
            );
            assert!(!body.contains("hostVersion"), "{path} leaked a file");
        }
    }

    #[tokio::test]
    async fn a_missing_asset_is_404_but_the_spa_still_falls_back() {
        let dir = dist();
        let app = router(state(dir.path().to_path_buf()));
        let (status, _, _) = call(app.clone(), get("/assets/missing.js", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, body) = call(app, get("/no/such/route", "127.0.0.1:40123")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Jouzu Host"));
    }

    #[test]
    fn a_live_lock_refuses_a_second_host_and_keeps_host_json() {
        let home = tempfile::tempdir().unwrap();
        write_host_file(home.path(), 40123, &"b".repeat(64), "0.1.0").unwrap();
        let first = HostLock::acquire(home.path()).unwrap();
        let before = std::fs::read(host_file_path(home.path())).unwrap();
        let error = HostLock::acquire(home.path()).unwrap_err();
        assert!(error.contains("already running"), "{error}");
        assert!(error.contains("40123"), "{error}");
        let after = std::fs::read(host_file_path(home.path())).unwrap();
        assert_eq!(before, after);
        drop(first);
        assert!(!host_lock_path(home.path()).exists());
    }

    #[test]
    fn a_stale_lock_is_replaced_and_removed_on_exit() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(host_lock_path(home.path()), b"").unwrap();
        let lock = HostLock::acquire(home.path()).unwrap();
        assert!(host_lock_path(home.path()).exists());
        drop(lock);
        assert!(!host_lock_path(home.path()).exists());
    }

    #[test]
    fn clean_exit_removes_host_json_and_lock() {
        let home = tempfile::tempdir().unwrap();
        let token = "c".repeat(64);
        write_host_file(home.path(), 40124, &token, "0.1.0").unwrap();
        let lock = HostLock::acquire(home.path()).unwrap();
        assert!(host_file_path(home.path()).exists());
        assert!(host_lock_path(home.path()).exists());
        remove_host_file(home.path(), &token);
        assert!(!host_file_path(home.path()).exists());
        drop(lock);
        assert!(!host_lock_path(home.path()).exists());
    }
    #[test]
    fn only_one_of_two_concurrent_acquires_wins() {
        let home = std::sync::Arc::new(tempfile::tempdir().unwrap().keep());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let home = home.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                HostLock::acquire(&home)
            }));
        }
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        drop(results);
        let _ = std::fs::remove_dir_all(home.as_path());
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::session::{Attachment, RuntimeSpec, SessionManager, Status};
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use std::{
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };
    use tokio::sync::mpsc;
    use tower::ServiceExt;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("fake-runtime.mjs")
    }

    fn manager_with_spec(
        spec: RuntimeSpec,
        replay: usize,
    ) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = Arc::new(SessionManager::new(
            Some(spec),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            replay,
            None,
        ));
        (manager, home, workspace)
    }

    fn manager_with_env(
        replay: usize,
        env: &[(&str, &str)],
    ) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        let mut spec = RuntimeSpec::node_script(&fixture());
        spec.env.extend(
            env.iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        );
        manager_with_spec(spec, replay)
    }

    #[cfg(windows)]
    fn kill_tree(pid: u32) {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    #[cfg(unix)]
    fn kill_tree(pid: u32) {
        let _ = std::process::Command::new("pkill")
            .args(["-KILL", "-P", &pid.to_string()])
            .output();
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .output();
    }

    async fn wait_until<F>(mut check: F)
    where
        F: FnMut() -> bool,
    {
        for _ in 0..240 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("condition was not reached");
    }

    fn slow_manager(replay: usize) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        let mut spec = RuntimeSpec::node_script(&fixture());
        spec.env
            .push(("FAKE_RUNTIME_START_DELAY_MS".into(), "2000".into()));
        manager_with_spec(spec, replay)
    }

    fn manager(replay: usize) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        manager_with_spec(RuntimeSpec::node_script(&fixture()), replay)
    }

    fn app(manager: Arc<SessionManager>) -> Router {
        let home = std::env::temp_dir();
        AppState {
            token: Arc::new("a".repeat(64)),
            port: 40123,
            dist: home.clone(),
            started: Instant::now(),
            version: "0.1.0".to_string(),
            sessions: manager,
            control: Arc::new(control::ControlManager::new(&home, &home, &home, &home.join("data"), None).expect("control manager")),
            events: events::EventHub::new(),
            models: Arc::new(models::Models::new(&home)),
        }
        .pipe(router)
    }

    trait Pipe: Sized {
        fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
            f(self)
        }
    }
    impl Pipe for AppState {}

    fn request(method: Method, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::AUTHORIZATION, format!("Bearer {}", "a".repeat(64)))
    }

    async fn call(app: Router, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, headers, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn capabilities_report_the_phase_c_contract() {
        let (manager, _home, _workspace) = manager(50);
        let app = app(manager);
        let response = call(
            app,
            request(Method::GET, "/v1/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        let body: Value = serde_json::from_str(&response.2).unwrap();
        assert_eq!(body["contract"], "2026-11-12");
        assert_eq!(body["runtimeKind"], "pi");
        assert!(body["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "recovery"));
    }

    #[tokio::test]
    async fn a_slow_spawn_does_not_block_health_or_list() {
        let (manager, _home, workspace) = slow_manager(50);
        let app = app(manager);
        let body = json!({ "workspacePath": workspace.path() });
        let created = call(
            app.clone(),
            request(Method::POST, "/v1/sessions")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await;
        assert_eq!(created.0, StatusCode::ACCEPTED, "{}", created.2);

        let started = Instant::now();
        let health = call(
            app.clone(),
            request(Method::GET, "/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(health.0, StatusCode::OK, "{}", health.2);
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "health took {:?}",
            started.elapsed()
        );

        let started = Instant::now();
        let list = call(
            app,
            request(Method::GET, "/v1/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(list.0, StatusCode::OK, "{}", list.2);
        assert!(
            started.elapsed() < Duration::from_millis(250),
            "list took {:?}",
            started.elapsed()
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_crashed_idle_runtime_recovers_without_restart() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let previous = session.runtime_pid().expect("runtime pid");
        kill_tree(previous);
        wait_until(|| {
            session.status() == Status::Idle
                && session.runtime_pid().is_some_and(|pid| pid != previous)
        })
        .await;
        assert_eq!(session.status(), Status::Idle);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_crash_during_a_turn_keeps_one_user_message() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("client-1", "hello").unwrap();
        wait_status(&session, Status::Running).await;
        let previous = session.runtime_pid().expect("runtime pid");
        kill_tree(previous);
        wait_until(|| {
            session.status() == Status::Idle
                && session.runtime_pid().is_some_and(|pid| pid != previous)
        })
        .await;
        let history = session.history(200, None);
        let users = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["kind"] == "user")
            .count();
        assert_eq!(users, 1, "{history}");
    }

    #[tokio::test]
    async fn a_restarted_runtime_accepts_a_new_prompt() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("before-crash", "hello").unwrap();
        wait_status(&session, Status::Running).await;
        let previous = session.runtime_pid().expect("runtime pid");
        kill_tree(previous);
        wait_until(|| {
            session.status() == Status::Idle
                && session.runtime_pid().is_some_and(|pid| pid != previous)
        })
        .await;
        let state = session
            .request(json!({ "type": "get_state" }), Duration::from_secs(2))
            .await;
        assert!(state.is_ok(), "recovered runtime did not answer get_state: {state:?}");
        session.send("after-crash", "again").unwrap();
        wait_until(|| {
            session
                .history(50, None)["messages"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| {
                    row["kind"] == "assistant" && row["text"] == "again"
                }))
        })
        .await;
    }

    #[tokio::test]
    async fn a_restart_releases_the_flow_hold_once() {
        let log = tempfile::NamedTempFile::new().unwrap();
        let log_path = log.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) =
            manager_with_env(50, &[
                ("FAKE_RUNTIME_PROMPT_LOG", &log_path),
                ("FAKE_RUNTIME_DELAY_MS", "1000"),
            ]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("before-crash", "hello").unwrap();
        wait_until(|| std::fs::read_to_string(&log_path).is_ok_and(|text| text.contains("hello"))).await;
        let previous = session.runtime_pid().expect("runtime pid");
        kill_tree(previous);
        wait_until(|| {
            session.status() == Status::Idle
                && session.runtime_pid().is_some_and(|pid| pid != previous)
        })
        .await;
        let prompts = std::fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = prompts.lines().collect();
        assert_eq!(lines, vec!["hello", "/flow clear"], "{prompts}");
    }

    #[tokio::test]
    async fn a_queued_follow_up_is_listed_after_the_reply_it_waited_for() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_status(&session, Status::Running).await;
        session.send("second", "two").unwrap();
        wait_until(|| {
            session.status() == Status::Idle
                && session.history(50, None)["messages"]
                    .as_array()
                    .is_some_and(|rows| rows.len() == 4)
        })
        .await;
        let history = session.history(50, None);
        let mut rows: Vec<String> = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| format!("{}:{}", row["kind"].as_str().unwrap_or(""), row["text"].as_str().unwrap_or("")))
            .collect();
        rows.reverse();
        assert_eq!(rows, vec!["user:one", "assistant:one", "user:two", "assistant:two"], "{history}");
        assert!(history["messages"].as_array().unwrap().iter().all(|row| row.get("queued").is_none()));
    }

    #[tokio::test]
    async fn a_queued_follow_up_is_listed_after_the_partial_reply() {
        let (manager, _home, workspace) = manager_with_env(50, &[("FAKE_RUNTIME_DELAY_MS", "150")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| {
            session.history(50, None)["messages"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| row["partial"] == true))
        })
        .await;
        session.send("second", "two").unwrap();
        let history = session.history(50, None);
        let mut rows: Vec<String> = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| format!("{}{}", row["kind"].as_str().unwrap_or(""), if row["partial"] == true { "*" } else { "" }))
            .collect();
        rows.reverse();
        assert_eq!(rows, vec!["user", "assistant*", "user"], "{history}");
    }

    #[tokio::test]
    async fn a_handled_prompt_ends_the_turn_without_a_run() {
        let (manager, _home, workspace) = manager_with_env(50, &[("FAKE_RUNTIME_HANDLED", "1")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("kept-by-flow", "hello").unwrap();
        session.send("kept-again", "next").unwrap();
        // Before the fix the host stayed Running forever after a handled prompt.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(session.status(), Status::Idle);
        let users = session.history(50, None)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["kind"] == "user")
            .count();
        assert_eq!(users, 2);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn repeated_crashes_end_in_error() {
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_EXIT_ON_START_MS", "5")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_until(|| session.status() == Status::Error).await;
        assert_eq!(session.status(), Status::Error);
    }

    #[tokio::test]
    async fn persisted_session_ids_are_stable_and_distinct() {
        let workspace = tempfile::tempdir().unwrap();
        let first = workspace.path().join("first.jsonl");
        let second = workspace.path().join("second.jsonl");
        std::fs::write(&first, "{}\n").unwrap();
        std::fs::write(&second, "{}\n").unwrap();
        let first_id = crate::session::session_id_for_path(first.to_str().unwrap());
        let again = crate::session::session_id_for_path(first.to_str().unwrap());
        let other = crate::session::session_id_for_path(second.to_str().unwrap());
        assert_eq!(first_id, again);
        assert_ne!(first_id, other);
    }

    #[tokio::test]
    async fn garbage_output_is_counted_not_silent() {
        let (manager, _home, workspace) = manager_with_env(50, &[("FAKE_RUNTIME_GARBAGE", "1")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        wait_until(|| session.runtime_parse_errors() > 0).await;
        assert!(session.runtime_parse_errors() > 0);
    }

    #[tokio::test]
    async fn get_state_is_answered_while_streaming() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("client-1", "hello").unwrap();
        let state = session
            .request(json!({ "type": "get_state" }), Duration::from_secs(1))
            .await
            .expect("get_state during streaming");
        assert_eq!(state["model"]["id"], "model");
    }

    #[tokio::test]
    async fn a_hung_runtime_does_not_block_health_or_list() {
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_IGNORE_STDIN", "1")]);
        let manager_for_app = manager.clone();
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let app = app(manager_for_app);

        let started = Instant::now();
        let health = call(
            app.clone(),
            request(Method::GET, "/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(health.0, StatusCode::OK, "{}", health.2);
        assert!(started.elapsed() < Duration::from_millis(250));

        let started = Instant::now();
        let list = call(
            app,
            request(Method::GET, "/v1/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(list.0, StatusCode::OK, "{}", list.2);
        assert!(started.elapsed() < Duration::from_millis(250));

        wait_until(|| {
            matches!(
                session.status(),
                Status::Recovering | Status::Error
            )
        })
        .await;
    }

    #[tokio::test]
    async fn stopping_a_pending_session_cancels_it_without_a_runtime() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        assert_eq!(session.status(), Status::Pending);
        session.stop();
        assert_eq!(session.status(), Status::Cancelled);
        assert!(session.runtime_pid().is_none());
        assert!(manager.list().is_empty());
    }

    #[tokio::test]
    async fn new_sessions_in_one_workspace_are_distinct() {
        let (manager, _home, workspace) = manager(50);
        let first = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let second = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        assert_ne!(first.id, second.id);
    }

    #[tokio::test]
    async fn a_new_session_is_pending_until_the_first_message() {
        let (manager, _home, workspace) = manager(50);
        let app = app(manager.clone());
        let body = json!({ "workspacePath": workspace.path() });
        let response = call(
            app.clone(),
            request(Method::POST, "/v1/sessions")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await;
        assert_eq!(response.0, StatusCode::ACCEPTED, "{}", response.2);
        let value: Value = serde_json::from_str(&response.2).unwrap();
        assert_eq!(value["status"], "pending");
        let session_id = value["sessionId"].as_str().unwrap().to_string();
        let session = manager.get(&session_id).unwrap();
        assert_eq!(session.status(), Status::Pending);
        assert!(session.runtime_pid().is_none());

        let list = call(
            app.clone(),
            request(Method::GET, "/v1/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert!(!list.2.contains(&session_id));

        let send = call(
            app,
            request(
                Method::POST,
                &format!("/v1/sessions/{session_id}/messages"),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "clientMessageId": "pending-1", "text": "hello" }).to_string(),
            ))
            .unwrap(),
        )
        .await;
        assert_eq!(send.0, StatusCode::ACCEPTED, "{}", send.2);
        wait_status(&session, Status::Idle).await;
        assert!(session.runtime_pid().is_some());
    }

    #[tokio::test]
    async fn persisted_list_is_cached_until_refresh() {
        let (manager, _home, workspace) = manager(50);
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = workspace.path().to_string_lossy().replace('\\', "/");
        let first = directory.join("first.jsonl");
        std::fs::write(
            &first,
            format!("{{\"type\":\"session\",\"cwd\":\"{cwd}\"}}\n"),
        )
        .unwrap();
        let app = app(manager);
        let listed = call(
            app.clone(),
            request(Method::GET, "/v1/sessions/persisted")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert!(listed.2.contains("first.jsonl"), "{}", listed.2);

        let second = directory.join("second.jsonl");
        std::fs::write(
            &second,
            format!("{{\"type\":\"session\",\"cwd\":\"{cwd}\"}}\n"),
        )
        .unwrap();
        let cached = call(
            app.clone(),
            request(Method::GET, "/v1/sessions/persisted")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert!(!cached.2.contains("second.jsonl"), "{}", cached.2);

        let refreshed = call(
            app,
            request(Method::GET, "/v1/sessions/persisted?refresh=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert!(refreshed.2.contains("second.jsonl"), "{}", refreshed.2);
    }

    #[tokio::test]
    async fn tools_and_mcp_endpoints_read_host_state() {
        let (manager, home, _workspace) = manager(50);
        let agent = home.path().join("data").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            agent.join("tools.json"),
            json!({ "reviewTools": ["generate_image"], "image": { "provider": "shisa" } }).to_string(),
        )
        .unwrap();
        std::fs::write(
            agent.join("mcp.json"),
            json!({ "mcpServers": { "local": { "command": "node", "exposure": "eager" } } }).to_string(),
        )
        .unwrap();
        let app = app(manager);

        let tools = call(
            app.clone(),
            request(Method::GET, "/v1/tools")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(tools.0, StatusCode::OK, "{}", tools.2);
        assert!(tools.2.contains("generate_image"));

        let saved = call(
            app.clone(),
            request(Method::PUT, "/v1/tools")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "image": { "provider": "shisa", "model": "gemini-3-pro-image", "size": "2K", "maxImages": 2 } })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(saved.0, StatusCode::OK, "{}", saved.2);
        assert!(saved.2.contains("\"size\":\"2K\""), "{}", saved.2);

        let mcp = call(
            app,
            request(Method::GET, "/v1/mcp")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(mcp.0, StatusCode::OK, "{}", mcp.2);
        assert!(mcp.2.contains("\"transport\":\"Local\""), "{}", mcp.2);
        assert!(mcp.2.contains("\"exposure\":\"eager\""), "{}", mcp.2);
    }

    #[tokio::test]
    async fn history_rows_and_done_carry_blocks() {
        let (manager, _home, workspace) = manager(100);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager);
        let (mut rx, reader) = subscribe(app, &session.id).await;
        let _ = next_event(&mut rx, "session.snapshot").await;

        session.send("blocks-1", "hello").unwrap();
        let start = next_event(&mut rx, "message.start").await;
        assert_eq!(start["role"], "assistant", "{start}");
        let done = next_event(&mut rx, "message.done").await;
        assert!(done["blocks"].is_array(), "{done}");

        wait_status(&session, Status::Idle).await;
        let history = session.history(50, None);
        let rows = history["messages"].as_array().unwrap();
        assert!(rows.iter().all(|row| row["blocks"].is_array()), "{history}");
        assert!(rows.iter().any(|row| row["kind"] == "user"));
        assert!(rows.iter().any(|row| row["kind"] == "assistant"));
        reader.abort();
    }

    #[tokio::test]
    async fn assistant_blocks_include_thinking_and_tools() {
        let (manager, _home, workspace) = manager_with_env(50, &[("FAKE_RUNTIME_TOOL", "1")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("blocks-2", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        let history = session.history(50, None);
        let rows = history["messages"].as_array().unwrap();
        let assistant = rows
            .iter()
            .find(|row| row["kind"] == "assistant")
            .expect("assistant row");
        let types = assistant["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|block| block["type"].as_str())
            .collect::<Vec<_>>();
        assert!(types.contains(&"thinking"), "{assistant}");
        assert!(types.contains(&"toolCall"), "{assistant}");
        assert!(types.contains(&"toolResult"), "{assistant}");
        let tool = rows.iter().find(|row| row["kind"] == "tool").unwrap();
        assert_eq!(tool["tool"]["status"], "ok", "{tool}");
    }

    #[tokio::test]
    async fn model_and_thinking_endpoints_update_the_session() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager);
        let model = call(
            app.clone(),
            request(Method::POST, &format!("/v1/sessions/{}/model", session.id))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "provider": "fixture", "model": "model" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(model.0, StatusCode::OK, "{}", model.2);
        assert!(model.2.contains("fixture-model"), "{}", model.2);

        let thinking = call(
            app,
            request(Method::POST, &format!("/v1/sessions/{}/thinking", session.id))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "level": "high" }).to_string()))
                .unwrap(),
        )
        .await;
        assert_eq!(thinking.0, StatusCode::OK, "{}", thinking.2);
        assert!(thinking.2.contains("\"high\""), "{}", thinking.2);
    }

    #[tokio::test]
    async fn attach_history_waits_for_the_starting_runtime() {
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().join("attached.jsonl");
        let session = manager
            .create(
                workspace.path().to_str().unwrap(),
                Some(path.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        // Attach returns before the runtime handshake; get_messages must wait instead
        // of surfacing "runtime not ready" to the client.
        let history = session
            .request(json!({ "type": "get_messages" }), Duration::from_secs(5))
            .await
            .expect("history after attach");
        assert!(history["messages"].is_array(), "{history}");
    }

    #[tokio::test]
    async fn pending_history_is_empty_without_a_runtime() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let history = session
            .request(json!({ "type": "get_messages" }), Duration::from_secs(1))
            .await
            .expect("pending history");
        assert_eq!(history["messages"].as_array().unwrap().len(), 0);
        assert!(session.runtime_pid().is_none());
    }

    #[tokio::test]
    async fn history_preview_is_served_at_the_new_path() {
        let (manager, _home, _workspace) = manager(50);
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("preview.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n",
        )
        .unwrap();
        let path = file.to_string_lossy().replace('\\', "/");
        let encoded = percent_encoding::utf8_percent_encode(
            &path,
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let app = app(manager);
        let response = call(
            app,
            request(
                Method::GET,
                &format!("/v1/sessions/history?sessionPath={encoded}"),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
        assert_eq!(response.0, StatusCode::OK, "{}", response.2);
        let body: Value = serde_json::from_str(&response.2).unwrap();
        assert_eq!(body["messages"][0]["role"], "user");
    }

    async fn wait_status(session: &crate::session::Session, expected: Status) {
        for _ in 0..100 {
            if session.status() == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("status was {:?}, expected {:?}", session.status(), expected);
    }

    fn sse_event(block: &str) -> Option<(String, Value)> {
        let mut event = String::new();
        let mut data = String::new();
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("event:") {
                event = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push_str(value.trim());
            }
        }
        if event.is_empty() || data.is_empty() {
            return None;
        }
        Some((event, serde_json::from_str(&data).ok()?))
    }

    async fn read_sse(response: Response, tx: mpsc::UnboundedSender<(String, Value)>) {
        let mut body = response.into_body();
        let mut buffer = String::new();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(10), body.frame()).await;
            let Ok(Some(Ok(frame))) = frame else { break };
            let Some(data) = frame.data_ref() else {
                continue;
            };
            buffer.push_str(&String::from_utf8_lossy(data));
            while let Some(index) = buffer.find("\n\n") {
                let block: String = buffer.drain(..index + 2).collect();
                if let Some(event) = sse_event(&block) {
                    if tx.send(event).is_err() {
                        return;
                    }
                }
            }
        }
    }

    async fn subscribe(
        app: Router,
        session_id: &str,
    ) -> (
        mpsc::UnboundedReceiver<(String, Value)>,
        tokio::task::JoinHandle<()>,
    ) {
        let response = app
            .oneshot(
                request(
                    Method::GET,
                    &format!("/v1/sessions/{session_id}/events?clientId=test"),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));
        let (tx, rx) = mpsc::unbounded_channel();
        (rx, tokio::spawn(read_sse(response, tx)))
    }

    async fn subscribe_after(
        app: Router,
        session_id: &str,
        last_event_id: Option<u64>,
    ) -> (
        mpsc::UnboundedReceiver<(String, Value)>,
        tokio::task::JoinHandle<()>,
    ) {
        let mut builder = request(
            Method::GET,
            &format!("/v1/sessions/{session_id}/events?clientId=test"),
        );
        if let Some(id) = last_event_id {
            builder = builder.header("last-event-id", id.to_string());
        }
        let response = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (tx, rx) = mpsc::unbounded_channel();
        (rx, tokio::spawn(read_sse(response, tx)))
    }
    async fn next_event(rx: &mut mpsc::UnboundedReceiver<(String, Value)>, name: &str) -> Value {
        for _ in 0..100 {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {name}"))
                .expect("stream closed");
            if event.0 == name {
                return event.1;
            }
        }
        panic!("no {name} event");
    }

    fn manager_with_ui(
        method: &str,
        timeout_ms: Option<u64>,
    ) -> (Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir) {
        let mut spec = RuntimeSpec::node_script(&fixture());
        spec.env
            .push(("FAKE_RUNTIME_UI".to_string(), method.to_string()));
        if let Some(timeout_ms) = timeout_ms {
            spec.env.push((
                "FAKE_RUNTIME_UI_TIMEOUT_MS".to_string(),
                timeout_ms.to_string(),
            ));
        }
        manager_with_spec(spec, 100)
    }

    async fn subscribe_as(
        app: Router,
        session_id: &str,
        client_id: &str,
        capabilities: &str,
    ) -> (
        mpsc::UnboundedReceiver<(String, Value)>,
        tokio::task::JoinHandle<()>,
    ) {
        let response = app
            .oneshot(
                request(
                    Method::GET,
                    &format!(
                        "/v1/sessions/{session_id}/events?clientId={client_id}&capabilities={capabilities}"
                    ),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (tx, rx) = mpsc::unbounded_channel();
        (rx, tokio::spawn(read_sse(response, tx)))
    }

    async fn post_json(app: Router, uri: &str, body: Value) -> (StatusCode, Value) {
        let response = call(
            app,
            request(Method::POST, uri)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await;
        (
            response.0,
            serde_json::from_str(&response.2).unwrap_or(Value::Null),
        )
    }

    async fn session_info(app: &Router, session_id: &str) -> Value {
        let response = call(
            app.clone(),
            request(Method::GET, &format!("/v1/sessions/{session_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        serde_json::from_str(&response.2).unwrap()
    }
    async fn text_until_done(rx: &mut mpsc::UnboundedReceiver<(String, Value)>) -> String {
        let mut text = String::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .expect("timed out waiting for done")
                .expect("stream closed");
            match event.0.as_str() {
                "message.delta" => text.push_str(event.1["text"].as_str().unwrap()),
                "message.done" => return text,
                _ => {}
            }
        }
    }

    #[tokio::test]
    async fn pi_rpc_create_send_stream_and_detach() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) = subscribe(app.clone(), &session.id).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        session.send("client-1", "hello").unwrap();
        let mut deltas = String::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            match event.0.as_str() {
                "message.delta" => deltas.push_str(event.1["text"].as_str().unwrap()),
                "message.done" => {
                    assert_eq!(event.1["stopReason"], "completed");
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(deltas, "hello");
        reader.abort();

        assert_ne!(session.status(), Status::Stopped);
        session.send("client-2", "again").unwrap();
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.status(), Status::Idle);
    }

    #[tokio::test]
    async fn replay_returns_events_and_gap_returns_snapshot() {
        let (manager, _home, workspace) = manager(2);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("client-1", "abcdefgh").unwrap();
        wait_status(&session, Status::Idle).await;
        let cursor = session.cursor();

        let (snapshot, snapshot_cursor) = session.events_after(0);
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].event, "session.snapshot");
        assert_eq!(snapshot[0].id, snapshot_cursor);

        let (replay, _) = session.events_after(cursor - 1);
        assert!(!replay.is_empty());
        assert!(replay.iter().all(|event| event.id > cursor - 1));

        let (gap, gap_cursor) = session.events_after(1);
        assert_eq!(gap.len(), 1);
        assert_eq!(gap[0].event, "session.snapshot");
        assert_eq!(gap[0].id, gap_cursor);
    }

    #[tokio::test]
    async fn events_require_auth_and_client_id() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager);
        let path = format!("/v1/sessions/{}/events?clientId=test", session.id);
        let no_auth = Request::builder()
            .uri(&path)
            .header(header::HOST, "127.0.0.1:40123")
            .body(Body::empty())
            .unwrap();
        assert_eq!(call(app.clone(), no_auth).await.0, StatusCode::UNAUTHORIZED);

        let no_client = request(Method::GET, &format!("/v1/sessions/{}/events", session.id))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            call(app.clone(), no_client).await.0,
            StatusCode::BAD_REQUEST
        );

        let (mut rx, reader) = subscribe(app, &session.id).await;
        let event = next_event(&mut rx, "session.snapshot").await;
        assert_eq!(event["sessionId"], session.id);
        reader.abort();
    }

    #[tokio::test]
    async fn interrupt_ends_the_turn_as_interrupted() {
        let (manager, _home, workspace) = manager(100);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) = subscribe(app, &session.id).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        session.send("client-1", &"x".repeat(200)).unwrap();
        let _ = next_event(&mut rx, "message.delta").await;
        session.interrupt().unwrap();
        let done = next_event(&mut rx, "message.done").await;
        assert_eq!(done["stopReason"], "interrupted");
        wait_status(&session, Status::Idle).await;
        reader.abort();
    }

    #[tokio::test]
    async fn a_pre_send_cancel_leaves_a_tombstone() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let tombstone = session.cancel_message("before-host").unwrap();
        assert_eq!(tombstone["status"], "tombstoned");
        let receipt = session.send("before-host", "hello").unwrap();
        assert_eq!(receipt["receipt"], "cancelled");
        let history = session.history(10, None);
        assert_eq!(history["messages"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn idempotent_send_and_conflict() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let first = session.send("same", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        let again = session.send("same", "hello").unwrap();
        assert_eq!(first["messageId"], again["messageId"]);
        let conflict = session.send("same", "different").unwrap_err();
        assert_eq!(conflict.status, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn stop_terminates_the_job_tree() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let pid_file = home.path().join("child.pid");
        let mut spec = RuntimeSpec::node_script(&fixture());
        spec.env.push((
            "FAKE_RUNTIME_CHILD_PID_FILE".to_string(),
            pid_file.to_string_lossy().into_owned(),
        ));
        let manager = Arc::new(SessionManager::new(
            Some(spec),
            home.path().to_path_buf(),
            home.path().join("data"),
            None,
            50,
            None,
        ));
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let mut child_pid = None;
        for _ in 0..50 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    child_pid = Some(pid);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let child_pid = child_pid.expect("fixture child pid");
        session.stop();
        wait_status(&session, Status::Stopped).await;
        for _ in 0..50 {
            if !pid_running(child_pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("fixture child {child_pid} survived stop");
    }

    fn pid_running(pid: u32) -> bool {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        output
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn create_attaches_by_session_path() {
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().to_str().unwrap();
        let first = manager
            .create(path, Some("one.jsonl".to_string()), None)
            .unwrap();
        let second = manager
            .create(path, Some("one.jsonl".to_string()), None)
            .unwrap();
        assert_eq!(first.id, second.id);
        let third = manager
            .create(path, Some("two.jsonl".to_string()), None)
            .unwrap();
        assert_ne!(first.id, third.id);
    }

    #[tokio::test]
    async fn http_stop_marks_the_session_stopped() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager);
        let response = call(
            app,
            request(Method::POST, &format!("/v1/sessions/{}/stop", session.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        assert_eq!(session.status(), Status::Stopped);
    }
    #[tokio::test]
    async fn sse_resumes_from_last_event_id_and_snapshots_on_gap() {
        let (manager, _home, workspace) = manager(2);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("client-1", "abcdef").unwrap();
        wait_status(&session, Status::Idle).await;
        let cursor = session.cursor();

        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_after(app.clone(), &session.id, Some(cursor.saturating_sub(1))).await;
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(first.0, "session.snapshot");
        reader.abort();

        let (mut rx, reader) = subscribe_after(app, &session.id, Some(1)).await;
        let first = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.0, "session.snapshot");
        reader.abort();
    }
    #[tokio::test]
    async fn http_create_list_get_and_send() {
        let (manager, _home, workspace) = manager(50);
        let app = app(manager.clone());
        let body = json!({ "workspacePath": workspace.path() });
        let response = call(
            app.clone(),
            request(Method::POST, "/v1/sessions")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await;
        assert_eq!(response.0, StatusCode::ACCEPTED, "{}", response.2);
        let value: Value = serde_json::from_str(&response.2).unwrap();
        let session_id = value["sessionId"].as_str().unwrap().to_string();
        assert!(response.1.contains_key(header::LOCATION));

        let send = call(
            app.clone(),
            request(
                Method::POST,
                &format!("/v1/sessions/{session_id}/messages"),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "clientMessageId": "http-1", "text": "hello" }).to_string(),
            ))
            .unwrap(),
        )
        .await;
        assert_eq!(send.0, StatusCode::ACCEPTED, "{}", send.2);

        let list = call(
            app.clone(),
            request(Method::GET, "/v1/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(list.0, StatusCode::OK);
        assert!(list.2.contains(&session_id));

        let get = call(
            app.clone(),
            request(Method::GET, &format!("/v1/sessions/{session_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(get.0, StatusCode::OK);
        assert!(get.2.contains(&session_id));

        let missing = call(
            app,
            request(Method::GET, "/v1/sessions/nope")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
    }
    #[tokio::test]
    async fn extension_notices_status_and_widgets_reach_clients() {
        let (manager, _home, workspace) = manager_with_ui("notices", None);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_as(app.clone(), &session.id, "viewer", "view").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        session.send("client-1", "go").unwrap();
        let notice = next_event(&mut rx, "session.notice").await;
        assert_eq!(notice["level"], "warning");
        assert!(notice["message"]
            .as_str()
            .unwrap()
            .starts_with("Flow control is holding"));
        for _ in 0..50 {
            if session.summary()["widgets"]["flow"].is_array() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let summary = session.summary();
        assert_eq!(summary["statuses"]["flow"], "held 1");
        assert_eq!(summary["widgets"]["flow"], json!(["line a", "line b"]));
        reader.abort();
        let (mut snap_rx, snap_reader) =
            subscribe_as(app.clone(), &session.id, "late", "view").await;
        let snapshot = next_event(&mut snap_rx, "session.snapshot").await;
        assert_eq!(snapshot["statuses"]["flow"], "held 1");
        snap_reader.abort();
    }

    #[tokio::test]
    async fn approval_confirm_decision_resumes_and_duplicate_is_resolved() {
        let (manager, _home, workspace) = manager_with_ui("confirm", None);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_as(app.clone(), &session.id, "answerer", "view,control,prompts").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        session.send("client-1", "go").unwrap();
        let requested = next_event(&mut rx, "approval.requested").await;
        let approval_id = requested["approvalId"].as_str().unwrap().to_string();
        assert_eq!(requested["options"], json!(["Approve", "Deny"]));
        assert_eq!(requested["turnId"], "m-1");
        assert!(requested["expiresAt"].is_string());

        let (mut snap_rx, snap_reader) =
            subscribe_as(app.clone(), &session.id, "snap", "view").await;
        let snapshot = next_event(&mut snap_rx, "session.snapshot").await;
        assert_eq!(snapshot["pendingApprovals"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["pendingQuestions"].as_array().unwrap().len(), 0);
        snap_reader.abort();
        let info = session_info(&app, &session.id).await;
        assert_eq!(info["pendingApprovalCount"], 1);
        assert_eq!(info["status"], "waiting_approval");

        let unauthenticated = call(
            app.clone(),
            Request::builder()
                .method(Method::POST)
                .uri(format!("/v1/approvals/{approval_id}/decision"))
                .header(header::HOST, "127.0.0.1:40123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "clientId": "answerer", "decision": "Approve" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(unauthenticated.0, StatusCode::UNAUTHORIZED);

        let (status, body) = post_json(
            app.clone(),
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "answerer", "decision": "Approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "allowed");

        let resolved = next_event(&mut rx, "approval.resolved").await;
        assert_eq!(resolved["approvalId"], approval_id);
        assert_eq!(resolved["state"], "allowed");
        assert_eq!(resolved["answeredBy"], "answerer");
        assert_eq!(text_until_done(&mut rx).await, "approved");
        wait_status(&session, Status::Idle).await;

        let (status, body) = post_json(
            app.clone(),
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "answerer", "decision": "Deny" }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "prompt-resolved");
        assert_eq!(
            session_info(&app, &session.id).await["pendingApprovalCount"],
            0
        );
        reader.abort();
    }

    #[tokio::test]
    async fn a_global_stream_keeps_open_sessions_from_reaping() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;

        let guard = manager.enter_global_client();
        manager.reap_idle(Duration::ZERO);
        assert!(
            manager.get(&session.id).is_some(),
            "an open global stream must keep its sessions"
        );

        drop(guard);
        manager.reap_idle(Duration::ZERO);
        assert!(
            manager.get(&session.id).is_none(),
            "without a stream, the idle session can be reaped"
        );
    }

    #[tokio::test]
    async fn global_stream_client_can_answer_approvals() {        let (manager, _home, workspace) = manager_with_ui("confirm", None);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let response = app
            .clone()
            .oneshot(
                request(
                    Method::GET,
                    "/v1/events?clientId=global-ui&capabilities=view,control,prompts",
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (tx, _rx) = mpsc::unbounded_channel();
        let reader = tokio::spawn(read_sse(response, tx));
        tokio::time::sleep(Duration::from_millis(100)).await;

        session.send("client-1", "go").unwrap();
        let mut approval_id = String::new();
        for _ in 0..100 {
            let summary = session.summary();
            if let Some(id) = summary["pendingApprovals"][0]["approvalId"].as_str() {
                approval_id = id.to_string();
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !approval_id.is_empty(),
            "summary carries the pending approval"
        );

        let (status, _) = post_json(
            app.clone(),
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "never-connected", "decision": "Approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = post_json(
            app.clone(),
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "global-ui", "decision": "Approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "allowed");
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.summary()["pendingApprovals"], json!([]));
        reader.abort();
    }

    #[tokio::test]
    async fn select_question_answer_resumes_and_duplicate_is_resolved() {
        let (manager, _home, workspace) = manager_with_ui("select", None);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_as(app.clone(), &session.id, "answerer", "view,control,prompts").await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        session.send("client-1", "go").unwrap();
        let requested = next_event(&mut rx, "question.requested").await;
        let question_id = requested["questionId"].as_str().unwrap().to_string();
        let item = &requested["questions"][0];
        assert_eq!(item["id"], "q1");
        assert_eq!(item["options"], json!(["A", "B"]));
        assert_eq!(info_status(&app, &session.id).await, "waiting_question");
        assert_eq!(
            session_info(&app, &session.id).await["pendingQuestionCount"],
            1
        );

        let (status, body) = post_json(
            app.clone(),
            &format!("/v1/questions/{question_id}/answer"),
            json!({ "clientId": "answerer", "answers": { "q1": "B" } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["state"], "answered");
        let answered = next_event(&mut rx, "question.answered").await;
        assert_eq!(answered["questionId"], question_id);
        assert_eq!(answered["answers"]["q1"], "B");
        assert_eq!(text_until_done(&mut rx).await, "B");

        let (status, body) = post_json(
            app,
            &format!("/v1/questions/{question_id}/answer"),
            json!({ "clientId": "answerer", "answers": { "q1": "A" } }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "prompt-resolved");
        reader.abort();
    }

    #[tokio::test]
    async fn input_and_editor_questions_map_to_questions() {
        for (method, answer) in [("input", "typed"), ("editor", "edited")] {
            let (manager, _home, workspace) = manager_with_ui(method, None);
            let session = manager
                .create(workspace.path().to_str().unwrap(), None, None)
                .unwrap();
            wait_status(&session, Status::Idle).await;
            let app = app(manager.clone());
            let (mut rx, reader) =
                subscribe_as(app.clone(), &session.id, "answerer", "view,control,prompts").await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            session.send("client-1", "go").unwrap();
            let requested = next_event(&mut rx, "question.requested").await;
            let question_id = requested["questionId"].as_str().unwrap().to_string();
            assert_eq!(
                requested["questions"][0]["header"]
                    .as_str()
                    .unwrap()
                    .is_empty(),
                false
            );
            let (status, body) = post_json(
                app,
                &format!("/v1/questions/{question_id}/answer"),
                json!({ "clientId": "answerer", "answers": { "q1": answer } }),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{method}: {body}");
            assert_eq!(text_until_done(&mut rx).await, answer);
            reader.abort();
        }
    }

    #[tokio::test]
    async fn prompt_answer_requires_prompts_capability() {
        let (manager, _home, workspace) = manager_with_ui("confirm", None);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_as(app.clone(), &session.id, "viewer", "view,control").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.send("client-1", "go").unwrap();
        let requested = next_event(&mut rx, "approval.requested").await;
        let approval_id = requested["approvalId"].as_str().unwrap().to_string();

        let (status, body) = post_json(
            app.clone(),
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "viewer", "decision": "Approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"]["code"], "prompt-forbidden");
        assert_eq!(info_count(&app, &session.id).await, 1);

        let (mut answer_rx, answer_reader) =
            subscribe_as(app.clone(), &session.id, "answerer", "view,control,prompts").await;
        let (status, _) = post_json(
            app,
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "answerer", "decision": "Approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let _ = next_event(&mut answer_rx, "approval.resolved").await;
        answer_reader.abort();
        reader.abort();
    }

    #[tokio::test]
    async fn expired_prompts_resolve_and_reject_late_answers() {
        let (manager, _home, workspace) = manager_with_ui("confirm", Some(200));
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_as(app.clone(), &session.id, "answerer", "view,control,prompts").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.send("client-1", "go").unwrap();
        let requested = next_event(&mut rx, "approval.requested").await;
        let approval_id = requested["approvalId"].as_str().unwrap().to_string();
        let resolved = next_event(&mut rx, "approval.resolved").await;
        assert_eq!(resolved["state"], "expired");
        assert_eq!(resolved["decision"], "expired");
        let (status, body) = post_json(
            app.clone(),
            &format!("/v1/approvals/{approval_id}/decision"),
            json!({ "clientId": "answerer", "decision": "Approve" }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "prompt-expired");
        assert_eq!(info_count(&app, &session.id).await, 0);
        reader.abort();
    }

    #[tokio::test]
    async fn question_expiry_emits_cancelled() {
        let (manager, _home, workspace) = manager_with_ui("select", Some(200));
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) =
            subscribe_as(app.clone(), &session.id, "answerer", "view,control,prompts").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.send("client-1", "go").unwrap();
        let requested = next_event(&mut rx, "question.requested").await;
        let question_id = requested["questionId"].as_str().unwrap().to_string();
        let cancelled = next_event(&mut rx, "question.cancelled").await;
        assert_eq!(cancelled["reason"], "expired");
        let (status, body) = post_json(
            app,
            &format!("/v1/questions/{question_id}/answer"),
            json!({ "clientId": "answerer", "answers": { "q1": "A" } }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "prompt-expired");
        reader.abort();
    }

    #[tokio::test]
    async fn noninteractive_ui_methods_are_ignored() {
        let (manager, _home, workspace) = manager_with_ui("noise", None);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) = subscribe_as(app.clone(), &session.id, "viewer", "view").await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.send("client-1", "hi").unwrap();
        let mut saw_prompt = false;
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            if event.0.starts_with("approval.") || event.0.starts_with("question.") {
                saw_prompt = true;
            }
            if event.0 == "message.done" {
                break;
            }
        }
        assert!(!saw_prompt);
        assert_eq!(info_count(&app, &session.id).await, 0);
        reader.abort();
    }

    async fn info_status(app: &Router, session_id: &str) -> String {
        session_info(app, session_id).await["status"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn info_count(app: &Router, session_id: &str) -> u64 {
        session_info(app, session_id).await["pendingApprovalCount"]
            .as_u64()
            .unwrap()
            + session_info(app, session_id).await["pendingQuestionCount"]
                .as_u64()
                .unwrap()
    }

    #[tokio::test]
    async fn command_models_thinking_and_state_are_available() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;

        let models = session
            .request(json!({ "type": "get_available_models" }), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(models["models"].as_array().unwrap().is_empty());

        let levels = session
            .request(
                json!({ "type": "get_available_thinking_levels" }),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(levels["levels"], json!(["off"]));

        let state = session
            .request(json!({ "type": "get_state" }), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(state["model"]["id"], "model");
        assert_eq!(state["thinkingLevel"], "off");
    }

    #[tokio::test]
    async fn assistant_history_records_model_and_provider() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("model-history", "hello").unwrap();
        wait_status(&session, Status::Idle).await;

        let history = session.history(10, None);
        let assistant = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "assistant")
            .unwrap();
        assert_eq!(assistant["model"], "fixture-model");
        assert_eq!(assistant["provider"], "fixture");
    }

    #[tokio::test]
    async fn attachments_are_stored_and_history_has_no_base64() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session
            .send_with_client(
                "attachment-1",
                "image",
                None,
                &[Attachment {
                    name: "pixel.png".into(),
                    mime_type: "image/png".into(),
                    data: "AAEC".into(),
                }],
            )
            .unwrap();
        wait_status(&session, Status::Idle).await;

        let history = session.history(10, None);
        let user = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "user")
            .unwrap();
        let attachment = &user["attachments"][0];
        assert!(attachment.get("data").is_none());
        assert_eq!(attachment["mimeType"], "image/png");
        assert!(attachment["path"].as_str().unwrap().ends_with(".png"));
        assert!(std::path::Path::new(attachment["path"].as_str().unwrap()).is_file());
    }

    #[tokio::test]
    async fn reload_current_session_is_accepted_and_other_paths_are_rejected() {
        let (manager, home, workspace) = manager(50);
        let directory = home.path().join("data").join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("reload.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({ "type": "session", "version": 3, "id": "reload", "cwd": workspace.path() }),
                json!({ "type": "message", "message": { "role": "user", "content": "old" } })
            ),
        )
        .unwrap();
        let session = manager
            .create(
                workspace.path().to_str().unwrap(),
                Some(path.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        wait_status(&session, Status::Idle).await;

        let result = session
            .request(
                json!({ "type": "switch_session", "sessionPath": path }),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(result["cancelled"], false);

        let other = directory.join("other.jsonl");
        std::fs::write(&other, "{}\n").unwrap();
        let error = session
            .request(
                json!({ "type": "switch_session", "sessionPath": other }),
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "invalid-request");
    }

    #[test]
    fn flow_reports_filter_hidden_and_keep_displayed_reports() {
        let (manager, home, _workspace) = manager(50);
        let directory = home.path().join("data").join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("flow.jsonl");
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n",
                json!({ "type": "session", "version": 3, "id": "flow", "cwd": "C:/work" }),
                json!({
                    "type": "custom_message",
                    "customType": "jouzu-flow",
                    "display": true,
                    "content": [{ "type": "text", "text": "{\"kind\":\"work\",\"content\":\"Continue\"}" }]
                }),
                json!({
                    "type": "custom_message",
                    "customType": "jouzu-flow",
                    "display": false,
                    "content": [{ "type": "text", "text": "{\"kind\":\"hidden\"}" }]
                })
            ),
        )
        .unwrap();
        let reports = manager.flow_reports(path.to_str().unwrap()).unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["kind"], "work");
    }
}



















