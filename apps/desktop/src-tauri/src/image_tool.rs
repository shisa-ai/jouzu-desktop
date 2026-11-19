use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// The desktop's own pi extension, installed into the agent's extension folder.
const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-image/package.json"
));
const EXTENSION: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-image/index.js"
));
const SHISA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-image/providers/shisa.mjs"
));
const RUNTIME_PROVIDERS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-image/providers/runtime.mjs"
));
const ARTIFACTS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packaging/desktop/extensions/jouzu-image/artifacts.mjs"
));

const SIZES: [&str; 3] = ["1K", "2K", "4K"];
const DEFAULT_PROVIDER: &str = "shisa";
const DEFAULT_SIZE: &str = "1K";
const DEFAULT_MAX_IMAGES: u64 = 3;
const REVIEW_TOOLS: [&str; 1] = ["generate_image"];

fn agent_dir(home: &Path) -> PathBuf {
    home.join("agent")
}

/// Write the extension into the Jouzu home's agent folder, where the runtime loads it.
/// Idempotent: a newer desktop replaces the files.
pub fn ensure(home: &Path) -> Result<(), String> {
    let directory = agent_dir(home).join("extensions").join("jouzu-image");
    std::fs::create_dir_all(directory.join("providers")).map_err(|error| format!("Could not create the image extension: {error}"))?;
    std::fs::write(directory.join("package.json"), MANIFEST).map_err(|error| error.to_string())?;
    std::fs::write(directory.join("index.js"), EXTENSION).map_err(|error| error.to_string())?;
    std::fs::write(directory.join("providers").join("shisa.mjs"), SHISA).map_err(|error| error.to_string())?;
    std::fs::write(directory.join("providers").join("runtime.mjs"), RUNTIME_PROVIDERS).map_err(|error| error.to_string())?;
    std::fs::write(directory.join("artifacts.mjs"), ARTIFACTS).map_err(|error| error.to_string())?;
    Ok(())
}

fn tools_path(home: &Path) -> PathBuf {
    agent_dir(home).join("tools.json")
}

fn valid_model(model: &str) -> bool {
    model.len() <= 128 && model.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | '/'))
}

fn normalize_image(value: &serde_json::Value) -> serde_json::Value {
    let enabled = value.get("enabled").and_then(|enabled| enabled.as_bool()).unwrap_or(true);
    let provider = value
        .get("provider")
        .and_then(|provider| provider.as_str())
        .filter(|provider| !provider.trim().is_empty())
        .unwrap_or(DEFAULT_PROVIDER);
    let model = value
        .get("model")
        .and_then(|model| model.as_str())
        .filter(|model| valid_model(model))
        .unwrap_or("");
    let size = value
        .get("size")
        .and_then(|size| size.as_str())
        .filter(|size| SIZES.contains(size))
        .unwrap_or(DEFAULT_SIZE);
    let max_images = value
        .get("maxImages")
        .and_then(|max| max.as_u64())
        .map(|max| max.clamp(1, 10))
        .unwrap_or(DEFAULT_MAX_IMAGES);
    serde_json::json!({ "enabled": enabled, "provider": provider, "model": model, "size": size, "maxImages": max_images })
}

fn review_tools(value: &serde_json::Value) -> serde_json::Value {
    let tools: Vec<&str> = value
        .get("reviewTools")
        .and_then(|tools| tools.as_array())
        .map(|tools| tools.iter().filter_map(|tool| tool.as_str()).collect())
        .unwrap_or_default();
    if tools.is_empty() {
        serde_json::json!(REVIEW_TOOLS)
    } else {
        serde_json::json!(tools)
    }
}

fn default_tools() -> serde_json::Value {
    serde_json::json!({ "image": normalize_image(&serde_json::json!({})), "reviewTools": REVIEW_TOOLS })
}

pub fn read_tools(home: &Path) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = std::fs::read_to_string(tools_path(home))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(default_tools);
    Ok(serde_json::json!({
        "image": normalize_image(value.get("image").unwrap_or(&serde_json::Value::Null)),
        "reviewTools": review_tools(&value),
    }))
}

pub fn save_tools(home: &Path, image: &serde_json::Value) -> Result<serde_json::Value, String> {
    let current = read_tools(home)?;
    let directory = agent_dir(home);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let value = serde_json::json!({
        "image": normalize_image(image),
        "reviewTools": current.get("reviewTools").cloned().unwrap_or_else(|| serde_json::json!(REVIEW_TOOLS)),
    });
    std::fs::write(tools_path(home), format!("{}\n", serde_json::to_string_pretty(&value).unwrap()))
        .map_err(|error| error.to_string())?;
    Ok(value)
}

