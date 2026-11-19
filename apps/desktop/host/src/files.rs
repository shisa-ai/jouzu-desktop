use std::path::Path;

use serde_json::{json, Value};

/// Directories that never belong to a turn's output. Skipping them keeps a snapshot
/// cheap and stops dependency or build churn from being reported as edits.
const SNAPSHOT_SKIP: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".turbo", "coverage",
];
const SNAPSHOT_MAX_ENTRIES: usize = 20_000;
const SNAPSHOT_MAX_DEPTH: usize = 8;

/// A bounded snapshot of every file under a workspace, for the turn summary.
pub fn snapshot(root: &str) -> Result<Value, String> {
    let directory = Path::new(root)
        .canonicalize()
        .map_err(|_| "That folder is not available.".to_string())?;
    if !directory.is_dir() {
        return Err("That folder is not available.".to_string());
    }
    let mut files = Vec::new();
    walk(&directory, 0, &mut files);
    let truncated = files.len() >= SNAPSHOT_MAX_ENTRIES;
    Ok(json!({ "path": directory.to_string_lossy(), "files": files, "truncated": truncated }))
}

fn walk(directory: &Path, depth: usize, out: &mut Vec<Value>) {
    if depth > SNAPSHOT_MAX_DEPTH || out.len() >= SNAPSHOT_MAX_ENTRIES {
        return;
    }
    let Ok(read) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in read.flatten() {
        if out.len() >= SNAPSHOT_MAX_ENTRIES {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if SNAPSHOT_SKIP.iter().any(|skip| name.eq_ignore_ascii_case(skip)) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            walk(&path, depth + 1, out);
        } else if metadata.is_file() {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0);
            out.push(json!({
                "path": path.to_string_lossy(),
                "size": metadata.len(),
                "modified": modified,
            }));
        }
    }
}

/// Read one workspace file for a dropped image. Bounded so a huge file cannot be
/// pulled into the webview by accident.
pub fn read(path: &str) -> Result<Value, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::path::Path as StdPath;
    let file = StdPath::new(path)
        .canonicalize()
        .map_err(|_| "That file is not available.".to_string())?;
    let metadata = std::fs::metadata(&file).map_err(|_| "That file is not available.".to_string())?;
    if !metadata.is_file() || metadata.len() > 25 * 1024 * 1024 {
        return Err("That file cannot be read.".to_string());
    }
    let bytes = std::fs::read(&file).map_err(|_| "That file is not available.".to_string())?;
    let name = file.file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default();
    let mime = match file.extension().and_then(|value| value.to_str()).map(str::to_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    };
    Ok(json!({ "name": name, "mimeType": mime, "data": STANDARD.encode(bytes) }))
}

pub fn list(path: &str) -> Result<Value, String> {
    let directory = Path::new(path)
        .canonicalize()
        .map_err(|_| "That folder is not available.".to_string())?;
    if !directory.is_dir() {
        return Err("That folder is not available.".to_string());
    }
    let read = std::fs::read_dir(&directory)
        .map_err(|_| "The folder could not be read.".to_string())?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let metadata = entry.metadata().ok();
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "isDir": metadata.as_ref().map(|value| value.is_dir()).unwrap_or(false),
            "size": metadata.as_ref().map(|value| value.len()).unwrap_or(0),
        }));
    }
    entries.sort_by(|a, b| {
        let left = a.get("isDir").and_then(Value::as_bool).unwrap_or(false);
        let right = b.get("isDir").and_then(Value::as_bool).unwrap_or(false);
        right.cmp(&left).then(
            a.get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase()
                .cmp(
                    &b.get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase(),
                ),
        )
    });
    Ok(json!({ "entries": entries, "path": directory.to_string_lossy() }))
}

