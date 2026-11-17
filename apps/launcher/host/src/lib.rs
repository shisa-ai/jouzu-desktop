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
pub mod awake;
pub mod control;
mod environment;
pub mod events;
mod files;
pub mod runtime;
pub mod sessions_repair;
pub mod session;
pub mod web_access;

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
/// Stamped by `scripts/build-app.mjs`; the shell checks it matches its own.
pub const BUILD_ID: &str = env!("JOUZU_BUILD_ID");
pub const COMMIT: &str = env!("JOUZU_COMMIT");

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
    pub web: Arc<web_access::WebAccess>,
}

#[derive(Debug, Serialize)]
pub struct HostInfo {
    pub schema: u32,
    #[serde(rename = "hostVersion")]
    pub host_version: String,
    pub build: String,
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
        build: BUILD_ID.to_string(),
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
    // One whole line per write, one writer at a time: lines from concurrent
    // sessions must never interleave (Windows appends are not atomic).
    static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let line = format!("{record}\n");
    let _guard = WRITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path.join("host.log"))
    {
        let _ = file.write_all(line.as_bytes());
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
        .route("/timing", axum::routing::post(record_ui_timing))
        .route("/runtime/warm", get(warm_runtime).post(aim_warm_runtime))
        .route(
            "/environment",
            get(read_environment).put(save_environment),
        )
        .route("/capabilities", get(capabilities))
        .route("/web-access", get(web_access_snapshot).put(update_web_access))
        .route(
            "/web-access/pairing",
            axum::routing::post(start_web_pairing).delete(cancel_web_pairing),
        )
        .route("/web-access/devices", axum::routing::delete(revoke_all_web_devices))
        .route("/web-access/devices/{id}", axum::routing::delete(revoke_web_device))
        .route("/control", axum::routing::post(control_request))
        .route("/control/cancel", axum::routing::post(control_cancel))
        .route("/control/events", get(control_events))
        .route("/events", get(global_events))
        .route("/models", get(models))
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
        .route(
            "/sessions/{id}/attachments/{attachment}",
            get(session_attachment),
        )
        .route("/sessions/{id}/stop", axum::routing::post(stop_session))
        .route("/sessions/{id}/view", axum::routing::post(view_session))
        .route("/sessions/{id}/snapshot", get(session_snapshot))
        .route("/sessions/{id}/stats", get(session_stats))
        .route("/sessions/{id}/compact", axum::routing::post(compact_session))
        .route("/sessions/{id}/export", axum::routing::post(export_session))
        .route("/sessions/{id}/reload", axum::routing::post(reload_session))
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
        ))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            log_failures,
        ));

    Router::new()
        .route("/", get(root))
        .route("/pair", get(pair_device))
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
    /// Read the messages before this position (the `nextBefore` of the later page).
    before: Option<usize>,
}

async fn history_preview(
    State(state): State<AppState>,
    Query(query): Query<MessagesQuery>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        state
            .sessions
            .messages(&query.session_path, query.limit, query.before)?,
    ))
}

#[derive(Deserialize)]
struct BranchRequest {
    #[serde(rename = "sessionPath")]
    session_path: String,
    /// The user turn to branch through (1 = the first user message).
    turn: usize,
}

async fn branch_session(
    State(state): State<AppState>,
    Json(request): Json<BranchRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "sessionPath": state
            .sessions
            .branch_session(&request.session_path, request.turn)?,
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
    let client_id = request.client_id.clone();
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
    if let Some(client_id) = client_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        state.sessions.hold(client_id, &session.id);
    }
    // The runtime starts now: the session's model is the one it reports.
    session.attach_early();
    // The session as it stands (model, queue, turn, prompts): the client starts
    // from this and follows events after `cursor`, so nothing published before
    // it subscribed (the model chosen at creation) is missed.
    let mut body = session.snapshot_event().data;
    body["workspacePath"] = json!(session.workspace_path);
    let mut response = (StatusCode::ACCEPTED, Json(body)).into_response();
    response.headers_mut().insert(
        header::LOCATION,
        HeaderValue::from_str(&format!("/v1/sessions/{}", session.id))
            .unwrap_or_else(|_| HeaderValue::from_static("/v1/sessions")),
    );
    Ok(response)
}

#[derive(Deserialize)]
struct ViewRequest {
    #[serde(rename = "clientId")]
    client_id: String,
}

/// The client now shows this session: its content streams to that client again.
async fn view_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<ViewRequest>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    state.sessions.hold(request.client_id.trim(), &session.id);
    Ok(Json(json!({ "sessionId": session.id, "cursor": session.cursor() })))
}

async fn get_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    Ok(Json(session.info()))
}

/// The session as it stands now, with the cursor it is current to. A client that
/// subscribed late compares the cursor with the events it already saw.
async fn session_snapshot(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    Ok(Json(session.snapshot_event().data))
}

async fn send_message(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<SendRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    if let Some(client_id) = request
        .client_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        state.sessions.hold(client_id, &session.id);
    }
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
    // The runtime may clamp the level: the session reports the one it set.
    Ok(Json(session.select_thinking(&request.level).await?))
}

/// Usage counters for the status line. A session without a runtime yet has no
/// counters, which is an answer (`null`), not an error.
async fn session_stats(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    if !session.has_runtime() {
        return Ok(Json(json!({ "stats": null })));
    }
    let stats = session
        .request(json!({ "type": "get_session_stats" }), Duration::from_secs(10))
        .await?;
    Ok(Json(json!({ "stats": stats })))
}

async fn compact_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let data = session
        .request(json!({ "type": "compact" }), Duration::from_secs(300))
        .await?;
    Ok(Json(json!({ "data": data })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    output_path: String,
}

async fn export_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<ExportRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.output_path.trim().is_empty() {
        return Err(ApiError::bad_request("outputPath is required"));
    }
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let data = session
        .request(
            json!({ "type": "export_html", "outputPath": request.output_path }),
            Duration::from_secs(60),
        )
        .await?;
    Ok(Json(json!({ "data": data })))
}

/// Re-read the session's own saved file into its runtime. The host knows which
/// file that is, so the client does not name a path.
async fn reload_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let path = session
        .saved_path()
        .ok_or_else(|| ApiError::bad_request("This session has no saved file yet"))?;
    let data = session
        .request(
            json!({ "type": "switch_session", "sessionPath": path }),
            Duration::from_secs(30),
        )
        .await?;
    Ok(Json(json!({ "data": data })))
}

async fn interrupt_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    Ok(Json(session.interrupt()?))
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
    let reads_only = matches!(
        body.get("action").and_then(Value::as_str),
        Some("status")
    );
    let result = state.control.request(body).await;
    // Sign-ins, providers, profiles and catalogs change what a runtime loads at
    // start; an unused warm runtime would still have the old ones.
    if !reads_only && result.is_ok() {
        recycle_warm_runtime(&state);
    }
    result.map(Json)
}

fn recycle_warm_runtime(state: &AppState) {
    if let Some(pool) = state.sessions.warm_runtime() {
        pool.recycle();
    }
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
    // While this stream is open, the session the client has open is not reaped.
    let client_stream = query
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|client_id| state.sessions.connect_client(client_id));
    let viewer = query
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let latest = state.events.latest_seq();
    let summaries = state.sessions.summaries();
    let sessions = state.sessions.clone();
    let mut receiver = state.events.subscribe();
    let events = state.events.clone();
    let stream = async_stream::stream! {
        let _client_stream = client_stream;
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
                    if withheld(&sessions, viewer.as_deref(), &event) { continue; }
                    yield Ok::<_, Infallible>(hub_sse_event(event));
                }
            }
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event.seq > last => {
                    last = event.seq;
                    if withheld(&sessions, viewer.as_deref(), &event) { continue; }
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

/// What a session says, as opposed to what state it is in. Content goes only to a
/// client viewing that session; state (status, turns, the summary) goes to every
/// client, so a sidebar always knows which sessions are running. A client that
/// opens a session catches up from its history, which includes the partial reply.
const CONTENT_EVENTS: &[&str] = &[
    "message.start",
    "message.delta",
    "message.done",
    "message.custom",
    "tool.start",
    "tool.update",
    "tool.result",
    "runtime.event",
];

fn withheld(sessions: &SessionManager, viewer: Option<&str>, event: &events::HubEvent) -> bool {
    let Some(viewer) = viewer else { return false };
    if event.session_id.is_empty() || !CONTENT_EVENTS.contains(&event.event.as_str()) {
        return false;
    }
    sessions.viewing(viewer).as_deref() != Some(event.session_id.as_str())
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

async fn root(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
    uri: Uri,
) -> Response {
    // The internal token is never exchanged on a web access listener.
    if matches!(listener.map(|value| value.0), Some(web_access::Listener::Web { .. })) {
        return serve_index(&state).await;
    }
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

/// Moments only the client can see: the loading page giving way, the user's own
/// message on screen, the first words painted, Stop shown. They land in host.log
/// beside the host's own `timing` lines, so one log times what the user saw.
#[derive(Deserialize)]
struct UiTiming {
    mark: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "clientMessageId")]
    client_message_id: Option<String>,
}

const UI_TIMING_MARKS: &[&str] = &["ui.boot", "loading.ready", "message.shown", "first_output.shown", "stop.shown"];

async fn record_ui_timing(
    State(state): State<AppState>,
    Json(body): Json<UiTiming>,
) -> Result<Json<Value>, ApiError> {
    if !UI_TIMING_MARKS.contains(&body.mark.as_str()) {
        return Err(ApiError::bad_request("Unknown timing mark"));
    }
    log(
        state.sessions.home(),
        "info",
        "timing.ui",
        json!({
            "mark": body.mark,
            "session": body.session_id,
            "clientMessageId": body.client_message_id,
        }),
    );
    Ok(Json(json!({ "recorded": true })))
}

async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "hostVersion": state.version,
        "uptimeSeconds": state.started.elapsed().as_secs(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct WarmQuery {
    #[serde(rename = "waitMs")]
    wait_ms: Option<u64>,
}

#[derive(Deserialize)]
struct AimWarmRequest {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
}

/// The client opened a workspace: warm the runtime for it.
async fn aim_warm_runtime(
    State(state): State<AppState>,
    Json(request): Json<AimWarmRequest>,
) -> Result<Json<Value>, ApiError> {
    let Some(pool) = state.sessions.warm_runtime() else {
        return Ok(Json(json!({ "state": "off" })));
    };
    let workspace = std::fs::canonicalize(&request.workspace_path)
        .map_err(|_| ApiError::bad_request("workspacePath is unavailable"))?;
    if !workspace.is_dir() || !state.sessions.workspace_allowed(&request.workspace_path) {
        return Err(ApiError::bad_request("workspacePath must be a known folder"));
    }
    // In the spelling this folder's sessions already use.
    let text = state.sessions.folder_text(&workspace);
    // A client asking (loading, or its retry) is a fresh reason to try again.
    pool.reset_failures();
    pool.aim(std::path::Path::new(&text));
    // The window shows loading until this runtime is ready.
    pool.hurry();
    Ok(Json(pool.status()))
}

/// The warm runtime's state. With `waitMs`, waits until it is ready or failed
/// (at most that long), so the loading screen can wait without polling.
async fn warm_runtime(
    State(state): State<AppState>,
    Query(query): Query<WarmQuery>,
) -> Json<Value> {
    let Some(pool) = state.sessions.warm_runtime() else {
        return Json(json!({ "state": "off" }));
    };
    let wait = Duration::from_millis(query.wait_ms.unwrap_or(0).min(120_000));
    if wait.is_zero() {
        return Json(pool.status());
    }
    pool.hurry();
    Json(pool.wait_settled(wait).await)
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
    environment::save(state.sessions.runtime_home(), &entries).map_err(ApiError::bad_request)?;
    recycle_warm_runtime(&state);
    Ok(Json(json!({ "entries": entries })))
}

/// The models a running runtime registered, as it answers them: the list
/// `set_model` accepts. The host keeps no list of its own.
async fn models(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    match state.sessions.runtime_models().await {
        Some(answer) => answer.map(Json),
        None => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "models-unavailable",
            "The runtime is not ready yet",
            true,
        )),
    }
}

async fn tools_snapshot(State(state): State<AppState>) -> Json<Value> {
    let path = state.sessions.runtime_home().join("agent").join("tools.json");
    let value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));
    Json(json!({
        "path": path.to_string_lossy(),
        "exists": path.is_file(),
        "settings": read_tools_settings(&value),
    }))
}

/// The tools settings in the shape every reader can rely on, whatever the file
/// holds: a missing file or section reads as the defaults the save path writes,
/// and a value the save path would refuse reads as its default. An unset
/// provider stays empty: which provider can be used is the image tool's answer.
fn read_tools_settings(value: &Value) -> Value {
    let image = value.get("image").unwrap_or(&Value::Null);
    let provider = image
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let model = image
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| valid_image_model(model))
        .unwrap_or("");
    let review = value
        .get("reviewTools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter(|tool| tool.is_string())
                .cloned()
                .collect::<Vec<_>>()
        })
        .filter(|tools| !tools.is_empty())
        .unwrap_or_else(|| vec![json!("generate_image")]);
    json!({ "image": image_tool_fields(image, provider, model), "reviewTools": review })
}

fn valid_image_model(model: &str) -> bool {
    model.len() <= 128
        && model.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '/')
        })
}

/// The image settings with defaults for every field but the two the caller checked.
fn image_tool_fields(value: &Value, provider: &str, model: &str) -> Value {
    let enabled = value
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
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
    json!({
        "enabled": enabled,
        "provider": provider,
        "model": model,
        "size": size,
        "maxImages": max_images,
    })
}