/// Run the extension's CLI entry with the same home the runtime uses.
fn run_cli(managed: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    let node = crate::runtime_install::node_executable(managed);
    if !node.is_file() {
        return Err("The runtime is not installed yet.".into());
    }
    let home = crate::runtime::effective_home()?;
    let script = home.join("agent").join("extensions").join("jouzu-image").join("index.js");
    if !script.is_file() {
        return Err("The image tool is not installed yet.".into());
    }
    let mut command = std::process::Command::new(node);
    command
        .arg(&script)
        .args(args)
        .env("JOUZU_HOME", &home)
        .env("PI_CODING_AGENT_DIR", home.join("agent"))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "The image tool could not be started.".to_string())?;
    // Never wait forever on a provider that does not answer.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The image tool did not answer in time.".into());
            }
            Err(_) => return Err("The image tool could not be started.".to_string()),
        }
    }
    let output = child.wait_with_output().map_err(|_| "The image tool could not be started.".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|_| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("The image tool returned an unexpected answer. {}", stderr.trim())
    })?;
    if let Some(error) = value.get("error").and_then(|error| error.as_str()) {
        return Err(error.to_string());
    }
    Ok(value)
}

#[tauri::command]
pub fn tools_settings_read() -> Result<serde_json::Value, String> {
    read_tools(&crate::runtime::effective_home()?)
}

#[tauri::command]
pub fn tools_settings_save(image: serde_json::Value) -> Result<serde_json::Value, String> {
    save_tools(&crate::runtime::effective_home()?, &image)
}

/// The image providers the extension offers, for the Tools page.
#[tauri::command]
pub async fn image_providers() -> Result<serde_json::Value, String> {
    let managed = crate::runtime::managed_root()?;
    tauri::async_runtime::spawn_blocking(move || run_cli(&managed, &["--providers"]))
        .await
        .map_err(|_| "The image tool could not be started.".to_string())?
}

/// The signed-in provider's image models, for the Tools page.
#[tauri::command]
pub async fn image_models(provider: String) -> Result<serde_json::Value, String> {
    let managed = crate::runtime::managed_root()?;
    tauri::async_runtime::spawn_blocking(move || run_cli(&managed, &["--models", &provider]))
        .await
        .map_err(|_| "The image tool could not be started.".to_string())?
}

/// Called after a runtime install and on app start, so existing installs get it too.
#[tauri::command]
pub fn image_tool_ensure() -> Result<(), String> {
    ensure(&crate::runtime::effective_home()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_extension_lands_where_pi_looks_for_it() {
        let managed = tempfile::tempdir().unwrap();
        ensure(managed.path()).unwrap();
        let directory = managed.path().join("agent/extensions/jouzu-image");
        assert!(directory.join("package.json").is_file());
        assert!(directory.join("index.js").is_file());
        assert!(directory.join("providers/shisa.mjs").is_file());
        assert!(directory.join("providers/runtime.mjs").is_file());
        assert!(directory.join("artifacts.mjs").is_file());
        let manifest = std::fs::read_to_string(directory.join("package.json")).unwrap();
        assert!(manifest.contains("pi"));
    }

    #[test]
    fn tools_settings_round_trip_with_defaults() {
        let managed = tempfile::tempdir().unwrap();
        let defaults = read_tools(managed.path()).unwrap();
        assert_eq!(defaults["image"]["provider"], DEFAULT_PROVIDER);
        assert_eq!(defaults["image"]["maxImages"], DEFAULT_MAX_IMAGES);
        assert_eq!(defaults["reviewTools"], serde_json::json!(REVIEW_TOOLS));

        let saved = save_tools(managed.path(), &serde_json::json!({ "provider": "shisa", "model": "gemini-3-pro-image", "size": "2K", "maxImages": 2 })).unwrap();
        assert_eq!(saved["image"]["model"], "gemini-3-pro-image");
        assert_eq!(saved["image"]["size"], "2K");
        assert_eq!(saved["image"]["maxImages"], 2);
        let read = read_tools(managed.path()).unwrap();
        assert_eq!(read["image"]["model"], "gemini-3-pro-image");
        assert_eq!(read["reviewTools"], serde_json::json!(REVIEW_TOOLS));
    }

    #[test]
    fn tools_settings_normalize_unknown_values() {
        let managed = tempfile::tempdir().unwrap();
        let saved = save_tools(managed.path(), &serde_json::json!({ "size": "9K", "maxImages": 99, "model": "future-image-model" })).unwrap();
        assert_eq!(saved["image"]["size"], DEFAULT_SIZE);
        assert_eq!(saved["image"]["maxImages"], 10);
        assert_eq!(saved["image"]["model"], "future-image-model");
        let blank = save_tools(managed.path(), &serde_json::json!({ "provider": "  ", "model": "" })).unwrap();
        assert_eq!(blank["image"]["provider"], DEFAULT_PROVIDER);
        assert_eq!(blank["image"]["model"], "");
    }

    #[test]
    fn saving_keeps_a_custom_review_list() {
        let managed = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(managed.path().join("agent")).unwrap();
        std::fs::write(tools_path(managed.path()), r#"{"reviewTools":["generate_image","other_tool"]}"#).unwrap();
        let saved = save_tools(managed.path(), &serde_json::json!({ "enabled": false })).unwrap();
        assert_eq!(saved["reviewTools"], serde_json::json!(["generate_image", "other_tool"]));
        assert_eq!(saved["image"]["enabled"], false);
    }

    #[test]
    fn the_cli_reports_a_missing_runtime() {
        let managed = tempfile::tempdir().unwrap();
        let error = run_cli(managed.path(), &["--providers"]).unwrap_err();
        assert!(error.contains("runtime is not installed"));
    }
}
