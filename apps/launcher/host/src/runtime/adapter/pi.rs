//! pi RPC record/adapter boundary.
//!
//! The session core owns state; this module owns the pi wire vocabulary. Adding
//! a record type or a delta kind starts here rather than in `session.rs`.

use serde_json::Value;

pub const KIND: &str = "pi";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Record {
    Response,
    AgentStart,
    /// One step of a run: a model call and the tools it asks for.
    TurnStart,
    TurnEnd,
    MessageStart,
    MessageEnd,
    MessageUpdate,
    ToolStart,
    ToolUpdate,
    ToolEnd,
    AgentSettled,
    RetryStart,
    RetryEnd,
    CompactionStart,
    CompactionEnd,
    CustomMessage,
    ExtensionUiRequest,
    ExtensionError,
    Error,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaKind {
    Text,
    Thinking,
    /// The model is writing a tool call's arguments.
    ToolCall,
    Other,
}

pub fn classify(value: &Value) -> Record {
    match value.get("type").and_then(Value::as_str) {
        Some("response") => Record::Response,
        Some("agent_start") => Record::AgentStart,
        Some("turn_start") => Record::TurnStart,
        Some("turn_end") => Record::TurnEnd,
        Some("message_start") => Record::MessageStart,
        Some("message_end") => Record::MessageEnd,
        Some("auto_retry_start") => Record::RetryStart,
        Some("auto_retry_end") => Record::RetryEnd,
        Some("compaction_start") => Record::CompactionStart,
        Some("compaction_end") => Record::CompactionEnd,
        Some("message_update") => Record::MessageUpdate,
        Some("tool_execution_start") => Record::ToolStart,
        Some("tool_execution_update") => Record::ToolUpdate,
        Some("tool_execution_end") => Record::ToolEnd,
        Some("agent_settled") => Record::AgentSettled,
        Some("custom_message") => Record::CustomMessage,
        Some("extension_ui_request") => Record::ExtensionUiRequest,
        Some("extension_error") => Record::ExtensionError,
        Some("error") => Record::Error,
        _ => Record::Other,
    }
}

pub fn delta_kind(value: &Value) -> DeltaKind {
    match value
        .get("assistantMessageEvent")
        .and_then(|update| update.get("type"))
        .and_then(Value::as_str)
    {
        Some("text_delta") => DeltaKind::Text,
        Some("thinking_delta") => DeltaKind::Thinking,
        Some("toolcall_start" | "toolcall_delta") => DeltaKind::ToolCall,
        _ => DeltaKind::Other,
    }
}

/// The text of a message's content (a string, or text blocks joined).
pub fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

pub fn delta_text(value: &Value) -> &str {
    value
        .get("assistantMessageEvent")
        .and_then(|update| update.get("delta"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// Commands the host sends. Each returns the record without an id; the
/// session adds the request id it will match the response by.
pub mod command {
    use serde_json::{json, Value};

    /// The same command, carrying the id its response will name.
    pub fn with_id(mut command: Value, id: &str) -> Value {
        command["id"] = Value::String(id.to_string());
        command
    }

    pub fn get_state() -> Value {
        json!({ "type": "get_state" })
    }

    pub fn get_messages() -> Value {
        json!({ "type": "get_messages" })
    }

    pub fn get_session_stats() -> Value {
        json!({ "type": "get_session_stats" })
    }

    pub fn compact() -> Value {
        json!({ "type": "compact" })
    }

    pub fn export_html(output_path: &str) -> Value {
        json!({ "type": "export_html", "outputPath": output_path })
    }

    /// Attach the runtime to a saved session file.
    pub fn switch_session(path: &str) -> Value {
        json!({ "type": "switch_session", "sessionPath": path })
    }

    /// A user turn. Images are `(mime, base64)` pairs.
    pub fn prompt(text: &str, images: &[(&str, &str)]) -> Value {
        let mut prompt = json!({ "type": "prompt", "message": text });
        if !images.is_empty() {
            prompt["images"] = json!(images
                .iter()
                .map(|(mime, data)| json!({ "type": "image", "data": data, "mimeType": mime }))
                .collect::<Vec<_>>());
        }
        prompt
    }

    pub fn abort() -> Value {
        json!({ "type": "abort" })
    }

    /// The same user message, for the running turn: the runtime delivers it at
    /// the next step boundary, before the next model call.
    pub fn as_steer(prompt: &Value) -> Value {
        let mut steer = prompt.clone();
        steer["type"] = Value::String("steer".to_string());
        steer
    }

    /// Take back every steered message the runtime has not delivered yet.
    pub fn clear_queue() -> Value {
        json!({ "type": "clear_queue" })
    }

    pub fn set_model(provider: &str, model: &str) -> Value {
        json!({ "type": "set_model", "provider": provider, "modelId": model })
    }

    pub fn set_thinking_level(level: &str) -> Value {
        json!({ "type": "set_thinking_level", "level": level })
    }

    /// Answers to an extension's approval or question.
    pub fn ui_cancelled(request: &str) -> Value {
        json!({ "type": "extension_ui_response", "id": request, "cancelled": true })
    }

    pub fn ui_confirmed(request: &str, confirmed: bool) -> Value {
        json!({ "type": "extension_ui_response", "id": request, "confirmed": confirmed })
    }

    pub fn ui_value(request: &str, value: &str) -> Value {
        json!({ "type": "extension_ui_response", "id": request, "value": value })
    }

    /// The command kind, as the runtime names it.
    pub fn kind(command: &Value) -> Option<&str> {
        command.get("type").and_then(Value::as_str)
    }
}

/// Which command a `response` record answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Prompt,
    GetState,
    GetMessages,
    SwitchSession,
    SetThinkingLevel,
    Other,
}

pub fn reply_to(response: &Value) -> Reply {
    match response.get("command").and_then(Value::as_str) {
        Some("prompt") => Reply::Prompt,
        Some("get_state") => Reply::GetState,
        Some("get_messages") => Reply::GetMessages,
        Some("switch_session") => Reply::SwitchSession,
        Some("set_thinking_level") => Reply::SetThinkingLevel,
        _ => Reply::Other,
    }
}

impl Reply {
    /// Commands that attach a runtime to its session; their failure fails the start.
    pub fn is_handshake(self) -> bool {
        matches!(self, Reply::GetState | Reply::GetMessages | Reply::SwitchSession)
    }
}

/// What the runtime reports about itself in a `get_state` answer.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct State {
    pub session_file: Option<String>,
    pub model: Option<Value>,
    pub thinking_level: Option<String>,
}

impl State {
    pub fn read(data: &Value) -> Self {
        Self {
            session_file: data.get("sessionFile").and_then(Value::as_str).map(str::to_string),
            model: data.get("model").filter(|model| !model.is_null()).cloned(),
            thinking_level: data
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_record_and_delta_kinds() {
        assert_eq!(classify(&json!({ "type": "agent_start" })), Record::AgentStart);
        assert_eq!(
            classify(&json!({ "type": "tool_execution_end" })),
            Record::ToolEnd
        );
        assert_eq!(classify(&json!({ "type": "unknown" })), Record::Other);
        assert_eq!(
            delta_kind(&json!({ "assistantMessageEvent": { "type": "thinking_delta", "delta": "x" } })),
            DeltaKind::Thinking
        );
        assert_eq!(
            delta_text(&json!({ "assistantMessageEvent": { "type": "text_delta", "delta": "hi" } })),
            "hi"
        );
    }

    #[test]
    fn commands_carry_the_runtime_vocabulary() {
        let prompt = command::with_id(command::prompt("hi", &[("image/png", "AA==")]), "c1");
        assert_eq!(prompt["id"], "c1");
        assert_eq!(prompt["type"], "prompt");
        assert_eq!(prompt["images"][0]["mimeType"], "image/png");
        assert!(command::prompt("hi", &[]).get("images").is_none());
        assert_eq!(command::switch_session("a.jsonl")["sessionPath"], "a.jsonl");
        assert_eq!(command::ui_value("r", "yes")["value"], "yes");
        let state = State::read(&json!({ "sessionFile": "f", "model": null, "thinkingLevel": "low" }));
        assert_eq!(state.session_file.as_deref(), Some("f"));
        assert!(state.model.is_none());
        assert_eq!(state.thinking_level.as_deref(), Some("low"));
    }
}
