//! What the runtimes' replies say about each provider's sign-in.
//!
//! A stored key or token says nothing about whether the provider accepts it.
//! The only source is a reply: one the provider refused for its key or sign-in
//! (`provider_error::code` = `auth`), or one it answered. The host keeps the
//! latest of those per provider for Settings (`AppView.providerAuth`), until a
//! reply is answered or the person signs in again. The runtime does not report
//! provider availability over RPC (runtime request G5).

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

#[derive(Default)]
pub struct ProviderAnswers {
    refused: Mutex<BTreeMap<String, Value>>,
    changed: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

impl ProviderAnswers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set once by the host: runs whenever the map changes.
    pub fn on_change(&self, action: impl Fn() + Send + Sync + 'static) {
        let _ = self.changed.set(Box::new(action));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Value>> {
        self.refused.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self, changed: bool) {
        if changed {
            if let Some(action) = self.changed.get() {
                action();
            }
        }
    }

    /// A reply from `provider` ended: refused for its sign-in (with the
    /// provider's words), or answered.
    pub fn reply(&self, provider: &str, refused: Option<&str>, at: &str) {
        if provider.is_empty() {
            return;
        }
        let changed = {
            let mut map = self.lock();
            match refused {
                Some(text) => {
                    let entry = json!({ "refusedAt": at, "text": text });
                    map.insert(provider.to_string(), entry);
                    true
                }
                None => map.remove(provider).is_some(),
            }
        };
        self.notify(changed);
    }

    /// The person signed in again, saved a key or removed one: what an earlier
    /// reply said no longer applies.
    pub fn forget(&self, provider: &str) {
        let changed = self.lock().remove(provider).is_some();
        self.notify(changed);
    }

    /// `{ provider: { refusedAt, text } }` for every provider whose latest reply
    /// was refused for its sign-in.
    pub fn view(&self) -> Value {
        Value::Object(self.lock().clone().into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::ProviderAnswers;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn a_refusal_lasts_until_an_answer_or_a_new_sign_in() {
        let answers = ProviderAnswers::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let seen = changes.clone();
        answers.on_change(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        answers.reply("shisa", Some("401 Unauthorized"), "t1");
        assert_eq!(answers.view()["shisa"]["text"], "401 Unauthorized");
        answers.reply("other", None, "t2");
        assert_eq!(changes.load(Ordering::SeqCst), 1, "an answer from another provider changes nothing");
        answers.reply("shisa", None, "t3");
        assert!(answers.view().get("shisa").is_none());
        answers.reply("shisa", Some("401"), "t4");
        answers.forget("shisa");
        assert!(answers.view().as_object().unwrap().is_empty());
        assert_eq!(changes.load(Ordering::SeqCst), 4);
    }
}
