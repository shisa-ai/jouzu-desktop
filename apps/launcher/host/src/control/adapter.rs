//! The control adapter: how the private Jouzu script is handed to Node, and how the
//! lines it writes are read. Two functions and no trait: the manager calls them
//! directly, and a future file- or command-based adapter changes only these bodies.

use std::path::PathBuf;

/// The private Jouzu configuration adapter, embedded so it cannot drift from the
/// binary that runs it. Windows rejects a command line above 32,767 characters, so
/// the script must stay well under it; `MAX_SCRIPT_BYTES` trips loudly instead of
/// failing at spawn time.
pub const SCRIPT: &str = include_str!("../../../../../packaging/launcher/control.mjs");
pub const MAX_SCRIPT_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone)]
pub struct ControlContext {
    pub node: PathBuf,
    /// Managed root passed as the adapter's first argument.
    pub root: PathBuf,
    /// The active Jouzu app passed as the adapter's second argument.
    pub app: PathBuf,
    /// The runtime home: `JOUZU_HOME` for the adapter, and the folder whose
    /// `launcher-environment.bin` holds the variables saved in Settings.
    pub home: PathBuf,
    /// The program run with `--eval`: `SCRIPT`, except in tests.
    pub script: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A device-code notice from the adapter. It is written to stderr as one JSON line
/// during Shisa.AI sign-in or a provider OAuth flow; nothing else on stderr is an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    /// Set for a provider OAuth device flow; absent for Shisa.AI sign-in.
    pub provider: Option<String>,
    /// A URL-only flow has no user code to type, only a page to open.
    pub url: String,
    pub code: String,
}

/// `environment` is the saved variables read for this launch; it is applied after
/// `JOUZU_HOME`.
pub fn spec(context: &ControlContext, environment: &[(String, String)]) -> Result<LaunchSpec, String> {
    if context.script.len() > MAX_SCRIPT_BYTES {
        return Err("Control adapter is too large for the command line".into());
    }
    if !context.node.is_file() {
        return Err(format!(
            "Jouzu's bundled Node.js is missing ({}). Reinstall Jouzu to restore it.",
            context.node.display()
        ));
    }
    // Node rejects verbatim paths, so the managed paths are converted at this boundary.
    let root = super::app::process_path(&context.root);
    let app = super::app::process_path(&context.app);
    let args = vec![
        "--input-type=module".to_string(),
        "--eval".to_string(),
        context.script.clone(),
        "--".to_string(),
        root.to_string_lossy().into_owned(),
        app.to_string_lossy().into_owned(),
    ];
    let mut env = vec![(
        "JOUZU_HOME".to_string(),
        context.home.to_string_lossy().into_owned(),
    )];
    env.extend(environment.iter().cloned());
    Ok(LaunchSpec {
        program: super::app::process_path(&context.node),
        args,
        env,
    })
}

