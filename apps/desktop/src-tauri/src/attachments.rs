use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LOCAL_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// One image read from the workspace for the transcript.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
    pub mime_type: String,
    pub data: String,
    pub bytes: u64,
    pub name: String,
}

/// A refusal from `read_local_image`, with a stable reason the webview can map.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReadError {
    pub reason: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

impl ImageReadError {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, message: message.into(), bytes: None }
    }

    fn oversized(bytes: u64) -> Self {
        Self {
            reason: "too-large",
            message: format!("The image is {bytes} bytes; the limit is 10 MB."),
            bytes: Some(bytes),
        }
    }
}

/// Read an image named in the transcript. The workspace is the only boundary:
/// relative paths resolve against it and a canonical path must stay under it.
/// The type comes from the magic bytes, never from the extension.
#[tauri::command]
pub fn read_local_image(workspace: String, path: String) -> Result<ImagePayload, ImageReadError> {
    read_local_image_at(&workspace, &path)
}

pub fn read_local_image_at(workspace: &str, raw_path: &str) -> Result<ImagePayload, ImageReadError> {
    if workspace.trim().is_empty() {
        return Err(ImageReadError::new("not-found", "The workspace folder is unavailable."));
    }
    let workspace_root = std::fs::canonicalize(workspace).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ImageReadError::new("not-found", "The workspace folder is unavailable."),
        _ => ImageReadError::new("unreadable", "The workspace folder could not be read."),
    })?;
    let requested = Path::new(raw_path);
    let candidate: PathBuf = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        workspace_root.join(requested)
    };
    // canonicalize resolves `..` segments and links, so an escape cannot hide
    // behind a path that only looks like it starts with the workspace.
    let canonical = std::fs::canonicalize(&candidate).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ImageReadError::new("not-found", format!("{raw_path} was not found.")),
        _ => ImageReadError::new("unreadable", "The image could not be read."),
    })?;
    if !is_under(&workspace_root, &canonical) {
        return Err(ImageReadError::new("outside-workspace", "The image is outside the workspace."));
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| ImageReadError::new("unreadable", "The image could not be read."))?;
    if !metadata.is_file() {
        return Err(ImageReadError::new("not-a-file", "That path is not a file."));
    }
    let size = metadata.len();
    if size > MAX_LOCAL_IMAGE_BYTES {
        return Err(ImageReadError::oversized(size));
    }
    let bytes = std::fs::read(&canonical)
        .map_err(|_| ImageReadError::new("unreadable", "The image could not be read."))?;
    let mime = image_mime(&bytes).ok_or_else(|| {
        let kind = canonical
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_ascii_lowercase()))
            .unwrap_or_else(|| "file".to_string());
        ImageReadError::new("not-an-image", format!("{kind} is not a supported image."))
    })?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    Ok(ImagePayload {
        mime_type: mime.to_string(),
        data: STANDARD.encode(&bytes),
        bytes: bytes.len() as u64,
        name,
    })
}

/// Sniff the four formats the transcript may render. SVG is deliberately absent.
pub(crate) fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// Windows hands back extended-length (`\\?\`) paths and mixes separators. Compare
/// the normalized forms so a drive-letter case change or a junction cannot pass.
fn comparable(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text
    };
    let text = text.trim_end_matches('\\');
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text.to_string()
    }
}

fn is_under(workspace: &Path, candidate: &Path) -> bool {
    let root = comparable(workspace);
    let path = comparable(candidate);
    if path == root {
        return true;
    }
    path.strip_prefix(&root)
        .is_some_and(|rest| rest.starts_with('\\'))
}
/// A text preview is bounded and only reads inside the session workspace.
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

/// Resolve `path` against `workspace` and refuse anything outside it.
fn inside_workspace(workspace: &str, path: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(workspace).map_err(|_| "The workspace folder is unavailable.".to_string())?;
    let candidate = Path::new(path);
    let joined = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(candidate) };
    let resolved = std::fs::canonicalize(&joined).map_err(|_| "That file no longer exists.".to_string())?;
    if !resolved.starts_with(&root) {
        return Err("That file is outside the workspace.".into());
    }
    if !resolved.is_file() {
        return Err("That path is not a file.".into());
    }
    Ok(resolved)
}

