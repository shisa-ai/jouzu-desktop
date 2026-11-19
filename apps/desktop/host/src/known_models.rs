//! The runtime's latest answers about models, kept so a client never waits for
//! a list it has already been given.
//!
//! Every runtime the host starts reads the same configuration, so they register
//! the same models: the last list any of them answered (`get_available_models`)
//! is what the next one will answer too. The host keeps that answer, and the
//! model a blank runtime reported at start (`get_state`), and nothing else: it is
//! a copy of the runtime's words, never a list or default of the host's own. A
//! newer answer replaces it; a configuration change forgets it, and answers from
//! runtimes started before that change are not taken (`generation`).

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

use serde_json::Value;

#[derive(Default)]
struct Known {
    models: Vec<Value>,
    start_model: Option<Value>,
}

#[derive(Default)]
pub struct KnownModels {
    known: Mutex<Known>,
    generation: AtomicU64,
}

impl KnownModels {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Known> {
        self.known.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The configuration generation a runtime started under. Its answers count
    /// only while no configuration change came after it.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// The configuration changed: what runtimes said before no longer holds.
    pub fn forget(&self) {
        let mut known = self.lock();
        self.generation.fetch_add(1, Ordering::SeqCst);
        *known = Known::default();
    }

    /// A runtime answered `get_available_models`.
    pub fn remember_list(&self, generation: u64, models: &[Value]) {
        let mut known = self.lock();
        if generation == self.generation() {
            known.models = models.to_vec();
        }
    }

    /// A blank runtime (warm, or a new conversation's) reported its model.
    pub fn remember_start_model(&self, generation: u64, model: Option<&Value>) {
        let mut known = self.lock();
        if generation == self.generation() {
            known.start_model = model.filter(|model| model.get("id").is_some()).cloned();
        }
    }

    /// The latest list a runtime answered; empty when none has yet.
    pub fn list(&self) -> Vec<Value> {
        self.lock().models.clone()
    }

    /// The model a blank runtime last reported at start.
    pub fn start_model(&self) -> Option<Value> {
        self.lock().start_model.clone()
    }

    /// The listed entry for `provider`/`id`, as the runtime described it.
    pub fn find(&self, provider: &str, id: &str) -> Option<Value> {
        self.lock()
            .models
            .iter()
            .find(|model| is_model(model, provider, id))
            .cloned()
    }
}

/// Whether a runtime model entry is `provider`/`id`.
pub fn is_model(model: &Value, provider: &str, id: &str) -> bool {
    model.get("provider").and_then(Value::as_str) == Some(provider)
        && model.get("id").and_then(Value::as_str) == Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_from_before_a_configuration_change_are_not_taken() {
        let known = KnownModels::new();
        let before = known.generation();
        known.remember_list(before, &[json!({ "provider": "a", "id": "x" })]);
        assert_eq!(known.list().len(), 1);
        known.forget();
        assert!(known.list().is_empty());
        // A runtime started before the change answers late: ignored.
        known.remember_list(before, &[json!({ "provider": "a", "id": "x" })]);
        assert!(known.list().is_empty());
        known.remember_list(known.generation(), &[json!({ "provider": "b", "id": "y" })]);
        assert!(known.find("b", "y").is_some());
        assert!(known.find("a", "x").is_none());
    }
}
