use axum::{extract::{Path, State}, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use crate::{AppState, session::ApiError};

const SCRIPT: &str = include_str!("../../../../packaging/launcher/assistant.mjs");
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Default, Serialize, Deserialize)]
struct Store {
    projects: Vec<Project>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    workspace_ids: Vec<String>,
    #[serde(default)]
    session_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message { text: String }
fn load(state: &AppState) -> Result<Store, ApiError> {
    match std::fs::read(state.sessions.home().join("assistant/state.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| ApiError::internal(format!("Cannot read Assistant state: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}
fn save(state: &AppState, store: &Store) -> Result<(), ApiError> {
    let dir = state.sessions.home().join("assistant");
    std::fs::create_dir_all(&dir).map_err(|e| ApiError::internal(e.to_string()))?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| ApiError::internal(e.to_string()))?;
    std::fs::write(dir.join("state.tmp"), bytes)
        .and_then(|_| std::fs::rename(dir.join("state.tmp"), dir.join("state.json")))
        .map_err(|e| ApiError::internal(e.to_string()))
}
fn sessions(state: &AppState) -> Vec<Value> {
    let mut result = state.sessions.persisted(None, true);
    result.extend(state.sessions.list());
    // Prefer the live projection when the same persisted session is also running.
    let mut known = std::collections::BTreeMap::new();
    for mut entry in result {
        let id = entry.get("sessionPath").and_then(Value::as_str)
            .map(crate::session::session_id_for_path)
            .or_else(|| entry.get("sessionId").and_then(Value::as_str).map(str::to_string));
        if let Some(id) = id {
            entry["sessionId"] = json!(id);
            known.insert(id, entry);
        }
    }
    // Never expose conversation previews, messages, or queued prompts.
    known.into_values().map(|entry| {
        let mut value = json!({});
        for key in ["id", "sessionId", "title", "workspacePath", "status", "sessionPath"] {
            if let Some(field) = entry.get(key) { value[key] = field.clone(); }
        }
        value
    }).collect()
}
fn snapshot(state: &AppState, store: &Store) -> Value {
    json!({"projects": store.projects,
        "workspaces": state.sessions.workspaces(), "sessions": sessions(state)})
}
fn validate(project: &Project, workspaces: &[Value], sessions: &[Value]) -> Result<(), ApiError> {
    if project.name.trim().is_empty() || project.name.len() > 200 || project.description.len() > 8000
        || project.workspace_ids.len() > 100 || project.session_ids.len() > 300 {
        return Err(ApiError::bad_request("Invalid project metadata"));
    }
    for id in &project.workspace_ids {
        if !workspaces.iter().any(|v| v.get("id").and_then(Value::as_str) == Some(id)) {
            return Err(ApiError::bad_request("Unknown workspace ID"));
        }
    }
    for id in &project.session_ids {
        if !sessions.iter().any(|v| ["id", "sessionId"].iter().any(|key| v.get(key).and_then(Value::as_str) == Some(id))) {
            return Err(ApiError::bad_request("Unknown session ID"));
        }
    }
    Ok(())
}
fn upsert(state: &AppState, store: &mut Store, project: Project, id: Option<String>) -> Result<Value, ApiError> {
    validate(&project, &state.sessions.workspaces(), &sessions(state))?;
    let result = commit_project(store, project, id, |candidate| save(state, candidate))?;
    crate::log(state.sessions.home(), "info", "assistant.project_updated", json!({"projectId": result["id"]}));
    Ok(result)
}
fn commit_project(store: &mut Store, mut project: Project, id: Option<String>, persist: impl FnOnce(&Store) -> Result<(), ApiError>) -> Result<Value, ApiError> {
    let mut candidate = store.clone();
    if let Some(id) = id {
        let existing = candidate.projects.iter_mut().find(|p| p.id == id)
            .ok_or_else(|| ApiError::bad_request("Unknown project ID"))?;
        project.id = id;
        *existing = project.clone();
    } else {
        if store.projects.len() >= 200 { return Err(ApiError::bad_request("Project limit reached")); }
        project.id = crate::new_token();
        candidate.projects.push(project.clone());
    }
    persist(&candidate)?;
    *store = candidate;
    Ok(json!(project))
}
pub async fn get(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _lock = LOCK.lock().await;
    let store = load(&state)?;
    let messages = run(&state, None).await?;
    let mut value = snapshot(&state, &store);
    value["messages"] = messages;
    Ok(Json(value))
}
pub async fn create(State(state): State<AppState>, Json(project): Json<Project>) -> Result<Json<Value>, ApiError> {
    let _lock = LOCK.lock().await;
    Ok(Json(upsert(&state, &mut load(&state)?, project, None)?))
}
pub async fn update(State(state): State<AppState>, Path(id): Path<String>, Json(project): Json<Project>) -> Result<Json<Value>, ApiError> {
    let _lock = LOCK.lock().await;
    Ok(Json(upsert(&state, &mut load(&state)?, project, Some(id))?))
}
pub async fn send(State(state): State<AppState>, Json(message): Json<Message>) -> Result<Json<Value>, ApiError> {
    if message.text.trim().is_empty() || message.text.len() > 16000 || message.text.trim_start().starts_with('/') {
        return Err(ApiError::bad_request("Enter a message of at most 16000 bytes. Assistant does not run slash commands."));
    }
    let _lock = LOCK.try_lock().map_err(|_| ApiError::unavailable("Assistant is busy. Try again when the reply finishes."))?;
    let messages = run(&state, Some(message.text)).await?;
    let mut value = snapshot(&state, &load(&state)?);
    value["messages"] = messages;
    Ok(Json(value))
}
async fn run(state: &AppState, text: Option<String>) -> Result<Value, ApiError> {
    let mut store = load(state)?;
    let model = state.models.default_model();
    let mut spec = state.control.launch_spec()?;
    spec.args[2] = SCRIPT.to_string();
    let cwd = state.sessions.home().join("assistant/workspace");
    std::fs::create_dir_all(&cwd).map_err(|e| ApiError::internal(e.to_string()))?;
    let mut command = tokio::process::Command::new(spec.program);
    command.args(spec.args).envs(spec.env).current_dir(&cwd)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| ApiError::unavailable(e.to_string()))?;
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let request = json!({"text": text, "model": model});
    input.write_all(format!("{request}\n").as_bytes()).await.map_err(|e| ApiError::internal(e.to_string()))?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(180), async {
        let mut reader = BufReader::new(output);
        let mut calls = 0;
        loop {
            let mut line = String::new();
            // Bound each protocol frame before allocating an unbounded line.
            use tokio::io::AsyncReadExt;
            let size = (&mut reader).take(256 * 1024).read_line(&mut line).await.map_err(|e| ApiError::internal(e.to_string()))?;
            if size == 0 || !line.ends_with('\n') { return Err(ApiError::internal("Assistant runtime closed or exceeded its output limit")); }
            let frame: Value = serde_json::from_str(&line).map_err(|_| ApiError::internal("Invalid Assistant response"))?;
            match frame["type"].as_str() {
                Some("reply") => return Ok(frame["messages"].clone()),
                Some("error") => return Err(ApiError::unavailable(frame["message"].as_str().unwrap_or("Assistant failed"))),
                Some("tool") => {
                    calls += 1;
                    if calls > 20 { return Err(ApiError::bad_request("Assistant tool limit reached")); }
                    let response = match frame["name"].as_str() {
                        Some("coordination_list") => Ok(snapshot(state, &store)),
                        Some("project_save") => {
                            serde_json::from_value::<Project>(frame["arguments"].clone())
                                .map_err(|_| ApiError::bad_request("Invalid project metadata"))
                                .and_then(|p| { let id = (!p.id.is_empty()).then(|| p.id.clone()); upsert(&state, &mut store, p, id) })
                        },
                        _ => Err(ApiError::bad_request("Tool is not allowed")),
                    };
                    let value = match response { Ok(value) => json!({"result":value}), Err(e) => json!({"error":e.message}) };
                    input.write_all(format!("{value}\n").as_bytes()).await.map_err(|e| ApiError::internal(e.to_string()))?;
                },
                _ => return Err(ApiError::internal("Unexpected Assistant response")),
            }
        }
    }).await.map_err(|_| ApiError::unavailable("Assistant reply timed out"))??;
    let _ = child.kill().await;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_links_require_authoritative_ids() {
        let mut p: Project = serde_json::from_value(json!({"name":"Shared", "workspaceIds":["w"], "sessionIds":["s"]})).unwrap();
        assert!(validate(&p, &[json!({"id":"w"})], &[json!({"id":"s"})]).is_ok());
        assert!(validate(&p, &[], &[json!({"id":"s"})]).is_err());
        assert!(validate(&p, &[json!({"id":"w"})], &[]).is_err());
        p.name = " ".into();
        assert!(validate(&p, &[json!({"id":"w"})], &[json!({"id":"s"})]).is_err());
    }
    #[test]
    fn failed_save_does_not_change_visible_or_later_persisted_projects() {
        let mut store = Store::default();
        let project = || serde_json::from_value::<Project>(json!({"name":"Shared", "workspaceIds":["w"], "sessionIds":["s"]})).unwrap();
        assert!(commit_project(&mut store, project(), None, |_| Err(ApiError::internal("write failed"))).is_err());
        assert!(store.projects.is_empty());
        commit_project(&mut store, project(), None, |candidate| { assert_eq!(candidate.projects.len(), 1); Ok(()) }).unwrap();
        commit_project(&mut store, project(), None, |_| Ok(())).unwrap();
        let restored: Store = serde_json::from_slice(&serde_json::to_vec(&store).unwrap()).unwrap();
        assert_eq!(restored.projects.len(), 2);
        assert_ne!(restored.projects[0].id, restored.projects[1].id);
        for p in restored.projects { assert_eq!(p.workspace_ids, vec!["w"]); assert_eq!(p.session_ids, vec!["s"]); }
    }
    #[test]
    fn requests_reject_runtime_overrides() {
        assert!(serde_json::from_value::<Message>(json!({"text":"hello", "model":"x"})).is_err());
        assert!(serde_json::from_value::<Project>(json!({"name":"x", "workspacePath":"/tmp"})).is_err());
        assert!(SCRIPT.len() < 24 * 1024);
    }
}