/// Read one workspace file for the turn-summary preview (0080). Binary and
/// oversized files are reported, never returned as mojibake.
#[tauri::command]
pub fn workspace_read(path: String, workspace: String) -> Result<serde_json::Value, String> {
    let file = inside_workspace(&workspace, &path)?;
    let metadata = std::fs::metadata(&file).map_err(|_| "That file no longer exists.".to_string())?;
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Ok(serde_json::json!({
            "binary": false,
            "truncated": true,
            "bytes": metadata.len(),
            "text": "",
        }));
    }
    let bytes = std::fs::read(&file).map_err(|_| "That file could not be read.".to_string())?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(serde_json::json!({
            "binary": false,
            "truncated": false,
            "bytes": metadata.len(),
            "text": text,
        })),
        Err(_) => Ok(serde_json::json!({
            "binary": true,
            "truncated": false,
            "bytes": metadata.len(),
            "text": "",
        })),
    }
}

/// Read an image path supplied by the native drag/drop event. The frontend still
/// validates the signature before attaching it to a message.
#[tauri::command]
pub fn read_dropped_image(path: String) -> Result<serde_json::Value, String> {
    let path = Path::new(&path);
    let metadata = std::fs::metadata(path).map_err(|_| "Dropped image is unavailable.")?;
    if !metadata.is_file() {
        return Err("Dropped item is not a file.".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES {
        return Err("Dropped image must be between 1 byte and 10 MB.".into());
    }
    let mime = match path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => return Err("Dropped file is not a supported image.".into()),
    };
    let bytes = std::fs::read(path).map_err(|_| "Dropped image could not be read.")?;
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("dropped-image").to_string();
    Ok(serde_json::json!({ "name": name, "mimeType": mime, "data": STANDARD.encode(bytes) }))
}


/// List one directory of the session workspace for the Files view.
#[tauri::command]
pub fn workspace_list(path: String) -> Result<serde_json::Value, String> {
    let directory = std::path::Path::new(&path);
    if !directory.is_dir() {
        return Err("That folder is not available.".into());
    }
    let read = std::fs::read_dir(directory).map_err(|_| "The folder could not be read.".to_string())?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let metadata = entry.metadata().ok();
        entries.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "isDir": metadata.as_ref().map(|value| value.is_dir()).unwrap_or(false),
            "size": metadata.as_ref().map(|value| value.len()).unwrap_or(0),
        }));
    }
    entries.sort_by(|a, b| {
        let left = a.get("isDir").and_then(|value| value.as_bool()).unwrap_or(false);
        let right = b.get("isDir").and_then(|value| value.as_bool()).unwrap_or(false);
        right.cmp(&left).then(
            a.get("name").and_then(|value| value.as_str()).unwrap_or("").to_lowercase()
                .cmp(&b.get("name").and_then(|value| value.as_str()).unwrap_or("").to_lowercase()),
        )
    });
    Ok(serde_json::json!({ "path": directory.to_string_lossy(), "entries": entries }))
}

/// Directories that never belong to a turn's output. Skipping them keeps a snapshot
/// cheap and stops dependency or build churn from being reported as edits.
const SNAPSHOT_SKIP: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".turbo", "coverage"];
const SNAPSHOT_MAX_ENTRIES: usize = 20_000;
const SNAPSHOT_MAX_DEPTH: usize = 8;

/// Snapshot a workspace for the turn summary: path, size and mtime for every file.
/// Bounded by entry count and depth so a large repository cannot stall a turn end.
#[tauri::command]
pub fn workspace_snapshot(path: String) -> Result<serde_json::Value, String> {
    let root = std::path::Path::new(&path);
    if !root.is_dir() {
        return Err("That folder is not available.".into());
    }
    fn walk(directory: &std::path::Path, depth: usize, out: &mut Vec<serde_json::Value>) {
        if depth > SNAPSHOT_MAX_DEPTH || out.len() >= SNAPSHOT_MAX_ENTRIES {
            return;
        }
        let Ok(read) = std::fs::read_dir(directory) else { return };
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
            let Ok(metadata) = entry.metadata() else { continue };
            if metadata.is_dir() {
                walk(&path, depth + 1, out);
            } else if metadata.is_file() {
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_secs())
                    .unwrap_or(0);
                out.push(serde_json::json!({
                    "path": path.to_string_lossy(),
                    "size": metadata.len(),
                    "modified": modified,
                }));
            }
        }
    }
    let mut files = Vec::new();
    walk(root, 0, &mut files);
    let truncated = files.len() >= SNAPSHOT_MAX_ENTRIES;
    Ok(serde_json::json!({ "path": root.to_string_lossy(), "files": files, "truncated": truncated }))
}