/// Parse one stderr line. The adapter writes
/// `{"type":"device","url":…,"code":…,"provider"?:…}`; every other line (logs, blank
/// lines, malformed JSON) is not an event.
pub fn parse_event(line: &str) -> Option<DeviceCode> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|value| value.as_str()) != Some("device") {
        return None;
    }
    let url = value.get("url").and_then(|value| value.as_str())?.trim();
    let code = match value.get("code") {
        None | Some(serde_json::Value::Null) => "",
        Some(serde_json::Value::String(text)) => text.trim(),
        // A malformed code is a malformed event, not an empty one.
        Some(_) => return None,
    };
    // A provider id routes the code to a provider dialog, so a malformed one is a
    // malformed event rather than an event with the provider dropped.
    let provider = match value.get("provider") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(text)) => {
            let text = text.trim();
            if text.is_empty()
                || text.len() > 64
                || !text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'_' || byte == b'-')
            {
                return None;
            }
            Some(text.to_string())
        }
        Some(_) => return None,
    };
    // A URL-only device flow carries an empty code; the URL is what identifies it.
    if url.is_empty() || url.len() > 2048 || code.len() > 128 {
        return None;
    }
    Some(DeviceCode {
        provider,
        url: url.to_string(),
        code: code.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bundled Node that exists (spec refuses a missing one).
    fn node() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jouzu-adapter-node-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let node = dir.join("node.exe");
        std::fs::write(&node, "").unwrap();
        node
    }

    fn saved() -> Vec<(String, String)> {
        vec![("EXAMPLE".into(), "1".into())]
    }

    fn context() -> ControlContext {
        ControlContext {
            node: node(),
            root: PathBuf::from(r"C:\managed"),
            app: PathBuf::from(r"C:\managed\app"),
            home: PathBuf::from(r"C:\managed\data"),
            script: SCRIPT.to_string(),
        }
    }

    #[test]
    fn the_script_fits_the_command_line() {
        assert!(SCRIPT.len() <= MAX_SCRIPT_BYTES, "adapter grew to {} bytes", SCRIPT.len());
        assert!(spec(&context(), &saved()).is_ok());
    }

    #[test]
    fn a_missing_bundled_node_is_an_error_not_a_fallback() {
        let mut context = context();
        context.node = PathBuf::from(r"C:\nowhere\runtime\node\node.exe");
        let error = spec(&context, &saved()).unwrap_err();
        assert!(error.contains("bundled Node.js is missing"), "{error}");
    }

    #[test]
    fn the_spec_passes_root_and_app_positionally() {
        let spec = spec(&context(), &saved()).unwrap();
        assert!(spec.program.ends_with("node.exe"));
        assert_eq!(spec.args[0], "--input-type=module");
        assert_eq!(spec.args[1], "--eval");
        assert_eq!(spec.args[2], SCRIPT);
        assert_eq!(spec.args[3], "--");
        assert_eq!(spec.args[4], r"C:\managed");
        assert_eq!(spec.args[5], r"C:\managed\app");
        assert_eq!(spec.args.len(), 6);
    }

    #[test]
    fn the_spec_sets_jouzu_home_before_saved_environment() {
        let spec = spec(&context(), &saved()).unwrap();
        assert_eq!(spec.env[0], ("JOUZU_HOME".to_string(), r"C:\managed\data".to_string()));
        assert_eq!(spec.env[1], ("EXAMPLE".to_string(), "1".to_string()));
    }

    #[test]
    fn a_shisa_device_line_becomes_an_event() {
        // The exact shape 1.0.23 `control.mjs` writes for Shisa.AI sign-in.
        let line = r#"{"type":"device","url":"https://platform.shisa.ai/connect","code":"ABCD-EFGH"}"#;
        let code = parse_event(line).expect("device line");
        assert_eq!(code.url, "https://platform.shisa.ai/connect");
        assert_eq!(code.code, "ABCD-EFGH");
        assert_eq!(code.provider, None);
    }

    #[test]
    fn a_provider_device_line_keeps_the_provider() {
        // 1.0.23 adds `provider` for provider OAuth and may omit a user code.
        let line = r#"{"type":"device","provider":"openai-codex","url":"https://example.test/device","code":""}"#;
        let code = parse_event(line).expect("provider device line");
        assert_eq!(code.provider.as_deref(), Some("openai-codex"));
        assert_eq!(code.url, "https://example.test/device");
        assert_eq!(code.code, "");
    }

    #[test]
    fn other_lines_are_not_events() {
        for line in [
            "",
            "   ",
            "starting configuration",
            "{\"type\":\"progress\",\"value\":1}",
            "{\"type\":\"device\"}",
            "{\"type\":\"device\",\"url\":\"\",\"code\":\"X\"}",
            "{\"type\":\"device\",\"url\":\"https://example.test\",\"code\":1}",
            "{\"type\":\"device\",\"url\":\"https://example.test\",\"provider\":\"../../x\",\"code\":\"A\"}",
            "not json at all",
        ] {
            assert_eq!(parse_event(line), None, "unexpected event for {line:?}");
        }
    }
}