fn normalize_image_tool(value: &Value) -> Result<Value, ApiError> {
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
    if !valid_image_model(model) {
        return Err(ApiError::bad_request("model is invalid"));
    }
    Ok(image_tool_fields(value, provider, model))
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
    recycle_warm_runtime(&state);
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

async fn capabilities(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
) -> Json<Value> {
    let scopes = state
        .web
        .scopes(listener.map(|value| value.0).unwrap_or(web_access::Listener::Internal));
    let default_workspace = default_workspace();
    Json(json!({
        "contract": "2026-11-12",
        "hostVersion": state.version,
        "runtimeKind": crate::runtime::adapter::pi::KIND,
        "features": ["chat", "sse", "replay", "prompts", "history-paging", "history-blocks", "models", "control", "tools", "mcp", "recovery", "deferred-sessions"],
        "scopes": scopes,
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

/// An image of a user message in the session's history, by the id the history
/// row gives it. History rows carry no image data, so every client (desktop
/// window or web) shows a message's images through this one route (#119).
async fn session_attachment(
    State(state): State<AppState>,
    AxumPath((id, attachment)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let session = state.sessions.get(&id).ok_or_else(session_not_found)?;
    let (mime_type, data) = session.attachment(&attachment)?;
    Ok(Json(json!({ "id": attachment, "mimeType": mime_type, "data": data })))
}

/// A request the host could not serve leaves a line in host.log with what the
/// client was told, so no failure exists only in a UI that may not show it.
async fn log_failures(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    if !response.status().is_server_error() {
        return response;
    }
    let status = response.status();
    let (parts, body) = response.into_parts();
    let bytes = axum::body::to_bytes(body, 64 * 1024).await.unwrap_or_default();
    let error = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.get("error").cloned())
        .unwrap_or(Value::Null);
    log(
        &state.sessions.home(),
        "error",
        "request.failed",
        json!({ "method": method, "path": path, "status": status.as_u16(), "error": error }),
    );
    Response::from_parts(parts, axum::body::Body::from(bytes))
}

async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // On a web access listener the guard already authenticated the device; the
    // internal token is not accepted there.
    if matches!(listener_of(&request), web_access::Listener::Web { .. }) {
        return if request.extensions().get::<web_access::DeviceId>().is_some() {
            next.run(request).await
        } else {
            unauthorized("This device is not paired").into_response()
        };
    }
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
    if let web_access::Listener::Web { local } = listener_of(&request) {
        return web_guard(state, local, request, next).await;
    }
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

// ---- Web access (issue #91) -------------------------------------------------

fn listener_of(request: &Request) -> web_access::Listener {
    request
        .extensions()
        .get::<web_access::Listener>()
        .copied()
        .unwrap_or(web_access::Listener::Internal)
}

fn peer_of(request: &Request) -> Option<std::net::IpAddr> {
    request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip())
}

fn device_cookie(headers: &HeaderMap) -> Option<String> {
    let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
    let prefix = format!("{}=", web_access::DEVICE_COOKIE);
    cookies
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(&prefix).map(str::to_string))
}

fn forbidden(message: &'static str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": { "code": "forbidden", "message": message, "retryable": false } })),
    )
        .into_response()
}

/// Every request on a web access listener: the peer must be on the network that
/// listener serves, Host/Origin must name the listener, and everything except
/// the pairing page needs a paired device. A device's response stream ends as
/// soon as the device is revoked or its network stops being served.
async fn web_guard(
    state: AppState,
    local: std::net::SocketAddr,
    mut request: Request,
    next: Next,
) -> Response {
    let peer = peer_of(&request);
    let host_ok = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| web_access::WebAccess::host_allowed(local, host));
    let origin_ok = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_none_or(|origin| web_access::WebAccess::origin_allowed(local, origin));
    let Some(peer) = peer.filter(|peer| state.web.peer_allowed(local, *peer)) else {
        log(
            state.sessions.home(),
            "warn",
            "web.refused",
            json!({ "listener": local.to_string(), "peer": peer.map(|value| value.to_string()), "reason": "network" }),
        );
        return forbidden("This device is not on a network Jouzu allows");
    };
    if !host_ok || !origin_ok {
        log(
            state.sessions.home(),
            "warn",
            "web.refused",
            json!({ "listener": local.to_string(), "peer": peer.to_string(), "reason": "host-or-origin" }),
        );
        return forbidden("Unknown Host or Origin");
    }
    let path = request.uri().path().to_string();
    if path == "/pair" {
        return next.run(request).await;
    }
    let device = device_cookie(request.headers())
        .and_then(|cookie| state.web.authorize(&cookie, local, peer));
    let Some(device) = device else {
        return if path.starts_with("/v1/") || path == "/v1" {
            unauthorized("This device is not paired").into_response()
        } else {
            Redirect::to("/pair").into_response()
        };
    };
    request
        .extensions_mut()
        .insert(web_access::DeviceId(device.clone()));
    let response = next.run(request).await;
    let web = state.web.clone();
    let mut changes = web.subscribe();
    let (parts, body) = response.into_parts();
    let ended = async move {
        while changes.changed().await.is_ok() {
            if !web.still_allowed(&device, local, peer) {
                break;
            }
        }
    };
    use futures_util::StreamExt;
    let stream = body.into_data_stream().take_until(Box::pin(ended));
    Response::from_parts(parts, Body::from_stream(stream))
}

fn internal_only(listener: Option<axum::Extension<web_access::Listener>>) -> Result<(), Response> {
    match listener.map(|value| value.0) {
        Some(web_access::Listener::Web { .. }) => {
            Err(forbidden("Web access is managed only in Jouzu Desktop"))
        }
        _ => Ok(()),
    }
}

async fn web_access_snapshot(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
) -> Response {
    if let Err(response) = internal_only(listener) {
        return response;
    }
    Json(state.web.snapshot()).into_response()
}

async fn update_web_access(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
    Json(update): Json<web_access::Update>,
) -> Response {
    if let Err(response) = internal_only(listener) {
        return response;
    }
    let mode = update.mode;
    let networks = update.networks.clone();
    if let Err(message) = state.web.update(update) {
        return ApiError::new(StatusCode::BAD_REQUEST, "invalid-request", message, false).into_response();
    }
    log(
        state.sessions.home(),
        "info",
        "web.scope",
        json!({ "mode": mode, "networks": networks }),
    );
    reconcile_web_access(&state).await;
    Json(state.web.snapshot()).into_response()
}

async fn start_web_pairing(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
) -> Response {
    if let Err(response) = internal_only(listener) {
        return response;
    }
    match state.web.start_pairing() {
        Ok((code, lifetime)) => {
            log(state.sessions.home(), "info", "web.pairing.started", json!({}));
            Json(json!({
                "code": code,
                "expiresInSeconds": lifetime.as_secs(),
                "links": state.web.pairing_urls(&code),
            }))
            .into_response()
        }
        Err(message) => {
            ApiError::new(StatusCode::CONFLICT, "invalid-request", message, false).into_response()
        }
    }
}

async fn cancel_web_pairing(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
) -> Response {
    if let Err(response) = internal_only(listener) {
        return response;
    }
    state.web.cancel_pairing();
    StatusCode::NO_CONTENT.into_response()
}

async fn revoke_web_device(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(response) = internal_only(listener) {
        return response;
    }
    match state.web.revoke(Some(&id)) {
        Ok(true) => {
            log(state.sessions.home(), "info", "web.device.revoked", json!({ "device": id }));
            Json(state.web.snapshot()).into_response()
        }
        Ok(false) => ApiError::new(StatusCode::NOT_FOUND, "invalid-request", "No such device", false).into_response(),
        Err(message) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message, false).into_response(),
    }
}

async fn revoke_all_web_devices(
    State(state): State<AppState>,
    listener: Option<axum::Extension<web_access::Listener>>,
) -> Response {
    if let Err(response) = internal_only(listener) {
        return response;
    }
    match state.web.revoke(None) {
        Ok(_) => {
            log(state.sessions.home(), "info", "web.device.revoked", json!({ "device": "all" }));
            Json(state.web.snapshot()).into_response()
        }
        Err(message) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message, false).into_response(),
    }
}

/// `/pair` on a web access listener: with `?code=` it exchanges the code for a
/// device credential cookie; without one it shows a form to type the code.
async fn pair_device(State(state): State<AppState>, request: Request) -> Response {
    let web_access::Listener::Web { local } = listener_of(&request) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let headers = request.headers();
    let uri = request.uri();
    let Some(peer) = peer_of(&request) else {
        return forbidden("This device is not on a network Jouzu allows");
    };
    let query = query_map(uri.query().unwrap_or(""));
    let Some(code) = query.get("code").filter(|value| !value.trim().is_empty()) else {
        return pair_page(None);
    };
    let name = web_access::device_name(headers.get(header::USER_AGENT).and_then(|value| value.to_str().ok()));
    match state.web.complete_pairing(code, &name, local, peer) {
        Ok((credential, network)) => {
            log(
                state.sessions.home(),
                "info",
                "web.device.paired",
                json!({ "name": name, "network": network, "peer": peer.to_string() }),
            );
            let cookie = format!(
                "{}={credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000",
                web_access::DEVICE_COOKIE
            );
            let mut response = Redirect::to("/").into_response();
            match HeaderValue::from_str(&cookie) {
                Ok(value) => {
                    response.headers_mut().insert(header::SET_COOKIE, value);
                    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                    response
                }
                Err(_) => forbidden("Pairing failed"),
            }
        }
        Err(error) => {
            log(
                state.sessions.home(),
                "warn",
                "web.pairing.failed",
                json!({ "peer": peer.to_string(), "reason": format!("{error:?}") }),
            );
            pair_page(Some(error.message()))
        }
    }
}

