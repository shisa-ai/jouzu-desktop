//! One process-wide event ring for every client.
//!
//! Session and control events keep their existing payloads; the hub adds a global
//! sequence, a session id and the per-session sequence before broadcasting. A client
//! reconnects with `Last-Event-ID`; if the gap is older than the ring it gets a
//! resync instead of a silently incomplete stream.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

const RING_EVENTS: usize = 10_000;
const RING_BYTES: usize = 8 * 1024 * 1024;
const BROADCAST_CAPACITY: usize = 2_048;

#[derive(Clone, Debug, Serialize)]
pub struct HubEvent {
    pub seq: u64,
    pub session_id: String,
    pub session_seq: u64,
    pub event: String,
    pub data: Value,
}

struct Ring {
    events: VecDeque<HubEvent>,
    bytes: usize,
}

impl Ring {
    fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(256),
            bytes: 0,
        }
    }

    fn push(&mut self, event: HubEvent) {
        let bytes = serde_json::to_vec(&event.data).map(|value| value.len()).unwrap_or(0) + 128;
        self.bytes += bytes;
        self.events.push_back(event);
        while self.events.len() > RING_EVENTS || self.bytes > RING_BYTES {
            match self.events.pop_front() {
                Some(removed) => {
                    let removed_bytes = serde_json::to_vec(&removed.data)
                        .map(|value| value.len())
                        .unwrap_or(0)
                        + 128;
                    self.bytes = self.bytes.saturating_sub(removed_bytes);
                }
                None => break,
            }
        }
    }
}

pub struct EventHub {
    seq: AtomicU64,
    ring: Mutex<Ring>,
    sender: broadcast::Sender<HubEvent>,
}

impl EventHub {
    pub fn new() -> Arc<Self> {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Arc::new(Self {
            seq: AtomicU64::new(0),
            ring: Mutex::new(Ring::new()),
            sender,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        self.sender.subscribe()
    }

    pub fn latest_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    /// Publish a session event. `session_seq` is the existing per-session cursor.
    pub fn publish_session(&self, session_id: &str, session_seq: u64, event: &str, data: Value) -> HubEvent {
        self.publish(session_id, session_seq, event, data)
    }

    /// Publish a control event; control is not owned by a session.
    pub fn publish_control(&self, event: &str, data: Value) -> HubEvent {
        self.publish("", 0, event, data)
    }

    fn publish(&self, session_id: &str, session_seq: u64, event: &str, data: Value) -> HubEvent {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut data = data;
        if let Some(object) = data.as_object_mut() {
            object.insert("seq".to_string(), json!(seq));
            object.insert("sessionId".to_string(), json!(session_id));
            object.insert("sessionSeq".to_string(), json!(session_seq));
            object.insert("event".to_string(), json!(event));
        } else {
            data = json!({
                "seq": seq,
                "sessionId": session_id,
                "sessionSeq": session_seq,
                "event": event,
                "value": data,
            });
        }
        let hub_event = HubEvent {
            seq,
            session_id: session_id.to_string(),
            session_seq,
            event: event.to_string(),
            data,
        };
        {
            let mut ring = self
                .ring
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            ring.push(hub_event.clone());
        }
        let _ = self.sender.send(hub_event.clone());
        hub_event
    }

    /// Replay everything after `after`. `resync` means the ring no longer contains
    /// the gap, so the client must reload state instead of trusting a partial replay.
    pub fn replay_after(&self, after: u64) -> (Vec<HubEvent>, bool, u64) {
        let ring = self
            .ring
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let latest = self.latest_seq();
        let oldest = ring.events.front().map(|event| event.seq);
        let resync = after > 0 && oldest.is_some_and(|oldest| after + 1 < oldest);
        let events = ring
            .events
            .iter()
            .filter(|event| event.seq > after)
            .cloned()
            .collect();
        (events, resync, latest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigns_global_and_session_sequences() {
        let hub = EventHub::new();
        let first = hub.publish_session("s1", 7, "message.delta", json!({ "text": "a" }));
        let second = hub.publish_control("control.started", json!({ "requestId": "r1" }));
        assert_eq!(first.seq, 1);
        assert_eq!(second.seq, 2);
        assert_eq!(first.session_id, "s1");
        assert_eq!(first.session_seq, 7);
        assert_eq!(second.session_id, "");
        assert_eq!(first.data["seq"], 1);
        assert_eq!(first.data["sessionId"], "s1");
        assert_eq!(first.data["sessionSeq"], 7);
        assert_eq!(first.data["event"], "message.delta");
        assert_eq!(hub.latest_seq(), 2);
    }

    #[test]
    fn replays_only_events_after_the_cursor() {
        let hub = EventHub::new();
        hub.publish_session("s1", 1, "one", json!({}));
        hub.publish_session("s1", 2, "two", json!({}));
        hub.publish_session("s1", 3, "three", json!({}));

        let (events, resync, latest) = hub.replay_after(1);
        assert!(!resync);
        assert_eq!(latest, 3);
        assert_eq!(events.iter().map(|event| event.seq).collect::<Vec<_>>(), vec![2, 3]);
    }
}
