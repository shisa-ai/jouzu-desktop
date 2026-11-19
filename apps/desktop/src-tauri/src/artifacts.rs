use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};

/// Artifact records live beside the data, one JSON sidecar per file (see 0072).
fn root() -> Result<PathBuf, String> {
    Ok(crate::runtime::effective_home()?.join("artifacts"))
}

fn within(base: &Path, candidate: &Path) -> bool {
    candidate.components().count() >= base.components().count() && candidate.starts_with(base)
}

fn record_paths(sidecar: &Path) -> Option<(serde_json::Value, PathBuf)> {
    let text = std::fs::read_to_string(sidecar).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let relative = value.get("path")?.as_str()?;
    let relative_path = Path::new(relative);
    if relative_path.is_absolute() || relative_path.components().any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return None;
    }
    let base = sidecar.parent()?.parent()?;
    let file = base.join(relative_path);
    if !within(base, &file) {
        return None;
    }
    Some((value, file))
}

fn collect(kind: &Path, out: &mut Vec<serde_json::Value>) {
    let Ok(entries) = std::fs::read_dir(kind) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some((mut value, file)) = record_paths(&path) {
            value["absolutePath"] = serde_json::Value::String(file.to_string_lossy().to_string());
            value["exists"] = serde_json::Value::Bool(file.is_file());
            out.push(value);
        }
    }
}

fn session_of(value: &serde_json::Value) -> Option<&str> {
    value.get("source")?.get("sessionId")?.as_str()
}

/// The runtime can name a session either by its file stem
/// (`<timestamp>_<uuid>`) or by the UUID alone; sidecars store the UUID.
/// Normalize only this boundary, never in each consumer.
fn session_key(value: &str) -> &str {
    value.rsplit_once('_').map_or(value, |(_, suffix)| suffix)
}

fn retain_session(records: &mut Vec<serde_json::Value>, session: &str) {
    let wanted = session_key(session);
    records.retain(|record| session_of(record).is_some_and(|value| session_key(value) == wanted));
}