fn pair_page(error: Option<String>) -> Response {
    let escape = |text: &str| {
        text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    };
    let error = error
        .map(|message| format!("<p class=\"error\" role=\"alert\">{}</p>", escape(&message)))
        .unwrap_or_default();
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair with Jouzu</title>
<style>:root{{color-scheme:light dark;font-family:system-ui,sans-serif}}body{{margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}}main{{max-width:360px;width:100%}}h1{{font-size:1.25rem}}p{{line-height:1.5;opacity:.85}}input,button{{font:inherit;padding:10px 12px;border-radius:8px;width:100%;box-sizing:border-box}}input{{border:1px solid #8886;letter-spacing:.2em;text-transform:uppercase}}button{{margin-top:12px;border:0;background:#2563eb;color:#fff}}.error{{color:#dc2626}}</style></head>
<body><main><h1>Pair this device with Jouzu</h1><p>In Jouzu Desktop, open Settings, Web access, and choose Pair a device. Enter the code shown there.</p>{error}
<form method="get" action="/pair"><label for="code">Pairing code</label><input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" maxlength="12" required autofocus><button type="submit">Pair</button></form></main></body></html>"#
    );
    let mut response = axum::response::Html(html).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

struct WebListener {
    stop: tokio::sync::oneshot::Sender<()>,
}

static WEB_LISTENERS: std::sync::OnceLock<tokio::sync::Mutex<HashMap<std::net::SocketAddr, WebListener>>> =
    std::sync::OnceLock::new();

/// Starts and stops web access listeners so they match the saved scope and the
/// current interface addresses. Safe to call at any time.
pub async fn reconcile_web_access(state: &AppState) {
    let listeners = WEB_LISTENERS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let mut listeners = listeners.lock().await;
    let desired = state.web.desired();
    let stale: Vec<std::net::SocketAddr> = listeners
        .keys()
        .filter(|address| !desired.contains(address))
        .copied()
        .collect();
    for address in stale {
        if let Some(listener) = listeners.remove(&address) {
            let _ = listener.stop.send(());
            log(state.sessions.home(), "info", "web.listener.stopped", json!({ "address": address.to_string() }));
        }
    }
    let mut failures = HashMap::new();
    for address in &desired {
        if listeners.contains_key(address) {
            continue;
        }
        match tokio::net::TcpListener::bind(address).await {
            Ok(tcp) => {
                let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
                let app = router(state.clone()).layer(axum::Extension(web_access::Listener::Web { local: *address }));
                let home = state.sessions.home().to_path_buf();
                let served = *address;
                tokio::spawn(async move {
                    let result = axum::serve(
                        tcp,
                        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
                    )
                    .with_graceful_shutdown(async move {
                        let _ = stopped.await;
                    })
                    .await;
                    if let Err(error) = result {
                        log(&home, "error", "web.listener.failed", json!({ "address": served.to_string(), "error": error.to_string() }));
                    }
                });
                log(state.sessions.home(), "info", "web.listener.started", json!({ "address": address.to_string() }));
                listeners.insert(*address, WebListener { stop });
            }
            Err(error) => {
                log(state.sessions.home(), "error", "web.listener.failed", json!({ "address": address.to_string(), "error": error.to_string() }));
                failures.insert(*address, error.to_string());
            }
        }
    }
    let serving: Vec<std::net::SocketAddr> = desired
        .iter()
        .filter(|address| listeners.contains_key(address))
        .copied()
        .collect();
    state.web.set_serving(serving, failures);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn control_manager(home: &Path) -> Arc<control::ControlManager> {
        Arc::new(
            control::ControlManager::new(home, home, None, &home.join("data"), None)
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
            web: Arc::new(web_access::WebAccess::disabled()),
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


    /// One raw HTTP/1.1 exchange over a real socket, so the web listener sees a
    /// real peer address. Returns the status line, headers and body as text.
    async fn raw(address: std::net::SocketAddr, path: &str, extra: &str) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n{extra}\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;
        String::from_utf8_lossy(&response).into_owned()
    }

    fn set_cookie(response: &str) -> Option<String> {
        response.lines().find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .starts_with("set-cookie:")
                .then(|| line["set-cookie:".len()..].trim().split(';').next().unwrap().to_string())
        })
    }

    /// Issue #91 end to end over real sockets: off by default, local scope
    /// needs pairing, the internal token is refused on the web listener, a
    /// paired device works, revoking it refuses the next request and ends its
    /// open event stream, and turning access off stops the listener.
    #[tokio::test]
    async fn web_access_requires_pairing_and_revoke_ends_access() {
        let dir = dist();
        let home = tempfile::tempdir().unwrap();
        let mut state = state(dir.path().to_path_buf());
        state.web = Arc::new(web_access::WebAccess::load(home.path()));
        reconcile_web_access(&state).await;
        assert!(state.web.desired().is_empty(), "access is off by default");

        state
            .web
            .update(web_access::Update { mode: web_access::Mode::Local, networks: vec![] })
            .unwrap();
        reconcile_web_access(&state).await;
        let address = state.web.desired()[0];
        assert!(address.ip().is_loopback());

        // Unpaired: API refused, pages redirect to pairing, the internal token does not help.
        assert!(raw(address, "/v1/capabilities", "").await.starts_with("HTTP/1.1 401"));
        let token = format!("Authorization: Bearer {}\r\n", "a".repeat(64));
        assert!(raw(address, "/v1/capabilities", &token).await.starts_with("HTTP/1.1 401"));
        let index = raw(address, &format!("/?token={}", "a".repeat(64)), "").await;
        assert!(set_cookie(&index).is_none(), "{index}");
        assert!(raw(address, "/", "").await.contains("location: /pair"));
        // A foreign Host header is refused even from this computer.
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        {
            use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
            stream
                .write_all(b"GET /pair HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"));
        }

        // Pair.
        let (code, _) = state.web.start_pairing().unwrap();
        assert!(raw(address, "/pair?code=WRONGWRO", "").await.contains("not correct"));
        let paired = raw(address, &format!("/pair?code={code}"), "User-Agent: Firefox/120 (Windows)\r\n").await;
        let cookie = set_cookie(&paired).expect("device cookie");
        assert!(cookie.starts_with(web_access::DEVICE_COOKIE));
        let header = format!("Cookie: {cookie}\r\n");
        let capabilities = raw(address, "/v1/capabilities", &header).await;
        assert!(capabilities.starts_with("HTTP/1.1 200"), "{capabilities}");
        assert!(capabilities.contains("\"loopback\""));
        // A paired browser still cannot manage web access.
        assert!(raw(address, "/v1/web-access", &header).await.starts_with("HTTP/1.1 403"));
        // The cookie means nothing on the internal listener.
        let internal = router(state.clone());
        let request = Request::builder()
            .uri("/v1/capabilities")
            .header(header::HOST, "127.0.0.1:40123")
            .header(header::COOKIE, cookie.clone())
            .body(Body::empty())
            .unwrap();
        assert_eq!(call(internal, request).await.0, StatusCode::UNAUTHORIZED);

        // Open an event stream, then revoke: the stream ends and the next request is refused.
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        {
            use tokio::io::AsyncWriteExt as _;
            let request = format!(
                "GET /v1/events HTTP/1.1\r\nHost: {address}\r\nAccept: text/event-stream\r\n{header}\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let device = state.web.snapshot()["devices"][0]["id"].as_str().unwrap().to_string();
        assert!(state.web.revoke(Some(&device)).unwrap());
        {
            use tokio::io::AsyncReadExt as _;
            let mut response = Vec::new();
            let ended = tokio::time::timeout(Duration::from_secs(5), async {
                let mut buffer = [0u8; 4096];
                loop {
                    match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            response.extend_from_slice(&buffer[..read]);
                            // chunked transfer: the terminating chunk ends the stream
                            if response.ends_with(b"0\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
            })
            .await;
            assert!(ended.is_ok(), "the revoked device's event stream must end");
            assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
        }
        assert!(raw(address, "/v1/capabilities", &header).await.starts_with("HTTP/1.1 401"));

        // Off: the listener closes.
        state
            .web
            .update(web_access::Update { mode: web_access::Mode::Off, networks: vec![] })
            .unwrap();
        reconcile_web_access(&state).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
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
        assert_eq!(value["build"], BUILD_ID);
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
    use crate::session::{Attachment, IdleLimits, RuntimeSpec, SessionManager, Status};
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
            control: Arc::new(control::ControlManager::new(&home, &home, None, &home.join("data"), None).expect("control manager")),
            events: events::EventHub::new(),
            web: Arc::new(web_access::WebAccess::disabled()),
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
    async fn the_hosts_own_flow_release_is_tagged_and_answered_after_its_reply() {
        let log = tempfile::NamedTempFile::new().unwrap();
        let log_path = log.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(50, &[
            ("FAKE_RUNTIME_PROMPT_LOG", &log_path),
            ("FAKE_RUNTIME_DELAY_MS", "1000"),
            ("FAKE_RUNTIME_FLOW_NOTICES", "1"),
        ]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("before-crash", "hello").unwrap();
        wait_until(|| std::fs::read_to_string(&log_path).is_ok_and(|text| text.contains("hello"))).await;
        let (_, crashed_at) = session.events_after(0);
        let previous = session.runtime_pid().expect("runtime pid");
        kill_tree(previous);
        wait_until(|| {
            session.status() == Status::Idle
                && session.runtime_pid().is_some_and(|pid| pid != previous)
                && session.events_after(crashed_at).0.iter().any(|event| event.event == "session.command_done")
        })
        .await;
        let flow: Vec<String> = session
            .events_after(crashed_at)
            .0
            .iter()
            .filter(|event| event.event == "session.notice" || event.event == "session.command_done")
            .map(|event| match event.event.as_str() {
                "session.notice" => format!(
                    "notice[{}]:{}",
                    event.data["command"]["origin"].as_str().unwrap_or("-"),
                    event.data["message"].as_str().unwrap_or("").split(':').next().unwrap_or("")
                ),
                _ => format!(
                    "done[{}]:{}:{}",
                    event.data["origin"].as_str().unwrap_or(""),
                    event.data["text"].as_str().unwrap_or(""),
                    event.data["success"]
                ),
            })
            .collect();
        // The recovery announcement runs on its own in the runtime, so it can land
        // before or inside the release's window; only its place before the reply counts.
        assert!(flow[0].ends_with(":Flow control is holding automated work"), "{flow:?}");
        assert_eq!(
            flow[1..],
            [
                "notice[host]:Flow clear released 1 request hold. Receipt evidence was preserved. Continue with a new message.",
                "done[host]:/flow clear:true",
            ],
            "{flow:?}"
        );
    }

    #[tokio::test]
    async fn a_queued_follow_up_is_listed_after_the_reply_it_waited_for() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
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
        // A waiting message is in the queue, not yet in the conversation.
        assert_eq!(rows, vec!["user", "assistant*"], "{history}");
        let queue = session.summary()["queue"].clone();
        assert_eq!(queue.as_array().map(Vec::len), Some(1), "{queue}");
        assert_eq!(queue[0]["text"], "two");
    }

    fn conversation(session: &crate::session::Session) -> Vec<String> {
        let mut rows: Vec<String> = session.history(200, None)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| format!("{}:{}", row["kind"].as_str().unwrap_or(""), row["text"].as_str().unwrap_or("")))
            .collect();
        rows.reverse();
        rows
    }

    fn queue_texts(session: &crate::session::Session) -> Vec<String> {
        session.summary()["queue"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["text"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[tokio::test]
    async fn a_message_sent_during_a_run_steers_it_once_in_order() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "3"),
                ("FAKE_RUNTIME_DELAY_MS", "60"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
        let receipt = session.send("second", "two").unwrap();
        assert_eq!(receipt["waiting"], true, "{receipt}");
        session.send("third", "three").unwrap();
        assert_eq!(queue_texts(&session), vec!["two", "three"]);
        // Sending the same message again (a reconnecting client) changes nothing.
        session.send("second", "two").unwrap();
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let rows = conversation(&session);
        let users: Vec<&String> = rows.iter().filter(|row| row.starts_with("user:")).collect();
        assert_eq!(users, vec!["user:one", "user:two", "user:three"], "{rows:?}");
        // Each steered message sits between replies of the same run, in order.
        let two = rows.iter().position(|row| row == "user:two").unwrap();
        let three = rows.iter().position(|row| row == "user:three").unwrap();
        assert!(!rows[two - 1].starts_with("user:") && !rows[three - 1].starts_with("user:"), "{rows:?}");
        assert!(rows.last().unwrap().starts_with("assistant:"), "{rows:?}");
        // They went in as steer, not as new prompts.
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        assert_eq!(sent.lines().collect::<Vec<_>>(), vec!["one"], "{sent}");
    }

    #[tokio::test]
    async fn a_message_sent_before_the_first_reply_steers_the_next_step() {
        // The runtime takes waiting steers once more just before its first model
        // call; a steer handed over then would join the first message. It must
        // wait for the first reply to start, and land as step 2.
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "2"),
                ("FAKE_RUNTIME_DELAY_MS", "150"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.status() == Status::Running).await;
        let receipt = session.send("second", "two").unwrap();
        assert_eq!(receipt["waiting"], true, "{receipt}");
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let rows = conversation(&session);
        let one = rows.iter().position(|row| row == "user:one").unwrap();
        let two = rows.iter().position(|row| row == "user:two").unwrap();
        assert!(rows[one + 1].starts_with("assistant:"), "the first message is answered on its own: {rows:?}");
        assert!(two > one + 1 && !rows[two - 1].starts_with("user:"), "{rows:?}");
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        assert_eq!(sent.lines().collect::<Vec<_>>(), vec!["one"], "it went in as steer: {sent}");
    }

    #[tokio::test]
    async fn a_steer_still_on_its_way_when_the_run_ends_is_used_once() {
        // The runtime queues a steer only after its input handlers ran, and it
        // handles other commands meanwhile. A run that ends while a steer is on
        // its way must not take back an empty queue and start the message as a
        // new turn too: the steer lands later and the message would run twice.
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "1"),
                ("FAKE_RUNTIME_DELAY_MS", "40"),
                ("FAKE_RUNTIME_STEER_DELAY_MS", "400"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.status() == Status::Running).await;
        session.send("second", "two").unwrap();
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        tokio::time::sleep(Duration::from_millis(800)).await;
        wait_until(|| session.status() == Status::Idle).await;
        let rows = conversation(&session);
        assert_eq!(rows.iter().filter(|row| *row == "user:two").count(), 1, "{rows:?}");
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        let runs = sent.lines().count();
        assert!(runs <= 2, "{sent}");
    }

    #[tokio::test]
    async fn a_stop_before_the_run_starts_still_stops_that_run() {
        // The runtime awaits its input handlers before the agent run exists; an
        // abort in that window is a no-op there, so the host repeats it.
        let (manager, _home, workspace) = manager_with_env(
            50,
            &[("FAKE_RUNTIME_INPUT_DELAY_MS", "300"), ("FAKE_RUNTIME_DELAY_MS", "200")],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let (_, before) = session.events_after(0);
        session.send("early", "hello").unwrap();
        wait_until(|| session.status() == Status::Running).await;
        assert_eq!(session.cancel_message("early").unwrap()["status"], "cancelling");
        wait_until(|| session.status() == Status::Idle).await;
        let events = session.events_after(before).0;
        let end = events.iter().find(|event| event.event == "turn.end").expect("turn.end");
        assert_eq!(end.data["status"], "interrupted", "{:?}", end.data);
        let rows = conversation(&session);
        // At most what was already on its way when the repeated abort arrived.
        assert!(!rows.contains(&"assistant:hello".to_string()), "{rows:?}");
    }

    #[tokio::test]
    async fn stop_takes_steered_messages_back_and_continue_sends_them_once() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "2"),
                ("FAKE_RUNTIME_HANG_TOOL", "1"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
        session.send("second", "two").unwrap();
        // The tool never finishes, so the run never reaches a step boundary.
        tokio::time::sleep(Duration::from_millis(300)).await;
        session.interrupt().unwrap();
        wait_until(|| session.status() == Status::Idle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let summary = session.summary();
        assert_eq!(queue_texts(&session), vec!["two"], "{summary}");
        assert_eq!(summary["queue"][0]["state"], "returned", "{summary}");
        // A client that attaches now (a reopened window) sees the same queue.
        let snapshot = session.snapshot_event().data;
        assert_eq!(snapshot["queue"], summary["queue"], "{snapshot}");
        assert!(snapshot.get("failedTurn").is_some() && snapshot.get("firstOutput").is_some(), "{snapshot}");
        assert!(!conversation(&session).contains(&"user:two".to_string()));
        session.continue_queue().unwrap();
        // It runs as its own turn now (this fixture's runs wait on a tool).
        wait_until(|| queue_texts(&session).is_empty() && std::fs::read_to_string(&prompt_log).is_ok_and(|text| text.lines().count() == 2)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let rows = conversation(&session);
        assert_eq!(rows.iter().filter(|row| *row == "user:two").count(), 1, "{rows:?}");
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        assert_eq!(sent.lines().collect::<Vec<_>>(), vec!["one", "two"], "{sent}");
    }

    /// A run the runtime started itself (Flow continuing its work) is the
    /// session's run like any other: it streams, it is shown, and a message
    /// sent during it is steered into it, never written as a new prompt (which
    /// the runtime refuses: "Agent is already processing").
    #[tokio::test]
    async fn a_message_sent_during_a_run_the_runtime_started_steers_it() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let steers = tempfile::NamedTempFile::new().unwrap();
        let steer_log = steers.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_SELF_RUN", "ready"),
                ("FAKE_RUNTIME_SELF_RUN_TEXT", "flow continues with task two of its list"),
                ("FAKE_RUNTIME_DELAY_MS", "40"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
                ("FAKE_RUNTIME_STEER_LOG", &steer_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_until(|| session.summary()["activeTurn"]["origin"] == "runtime").await;
        let summary = session.summary();
        assert_eq!(summary["status"], "running", "{summary}");
        assert!(summary["activeTurn"]["clientMessageId"].is_null(), "{summary}");
        let receipt = session.send("mine", "hello").unwrap();
        assert_eq!(receipt["waiting"], true, "a run is in progress: {receipt}");
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let summary = session.summary();
        assert!(summary["activeTurn"].is_null() && summary["failedTurn"].is_null(), "{summary}");
        let rows = conversation(&session);
        assert_eq!(rows.first().map(String::as_str), Some("assistant:flow continues with task two of its list"), "its reply is in history: {rows:?}");
        assert_eq!(rows.iter().filter(|row| *row == "user:hello").count(), 1, "{rows:?}");
        assert_eq!(rows.last().map(String::as_str), Some("assistant:hello"), "{rows:?}");
        assert_eq!(std::fs::read_to_string(&steer_log).unwrap().lines().collect::<Vec<_>>(), vec!["hello"]);
        assert_eq!(std::fs::read_to_string(&prompt_log).unwrap_or_default(), "", "never a prompt");
    }

    /// The runtime starts a run of its own while the user's prompt is still in
    /// its input handlers. The prompt did not start that run; the runtime
    /// refuses it, and the message is steered into that run instead of failing.
    #[tokio::test]
    async fn a_prompt_that_loses_to_a_run_the_runtime_started_is_steered() {
        let steers = tempfile::NamedTempFile::new().unwrap();
        let steer_log = steers.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_SELF_RUN", "prompt"),
                ("FAKE_RUNTIME_SELF_RUN_TEXT", "flow work that was already scheduled"),
                ("FAKE_RUNTIME_INPUT_DELAY_MS", "300"),
                ("FAKE_RUNTIME_DELAY_MS", "40"),
                ("FAKE_RUNTIME_STEER_LOG", &steer_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut events = session.subscribe();
        let reader = tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                let _ = tx.send((event.event.clone(), event.data.clone()));
            }
        });
        session.send("mine", "hello").unwrap();
        wait_until(|| session.summary()["activeTurn"]["origin"] == "runtime").await;
        let summary = session.summary();
        assert_eq!(summary["queue"][0]["clientMessageId"], "mine", "{summary}");
        assert_eq!(summary["queue"][0]["state"], "delivering", "{summary}");
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let summary = session.summary();
        assert!(summary["failedTurn"].is_null(), "{summary}");
        let rows = conversation(&session);
        assert_eq!(rows.iter().filter(|row| *row == "user:hello").count(), 1, "{rows:?}");
        assert_eq!(rows.last().map(String::as_str), Some("assistant:hello"), "{rows:?}");
        assert_eq!(std::fs::read_to_string(&steer_log).unwrap().lines().collect::<Vec<_>>(), vec!["hello"]);
        reader.abort();
        while let Ok((event, data)) = rx.try_recv() {
            assert_ne!(event, "error", "the refusal is not an error: {data}");
        }
    }

    /// Stop works on a run the runtime started; what it did not use is back in
    /// the host queue, and nothing is lost or sent twice.
    #[tokio::test]
    async fn stop_during_a_run_the_runtime_started_returns_waiting_messages() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_SELF_RUN", "ready"),
                ("FAKE_RUNTIME_SELF_RUN_TEXT", "a long piece of flow work that takes a while to write out in full"),
                ("FAKE_RUNTIME_DELAY_MS", "60"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_until(|| session.summary()["activeTurn"]["origin"] == "runtime").await;
        session.send("second", "two").unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.interrupt().unwrap();
        wait_until(|| session.status() == Status::Idle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let summary = session.summary();
        assert!(summary["activeTurn"].is_null(), "{summary}");
        assert_eq!(queue_texts(&session), vec!["two"], "{summary}");
        assert_eq!(summary["queue"][0]["state"], "returned", "{summary}");
        session.continue_queue().unwrap();
        wait_until(|| queue_texts(&session).is_empty() && session.status() == Status::Idle && std::fs::read_to_string(&prompt_log).is_ok_and(|text| text.lines().count() == 1)).await;
        let rows = conversation(&session);
        assert_eq!(rows.iter().filter(|row| *row == "user:two").count(), 1, "{rows:?}");
    }

    /// Stop is the host's: it reports the run as stopping, ends it, and a run
    /// the runtime starts on its own right after (Flow resuming) is a run like
    /// any other: shown, given waiting messages as steers, and stoppable.
    #[tokio::test]
    async fn stop_reports_stopping_and_a_run_the_runtime_starts_after_it_is_stoppable() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_SELF_RUN", "stop"),
                ("FAKE_RUNTIME_SELF_RUN_TEXT", "flow picks its task list up again and keeps writing for a while"),
                ("FAKE_RUNTIME_DELAY_MS", "60"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "a reply that is long enough to stop part way").unwrap();
        wait_until(|| session.summary()["activeTurn"]["phase"] == "running" && !conversation(&session).iter().any(|row| row.starts_with("assistant:"))).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let stopped = session.interrupt().unwrap();
        assert_eq!(stopped["status"], "cancelling", "{stopped}");
        // Flow starts its own run once the stopped one settles.
        wait_until(|| session.summary()["activeTurn"]["origin"] == "runtime").await;
        let summary = session.summary();
        assert_eq!(summary["activeTurn"]["phase"], "running", "{summary}");
        assert_eq!(summary["status"], "running", "{summary}");
        let receipt = session.send("second", "two").unwrap();
        assert_eq!(receipt["waiting"], true, "{receipt}");
        let stopped = session.interrupt().unwrap();
        assert_eq!(stopped["status"], "cancelling", "{stopped}");
        assert_eq!(session.summary()["activeTurn"]["phase"], "cancelling");
        wait_until(|| session.status() == Status::Idle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let summary = session.summary();
        assert!(summary["activeTurn"].is_null(), "{summary}");
        assert_eq!(queue_texts(&session), vec!["two"], "{summary}");
        assert_eq!(summary["queue"][0]["state"], "returned", "{summary}");
        // The session list says the host holds a message for this idle session,
        // so a client opens it live rather than from its file.
        let info = session.info();
        assert_eq!(info["queued"], 1, "{info}");
        assert_eq!(info["status"], "idle", "{info}");
        assert_eq!(session.interrupt().unwrap()["status"], "idle");
        session.continue_queue().unwrap();
        wait_until(|| queue_texts(&session).is_empty() && session.status() == Status::Idle && std::fs::read_to_string(&prompt_log).is_ok_and(|text| text.lines().count() == 2)).await;
        let rows = conversation(&session);
        assert_eq!(rows.iter().filter(|row| *row == "user:two").count(), 1, "{rows:?}");
    }

    /// Stop while the prompt is still in the runtime's input handlers, where an
    /// abort finds no run: the host stops the run when it starts.
    #[tokio::test]
    async fn stop_before_the_runtime_starts_the_run_stops_it_when_it_starts() {
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_INPUT_DELAY_MS", "300"),
                ("FAKE_RUNTIME_DELAY_MS", "60"),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "a reply that would take a good while to write out").unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let stopped = session.interrupt().unwrap();
        assert_eq!(stopped["status"], "cancelling", "{stopped}");
        let summary = session.summary();
        assert_eq!(summary["activeTurn"]["phase"], "cancelling", "{summary}");
        assert_eq!(summary["status"], "running", "{summary}");
        wait_until(|| session.status() == Status::Idle).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(session.summary()["activeTurn"].is_null());
        let rows = conversation(&session);
        assert!(
            !rows.iter().any(|row| row == "assistant:a reply that would take a good while to write out"),
            "the run was stopped, not answered in full: {rows:?}"
        );
    }

    /// A prompt the runtime answers "started" whose run ends before the agent
    /// starts (no `agent_start`): the settle still ends the run.
    #[tokio::test]
    async fn a_run_that_settles_without_starting_ends() {
        let (manager, _home, workspace) = manager_with_env(200, &[]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "NOSTART one").unwrap();
        wait_until(|| session.status() == Status::Idle && session.summary()["activeTurn"].is_null()).await;
        session.send("second", "two").unwrap();
        wait_until(|| session.status() == Status::Idle && conversation(&session).last().map(String::as_str) == Some("assistant:two")).await;
    }

    /// A prompt displaced by a run the runtime started, which the runtime then
    /// starts after all (its own run ended while the prompt waited in the input
    /// handlers): it becomes the run, with its row once in history.
    #[tokio::test]
    async fn a_displaced_prompt_the_runtime_starts_later_becomes_the_run() {
        let steers = tempfile::NamedTempFile::new().unwrap();
        let steer_log = steers.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_SELF_RUN", "prompt"),
                ("FAKE_RUNTIME_SELF_RUN_TEXT", "ok"),
                ("FAKE_RUNTIME_INPUT_DELAY_MS", "500"),
                ("FAKE_RUNTIME_DELAY_MS", "15"),
                ("FAKE_RUNTIME_STEER_LOG", &steer_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("mine", "hello").unwrap();
        wait_until(|| session.summary()["queue"][0]["state"] == "delivering").await;
        wait_until(|| session.summary()["activeTurn"]["clientMessageId"] == "mine").await;
        wait_until(|| session.status() == Status::Idle).await;
        let summary = session.summary();
        assert!(summary["failedTurn"].is_null() && summary["queue"].as_array().is_some_and(Vec::is_empty), "{summary}");
        let rows = conversation(&session);
        assert_eq!(rows, vec!["assistant:ok", "user:hello", "assistant:hello"], "{rows:?}");
        assert_eq!(std::fs::read_to_string(&steer_log).unwrap_or_default(), "", "never steered");
    }

    /// Removing a message the runtime has as a prompt it has not answered: it
    /// cannot be taken back, so the host drops it when the runtime answers.
    #[tokio::test]
    async fn removing_a_displaced_prompt_drops_it_when_the_runtime_answers() {
        let steers = tempfile::NamedTempFile::new().unwrap();
        let steer_log = steers.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_SELF_RUN", "prompt"),
                ("FAKE_RUNTIME_SELF_RUN_TEXT", "flow work that was already scheduled"),
                ("FAKE_RUNTIME_INPUT_DELAY_MS", "300"),
                ("FAKE_RUNTIME_DELAY_MS", "40"),
                ("FAKE_RUNTIME_STEER_LOG", &steer_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("mine", "hello").unwrap();
        wait_until(|| session.summary()["queue"][0]["state"] == "delivering").await;
        assert_eq!(session.cancel_message("mine").unwrap()["status"], "cancelling");
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let rows = conversation(&session);
        assert!(!rows.iter().any(|row| row == "user:hello"), "{rows:?}");
        assert_eq!(std::fs::read_to_string(&steer_log).unwrap_or_default(), "", "never steered");
        assert!(session.summary()["activeTurn"].is_null());
    }

    #[tokio::test]
    async fn a_removed_message_never_reaches_the_runtime() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "2"),
                ("FAKE_RUNTIME_HANG_TOOL", "1"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
        session.send("second", "two").unwrap();
        session.send("third", "three").unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(session.cancel_message("second").unwrap()["status"], "cancelled");
        assert_eq!(queue_texts(&session), vec!["three"]);
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.interrupt().unwrap();
        wait_until(|| session.status() == Status::Idle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.continue_queue().unwrap();
        wait_until(|| queue_texts(&session).is_empty() && std::fs::read_to_string(&prompt_log).is_ok_and(|text| text.lines().count() == 2)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let rows = conversation(&session);
        assert!(!rows.contains(&"user:two".to_string()), "{rows:?}");
        assert_eq!(rows.iter().filter(|row| *row == "user:three").count(), 1, "{rows:?}");
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        assert_eq!(sent.lines().collect::<Vec<_>>(), vec!["one", "three"], "{sent}");
    }

    #[tokio::test]
    async fn a_message_the_runtime_will_not_steer_runs_as_the_next_turn() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "2"),
                ("FAKE_RUNTIME_DELAY_MS", "60"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let mut rx = session.subscribe();
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
        session.send("second", "/ext run").unwrap();
        wait_until(|| std::fs::read_to_string(&prompt_log).is_ok_and(|text| text.lines().count() == 2)).await;
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        assert_eq!(sent.lines().collect::<Vec<_>>(), vec!["one", "/ext run"], "{sent}");
        // The refusal is the host's to handle; nobody sees a runtime error for it.
        while let Ok(event) = rx.try_recv() {
            assert_ne!(event.event, "error", "{:?}", event.data);
        }
    }

    #[tokio::test]
    async fn a_message_flow_holds_waits_visibly_and_runs_once_when_released() {
        let prompts = tempfile::NamedTempFile::new().unwrap();
        let prompt_log = prompts.path().to_str().unwrap().to_string();
        let (manager, _home, workspace) = manager_with_env(
            200,
            &[
                ("FAKE_RUNTIME_STEPS", "2"),
                ("FAKE_RUNTIME_DELAY_MS", "80"),
                ("FAKE_RUNTIME_PROMPT_LOG", &prompt_log),
            ],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
        session.send("second", "HOLD me").unwrap();
        // Taken by the extension, not delivered: still waiting, shown as held, not in history.
        wait_until(|| session.summary()["queue"][0]["state"] == "held").await;
        assert!(session.cancel_message("second").is_err(), "a held message cannot be removed here");
        let users = |session: &crate::session::Session| -> Vec<String> {
            conversation(session).into_iter().filter_map(|row| row.strip_prefix("user:").map(str::to_string)).collect()
        };
        assert_eq!(users(&session), vec!["one"]);
        // Released after the run ended: the host runs it as the next turn, once.
        wait_until(|| std::fs::read_to_string(&prompt_log).is_ok_and(|text| text.lines().count() == 2)).await;
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let sent = std::fs::read_to_string(&prompt_log).unwrap();
        assert_eq!(sent.lines().collect::<Vec<_>>(), vec!["one", "HOLD me"], "{sent}");
        assert_eq!(users(&session), vec!["one", "HOLD me"]);
    }

    #[tokio::test]
    async fn a_steered_message_keeps_its_images() {
        let (manager, _home, workspace) =
            manager_with_env(200, &[("FAKE_RUNTIME_STEPS", "3"), ("FAKE_RUNTIME_DELAY_MS", "60")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("first", "one").unwrap();
        wait_until(|| session.history(50, None)["messages"].as_array().is_some_and(|rows| rows.iter().any(|row| row["kind"] == "assistant"))).await;
        session
            .send_with_client(
                "second",
                "look",
                None,
                &[Attachment { name: "pixel.png".into(), mime_type: "image/png".into(), data: "AAEC".into() }],
            )
            .unwrap();
        assert_eq!(session.summary()["queue"][0]["images"], 1);
        wait_until(|| session.status() == Status::Idle && queue_texts(&session).is_empty()).await;
        let history = session.history(50, None);
        let user = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "user" && row["text"] == "look")
            .cloned()
            .unwrap();
        assert_eq!(user["attachments"][0]["mimeType"], "image/png", "{user}");
        let messages = session.request(json!({ "type": "get_messages" }), Duration::from_secs(2)).await.unwrap();
        let delivered = messages.get("data").unwrap_or(&messages)["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "user" && message["content"][0]["text"] == "look")
            .cloned()
            .unwrap();
        assert_eq!(delivered["content"][1]["mimeType"], "image/png", "{delivered}");
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

    /// A saved conversation opened while its runtime is not up: nothing can be
    /// sent before the runtime reports the session's model.
    async fn failing_session(env: &[(&str, &str)]) -> (Arc<crate::session::Session>, Arc<SessionManager>, tempfile::TempDir, tempfile::TempDir, String) {
        let (manager, home, workspace) = manager_with_env(50, env);
        let header = json!({ "type": "session", "version": 3, "id": "fails", "timestamp": "2026-01-01T00:00:00Z", "cwd": workspace.path().to_string_lossy() });
        let file = workspace.path().join("fails.jsonl");
        std::fs::write(&file, format!("{header}\n")).unwrap();
        let path = file.to_string_lossy().into_owned();
        let session = manager
            .create(workspace.path().to_str().unwrap(), Some(path.clone()), None)
            .unwrap();
        assert_eq!(session.send("waiting", "hello").unwrap_err().code, "no-model");
        (session, manager, home, workspace, path)
    }

    /// What a client is left with once the session has failed: no turn to
    /// wait for, no runtime to stop, and the reason.
    fn assert_failed_and_settled(session: &crate::session::Session, code: &str) {
        let summary = session.summary();
        assert_eq!(summary["status"], "error", "{summary}");
        assert!(summary["activeTurn"].is_null(), "a failed session keeps no turn waiting: {summary}");
        assert_eq!(session.runtime_pid(), None, "a failed session keeps no runtime");
        let (events, _) = session.events_after(1);
        let error = events.iter().rev().find(|event| event.event == "error").expect("an error event");
        assert_eq!(error.data["code"], code, "{}", error.data);
        // Stop has nothing left to wait for (it used to answer "cancelling" or
        // leave "Stopping…" up forever).
        let stop = session.cancel_message("waiting").unwrap();
        assert_ne!(stop["status"], "cancelling", "{stop}");
    }

    #[tokio::test]
    async fn a_session_the_runtime_refuses_to_open_fails_at_once_and_ends_the_waiting_turn() {
        let starts = tempfile::NamedTempFile::new().unwrap();
        let starts_path = starts.path().to_string_lossy().into_owned();
        let (session, manager, _home, _workspace, path) = failing_session(&[
            ("FAKE_RUNTIME_SWITCH_ERROR", "Flow session metadata is missing or inconsistent."),
            ("FAKE_RUNTIME_START_LOG", &starts_path),
        ])
        .await;
        wait_until(|| session.status() == Status::Error).await;
        assert_failed_and_settled(&session, "session-attach-failed");
        let (events, _) = session.events_after(1);
        let error = events.iter().rev().find(|event| event.event == "error").unwrap();
        let message = error.data["message"].as_str().unwrap();
        assert!(message.contains("Flow session metadata is missing or inconsistent."), "{message}");
        // The refusal is about the file, not the runtime: no restart may follow.
        tokio::time::sleep(Duration::from_millis(600)).await;
        let started = std::fs::read_to_string(starts.path()).unwrap().lines().count();
        assert_eq!(started, 1, "a refused session is not retried on new runtimes");
        assert_eq!(session.status(), Status::Error);
        // Opening it again is a new attempt with a new session.
        let again = manager
            .create(_workspace.path().to_str().unwrap(), Some(path), None)
            .unwrap();
        assert!(!Arc::ptr_eq(&again, &session));
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_runtime_that_keeps_dying_while_starting_fails_the_session() {
        let (session, manager, _home, _workspace, _path) =
            failing_session(&[("FAKE_RUNTIME_IGNORE_STDIN", "1"), ("FAKE_RUNTIME_EXIT_ON_START_MS", "5")]).await;
        for _ in 0..200 {
            if session.status() == Status::Error {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_failed_and_settled(&session, "runtime-crashed");
        manager.stop_all();
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
    async fn a_new_session_starts_its_runtime_and_sends_once_it_has_a_model() {
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
        // Its runtime starts at once; until it answers, the model is resolving.
        assert_eq!(value["status"], "starting");
        assert_eq!(value["model"], json!({ "state": "resolving" }));
        let session_id = value["sessionId"].as_str().unwrap().to_string();
        let session = manager.get(&session_id).unwrap();
        wait_status(&session, Status::Idle).await;
        assert!(session.runtime_pid().is_some());
        assert_eq!(session.summary()["model"]["state"], "ready");

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
            format!("{{\"type\":\"session\",\"cwd\":\"{cwd}\"}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n"),
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
            format!("{{\"type\":\"session\",\"cwd\":\"{cwd}\"}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n"),
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

    // #67: with no tools.json the Tools page still gets a full image section.
    #[tokio::test]
    async fn tools_read_fills_defaults_when_the_file_is_missing_or_partial() {
        let (manager, home, _workspace) = manager(50);
        let app = app(manager);
        let missing = call(
            app.clone(),
            request(Method::GET, "/v1/tools")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(missing.0, StatusCode::OK, "{}", missing.2);
        let body: Value = serde_json::from_str(&missing.2).unwrap();
        assert_eq!(body["exists"], false);
        assert_eq!(
            body["settings"],
            json!({ "image": { "enabled": true, "provider": "", "model": "", "size": "1K", "maxImages": 3 }, "reviewTools": ["generate_image"] })
        );

        let agent = home.path().join("data").join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            agent.join("tools.json"),
            json!({ "image": { "enabled": false, "model": "bad model!", "size": "9K", "maxImages": 50 } })
                .to_string(),
        )
        .unwrap();
        let partial = call(
            app,
            request(Method::GET, "/v1/tools")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        let body: Value = serde_json::from_str(&partial.2).unwrap();
        assert_eq!(
            body["settings"],
            json!({ "image": { "enabled": false, "provider": "", "model": "", "size": "1K", "maxImages": 10 }, "reviewTools": ["generate_image"] })
        );
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
        // Each step of the run is its own reply; together they hold everything.
        let replies = rows
            .iter()
            .filter(|row| row["kind"] == "assistant")
            .collect::<Vec<_>>();
        assert_eq!(replies.len(), 2, "{history}");
        let types = replies
            .iter()
            .flat_map(|row| row["blocks"].as_array().unwrap().iter())
            .filter_map(|block| block["type"].as_str())
            .collect::<Vec<_>>();
        assert!(types.contains(&"thinking"), "{history}");
        assert!(types.contains(&"toolCall"), "{history}");
        assert!(types.contains(&"toolResult"), "{history}");
        let tool = rows.iter().find(|row| row["kind"] == "tool").unwrap();
        assert_eq!(tool["tool"]["status"], "ok", "{tool}");
    }

    /// Polls the session summary while a run goes on and records each step state
    /// it shows, in order, until the session is idle again.
    async fn step_states(session: &crate::session::Session) -> Vec<Value> {
        let mut seen: Vec<Value> = Vec::new();
        for _ in 0..2000 {
            let step = session.summary()["activeTurn"]["step"].clone();
            if !step.is_null() && seen.last() != Some(&step) {
                seen.push(step);
            }
            if session.status() == Status::Idle && !seen.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        seen
    }

    #[tokio::test]
    async fn a_run_of_several_steps_keeps_each_step_as_its_own_reply() {
        let (manager, home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_STEPS", "3"), ("FAKE_RUNTIME_DELAY_MS", "25")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) = subscribe(app, &session.id).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.send("steps-1", "go").unwrap();
        let states = step_states(&session).await;
        let mut starts = Vec::new();
        let mut done = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            match event.0.as_str() {
                "message.start" => starts.push(event.1["step"].clone()),
                "message.done" => done.push((event.1["step"].clone(), event.1["stopReason"].clone())),
                "turn.end" => break,
                _ => {}
            }
        }
        reader.abort();
        // The client hears each step begin and end.
        assert_eq!(starts, vec![json!(1), json!(2), json!(3)]);
        assert_eq!(
            done,
            vec![(json!(1), json!("toolUse")), (json!(2), json!("toolUse")), (json!(3), json!("stop"))]
        );
        // The summary says which step runs and what it is doing.
        let names = states.iter().map(|step| step["state"].as_str().unwrap_or("")).collect::<Vec<_>>();
        for state in ["waiting_model", "thinking", "writing", "tools"] {
            assert!(names.contains(&state), "{state} missing from {states:?}");
        }
        assert!(states.iter().any(|step| step["n"] == 3), "{states:?}");
        assert!(
            states.iter().any(|step| step["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["name"] == "bash"))),
            "{states:?}"
        );
        // History: one reply per step, in order, reasoning kept, results on their calls.
        let history = session.history(50, None);
        let mut replies = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["kind"] == "assistant")
            .cloned()
            .collect::<Vec<_>>();
        replies.reverse();
        assert_eq!(replies.len(), 3, "{history}");
        for (index, reply) in replies.iter().enumerate() {
            let n = index + 1;
            assert_eq!(reply["step"], json!(n), "{reply}");
            let blocks = reply["blocks"].as_array().unwrap();
            assert!(blocks.iter().any(|block| block["type"] == "thinking" && block["text"] == format!("think {n}")), "{reply}");
            if n < 3 {
                let call = format!("call-{n}");
                assert!(blocks.iter().any(|block| block["type"] == "toolCall" && block["toolCallId"] == call), "{reply}");
                assert!(blocks.iter().any(|block| block["type"] == "toolResult" && block["toolCallId"] == call && block["ok"] == true), "{reply}");
            }
            assert_eq!(reply["usage"]["output"], json!(n), "{reply}");
        }
        // Each step's wait for the model is timed.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let log = std::fs::read_to_string(home.path().join("logs").join("host.log")).unwrap_or_default();
        assert_eq!(log.matches("\"step.start\"").count(), 3, "{log}");
        assert_eq!(log.matches("\"step.first_output\"").count(), 3, "{log}");
        assert_eq!(log.matches("\"tool.end\"").count(), 2, "{log}");
    }

    #[tokio::test]
    async fn a_provider_retry_shows_while_it_waits() {
        let (manager, _home, workspace) = manager_with_env(
            50,
            &[("FAKE_RUNTIME_STEPS", "2"), ("FAKE_RUNTIME_STEP_RETRY", "1"), ("FAKE_RUNTIME_DELAY_MS", "60")],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("retry-1", "go").unwrap();
        let states = step_states(&session).await;
        let retry = states
            .iter()
            .find(|step| step["state"] == "retrying")
            .unwrap_or_else(|| panic!("no retry in {states:?}"));
        assert_eq!(retry["retry"]["attempt"], 1);
        assert_eq!(retry["retry"]["maxAttempts"], 3);
        assert_eq!(retry["retry"]["error"], "overloaded");
        let after = states.iter().skip_while(|step| step["state"] != "retrying").nth(1).unwrap();
        assert_eq!(after["state"], "waiting_model", "{states:?}");
        assert!(after["retry"].is_null(), "{states:?}");
    }

    #[tokio::test]
    async fn a_tool_cut_off_by_stop_reads_as_interrupted() {
        let (manager, _home, workspace) = manager_with_env(
            50,
            &[("FAKE_RUNTIME_STEPS", "3"), ("FAKE_RUNTIME_HANG_TOOL", "1"), ("FAKE_RUNTIME_DELAY_MS", "15")],
        );
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) = subscribe(app, &session.id).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        session.send("hang-1", "go").unwrap();
        for _ in 0..300 {
            let step = session.summary()["activeTurn"]["step"].clone();
            if step["state"] == "tools" && step["tools"][0]["id"] == "call-2" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(session.summary()["activeTurn"]["step"]["tools"][0]["id"], "call-2");
        session.interrupt().unwrap();
        let closed = loop {
            let event = next_event(&mut rx, "tool.result").await;
            if event["toolCallId"] == "call-2" {
                break event;
            }
        };
        assert_eq!(closed["interrupted"], true);
        wait_status(&session, Status::Idle).await;
        reader.abort();
        let history = session.history(50, None);
        let rows = history["messages"].as_array().unwrap();
        let tool = rows.iter().find(|row| row["id"] == "tool:call-2").unwrap();
        assert_eq!(tool["tool"]["status"], "interrupted", "{tool}");
        let reply = rows
            .iter()
            .find(|row| row["kind"] == "assistant" && row["step"] == 2)
            .unwrap();
        assert!(
            reply["blocks"].as_array().unwrap().iter().any(|block| block["type"] == "toolResult" && block["toolCallId"] == "call-2" && block["interrupted"] == true),
            "{reply}"
        );
        // Nothing is left looking busy.
        assert!(!rows.iter().any(|row| row["tool"]["status"] == "running"), "{history}");
    }

    #[tokio::test]
    async fn an_extension_failure_is_reported_but_a_stale_context_race_is_not() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager.clone());
        let (mut rx, reader) = subscribe(app, &session.id).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut errors = Vec::new();
        for (id, text) in [
            ("stale-1", "EXTERR extension ctx is stale after session replacement"),
            ("boom-1", "EXTERR flow guard crashed"),
        ] {
            wait_status(&session, Status::Idle).await;
            session.send(id, text).unwrap();
            loop {
                let (name, data) = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                    .await
                    .expect("timed out")
                    .expect("stream closed");
                if name == "error" {
                    errors.push(data);
                } else if name == "turn.end" {
                    break;
                }
            }
        }
        reader.abort();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(errors[0]["message"], "flow guard crashed");
        assert_eq!(errors[0]["code"], "extension-error");
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
        // The level in effect is the one the runtime reports, not an echo.
        assert!(!thinking.2.contains("\"high\""), "{}", thinking.2);
        for _ in 0..100 {
            if session.summary()["thinkingLevel"] == "high" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(session.summary()["thinkingLevel"], "high");
    }

    #[tokio::test]
    async fn the_session_shows_the_runtime_model_and_its_lists() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        // Known before the session is ready: the runtime's own answer.
        let summary = session.summary();
        assert_eq!(summary["model"]["state"], "ready", "{summary}");
        assert_eq!(summary["model"]["id"], "model", "{summary}");
        assert_eq!(summary["model"]["name"], "fixture-model", "{summary}");
        // The lists are the same runtime's, unchanged.
        for _ in 0..100 {
            if session.summary()["models"].as_array().is_some_and(|models| models.len() == 2) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let summary = session.summary();
        assert_eq!(summary["models"][1]["id"], "other", "{summary}");
        assert_eq!(summary["thinkingLevels"], json!(["off", "low", "high"]), "{summary}");
        session.select_model("fixture", "other").await.unwrap();
        assert_eq!(session.summary()["model"]["id"], "other");
        assert_eq!(session.summary()["model"]["name"], "Fixture Other");
        session.select_thinking("high").await.unwrap();
        // The runtime reports the level it set.
        for _ in 0..100 {
            if session.summary()["thinkingLevel"] == "high" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(session.summary()["thinkingLevel"], "high");
    }

    #[tokio::test]
    async fn a_session_whose_runtime_has_no_model_cannot_send() {
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_NO_MODEL", "1")]);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.summary()["model"], json!({ "state": "none" }));
        let refused = session.send("first", "hello").unwrap_err();
        assert_eq!(refused.code, "no-model");
        assert!(!refused.retryable);
        assert_eq!(session.status(), Status::Idle);
    }

    #[tokio::test]
    async fn nothing_is_sent_or_chosen_before_the_runtime_reports_a_model() {
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().to_str().unwrap();
        // No runtime has answered for it: the host holds no model and no pick.
        let pending = manager.create_pending(path, None, None).unwrap();
        assert_eq!(pending.summary()["model"], json!({ "state": "resolving" }));
        let refused = pending.send("first", "hello").unwrap_err();
        assert_eq!(refused.code, "no-model");
        assert!(refused.retryable);
        let refused = pending.select_model("fixture", "other").await.unwrap_err();
        assert_eq!(refused.code, "model-resolving");
        let refused = pending.select_thinking("low").await.unwrap_err();
        assert_eq!(refused.code, "model-resolving");
        assert_eq!(pending.summary()["model"], json!({ "state": "resolving" }));
    }

    #[tokio::test]
    async fn a_rejected_model_switch_leaves_the_session_usable() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let refused = session.select_model("fixture", "missing").await.unwrap_err();
        assert_eq!(refused.code, "model-unavailable");
        assert!(refused.message.contains("Model not found"), "{}", refused.message);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(session.status(), Status::Idle);
        assert_eq!(session.summary()["model"]["id"], "model");
        session.send("after-switch", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        assert!(session.send("again", "hello").is_ok());
    }

    #[tokio::test]
    async fn a_saved_conversation_keeps_the_model_it_used() {
        let (manager, _home, workspace) = manager(50);
        let header = json!({ "type": "session", "version": 3, "id": "saved-model", "timestamp": "2026-01-01T00:00:00Z", "cwd": workspace.path().to_string_lossy() });
        let change = json!({ "type": "model_change", "id": "c1", "parentId": null, "timestamp": "2026-01-01T00:00:01Z", "provider": "fixture", "modelId": "own-model" });
        let file = workspace.path().join("saved.jsonl");
        std::fs::write(&file, format!("{header}\n{change}\n")).unwrap();
        let session = manager
            .create(workspace.path().to_str().unwrap(), Some(file.to_string_lossy().into_owned()), None)
            .unwrap();
        // The host does not guess the model from the file.
        assert_eq!(session.info()["model"], json!({ "state": "resolving" }));
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.info()["model"]["id"], "own-model", "{}", session.info());
        assert_eq!(session.info()["model"]["state"], "ready", "{}", session.info());
    }

    #[tokio::test]
    async fn a_new_session_takes_the_warm_runtime_and_the_pool_starts_the_next() {
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let _aim = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let status = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(status["state"], "ready", "{status}");
        let warm_pid = status["pid"].as_u64().unwrap() as u32;
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        session.attach_early();
        assert_eq!(session.runtime_pid(), Some(warm_pid));
        wait_status(&session, Status::Idle).await;
        wait_model_state(&session, "ready").await;
        session.send("first", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        let next = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(next["state"], "ready", "{next}");
        assert_ne!(next["pid"].as_u64().unwrap() as u32, warm_pid);
        assert_eq!(next["taken"], 1);
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_new_session_starts_its_runtime_at_once_without_a_warm_one() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        session.attach_early();
        assert_ne!(session.status(), Status::Pending);
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.summary()["model"]["state"], "ready");
        assert!(session.runtime_pid().is_some());
        session.send("m1", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        manager.stop_all();
    }

    #[tokio::test]
    async fn the_model_list_endpoint_relays_the_warm_runtime() {
        let (manager, _home, workspace) = manager(50);
        let app = app(manager.clone());
        // A session's runtime may predate a settings change: it is never asked.
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let none = call(app.clone(), request(Method::GET, "/v1/models").body(Body::empty()).unwrap()).await;
        assert_eq!(none.0, StatusCode::SERVICE_UNAVAILABLE, "{}", none.2);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        pool.aim(&std::fs::canonicalize(workspace.path()).unwrap());
        pool.wait_settled(Duration::from_secs(10)).await;
        let listed = call(app, request(Method::GET, "/v1/models").body(Body::empty()).unwrap()).await;
        assert_eq!(listed.0, StatusCode::OK, "{}", listed.2);
        let body: Value = serde_json::from_str(&listed.2).unwrap();
        assert_eq!(body["models"][0]["id"], "model", "{body}");
        assert_eq!(body["models"][1]["id"], "other", "{body}");
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_new_session_no_client_ever_showed_follows_the_idle_rule() {
        // An API caller without an event stream: its new session keeps its
        // runtime for the idle time, not only until the next reaper pass.
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_model_state(&session, "ready").await;
        manager.reap_idle(IdleLimits::all(Duration::from_secs(3600)));
        assert!(manager.get(&session.id).is_some());
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(manager.get(&session.id).is_none());
    }

    #[tokio::test]
    async fn an_untouched_new_session_nobody_shows_gives_its_runtime_back() {
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let folder = workspace.path().to_str().unwrap();
        let _aim = manager.create_pending(folder, None, None).unwrap();
        pool.wait_settled(Duration::from_secs(10)).await;
        let left = manager.create_pending(folder, None, None).unwrap();
        left.attach_early();
        wait_status(&left, Status::Idle).await;
        let _stream = manager.connect_client("window");
        manager.hold("window", &left.id);
        // Shown by a client: kept.
        manager.reap_idle(IdleLimits::all(Duration::from_secs(3600)));
        assert!(manager.get(&left.id).is_some());
        // Used: kept until the usual idle time.
        let used = manager.create_pending(folder, None, None).unwrap();
        used.attach_early();
        wait_model_state(&used, "ready").await;
        used.send("u1", "hello").unwrap();
        wait_status(&used, Status::Idle).await;
        // The client moves on: the untouched one is released at once, the used one is not.
        manager.hold("window", &used.id);
        let left_file = left.session_path.lock().unwrap().clone().expect("a new session has a file");
        let used_file = used.session_path.lock().unwrap().clone().expect("a new session has a file");
        manager.reap_idle(IdleLimits::all(Duration::from_secs(3600)));
        assert!(manager.get(&left.id).is_none());
        assert_eq!(left.status(), Status::Stopped);
        assert!(manager.get(&used.id).is_some());
        // #92: the never-used one leaves no file; the used one keeps its own.
        wait_until(|| !std::path::Path::new(&left_file).exists()).await;
        assert!(std::path::Path::new(&used_file).exists());
        manager.stop_all();
    }

    /// #93: visiting many sessions does not keep a runtime for each. Once the
    /// window moves on and the idle limit passes, only the session it shows
    /// keeps one (besides the warm pool).
    #[tokio::test]
    async fn sessions_the_window_left_give_their_runtimes_back() {
        let (manager, _home, workspace) = manager(50);
        let folder = workspace.path().to_str().unwrap();
        let _stream = manager.connect_client("window");
        let mut visited = Vec::new();
        for n in 0..5 {
            let path = workspace.path().join(format!("s{n}.jsonl"));
            let session = manager.create(folder, Some(path.to_string_lossy().into_owned()), None).unwrap();
            manager.hold("window", &session.id);
            wait_status(&session, Status::Idle).await;
            session.send(&format!("m{n}"), "hello").unwrap();
            wait_status(&session, Status::Idle).await;
            visited.push(session);
        }
        let limits = IdleLimits { idle: Duration::ZERO, pending: Duration::from_secs(3600), released_hold: Duration::from_secs(3600) };
        manager.reap_idle(limits);
        let live: Vec<_> = visited.iter().filter(|session| session.runtime_pid().is_some() && session.status() == Status::Idle).collect();
        assert_eq!(live.len(), 1, "only the shown session keeps its runtime");
        assert_eq!(live[0].id, visited[4].id);
        for session in &visited[..4] {
            assert_eq!(session.status(), Status::Stopped);
            assert!(manager.get(&session.id).is_none());
        }
        manager.stop_all();
    }

    /// #92: a new session left before anything was sent, with no runtime
    /// (nothing was warm), leaves no file once it is reaped or the host exits.
    #[tokio::test]
    async fn a_new_session_never_used_leaves_no_file() {
        let (manager, _home, workspace) = manager(50);
        let folder = workspace.path().to_str().unwrap();
        let left = manager.create_pending(folder, None, None).unwrap();
        let left_file = left.session_path.lock().unwrap().clone().expect("a new session has a file");
        let kept = manager.create_pending(folder, None, None).unwrap();
        let kept_file = kept.session_path.lock().unwrap().clone().expect("a new session has a file");
        assert!(std::path::Path::new(&left_file).exists());
        let _stream = manager.connect_client("window");
        manager.hold("window", &kept.id);
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(std::path::Path::new(&kept_file).exists(), "shown by a client: kept");
        assert_eq!(left.status(), Status::Cancelled);
        assert!(!std::path::Path::new(&left_file).exists());
        // A file that holds a conversation is never removed, whatever the host thinks.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&kept_file)
            .and_then(|mut file| {
                std::io::Write::write_all(
                    &mut file,
                    b"{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
                )
            })
            .unwrap();
        manager.shutdown();
        assert!(std::path::Path::new(&kept_file).exists());
    }

    /// #93: a saved conversation stopped before its start ran (the start is
    /// spawned) must not start a runtime that nobody owns.
    #[tokio::test]
    async fn a_session_stopped_before_its_start_runs_starts_no_runtime() {
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().join("old.jsonl");
        let session = manager
            .create(
                workspace.path().to_str().unwrap(),
                Some(path.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        session.stop();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(session.status(), Status::Stopped);
        assert_eq!(session.runtime_pid(), None);
    }

    /// #94: until one runtime has answered, a runtime may still have to apply
    /// its profile under a lock it does not wait for. A session that finds
    /// nothing to take while another runtime boots waits for it instead of
    /// starting a second one beside it.
    #[tokio::test]
    async fn before_any_runtime_answered_runtimes_start_one_at_a_time() {
        let (manager, _home, workspace) = slow_manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let folder = workspace.path().to_str().unwrap();
        wait_until(|| pool.status()["warm"] == 1).await;
        let first = manager
            .create(folder, Some(workspace.path().join("a.jsonl").to_string_lossy().into_owned()), None)
            .unwrap();
        wait_until(|| first.runtime_pid().is_some()).await;
        // The warm runtime, still booting, went to the first session.
        let second = manager
            .create(folder, Some(workspace.path().join("b.jsonl").to_string_lossy().into_owned()), None)
            .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(second.runtime_pid(), None, "no second runtime while the first boots");
        assert!(pool.must_wait(), "{}", pool.status());
        wait_status(&first, Status::Idle).await;
        // Once one answered, the second starts.
        wait_status(&second, Status::Idle).await;
        assert!(second.runtime_pid().is_some());
        assert_ne!(second.runtime_pid(), first.runtime_pid());
        manager.stop_all();
    }

    #[tokio::test]
    async fn opening_an_old_session_takes_the_warm_runtime() {
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let status = pool.wait_settled(Duration::from_secs(10)).await;
        let warm_pid = status["pid"].as_u64().unwrap() as u32;
        let path = workspace.path().join("old.jsonl");
        let session = manager
            .create(
                workspace.path().to_str().unwrap(),
                Some(path.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.runtime_pid(), Some(warm_pid));
        session.send("old", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        manager.stop_all();
    }

    /// Issue #87: on a first launch the desktop starts the host, then installs
    /// the managed runtime. The host must pick the runtime up once it exists,
    /// for sessions and for the warm pool, without being restarted.
    #[tokio::test]
    async fn a_managed_runtime_installed_after_the_host_started_is_picked_up() {
        let managed = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let manager = Arc::new(SessionManager::managed(
            managed.path().to_path_buf(),
            managed.path().to_path_buf(),
            managed.path().join("data"),
            None,
            50,
            None,
        ));
        // The host binary asks for a warm runtime at start, before the install.
        assert!(manager.enable_warm_runtime().is_none());
        assert!(manager.node_executable().is_none());
        let error = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .err()
            .expect("no runtime yet");
        assert_eq!(error.code, "runtime-missing", "{}", error.message);

        // What the first-run preparation writes: the bundled Node, then the app.
        let node = managed.path().join("runtime").join("node").join("node.exe");
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::copy(RuntimeSpec::node_script(&fixture()).program, &node).unwrap();
        let app = managed.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::copy(fixture(), app.join("bootstrap.mjs")).unwrap();

        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .expect("the installed runtime is used");
        assert_eq!(manager.node_executable(), Some(node));
        let pool = manager.warm_runtime().expect("the warm pool started with the runtime");
        let status = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(status["state"], "ready", "{status}");
        session.attach_early();
        wait_model_state(&session, "ready").await;
        session.send("first", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        manager.stop_all();
    }

    /// The warm runtime a session took dies while attaching. The session's hold
    /// on the pool ("attaching") went with that runtime: the runtime it starts
    /// next must not wait for it, which would be waiting for itself.
    #[tokio::test]
    async fn a_session_whose_warm_runtime_dies_while_attaching_starts_another() {
        let marker = tempfile::tempdir().unwrap();
        let marker = marker.path().join("exited");
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_EXIT_ON_SWITCH_ONCE", marker.to_str().unwrap()), ("FAKE_RUNTIME_START_DELAY_MS", "300")]);
        // Taken while still starting: no runtime has answered yet, so the pool
        // lets one start at a time (#94).
        let pool = manager.enable_warm_runtime().expect("warm pool");
        assert_eq!(pool.status()["state"], "starting");
        let path = workspace.path().join("old.jsonl");
        let session = manager
            .create(
                workspace.path().to_str().unwrap(),
                Some(path.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        wait_until(|| marker.exists()).await;
        wait_status(&session, Status::Idle).await;
        session.send("old", "hello").unwrap();
        wait_until(|| conversation(&session).last().map(String::as_str) == Some("assistant:hello")).await;
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_session_takes_a_warm_runtime_that_is_still_starting() {
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_START_DELAY_MS", "500")]);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        assert_eq!(pool.status()["state"], "starting");
        let warm_pid = pool.status()["pid"].as_u64().unwrap() as u32;
        session.attach_early();
        wait_model_state(&session, "ready").await;
        session.send("first", "hello").unwrap();
        assert_eq!(session.runtime_pid(), Some(warm_pid));
        wait_status(&session, Status::Idle).await;
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_warm_runtime_that_exits_is_reported_and_sessions_still_start() {
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_EXIT_ON_START_MS", "5"), ("FAKE_RUNTIME_START_DELAY_MS", "50")]);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let first = pool.wait_settled(Duration::from_secs(10)).await;
        let dead = first["pid"].as_u64();
        // The fixture answers, then exits: a warm runtime that dies unused is
        // dropped, never handed to a session; after repeated deaths the pool
        // reports the failure and stops trying.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_ne!(pool.status()["pid"].as_u64(), dead, "{}", pool.status());
        let deadline = Instant::now() + Duration::from_secs(20);
        while pool.status()["state"] != "failed" && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let status = pool.status();
        assert_eq!(status["state"], "failed", "{status}");
        assert!(status["pid"].is_null(), "{status}");
        assert!(status["error"].as_str().unwrap().contains("exited"), "{status}");
        manager.stop_all();
        let _ = workspace;
    }

    #[tokio::test]
    async fn the_warm_runtime_state_is_served_and_can_be_waited_for() {
        let (manager, _home, _workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_START_DELAY_MS", "300")]);
        manager.enable_warm_runtime();
        let app = app(manager.clone());
        let (status, _, body) = call(
            app,
            request(Method::GET, "/v1/runtime/warm?waitMs=10000")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["state"], "ready", "{value}");
        assert!(value["readyMs"].as_u64().unwrap() >= 300, "{value}");
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_new_session_aims_the_warm_runtime_at_its_folder() {
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let scratch = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(scratch["state"], "ready", "{scratch}");
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let aimed = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(aimed["state"], "ready", "{aimed}");
        assert_ne!(aimed["pid"], scratch["pid"]);
        // A folder no session has used yet is spelled plainly (`C:\x`, not the
        // `\\?\C:\x` that canonicalize gives on Windows).
        let folder = std::fs::canonicalize(workspace.path()).unwrap();
        let plain = folder.to_string_lossy();
        assert_eq!(aimed["workspace"], plain.trim_start_matches("\\\\?\\"));
        session.attach_early();
        wait_model_state(&session, "ready").await;
        session.send("first", "hello").unwrap();
        assert_eq!(
            session.runtime_pid(),
            Some(aimed["pid"].as_u64().unwrap() as u32)
        );
        wait_status(&session, Status::Idle).await;
        // The next warm runtime is for the same folder, and remembered.
        let next = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(next["workspace"], aimed["workspace"]);
        manager.stop_all();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_requests_start_one_warm_runtime_and_never_read_off() {
        // The process start runs outside the pool's lock. Until its slot exists
        // the pool must still say "starting" and must not start a second one.
        let (manager, _home, workspace) =
            manager_with_env(50, &[("FAKE_RUNTIME_START_DELAY_MS", "400")]);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let folder = std::fs::canonicalize(workspace.path()).unwrap();
        let mut threads = Vec::new();
        for n in 0..8 {
            let pool = pool.clone();
            let folder = folder.clone();
            let handle = tokio::runtime::Handle::current();
            threads.push(std::thread::spawn(move || {
                let _entered = handle.enter();
                let mut seen = Vec::new();
                for _ in 0..20 {
                    if n % 2 == 0 { pool.aim(&folder) } else { pool.fill() }
                    seen.push(pool.status());
                }
                seen
            }));
        }
        for thread in threads {
            for status in thread.join().unwrap() {
                assert_ne!(status["state"], "off", "{status}");
                let starting = status["slots"].as_array().unwrap().iter().filter(|slot| slot["ready"] == false).count();
                assert!(starting <= 1, "{status}");
            }
        }
        let status = pool.status();
        assert_ne!(status["state"], "off", "{status}");
        manager.stop_all();
    }

    #[tokio::test]
    async fn each_recent_folder_keeps_a_warm_runtime() {
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let a = std::fs::canonicalize(workspace.path()).unwrap().join("a");
        let b = std::fs::canonicalize(workspace.path()).unwrap().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        pool.aim(&a);
        pool.aim(&b);
        let count = |folder: &Path| {
            pool.status()["slots"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|slot| slot["ready"] == true && slot["workspace"] == folder.to_string_lossy().as_ref())
                .count()
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        while pool.status()["ready"] != 4 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(pool.status()["ready"], 4, "{}", pool.status());
        assert_eq!(count(&b), 3, "{}", pool.status());
        assert_eq!(count(&a), 1, "{}", pool.status());
        // A session in the older folder gets that folder's runtime.
        let session = manager.create_pending(a.to_str().unwrap(), None, None).unwrap();
        session.attach_early();
        wait_model_state(&session, "ready").await;
        session.send("in-a", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        assert_eq!(pool.folders()[0], a, "opening a session makes its folder the most recent");
        manager.stop_all();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_old_session_runs_in_the_folder_text_its_file_records() {
        // Pi treats two spellings of one folder as two folders; the runtime must
        // start in the spelling the session file records, and warm for it next.
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let alias = tempfile::tempdir().unwrap();
        let spelled = alias.path().join("same-folder");
        std::os::unix::fs::symlink(workspace.path(), &spelled).unwrap();
        let file = workspace.path().join("old.jsonl");
        std::fs::write(
            &file,
            format!(
                "{}\n",
                json!({ "type": "session", "version": 3, "id": "old", "timestamp": "2026-01-01T00:00:00Z", "cwd": spelled.to_string_lossy() })
            ),
        )
        .unwrap();
        let session = manager
            .create(
                workspace.path().to_str().unwrap(),
                Some(file.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let next = pool.wait_settled(Duration::from_secs(10)).await;
        assert_eq!(next["workspace"], spelled.to_string_lossy().as_ref(), "{next}");
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_file_nobody_wrote_in_is_not_listed() {
        // Warm runtimes and unused new sessions leave header-only files; they must
        // not crowd conversations out of the saved list.
        let (manager, _home, workspace) = manager(50);
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = workspace.path().to_string_lossy().replace('\\', "/");
        std::fs::write(directory.join("blank.jsonl"), format!("{{\"type\":\"session\",\"cwd\":\"{cwd}\"}}\n")).unwrap();
        std::fs::write(
            directory.join("used.jsonl"),
            format!("{{\"type\":\"session\",\"cwd\":\"{cwd}\"}}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n"),
        )
        .unwrap();
        let listed = manager.persisted(None, true);
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert!(listed[0]["sessionPath"].as_str().unwrap().ends_with("used.jsonl"));
        assert!(listed[0].get("blank").is_none());
    }

    #[tokio::test]
    async fn a_saved_session_opens_readable_in_its_own_folder() {
        // The client is showing another folder; the conversation belongs to the
        // folder its file names, and its transcript (tool results included) is
        // there before any runtime answers.
        let (manager, _home, shown) = manager(50);
        let own = tempfile::tempdir().unwrap();
        let file = own.path().join("old.jsonl");
        let lines = [
            json!({ "type": "session", "version": 3, "id": "saved", "timestamp": "2026-01-01T00:00:00Z", "cwd": own.path().to_string_lossy() }),
            json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": "list the files" }] } }),
            json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": "call-1", "name": "ls", "arguments": {} }] } }),
            json!({ "type": "message", "message": { "role": "toolResult", "toolCallId": "call-1", "toolName": "ls", "content": [{ "type": "text", "text": "a.txt" }], "isError": false } }),
            json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "text", "text": "One file." }] } }),
        ];
        std::fs::write(&file, lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
        let session = manager
            .create(
                shown.path().to_str().unwrap(),
                Some(file.to_string_lossy().into_owned()),
                None,
            )
            .unwrap();
        let history = session.history(50, None);
        let rows = history["messages"].as_array().unwrap();
        assert_eq!(rows.len(), 3, "{history}");
        let texts: Vec<&str> = rows.iter().rev().filter_map(|row| row["text"].as_str()).collect();
        assert_eq!(texts, vec!["list the files", "", "One file."]);
        let call = rows.iter().find(|row| row["blocks"][0]["type"] == "toolCall").unwrap();
        assert_eq!(call["blocks"][1]["type"], "toolResult", "{call}");
        assert_eq!(call["blocks"][1]["result"]["content"][0]["text"], "a.txt");
        let info = session.info();
        assert_eq!(info["title"], "list the files");
        assert_eq!(
            std::fs::canonicalize(info["workspacePath"].as_str().unwrap()).unwrap(),
            std::fs::canonicalize(own.path()).unwrap(),
        );
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.history(50, None)["messages"].as_array().unwrap().len(), 3);
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_saved_tool_call_with_no_result_reads_as_interrupted() {
        // The app closed while a tool ran: the saved file has the call, no result.
        let (manager, _home, shown) = manager(50);
        let own = tempfile::tempdir().unwrap();
        let file = own.path().join("cut.jsonl");
        let lines = [
            json!({ "type": "session", "version": 3, "id": "cut", "timestamp": "2026-01-01T00:00:00Z", "cwd": own.path().to_string_lossy() }),
            json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": "build it" }] } }),
            json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "thinking", "thinking": "plan" }, { "type": "toolCall", "id": "call-9", "name": "bash", "arguments": {} }], "stopReason": "toolUse" } }),
        ];
        std::fs::write(&file, lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
        let session = manager
            .create(shown.path().to_str().unwrap(), Some(file.to_string_lossy().into_owned()), None)
            .unwrap();
        let history = session.history(50, None);
        let reply = history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "assistant")
            .unwrap()
            .clone();
        let blocks = reply["blocks"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "thinking", "{reply}");
        let result = blocks.iter().find(|block| block["type"] == "toolResult").unwrap();
        assert_eq!(result["toolCallId"], "call-9");
        assert_eq!(result["interrupted"], true);
        assert_eq!(result["ok"], false);
        assert_eq!(reply["stopReason"], "toolUse");
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_long_saved_session_pages_back_to_its_first_turn_and_branches_by_turn() {
        // #20: a long conversation (130 turns, each with a tool call) is read page
        // by page, newest first, until the first turn, with no gap or repeat. Each
        // row names its user turn, and branching through a turn copies that turn
        // whole (tool result and final reply included) and nothing after it.
        let (manager, _home, workspace) = manager(50);
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("long.jsonl");
        let turns = 130usize;
        let mut lines = vec![json!({ "type": "session", "version": 3, "id": "long", "timestamp": "2026-01-01T00:00:00Z", "cwd": workspace.path().to_string_lossy() })];
        for turn in 1..=turns {
            let call = format!("call-{turn}");
            lines.push(json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": format!("question {turn}") }] } }));
            lines.push(json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": call, "name": "ls", "arguments": {} }], "stopReason": "toolUse" } }));
            lines.push(json!({ "type": "message", "message": { "role": "toolResult", "toolCallId": call, "toolName": "ls", "content": [{ "type": "text", "text": "a.txt" }], "isError": false } }));
            lines.push(json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "text", "text": format!("answer {turn}") }], "stopReason": "stop" } }));
        }
        std::fs::write(&file, lines.iter().map(|line| format!("{line}\n")).collect::<String>()).unwrap();
        let session = manager
            .create(workspace.path().to_str().unwrap(), Some(file.to_string_lossy().into_owned()), None)
            .unwrap();

        let mut rows: Vec<Value> = Vec::new();
        let mut before = None;
        let mut pages = 0;
        loop {
            let page = session.history(200, before);
            pages += 1;
            let messages = page["messages"].as_array().unwrap();
            // Pages arrive newest first; the transcript reads oldest first.
            rows.splice(0..0, messages.iter().rev().cloned());
            match page["nextBefore"].as_u64() {
                Some(next) => before = Some(next),
                None => break,
            }
            assert!(pages < 10, "paging did not end");
        }
        assert_eq!(rows.len(), turns * 3, "every saved row is reachable");
        let cursors: Vec<u64> = rows.iter().map(|row| row["cursor"].as_u64().unwrap()).collect();
        assert_eq!(cursors, (1..=(turns as u64 * 3)).collect::<Vec<_>>(), "no gap or repeat at page boundaries");
        for (at, row) in rows.iter().enumerate() {
            assert_eq!(row["turn"].as_u64(), Some((at / 3 + 1) as u64), "{row}");
        }
        assert_eq!(rows[0]["text"], "question 1");
        assert_eq!(rows.last().unwrap()["text"], format!("answer {turns}"));

        let branch = manager.branch_session(file.to_str().unwrap(), 1).unwrap();
        let copied: Vec<Value> = std::fs::read_to_string(&branch)
            .unwrap()
            .lines()
            .skip(1)
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let roles: Vec<&str> = copied.iter().filter_map(|entry| entry["message"]["role"].as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "toolResult", "assistant"]);
        assert_eq!(copied[3]["message"]["content"][0]["text"], "answer 1");
        let last = manager.branch_session(file.to_str().unwrap(), turns).unwrap();
        assert_eq!(std::fs::read_to_string(&last).unwrap().lines().count(), lines.len());
        assert!(manager.branch_session(file.to_str().unwrap(), 0).is_err());
        assert!(manager.branch_session(file.to_str().unwrap(), turns + 1).is_err());
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_saved_session_preview_pages_back_with_turn_numbers() {
        // #20: an idle saved session is shown from its file. Its pages go back to
        // the first message with no gap or repeat, and each page says which user
        // turn it starts in.
        let (manager, _home, workspace) = manager(50);
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("preview-long.jsonl");
        let mut lines = vec![json!({ "type": "session", "version": 3, "id": "p", "cwd": workspace.path().to_string_lossy() }).to_string()];
        for turn in 1..=130 {
            lines.push(json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": format!("q{turn}") }] } }).to_string());
            lines.push(json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "toolCall", "id": format!("c{turn}"), "name": "ls", "arguments": {} }] } }).to_string());
            lines.push(json!({ "type": "message", "message": { "role": "toolResult", "toolCallId": format!("c{turn}"), "content": [{ "type": "text", "text": "x" }] } }).to_string());
            lines.push(json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "text", "text": format!("a{turn}") }] } }).to_string());
        }
        std::fs::write(&file, lines.join("\n") + "\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut all: Vec<Value> = Vec::new();
        let mut before = None;
        let mut turns = Vec::new();
        loop {
            let page = manager.messages(&path, Some(200), before).unwrap();
            let messages = page["messages"].as_array().unwrap().clone();
            turns.push(page["turn"].as_u64().unwrap());
            all.splice(0..0, messages);
            match page["nextBefore"].as_u64() {
                Some(next) => before = Some(next as usize),
                None => break,
            }
        }
        assert_eq!(all.len(), 520);
        assert_eq!(turns, vec![80, 30, 0], "the newest page starts in turn 81, the next in turn 31");
        assert_eq!(all[0]["content"][0]["text"], "q1");
        assert_eq!(all[519]["content"][0]["text"], "a130");
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_saved_session_larger_than_32_mib_shows_its_newest_messages() {
        // #20: the newest messages of a long session are at the end of its file.
        let (manager, _home, workspace) = manager(50);
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("big.jsonl");
        let big = "x".repeat(33 * 1024 * 1024);
        let lines = [
            json!({ "type": "session", "version": 3, "id": "big", "cwd": workspace.path().to_string_lossy() }).to_string(),
            json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": big }] } }).to_string(),
            json!({ "type": "message", "message": { "role": "user", "content": [{ "type": "text", "text": "newest" }] } }).to_string(),
        ];
        std::fs::write(&file, lines.join("\n") + "\n").unwrap();
        let page = manager.messages(&file.to_string_lossy(), Some(1), None).unwrap();
        assert_eq!(page["messages"][0]["content"][0]["text"], "newest");
        assert_eq!(page["turn"], 1);
        assert_eq!(page["nextBefore"], 1);
        manager.stop_all();
    }

    #[tokio::test]
    async fn a_new_session_in_a_folder_keeps_the_spelling_its_sessions_use() {
        let (manager, _home, workspace) = manager(50);
        let folder = std::fs::canonicalize(workspace.path()).unwrap();
        // An older session spells the folder differently: on Windows the verbatim
        // `\\?\C:\x` that canonicalize gives (a verbatim path takes no `/`), elsewhere
        // with a trailing slash.
        let spelled = if folder.to_string_lossy().starts_with("\\\\?\\") {
            folder.to_string_lossy().into_owned()
        } else {
            format!("{}/", folder.to_string_lossy())
        };
        let directory = manager.runtime_home().join("state").join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("older.jsonl"),
            format!(
                "{}\n",
                json!({ "type": "session", "version": 3, "id": "older", "timestamp": "2026-01-01T00:00:00Z", "cwd": spelled })
            ),
        )
        .unwrap();
        assert_eq!(manager.folder_text(&folder), spelled);
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let path = session.info()["sessionPath"].as_str().unwrap().to_string();
        let header: Value = serde_json::from_str(
            std::fs::read_to_string(&path).unwrap().lines().next().unwrap(),
        )
        .unwrap();
        assert_eq!(header["cwd"], spelled.as_str());
    }

    #[tokio::test]
    async fn a_copy_of_an_open_conversation_is_refused_at_once() {
        let (manager, _home, workspace) = manager(50);
        let header = json!({ "type": "session", "version": 3, "id": "same-conversation", "timestamp": "2026-01-01T00:00:00Z", "cwd": workspace.path().to_string_lossy() });
        let first = workspace.path().join("first.jsonl");
        let copy = workspace.path().join("copy.jsonl");
        std::fs::write(&first, format!("{header}\n")).unwrap();
        std::fs::write(&copy, format!("{header}\n")).unwrap();
        let open = manager
            .create(workspace.path().to_str().unwrap(), Some(first.to_string_lossy().into_owned()), None)
            .unwrap();
        wait_status(&open, Status::Idle).await;
        let error = manager
            .create(workspace.path().to_str().unwrap(), Some(copy.to_string_lossy().into_owned()), None)
            .err()
            .expect("a second owner is refused");
        assert_eq!(error.code, "session-open-elsewhere");
        // The same file again is the same session, not a conflict.
        let again = manager
            .create(workspace.path().to_str().unwrap(), Some(first.to_string_lossy().into_owned()), None)
            .unwrap();
        assert_eq!(again.id, open.id);
        manager.stop_all();
    }

    #[tokio::test]
    async fn two_new_sessions_in_a_row_both_get_a_started_runtime() {
        let (manager, _home, workspace) = manager(50);
        let pool = manager.enable_warm_runtime().expect("warm pool");
        let folder = std::fs::canonicalize(workspace.path()).unwrap();
        pool.aim(&folder);
        // The first is ready, then the spare starts and becomes ready.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !(pool.status()["warm"] == 2 && pool.status()["state"] == "ready") && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(pool.status()["warm"], 2, "{}", pool.status());
        let first = manager.create_pending(workspace.path().to_str().unwrap(), None, Some("a".into())).unwrap();
        first.attach_early();
        let second = manager.create_pending(workspace.path().to_str().unwrap(), None, Some("b".into())).unwrap();
        second.attach_early();
        assert_ne!(first.runtime_pid(), second.runtime_pid());
        wait_model_state(&first, "ready").await;
        wait_model_state(&second, "ready").await;
        first.send("one", "hello").unwrap();
        second.send("two", "hello").unwrap();
        wait_status(&first, Status::Idle).await;
        wait_status(&second, Status::Idle).await;
        manager.stop_all();
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

    /// What a client does before sending: wait until the runtime reports a model.
    async fn wait_model_state(session: &crate::session::Session, expected: &str) {
        for _ in 0..200 {
            if session.summary()["model"]["state"] == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("model was {}, expected {expected}", session.summary()["model"]);
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
                "message.done" => assert_eq!(event.1["stopReason"], "stop"),
                "turn.end" => {
                    assert_eq!(event.1["status"], "completed");
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
        assert_eq!(done["stopReason"], "aborted");
        let end = next_event(&mut rx, "turn.end").await;
        assert_eq!(end["status"], "interrupted");
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
    async fn a_turn_leaves_timing_lines_without_content() {
        let (manager, home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        session.send("timed", "secret words").unwrap();
        wait_status(&session, Status::Idle).await;
        let log = std::fs::read_to_string(home.path().join("logs").join("host.log")).unwrap();
        let marks: Vec<String> = log
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|line| line["event"] == "timing" && line["fields"]["clientMessageId"] == "timed")
            .map(|line| line["fields"]["mark"].as_str().unwrap_or_default().to_string())
            .collect();
        for expected in ["message.accepted", "turn.start", "message.first_output", "turn.end"] {
            assert!(marks.iter().any(|mark| mark == expected), "{expected} missing from {marks:?}");
        }
        assert!(!log.contains("secret words"), "timing must not log content");
    }

    #[tokio::test]
    async fn content_streams_only_to_the_viewer_and_state_to_everyone() {
        let (manager, _home, workspace) = manager(50);
        let shown = manager.create(workspace.path().to_str().unwrap(), None, None).unwrap();
        let other = manager.create(workspace.path().to_str().unwrap(), None, None).unwrap();
        let _stream = manager.connect_client("window");
        manager.hold("window", &shown.id);
        let event = |session: &str, name: &str| crate::events::HubEvent {
            seq: 1,
            session_id: session.to_string(),
            session_seq: 1,
            event: name.to_string(),
            data: json!({}),
        };
        assert!(!super::withheld(&manager, Some("window"), &event(&shown.id, "message.delta")));
        assert!(super::withheld(&manager, Some("window"), &event(&other.id, "message.delta")));
        assert!(super::withheld(&manager, Some("window"), &event(&other.id, "tool.update")));
        for state in ["turn.start", "turn.end", "session.status", "session.updated", "message.accepted"] {
            assert!(!super::withheld(&manager, Some("window"), &event(&other.id, state)), "{state}");
        }
        // A client that never opened a session sees state only; an anonymous stream sees everything.
        let _quiet = manager.connect_client("quiet");
        assert!(super::withheld(&manager, Some("quiet"), &event(&shown.id, "message.delta")));
        assert!(!super::withheld(&manager, None, &event(&other.id, "message.delta")));
        // Viewing another session moves the content with it.
        manager.hold("window", &other.id);
        assert!(super::withheld(&manager, Some("window"), &event(&shown.id, "message.delta")));
        assert!(!super::withheld(&manager, Some("window"), &event(&other.id, "message.delta")));
    }

    #[tokio::test]
    async fn session_operations_have_their_own_routes() {
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().to_str().unwrap();
        let pending = manager.create_pending(path, None, None).unwrap();
        let session = manager.create(path, None, None).unwrap();
        wait_status(&session, Status::Idle).await;
        let app = app(manager);
        let stats = |id: &str| request(Method::GET, &format!("/v1/sessions/{id}/stats")).body(Body::empty()).unwrap();
        let (status, _, body) = call(app.clone(), stats(&pending.id)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.contains("\"stats\":null"), "{body}");
        let (status, _, body) = call(
            app.clone(),
            request(Method::POST, &format!("/v1/sessions/{}/export", session.id))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "outputPath": " " }).to_string()))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (status, _, _) = call(
            app,
            request(Method::POST, &format!("/v1/sessions/{}/command", session.id))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "type": "get_state" }).to_string()))
                .unwrap(),
        )
        .await;
        assert_ne!(status, StatusCode::OK, "raw runtime commands are gone");
    }

    #[tokio::test]
    async fn only_a_session_with_a_runtime_answers_stats() {
        let (manager, _home, workspace) = manager(50);
        let pending = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        assert!(!pending.has_runtime());
        let started = manager.create(workspace.path().to_str().unwrap(), None, None).unwrap();
        wait_status(&started, Status::Idle).await;
        assert!(started.has_runtime());
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
        // Send is offered once the runtime reports the model.
        wait_model_state(&manager.get(&session_id).unwrap(), "ready").await;

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
        // The detail shows the turn in progress exactly as the session list does.
        assert_eq!(info["activeTurn"]["turnId"], "m-1");
        assert_eq!(info["activeTurn"]["phase"], "running");
        assert_eq!(info["activeTurn"], session.summary()["activeTurn"]);

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
    async fn a_connected_client_keeps_only_the_session_it_has_open() {
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().to_str().unwrap();
        let first = manager.create(path, None, Some("first".into())).unwrap();
        let second = manager.create(path, None, Some("second".into())).unwrap();
        wait_status(&first, Status::Idle).await;
        wait_status(&second, Status::Idle).await;

        let stream = manager.connect_client("desktop");
        manager.hold("desktop", &first.id);
        manager.hold("desktop", &second.id);
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(
            manager.get(&first.id).is_none(),
            "a session the client left is reaped"
        );
        assert!(
            manager.get(&second.id).is_some(),
            "the open session is kept"
        );

        drop(stream);
        let reconnected = manager.connect_client("desktop");
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(
            manager.get(&second.id).is_some(),
            "a reconnected stream keeps its hold"
        );

        drop(reconnected);
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(manager.get(&second.id).is_none(), "a closed stream holds nothing");
    }

    #[tokio::test]
    async fn the_session_a_client_shows_survives_its_stream_dropping_for_the_idle_timeout() {
        // Issue #111: a sleeping machine drops the window's event stream. At resume
        // the reaper runs before the stream reconnects; the session in view must
        // still be there when it does.
        let (manager, _home, workspace) = manager(50);
        let path = workspace.path().to_str().unwrap();
        let shown = manager.create(path, None, Some("shown".into())).unwrap();
        let left = manager.create(path, None, Some("left".into())).unwrap();
        wait_status(&shown, Status::Idle).await;
        wait_status(&left, Status::Idle).await;
        let stream = manager.connect_client("desktop");
        manager.hold("desktop", &shown.id);
        drop(stream);

        let limits = IdleLimits {
            idle: Duration::ZERO,
            pending: Duration::ZERO,
            released_hold: Duration::from_secs(3600),
        };
        manager.reap_idle(limits);
        assert!(manager.get(&shown.id).is_some(), "the shown session is kept while its client reconnects");
        assert!(manager.get(&left.id).is_none(), "other idle sessions are still reaped");

        // The reconnected client keeps it as before.
        let _reconnected = manager.connect_client("desktop");
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(manager.get(&shown.id).is_some());
    }

    #[tokio::test]
    async fn a_client_that_never_comes_back_releases_its_session_after_the_hold() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let stream = manager.connect_client("desktop");
        manager.hold("desktop", &session.id);
        drop(stream);
        tokio::time::sleep(Duration::from_millis(60)).await;
        manager.reap_idle(IdleLimits {
            idle: Duration::ZERO,
            pending: Duration::ZERO,
            released_hold: Duration::from_millis(50),
        });
        assert!(manager.get(&session.id).is_none());
        assert_eq!(session.status(), Status::Stopped);
    }

    #[tokio::test]
    async fn an_untouched_new_session_in_view_survives_a_dropped_stream() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let stream = manager.connect_client("desktop");
        manager.hold("desktop", &session.id);
        drop(stream);
        manager.reap_idle(IdleLimits {
            idle: Duration::ZERO,
            pending: Duration::ZERO,
            released_hold: Duration::from_secs(3600),
        });
        assert!(manager.get(&session.id).is_some());
    }

    #[tokio::test]
    async fn a_new_session_the_client_has_open_is_kept_before_its_first_message() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create_pending(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        let _stream = manager.connect_client("desktop");
        manager.hold("desktop", &session.id);
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(manager.get(&session.id).is_some());
    }

    #[tokio::test]
    async fn a_client_without_a_stream_holds_nothing() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        manager.hold("desktop", &session.id);
        manager.reap_idle(IdleLimits::all(Duration::ZERO));
        assert!(manager.get(&session.id).is_none());
    }

    #[tokio::test]
    async fn global_stream_client_can_answer_approvals() {
        let (manager, _home, workspace) = manager_with_ui("confirm", None);
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
        assert_eq!(models["models"].as_array().unwrap().len(), 2);

        let levels = session
            .request(
                json!({ "type": "get_available_thinking_levels" }),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(levels["levels"], json!(["off", "low", "high"]));

        let state = session
            .request(json!({ "type": "get_state" }), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(state["model"]["id"], "model");
        assert_eq!(state["thinkingLevel"], "off");
    }

    #[tokio::test]
    async fn the_summary_reports_time_to_first_output() {
        let (manager, _home, workspace) = manager(50);
        let session = manager
            .create(workspace.path().to_str().unwrap(), None, None)
            .unwrap();
        wait_status(&session, Status::Idle).await;
        assert_eq!(session.summary()["firstOutput"]["turns"], 0);
        assert!(session.summary()["firstOutput"]["avgMs"].is_null());
        session.send("ttft", "hello").unwrap();
        wait_status(&session, Status::Idle).await;
        let first = &session.summary()["firstOutput"];
        assert_eq!(first["turns"], 1, "{first}");
        assert!(first["avgMs"].as_u64().is_some(), "{first}");
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
        // Where the host keeps the file is not part of history (web clients read it).
        assert!(attachment.get("path").is_none(), "{attachment}");
        assert!(!history.to_string().contains("attachments\\att-") && !history.to_string().contains("attachments/att-"), "{history}");
        let id = attachment["id"].as_str().unwrap();
        assert_eq!(session.attachment(id).unwrap(), ("image/png".to_string(), "AAEC".to_string()));
    }

    /// Issue #119: a message's images stay in the transcript a client rebuilds
    /// from host history, for a live session and for one read from its saved file.
    #[tokio::test]
    async fn history_images_are_served_by_id_live_and_from_the_saved_file() {
        let (manager, _home, workspace) = manager(50);
        let header = json!({ "type": "session", "version": 3, "id": "saved-images", "timestamp": "2026-01-01T00:00:00Z", "cwd": workspace.path().to_string_lossy() });
        let with_text = json!({ "type": "message", "id": "m1", "parentId": null, "timestamp": "2026-01-01T00:00:01Z", "message": { "role": "user", "content": [
            { "type": "text", "text": "what is in this picture?" },
            { "type": "image", "mimeType": "image/webp", "data": "UklGRg==" },
        ] } });
        let reply = json!({ "type": "message", "id": "m2", "parentId": "m1", "timestamp": "2026-01-01T00:00:02Z", "message": { "role": "assistant", "content": [{ "type": "text", "text": "A cat." }] } });
        let image_only = json!({ "type": "message", "id": "m3", "parentId": "m2", "timestamp": "2026-01-01T00:00:03Z", "message": { "role": "user", "content": [
            { "type": "image", "mimeType": "image/png", "data": "AAEC" },
        ] } });
        let file = workspace.path().join("saved.jsonl");
        std::fs::write(&file, format!("{header}\n{with_text}\n{reply}\n{image_only}\n")).unwrap();
        let session = manager
            .create(workspace.path().to_str().unwrap(), Some(file.to_string_lossy().into_owned()), None)
            .unwrap();
        wait_status(&session, Status::Idle).await;

        let users = |history: &Value| -> Vec<Value> {
            let mut rows: Vec<Value> = history["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["kind"] == "user")
                .cloned()
                .collect();
            rows.reverse();
            rows
        };
        let history = session.history(50, None);
        let saved = users(&history);
        assert_eq!(saved.len(), 2, "the image-only message is kept: {history}");
        assert_eq!(saved[0]["text"], "what is in this picture?");
        assert_eq!(saved[0]["attachments"][0]["mimeType"], "image/webp");
        assert_eq!(saved[0]["attachments"][0]["bytes"], 4);
        assert_eq!(saved[1]["text"], "");
        assert_eq!(saved[1]["attachments"][0]["mimeType"], "image/png");
        assert!(!history.to_string().contains("UklGRg=="), "history carries no image data: {history}");

        // A message sent now, with an image, next to those from the file.
        session
            .send_with_client(
                "live-image",
                "and this one?",
                None,
                &[Attachment { name: "pixel.gif".into(), mime_type: "image/gif".into(), data: "R0lG".into() }],
            )
            .unwrap();
        wait_status(&session, Status::Idle).await;
        let live = users(&session.history(50, None));
        assert_eq!(live.len(), 3, "{live:?}");

        let app = app(manager.clone());
        let fetch = |id: &str| {
            let app = app.clone();
            let path = format!("/v1/sessions/{}/attachments/{}", session.id, id);
            async move { call(app, request(Method::GET, &path).body(Body::empty()).unwrap()).await }
        };
        for (row, mime_type, data) in [
            (&saved[0], "image/webp", "UklGRg=="),
            (&saved[1], "image/png", "AAEC"),
            (&live[2], "image/gif", "R0lG"),
        ] {
            let id = row["attachments"][0]["id"].as_str().unwrap();
            let (status, _, body) = fetch(id).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["mimeType"], mime_type);
            assert_eq!(body["data"], data);
        }
        let (status, _, body) = fetch("att-unknown").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

        // The file read again (as on reload): same ids, still served.
        session.open_saved_history();
        let again = users(&session.history(50, None));
        assert_eq!(again[0]["attachments"][0]["id"], saved[0]["attachments"][0]["id"]);
        let (status, _, _) = fetch(saved[1]["attachments"][0]["id"].as_str().unwrap()).await;
        assert_eq!(status, StatusCode::OK);
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
    fn pins_saved_by_the_launcher_before_the_host_still_apply_and_keep_their_key() {
        let (manager, home, _workspace) = manager(50);
        let state = home.path().join("data").join("state");
        let directory = state.join("sessions");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("pinned.jsonl");
        std::fs::write(&path, format!("{}\n", json!({ "type": "session", "version": 3, "id": "p", "cwd": "C:/work" }))).unwrap();
        let canonical = path.canonicalize().unwrap().to_string_lossy().into_owned();
        // The launcher (1.0.x, still on the stable channel) keys entries by
        // `fs::canonicalize`, which on Windows starts with `\\?\`.
        let legacy = format!("\\\\?\\{}", canonical.trim_start_matches("\\\\?\\"));
        std::fs::write(
            state.join("session-preferences.json"),
            json!({ legacy.clone(): { "pinned": true, "archived": false, "title": "Kept" } }).to_string(),
        )
        .unwrap();
        let updated = manager.update_session(&canonical, None, Some(true), None).unwrap();
        assert_eq!(updated["pinned"], true, "{updated}");
        assert_eq!(updated["title"], "Kept", "{updated}");
        let stored: Value = serde_json::from_slice(&std::fs::read(state.join("session-preferences.json")).unwrap()).unwrap();
        let keys: Vec<&String> = stored.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec![&legacy], "{stored}");
        assert_eq!(stored[&legacy]["archived"], true, "{stored}");
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



