/// Copy an artifact to a destination chosen by the user.
#[tauri::command]
pub fn save_copy(from: String, to: String) -> Result<(), String> {
    let source = Path::new(&from);
    if !source.is_file() {
        return Err("That artifact no longer exists.".into());
    }
    std::fs::copy(source, Path::new(&to)).map_err(|_| "The file could not be saved.".to_string())?;
    Ok(())
}

/// Show an artifact in the platform's file browser.
/// Turn a transcript path into a reveal target (0057). A relative path needs the
/// session workspace; an absolute path the turn produced is allowed anywhere the
/// user can already reach. Rejections carry a stable reason for the inline copy.
fn reveal_target(path: &str, workspace: Option<&str>) -> Result<std::path::PathBuf, String> {
    if path.is_empty() || path.contains('\0') || path.len() > 32767 {
        return Err("not-a-file".into());
    }
    let candidate = Path::new(path);
    if candidate
        .components()
        .any(|component| component == std::path::Component::CurDir)
        && !candidate.is_absolute()
    {
        return Err("not-absolute".into());
    }
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        let workspace = workspace.filter(|value| !value.trim().is_empty()).ok_or("not-absolute")?;
        Path::new(workspace).join(candidate)
    };
    if !joined.exists() {
        return Err("not-found".into());
    }
    if joined
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(reserved_device_name)
    {
        return Err("not-a-file".into());
    }
    std::fs::canonicalize(&joined).map_err(|_| "not-found".to_string())
}

/// Windows reserved device names cannot be revealed as ordinary files.
fn reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit())
}

/// Show a produced file (or folder) in the platform file manager.
#[tauri::command]
pub fn reveal_path(path: String, workspace: Option<String>) -> Result<(), String> {
    let source = reveal_target(&path, workspace.as_deref())?;
    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // explorer.exe parses its own command line, and Rust's normal argument
        // quoting makes /select, fail (the window then opens at the default
        // folder). cmd passes the documented form through untouched.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let display = source.to_string_lossy();
        let display = display.strip_prefix(r"\\?\").unwrap_or(&display);
        std::process::Command::new("cmd.exe")
            .raw_arg(format!("/c explorer.exe /select,\"{display}\""))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg("-R").arg(&source).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(source.parent().unwrap_or(&source))
        .spawn();
    spawned.map(|_| ()).map_err(|_| "reveal-failed".to_string())
}

#[cfg(test)]
mod reveal_tests {
    use super::*;

    #[test]
    fn resolves_a_relative_path_against_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), b"x").unwrap();
        let target = reveal_target("a.txt", Some(&root.path().to_string_lossy())).unwrap();
        assert!(target.ends_with("a.txt"));
    }

    #[test]
    fn a_relative_path_without_a_workspace_is_refused() {
        assert_eq!(reveal_target("a.txt", None).unwrap_err(), "not-absolute");
    }

    #[test]
    fn a_missing_path_reports_not_found() {
        let missing = tempfile::tempdir().unwrap().path().join("missing.png");
        assert_eq!(reveal_target(missing.to_str().unwrap(), None).unwrap_err(), "not-found");
    }

    #[test]
    fn reserved_device_names_are_refused() {
        assert!(reserved_device_name("CON"));
        assert!(reserved_device_name("nul.txt"));
        assert!(reserved_device_name("COM1"));
        assert!(!reserved_device_name("conifer.png"));
        assert!(!reserved_device_name("console.log"));
    }

    #[test]
    fn a_nul_byte_is_refused() {
        assert_eq!(reveal_target("a\0b", None).unwrap_err(), "not-a-file");
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;

    #[test]
    fn lists_folders_before_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("b.txt"), b"x").unwrap();
        std::fs::create_dir(root.path().join("a-dir")).unwrap();
        let value = workspace_list(root.path().to_string_lossy().to_string()).unwrap();
        let entries = value["entries"].as_array().unwrap();
        assert_eq!(entries[0]["name"], "a-dir");
        assert_eq!(entries[1]["name"], "b.txt");
        assert_eq!(entries[0]["isDir"], true);
    }

    #[test]
    fn rejects_a_missing_folder() {
        assert!(workspace_list("C:/definitely/not/here".into()).is_err());
    }

    #[test]
    fn snapshots_workspace_files_and_skips_dependency_folders() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("hello.pdf"), b"%PDF").unwrap();
        std::fs::create_dir(root.path().join("node_modules")).unwrap();
        std::fs::write(root.path().join("node_modules").join("dep.js"), b"x").unwrap();
        std::fs::create_dir(root.path().join("nested")).unwrap();
        std::fs::write(root.path().join("nested").join("notes.md"), b"# n").unwrap();

        let value = workspace_snapshot(root.path().to_string_lossy().to_string()).unwrap();
        let files = value["files"].as_array().unwrap();
        let paths: Vec<&str> = files.iter().filter_map(|file| file["path"].as_str()).collect();

        assert!(paths.iter().any(|path| path.ends_with("hello.pdf")));
        assert!(paths.iter().any(|path| path.ends_with("notes.md")));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn reads_a_workspace_text_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes.md"), b"# notes").unwrap();
        let value = workspace_read("notes.md".into(), root.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(value["text"], "# notes");
        assert_eq!(value["binary"], false);
    }

    #[test]
    fn reports_a_binary_file_instead_of_decoding_it() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("blob.bin"), [0xff, 0xfe, 0x00]).unwrap();
        let value = workspace_read("blob.bin".into(), root.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(value["binary"], true);
        assert_eq!(value["text"], "");
    }

    #[test]
    fn a_preview_cannot_escape_the_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(root.path().join("outside.txt"), b"secret").unwrap();
        let refused = workspace_read("../outside.txt".into(), workspace.to_string_lossy().to_string());
        assert!(refused.is_err());
        let absolute = workspace_read(root.path().join("outside.txt").to_string_lossy().to_string(), workspace.to_string_lossy().to_string());
        assert!(absolute.is_err());
    }

    #[test]
    fn an_oversized_preview_is_reported_not_returned() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("big.txt"), vec![b'a'; (MAX_PREVIEW_BYTES as usize) + 8]).unwrap();
        let value = workspace_read("big.txt".into(), root.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(value["truncated"], true);
        assert_eq!(value["text"], "");
    }
}

