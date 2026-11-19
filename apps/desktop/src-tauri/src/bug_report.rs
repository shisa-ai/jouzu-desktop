//! What the app knows about this installation, so a report carries facts rather than recollection.
//! The draft itself is written by the payload's own reporter; nothing here describes it.

use crate::{active_app, git_environment, logs, runtime, terminal};
use std::{path::Path, process::Command};

/// The last line of a log about a given subject, which is what a report should carry.
fn last_line(managed: &Path, file: &str, needle: &str) -> Option<String> {
    let text = std::fs::read_to_string(logs::directory(managed).join(file)).ok()?;
    text.lines().rev().find(|line| line.contains(needle)).map(|line| line.to_string())
}

fn payload_version(slot: &Path) -> Option<String> {
    let text = std::fs::read_to_string(slot.join("node_modules/jouzu/package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["version"].as_str().map(str::to_string)
}

/// The facts a report carries, and the one line that describes them in the payload's environment section.
pub fn facts(root: &Path, managed: &Path, slot: &Path) -> serde_json::Value {
    let shape = if root.join("runtime/git/PortableGit.exe").is_file() { "full" } else { "without-git" };
    let update = last_line(managed, "desktop.log", "update").unwrap_or_else(|| "no update recorded".into());
    let session = last_line(managed, "session.log", "end exit=").unwrap_or_else(|| "no session recorded".into());
    let git = git_environment::report(root)
        .ok()
        .and_then(|report| report["effective"]["path"].as_str().map(str::to_string))
        .unwrap_or_else(|| "unavailable".into());
    let host = terminal::report(root)
        .ok()
        .and_then(|report| report["effective"].as_str().map(str::to_string))
        .unwrap_or_else(|| "standard console".into());
    let payload = payload_version(slot).unwrap_or_else(|| "unknown".into());
    let identity = format!(
        "Jouzu Desktop {} ({shape}), payload {payload}, install {}, last update: {update}, last session: {session}, Git Bash {git}, console host {host}",
        env!("CARGO_PKG_VERSION"),
        root.display()
    );
    serde_json::json!({
        "desktopVersion": env!("CARGO_PKG_VERSION"),
        "payloadVersion": payload,
        "installRoot": root.to_string_lossy(),
        "managedRoot": managed.to_string_lossy(),
        "shape": shape,
        "runtimeIdentity": identity,
    })
}

/// The draft as the payload's reporter writes it, with what the user typed and what this installation
/// knows. A release whose reporter is not there answers that instead of a draft.
/// The page a report is written on. The payload's own report carries the same address; this copy answers
/// when the payload cannot be asked, so the action never leads nowhere.
pub const ISSUE_NEW_URL: &str = "https://github.com/shisa-ai/jouzu/issues/new";

pub fn draft(
    app: &tauri::AppHandle,
    description: &str,
    expected: &str,
    actual: &str,
    reproduction: &str,
) -> Result<serde_json::Value, String> {
    let root = runtime::application_root(app)?;
    let managed = runtime::managed_root()?;
    let slot = active_app::resolve_app(&root, &managed)?;
    let mut request = facts(&root, &managed, &slot);
    request["description"] = serde_json::json!(description);
    request["expected"] = serde_json::json!(expected);
    request["actual"] = serde_json::json!(actual);
    request["reproduction"] = serde_json::json!(reproduction);
    let file = managed.join("cache").join("bug-report-facts.json");
    std::fs::create_dir_all(file.parent().ok_or("Cannot write the report request")?)
        .map_err(|error| error.to_string())?;
    std::fs::write(&file, request.to_string()).map_err(|error| error.to_string())?;
    let mut command = Command::new(crate::runtime_install::node_executable(&root));
    command
        .arg(root.join("runtime/desktop-update/bug-report.mjs"))
        .arg(&slot)
        .arg(&file);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&file);
    if !output.status.success() {
        return Err(crate::tool_script::failure(&output, "Cannot build the report"));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid report draft".to_string())
}



