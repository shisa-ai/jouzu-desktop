use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

fn within(base: &Path, candidate: &Path) -> bool {
    candidate.components().count() >= base.components().count() && candidate.starts_with(base)
}

fn record_paths(sidecar: &Path) -> Option<(Value, PathBuf)> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(sidecar).ok()?).ok()?;
    let relative = Path::new(value.get("path")?.as_str()?);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let base = sidecar.parent()?.parent()?;
    let file = base.join(relative);
    within(base, &file).then_some((value, file))
}

fn collect(directory: &Path, out: &mut Vec<Value>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some((mut value, file)) = record_paths(&path) {
            value["absolutePath"] = Value::String(file.to_string_lossy().into_owned());
            value["exists"] = Value::Bool(file.is_file());
            out.push(value);
        }
    }
}

fn every(home: &Path) -> Vec<Value> {
    let root = home.join("artifacts");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut values = Vec::new();
    let mut kinds: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    kinds.sort();
    for kind in kinds {
        collect(&kind, &mut values);
    }
    values
}

fn session_of(value: &Value) -> Option<&str> {
    value.get("source")?.get("sessionId")?.as_str()
}

pub fn list(home: &Path, kind: Option<&str>, session: Option<&str>) -> Value {
    let root = home.join("artifacts");
    let mut records = Vec::new();
    match kind.filter(|value| !value.trim().is_empty()) {
        Some(name) => collect(&root.join(name), &mut records),
        None => records = every(home),
    }
    if let Some(session) = session.filter(|value| !value.trim().is_empty()) {
        records.retain(|record| session_of(record) == Some(session));
    }
    records.sort_by(|a, b| {
        b.get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("createdAt").and_then(Value::as_str).unwrap_or(""))
    });
    records.truncate(200);
    json!({ "artifacts": records })
}

pub fn counts(home: &Path) -> Value {
    let mut counts = std::collections::BTreeMap::new();
    for record in every(home) {
        if let Some(session) = session_of(&record) {
            *counts.entry(session.to_string()).or_insert(0u64) += 1;
        }
    }
    json!({ "counts": counts })
}

fn valid_id(id: &str) -> bool {
    id.len() >= 16 && id.chars().all(|character| character.is_ascii_hexdigit())
}

pub fn read(home: &Path, id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err("That artifact id is not valid.".into());
    }
    let root = home.join("artifacts");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Err("No artifacts yet.".into());
    };
    for directory in entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()) {
        let sidecar = directory.join(format!("{id}.json"));
        if !sidecar.is_file() {
            continue;
        }
        let Some((value, file)) = record_paths(&sidecar) else {
            continue;
        };
        let bytes = std::fs::read(&file).map_err(|_| "That artifact file is missing.".to_string())?;
        return Ok(json!({
            "record": value,
            "mimeType": value.get("mimeType").and_then(Value::as_str).unwrap_or("application/octet-stream"),
            "data": STANDARD.encode(bytes),
        }));
    }
    Err("That artifact was not found.".into())
}

pub fn delete(home: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("That artifact id is not valid.".into());
    }
    let root = home.join("artifacts");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Err("No artifacts yet.".into());
    };
    for directory in entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()) {
        let sidecar = directory.join(format!("{id}.json"));
        if !sidecar.is_file() {
            continue;
        }
        if let Some((_, file)) = record_paths(&sidecar) {
            let _ = std::fs::remove_file(file);
        }
        std::fs::remove_file(&sidecar)
            .map_err(|_| "The artifact record could not be removed.".to_string())?;
        return Ok(());
    }
    Err("That artifact was not found.".into())
}