fn count_by_session(records: &[serde_json::Value]) -> std::collections::BTreeMap<String, u64> {
    let mut counts = std::collections::BTreeMap::new();
    for record in records {
        if let Some(session) = session_of(record) {
            *counts.entry(session.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

fn every_artifact(root: &Path) -> Vec<serde_json::Value> {
    let mut artifacts = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return artifacts };
    let mut kinds: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    kinds.sort();
    for directory in kinds {
        collect(&directory, &mut artifacts);
    }
    artifacts
}

#[tauri::command]
pub fn artifact_list(kind: Option<String>, session_id: Option<String>) -> Result<serde_json::Value, String> {
    let root = root()?;
    let mut artifacts = Vec::new();
    match kind.filter(|value| !value.trim().is_empty()) {
        Some(name) => collect(&root.join(name), &mut artifacts),
        None => {
            artifacts = every_artifact(&root);
        }
    }
    if let Some(session) = session_id.filter(|value| !value.trim().is_empty()) {
        retain_session(&mut artifacts, &session);
    }
    artifacts.sort_by(|a, b| b.get("createdAt").and_then(|value| value.as_str()).unwrap_or("").cmp(a.get("createdAt").and_then(|value| value.as_str()).unwrap_or("")));
    artifacts.truncate(200);
    Ok(serde_json::json!({ "artifacts": artifacts }))
}

/// One count per session, for sidebar badges; no file bodies are read.
#[tauri::command]
pub fn artifact_counts() -> Result<serde_json::Value, String> {
    let records = every_artifact(&root()?);
    Ok(serde_json::json!({ "counts": count_by_session(&records) }))
}

#[tauri::command]
pub fn artifact_read(id: String) -> Result<serde_json::Value, String> {
    if !id.chars().all(|character| character.is_ascii_hexdigit()) || id.len() < 16 {
        return Err("That artifact id is not valid.".into());
    }
    let root = root()?;
    let Ok(entries) = std::fs::read_dir(&root) else { return Err("No artifacts yet.".into()) };
    for directory in entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()) {
        let sidecar = directory.join(format!("{id}.json"));
        if !sidecar.is_file() {
            continue;
        }
        let Some((value, file)) = record_paths(&sidecar) else { continue };
        let bytes = std::fs::read(&file).map_err(|_| "That artifact file is missing.".to_string())?;
        return Ok(serde_json::json!({
            "record": value,
            "mimeType": value.get("mimeType").and_then(|mime| mime.as_str()).unwrap_or("application/octet-stream"),
            "data": STANDARD.encode(bytes),
        }));
    }
    Err("That artifact was not found.".into())
}

fn mime_and_kind(extension: &str) -> (&'static str, &'static str) {
    match extension.to_ascii_lowercase().as_str() {
        "png" => ("image/png", "images"),
        "jpg" | "jpeg" => ("image/jpeg", "images"),
        "webp" => ("image/webp", "images"),
        "gif" => ("image/gif", "images"),
        "md" | "mdx" => ("text/markdown", "documents"),
        "txt" => ("text/plain", "documents"),
        "json" => ("application/json", "documents"),
        "csv" => ("text/csv", "documents"),
        "pdf" => ("application/pdf", "documents"),
        "html" | "htm" => ("text/html", "documents"),
        "xml" => ("application/xml", "documents"),
        _ => ("application/octet-stream", "data"),
    }
}

/// Freeze one workspace file into the artifact store. This is the explicit user
/// Save action, never a model tool: the original reference stays in place until
/// the user chooses to keep a copy.
fn store_copy(
    root: &Path,
    workspace: &Path,
    path: &str,
    session_id: Option<&str>,
    prompt: Option<&str>,
) -> Result<serde_json::Value, String> {
    let workspace = std::fs::canonicalize(workspace).map_err(|_| "The workspace folder is unavailable.".to_string())?;
    let candidate = Path::new(path);
    let joined = if candidate.is_absolute() { candidate.to_path_buf() } else { workspace.join(candidate) };
    let source = std::fs::canonicalize(&joined).map_err(|_| "That file no longer exists.".to_string())?;
    if !source.starts_with(&workspace) {
        return Err("That file is outside the workspace.".into());
    }
    if !source.is_file() {
        return Err("That path is not a file.".into());
    }
    let metadata = std::fs::metadata(&source).map_err(|_| "That file could not be read.".to_string())?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("That file is larger than 10 MB.".into());
    }
    let bytes = std::fs::read(&source).map_err(|_| "That file could not be read.".to_string())?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("bin");
    let (mime, kind) = mime_and_kind(extension);
    let directory = root.join(kind);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file_name = format!("{id}.{extension}");
    let file = directory.join(&file_name);
    if !file.is_file() {
        std::fs::write(&file, &bytes).map_err(|error| error.to_string())?;
    }
    let sidecar = directory.join(format!("{id}.json"));
    if sidecar.is_file() {
        if let Some((mut value, file)) = record_paths(&sidecar) {
            value["absolutePath"] = serde_json::Value::String(file.to_string_lossy().to_string());
            return Ok(value);
        }
    }
    let mut record = serde_json::json!({
        "schema": 1,
        "id": id,
        "kind": kind,
        "mimeType": mime,
        "path": format!("{kind}/{file_name}"),
        "bytes": metadata.len(),
        "originPath": source.to_string_lossy(),
    });
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        record["prompt"] = serde_json::Value::String(prompt.trim().to_string());
    }
    if let Some(session) = session_id.filter(|value| !value.trim().is_empty()) {
        record["source"] = serde_json::json!({ "sessionId": session });
    }
    std::fs::write(&sidecar, serde_json::to_vec(&record).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    record["absolutePath"] = serde_json::Value::String(file.to_string_lossy().to_string());
    Ok(record)
}

/// Save a copy of one workspace file into the artifact store. The original is
/// left untouched; this is the user's Save, not a model-facing tool.
#[tauri::command]
pub fn artifact_store_copy(
    workspace: String,
    path: String,
    session_id: Option<String>,
    prompt: Option<String>,
) -> Result<serde_json::Value, String> {
    store_copy(&root()?, Path::new(&workspace), &path, session_id.as_deref(), prompt.as_deref())
}

#[tauri::command]
pub fn artifact_delete(id: String) -> Result<(), String> {    if !id.chars().all(|character| character.is_ascii_hexdigit()) || id.len() < 16 {
        return Err("That artifact id is not valid.".into());
    }
    let root = root()?;
    let Ok(entries) = std::fs::read_dir(&root) else { return Err("No artifacts yet.".into()) };
    for directory in entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()) {
        let sidecar = directory.join(format!("{id}.json"));
        if !sidecar.is_file() {
            continue;
        }
        if let Some((_, file)) = record_paths(&sidecar) {
            let _ = std::fs::remove_file(&file);
        }
        std::fs::remove_file(&sidecar).map_err(|_| "The artifact record could not be removed.".to_string())?;
        return Ok(());
    }
    Err("That artifact was not found.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_a_reference_copies_it_and_records_the_session() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("notes.md"), b"# notes").unwrap();
        let record = store_copy(
            root.path(),
            workspace.path(),
            "notes.md",
            Some("session-1"),
            Some("a report"),
        )
        .unwrap();
        assert_eq!(record["kind"], "documents");
        assert_eq!(record["mimeType"], "text/markdown");
        assert_eq!(record["source"]["sessionId"], "session-1");
        assert_eq!(record["prompt"], "a report");
        assert!(Path::new(record["absolutePath"].as_str().unwrap()).is_file());
        // Saving the same bytes again returns the existing frozen copy.
        let again = store_copy(root.path(), workspace.path(), "notes.md", Some("session-1"), None).unwrap();
        assert_eq!(again["id"], record["id"]);
    }

    #[test]
    fn saving_refuses_a_path_outside_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"secret").unwrap();
        let path = outside.path().join("secret.txt");
        assert!(store_copy(root.path(), workspace.path(), path.to_str().unwrap(), None, None).is_err());
    }

    fn seed(home: &Path) -> (PathBuf, PathBuf) {
        let directory = home.join("artifacts").join("images");
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("a".repeat(64) + ".png");
        std::fs::write(&file, b"png-bytes").unwrap();
        let record = serde_json::json!({
            "schema": 1,
            "id": "a".repeat(64),
            "kind": "images",
            "mimeType": "image/png",
            "path": format!("images/{}.png", "a".repeat(64)),
            "bytes": 9,
            "createdAt": "2026-10-29T00:00:00.000Z",
            "prompt": "a cat",
        });
        let sidecar = directory.join("a".repeat(64) + ".json");
        std::fs::write(&sidecar, record.to_string()).unwrap();
        (file, sidecar)
    }

    #[test]
    fn lists_records_with_absolute_paths() {
        let home = tempfile::tempdir().unwrap();
        seed(home.path());
        let root = home.path();
        let mut artifacts = Vec::new();
        collect(&root.join("artifacts/images"), &mut artifacts);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0]["prompt"], "a cat");
        assert!(artifacts[0]["absolutePath"].as_str().unwrap().ends_with(".png"));
    }


    #[test]
    fn lists_text_artifacts_beside_images() {
        let home = tempfile::tempdir().unwrap();
        seed(home.path());
        let documents = home.path().join("artifacts/documents");
        std::fs::create_dir_all(&documents).unwrap();
        let id = "b".repeat(64);
        let record = serde_json::json!({
            "id": id,
            "kind": "documents",
            "mimeType": "text/markdown",
            "path": format!("documents/{id}.md"),
            "createdAt": "2026-10-29T00:00:01.000Z",
        });
        std::fs::write(documents.join(format!("{id}.json")), record.to_string()).unwrap();
        std::fs::write(documents.join(format!("{id}.md")), b"# notes").unwrap();
        let mut artifacts = Vec::new();
        collect(&home.path().join("artifacts/images"), &mut artifacts);
        collect(&documents, &mut artifacts);
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.iter().any(|value| value["kind"] == "documents"));
    }

    #[test]
    fn filters_and_counts_by_session() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("artifacts/images");
        std::fs::create_dir_all(&directory).unwrap();
        for (index, session) in ["s1", "s1", "s2"].iter().enumerate() {
            let id = format!("{:064x}", index);
            let record = serde_json::json!({
                "id": id,
                "kind": "images",
                "path": format!("images/{id}.png"),
                "createdAt": format!("2026-10-29T00:00:0{index}Z"),
                "source": { "sessionId": session },
            });
            std::fs::write(directory.join(format!("{id}.json")), record.to_string()).unwrap();
            std::fs::write(directory.join(format!("{id}.png")), b"x").unwrap();
        }
        let mut records = Vec::new();
        collect(&directory, &mut records);
        assert_eq!(records.len(), 3);
        let mut filtered = records.clone();
        retain_session(&mut filtered, "s1");
        assert_eq!(filtered.len(), 2);
        let counts = count_by_session(&records);
        assert_eq!(counts.get("s1"), Some(&2));
        assert_eq!(counts.get("s2"), Some(&1));
    }

    #[test]
    fn a_session_file_stem_matches_its_sidecar_uuid() {
        let uuid = "01a1864a-5a64-74ab-94f8-106bc31fe975";
        let mut records = vec![
            serde_json::json!({ "source": { "sessionId": uuid } }),
            serde_json::json!({ "source": { "sessionId": "other-session" } }),
        ];
        retain_session(&mut records, &format!("2026-10-29T10-27-32-918Z_{uuid}"));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["source"]["sessionId"], uuid);
        let mut same = vec![serde_json::json!({ "source": { "sessionId": uuid } })];
        retain_session(&mut same, uuid);
        assert_eq!(same.len(), 1);
    }

    #[test]
    fn a_record_cannot_escape_the_artifacts_root() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("artifacts/images");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("b".repeat(64) + ".json"), serde_json::json!({ "path": "../../secret.txt" }).to_string()).unwrap();
        let mut artifacts = Vec::new();
        collect(&directory, &mut artifacts);
        assert!(artifacts.is_empty());
    }
}
