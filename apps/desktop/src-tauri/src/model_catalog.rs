//! Read the signed model-catalog snapshot so the model menu can show the
//! catalog's limits and prices instead of the runtime projection's placeholder
//! zero cost. The cache is written by Jouzu; this module only reads local files.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn documents(root: &Path) -> Vec<PathBuf> {
    fn walk(directory: &Path, depth: usize, found: &mut Vec<PathBuf>) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, found);
            } else if path.file_name().and_then(|name| name.to_str()) == Some("documents")
                || path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    == Some("documents")
            {
                if path.extension().and_then(|value| value.to_str()) == Some("json") {
                    found.push(path);
                }
            }
        }
    }
    let mut found = Vec::new();
    walk(root, 0, &mut found);
    found
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn model_id(offering: &Value) -> Option<&str> {
    offering.get("modelId").and_then(Value::as_str)
}

fn price(offering: &Value) -> Option<Value> {
    let price = offering.get("metadata")?.get("price")?;
    let fields = ["input", "output", "cacheRead", "cacheWrite"];
    if !fields.iter().any(|key| price.get(key).is_some_and(|value| value.is_number())) {
        return None;
    }
    let mut cost = serde_json::Map::new();
    for key in fields {
        if let Some(value) = price.get(key).filter(|value| value.is_number()) {
            cost.insert(key.into(), value.clone());
        }
    }
    Some(Value::Object(cost))
}

/// Return the newest complete catalog's offerings. A missing or malformed
/// snapshot is an empty list, never an invented price.
pub fn load() -> Result<Value, String> {
    let root = crate::runtime::effective_home()?.join("cache/model-catalog");
    let mut best: Option<(String, Vec<Value>)> = None;
    for path in documents(&root) {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(document) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if document.get("format").and_then(Value::as_str) != Some("jouzu.model-catalog")
            || document.get("scope").and_then(|scope| scope.get("complete")).and_then(Value::as_bool) != Some(true)
        {
            continue;
        }
        let generated = document
            .get("generatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let offerings = document
            .get("modelOfferings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let models = offerings
            .into_iter()
            .filter_map(|offering| {
                let id = model_id(&offering)?.to_string();
                let limits = offering.get("limits");
                let context_window = limits.and_then(|value| number(value, "contextWindow"));
                let max_tokens = limits.and_then(|value| number(value, "maxOutputTokens"));
                let cost = price(&offering);
                if context_window.is_none() && max_tokens.is_none() && cost.is_none() {
                    return None;
                }
                let mut model = serde_json::Map::new();
                model.insert("id".into(), Value::String(id));
                if let Some(value) = context_window {
                    model.insert("contextWindow".into(), json!(value));
                }
                if let Some(value) = max_tokens {
                    model.insert("maxTokens".into(), json!(value));
                }
                if let Some(value) = cost {
                    model.insert("cost".into(), value);
                }
                Some(Value::Object(model))
            })
            .collect::<Vec<_>>();
        if best.as_ref().is_none_or(|(current, _)| generated > *current) {
            best = Some((generated, models));
        }
    }
    Ok(json!({ "models": best.map(|(_, models)| models).unwrap_or_default() }))
}
