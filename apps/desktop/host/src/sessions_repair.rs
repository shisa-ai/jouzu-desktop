use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// What replaces an image taken out of the history, so the model still sees that
/// one was there.
const PLACEHOLDER: &str = "[image removed: the model rejected a request that contained images]";

/// Take the images out of a session whose requests the model rejects because of
/// an image.
///
/// The runtime keeps every image in the history and sends it again with each
/// request, so one refused image fails every later turn. A provider's error does
/// not reliably say which image it refused, or why, so every image block becomes
/// a short text placeholder and the text of the conversation stays as it was.
/// The host owns the session files, so the repair lives here. The original is kept
/// as `.jsonl.bak` and the rewrite is atomic: a failed repair changes nothing.
pub fn sanitize_images(session_path: &str) -> Result<Value, String> {
    let path = session_file(session_path)?;
    let (removed, backup) = sanitize(&path)?;
    Ok(json!({ "removed": removed, "backup": backup.to_string_lossy() }))
}

fn session_file(session_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(session_path)
        .canonicalize()
        .map_err(|_| "That session is not available.".to_string())?;
    if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("That session is not available.".to_string());
    }
    Ok(path)
}

/// Replace every image block in the session's messages with a text placeholder.
fn sanitize(path: &Path) -> Result<(usize, PathBuf), String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut removed = 0usize;
    let mut output = String::with_capacity(text.len());
    for line in text.lines() {
        let Ok(mut value) = serde_json::from_str::<Value>(line) else {
            output.push_str(line);
            output.push('\n');
            continue;
        };
        let mut changed = false;
        if value.get("type").and_then(Value::as_str) == Some("message") {
            if let Some(content) = value
                .get_mut("message")
                .and_then(|message| message.get_mut("content"))
                .and_then(Value::as_array_mut)
            {
                for block in content.iter_mut() {
                    if block.get("type").and_then(Value::as_str) == Some("image") {
                        *block = json!({ "type": "text", "text": PLACEHOLDER });
                        removed += 1;
                        changed = true;
                    }
                }
            }
        }
        // Lines without images are written back exactly as read.
        if changed {
            output.push_str(&serde_json::to_string(&value).map_err(|error| error.to_string())?);
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    if removed == 0 {
        return Ok((0, path.to_path_buf()));
    }
    let backup = path.with_extension("jsonl.bak");
    std::fs::copy(path, &backup).map_err(|error| error.to_string())?;
    let staged = path.with_extension("jsonl.tmp");
    std::fs::write(&staged, output).map_err(|error| error.to_string())?;
    std::fs::rename(&staged, path).map_err(|error| error.to_string())?;
    Ok((removed, backup))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(width: u32, height: u32) -> Value {
        let mut bytes = vec![0u8; 33];
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
        json!({ "type": "image", "mimeType": "image/png", "data": BASE64.encode(bytes) })
    }

    #[test]
    fn every_image_becomes_a_placeholder_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        // The #17 case: a 256x1 image the provider refuses ("must be larger than 10"),
        // read by a tool, next to an ordinary image the user attached.
        let user = json!({
            "type": "message",
            "message": { "role": "user", "content": [
                { "type": "text", "text": "look" }, image(640, 480)
            ]}
        });
        let tool = json!({
            "type": "message",
            "message": { "role": "toolResult", "content": [image(256, 1)] }
        });
        let original = format!("{user}\n{tool}\n");
        std::fs::write(&path, &original).unwrap();

        let (removed, backup) = sanitize(&path).unwrap();

        assert_eq!(removed, 2);
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"type\":\"image\""));
        assert_eq!(text.matches(PLACEHOLDER).count(), 2);
        assert!(text.contains("\"text\":\"look\""));
    }

    #[test]
    fn a_session_without_images_is_not_touched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let original = "{\"type\":\"session\",\"id\":\"x\"}\nnot json\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n";
        std::fs::write(&path, original).unwrap();

        assert_eq!(sanitize(&path).unwrap().0, 0);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(!path.with_extension("jsonl.bak").exists());
    }

    #[test]
    fn lines_without_images_are_kept_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let plain = "{\"type\":\"message\",  \"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}";
        let with_image = json!({ "type": "message", "message": { "role": "user", "content": [image(8, 8)] } });
        std::fs::write(&path, format!("{plain}\n{with_image}\n")).unwrap();

        assert_eq!(sanitize(&path).unwrap().0, 1);
        assert!(std::fs::read_to_string(&path).unwrap().starts_with(&format!("{plain}\n")));
    }
}