#[cfg(test)]
mod image_read_tests {
    use super::*;
    use std::io::Write;

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D',
        b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    ];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
    const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00";
    const WEBP: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 ";
    const BMP: &[u8] = b"BM\x10\x00\x00\x00\x00\x00\x00\x00";

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn write_file(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn failure(workspace: &str, path: &str) -> ImageReadError {
        read_local_image_at(workspace, path).expect_err("the image should be refused")
    }

    fn text(root: &Path) -> String {
        root.to_str().unwrap().to_string()
    }

    #[test]
    fn reads_a_png_from_a_relative_path() {
        let root = workspace();
        write_file(root.path(), "prusalicer-shots/09-printer-custom-gcode.png", PNG);
        let payload = read_local_image_at(&text(root.path()), "prusalicer-shots/09-printer-custom-gcode.png").unwrap();
        assert_eq!(payload.mime_type, "image/png");
        assert_eq!(payload.name, "09-printer-custom-gcode.png");
        assert_eq!(payload.bytes, PNG.len() as u64);
        assert_eq!(STANDARD.decode(&payload.data).unwrap(), PNG);
    }

    #[test]
    fn reads_a_non_ascii_path_with_a_space() {
        let root = workspace();
        let name = "shots dir/スクリーン ショット.png";
        write_file(root.path(), name, PNG);
        let payload = read_local_image_at(&text(root.path()), name).unwrap();
        assert_eq!(payload.name, "スクリーン ショット.png");
        assert_eq!(payload.mime_type, "image/png");
    }

    #[test]
    fn rejects_dotdot_that_escapes_the_workspace() {
        let outer = workspace();
        let root = outer.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        write_file(outer.path(), "outside.png", PNG);
        let error = failure(&text(&root), "../outside.png");
        assert_eq!(error.reason, "outside-workspace");
    }

    #[test]
    fn allows_dotdot_that_stays_inside_the_workspace() {
        let root = workspace();
        write_file(root.path(), "shots/a.png", PNG);
        let payload = read_local_image_at(&text(root.path()), "shots/../shots/a.png").unwrap();
        assert_eq!(payload.name, "a.png");
    }

    #[test]
    fn rejects_an_absolute_path_outside_the_workspace() {
        let root = workspace();
        let outside = workspace();
        let file = write_file(outside.path(), "outside.png", PNG);
        let error = failure(&text(root.path()), file.to_str().unwrap());
        assert_eq!(error.reason, "outside-workspace");
    }

    #[test]
    fn does_not_treat_a_sibling_folder_as_inside() {
        let outer = workspace();
        let root = outer.path().join("ws");
        let sibling = outer.path().join("ws-other");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let file = write_file(&sibling, "outside.png", PNG);
        let error = failure(&text(&root), file.to_str().unwrap());
        assert_eq!(error.reason, "outside-workspace");
    }

    #[test]
    fn rejects_a_missing_file() {
        let root = workspace();
        assert_eq!(failure(&text(root.path()), "missing.png").reason, "not-found");
    }

    #[test]
    fn rejects_a_workspace_that_does_not_exist() {
        let root = workspace();
        let missing = root.path().join("gone");
        assert_eq!(failure(&text(&missing), "a.png").reason, "not-found");
    }

    #[test]
    fn rejects_a_directory() {
        let root = workspace();
        std::fs::create_dir(root.path().join("folder.png")).unwrap();
        assert_eq!(failure(&text(root.path()), "folder.png").reason, "not-a-file");
    }

    #[test]
    fn rejects_a_file_that_is_not_an_image() {
        let root = workspace();
        write_file(root.path(), "fake.png", b"not really a png");
        assert_eq!(failure(&text(root.path()), "fake.png").reason, "not-an-image");
    }

    #[test]
    fn rejects_unsupported_magic_bytes() {
        let root = workspace();
        write_file(root.path(), "drawing.bmp", BMP);
        let error = failure(&text(root.path()), "drawing.bmp");
        assert_eq!(error.reason, "not-an-image");
        assert!(error.message.contains(".bmp"));
    }

    #[test]
    fn rejects_an_oversized_image_before_reading_it() {
        let root = workspace();
        let path = root.path().join("huge.png");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(PNG).unwrap();
        file.set_len(MAX_LOCAL_IMAGE_BYTES + 1).unwrap();
        drop(file);
        let error = failure(&text(root.path()), "huge.png");
        assert_eq!(error.reason, "too-large");
        assert_eq!(error.bytes, Some(MAX_LOCAL_IMAGE_BYTES + 1));
    }

    #[test]
    fn accepts_each_supported_magic_header() {
        let root = workspace();
        let cases: [(&str, &[u8], &str); 4] = [
            ("a.png", PNG, "image/png"),
            ("b.jpg", JPEG, "image/jpeg"),
            ("c.gif", GIF, "image/gif"),
            ("d.webp", WEBP, "image/webp"),
        ];
        for (name, bytes, mime) in cases {
            write_file(root.path(), name, bytes);
            let payload = read_local_image_at(&text(root.path()), name).unwrap();
            assert_eq!(payload.mime_type, mime);
        }
    }

    #[test]
    fn rejects_a_link_that_resolves_outside_the_workspace() {
        let root = workspace();
        let outside = workspace();
        write_file(outside.path(), "escaped.png", PNG);
        let Some(relative) = escape_link(root.path(), outside.path()) else {
            // Creating a link may be unavailable (Windows without the privilege).
            return;
        };
        let error = failure(&text(root.path()), &relative);
        assert_eq!(error.reason, "outside-workspace");
    }

    #[cfg(unix)]
    fn escape_link(root: &Path, outside: &Path) -> Option<String> {
        let link = root.join("link.png");
        std::os::unix::fs::symlink(outside.join("escaped.png"), &link).ok()?;
        Some("link.png".into())
    }

    #[cfg(windows)]
    fn escape_link(root: &Path, outside: &Path) -> Option<String> {
        let link = root.join("link.png");
        if std::os::windows::fs::symlink_file(outside.join("escaped.png"), &link).is_ok() {
            return Some("link.png".into());
        }
        // Junctions are available without SeCreateSymbolicLinkPrivilege.
        let junction = root.join("escape");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(outside)
            .status()
            .ok()?;
        if !status.success() {
            return None;
        }
        Some("escape/escaped.png".into())
    }
}
