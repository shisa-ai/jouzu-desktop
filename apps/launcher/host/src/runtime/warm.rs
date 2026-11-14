//! Runtimes started ahead of need.
//!
//! The runtime loads its extensions for one folder: switching it to a session in
//! another folder loads them all again (9-13 s measured on Windows), while a
//! switch within the same folder takes about a second. So the pool keeps one
//! blank runtime for each folder the user worked in recently (up to four), and
//! gives the spare places to the most recent folder. With the entry session the
//! app opens while loading, that is five runtimes (ADR 0004 / 0049).
//!
//! Starting a runtime costs seconds to minutes on a busy machine (Node start plus
//! extension imports). The pool starts one before anyone asks for it, plus a
//! spare once that one is ready. A session that needs a runtime takes a warm
//! one, raises it to normal priority and switches it to its own session file;
//! once that session's runtime answers, the pool refills. Until a session takes
//! a runtime, the pool drains its output itself so its pipes never fill.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use super::{process, RuntimeEvent, RuntimeSupervisor, SpawnSpec};

/// How long a warm runtime may take to answer its first request.
const READY_TIMEOUT: Duration = Duration::from_secs(300);
/// Failed warm-ups are retried this many times in a row, then the pool stops
/// until a session asks again; a broken install should not spin the CPU.
const MAX_FAILURES: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarmState {
    /// No warm runtime and none starting.
    Off,
    /// Process started; it has not answered yet (Node and extensions loading).
    Starting,
    /// Answered its first request: a session can use it at once.
    Ready,
    /// The last warm-up failed; `error` says why.
    Failed,
}

impl WarmState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

struct Slot {
    generation: u64,
    workspace: Option<PathBuf>,
    runtime: Arc<RuntimeSupervisor>,
    /// Where the runtime's events go once a session takes it.
    target: Arc<Mutex<Option<mpsc::Sender<RuntimeEvent>>>>,
    started_at: Instant,
    ready_ms: Option<u64>,
}

struct Inner {
    /// Warm runtimes, oldest first. At most `CAPACITY`, and at most one still
    /// starting: two booting at once would slow the one someone waits for.
    slots: Vec<Slot>,
    generation: u64,
    error: Option<String>,
    failures: usize,
    taken: u64,
    /// Folders to warm for, most recent first, at most `CAPACITY`. Empty warms
    /// in a scratch folder, which still saves the Node start.
    recent: Vec<PathBuf>,
    /// Sessions still attaching to a runtime they took. Nothing new starts until
    /// they are done: on a busy machine a runtime booting beside the one the
    /// user waits for (the entry session at start-up) slows it down.
    attaching: usize,
}

/// Blank runtimes kept warm. The entry session is the fifth runtime.
const CAPACITY: usize = 4;
/// With no folder known yet: one for the first session and a spare.
const SCRATCH_CAPACITY: usize = 2;

/// The folder each warm runtime should be for: one per recent folder, the rest
/// for the most recent one. `None` is the scratch folder.
fn plan(recent: &[PathBuf]) -> Vec<Option<PathBuf>> {
    let Some(first) = recent.first() else {
        return vec![None; SCRATCH_CAPACITY];
    };
    let mut plan: Vec<Option<PathBuf>> = recent.iter().take(CAPACITY).cloned().map(Some).collect();
    while plan.len() < CAPACITY {
        plan.push(Some(first.clone()));
    }
    plan
}

fn same_slot(left: Option<&Path>, right: Option<&Path>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => same_folder(left, right),
        (None, None) => true,
        _ => false,
    }
}

/// Which planned places are already filled: for each slot, the plan index it
/// covers, or `None` when it is not needed. Ready slots are matched first.
fn assign(plan: &[Option<PathBuf>], slots: &[Slot]) -> (Vec<Option<usize>>, Vec<bool>) {
    let mut covered = vec![false; plan.len()];
    let mut assigned = vec![None; slots.len()];
    for ready_pass in [true, false] {
        for (index, slot) in slots.iter().enumerate() {
            if assigned[index].is_some() || slot.ready_ms.is_some() != ready_pass {
                continue;
            }
            if let Some(place) = (0..plan.len())
                .find(|&place| !covered[place] && same_slot(plan[place].as_deref(), slot.workspace.as_deref()))
            {
                covered[place] = true;
                assigned[index] = Some(place);
            }
        }
    }
    (assigned, covered)
}

impl Inner {
    fn state(&self) -> WarmState {
        if self.slots.iter().any(|slot| slot.ready_ms.is_some()) {
            WarmState::Ready
        } else if !self.slots.is_empty() {
            WarmState::Starting
        } else if self.error.is_some() {
            WarmState::Failed
        } else {
            WarmState::Off
        }
    }

    /// The slot a session would take: a ready one first, else the oldest.
    fn next(&self) -> Option<usize> {
        self.slots
            .iter()
            .position(|slot| slot.ready_ms.is_some())
            .or_else(|| (!self.slots.is_empty()).then_some(0))
    }
}

pub struct WarmPool {
    spec: Box<dyn Fn(Option<&Path>) -> SpawnSpec + Send + Sync>,
    memory: Option<PathBuf>,
    inner: Mutex<Inner>,
    changed: Box<dyn Fn(Value) + Send + Sync>,
    ready: Notify,
}

impl WarmPool {
    /// `spec` builds the spawn spec for a warm runtime (no session-specific
    /// environment, a scratch working folder). `changed` is told the pool's
    /// state each time it changes.
    ///
    /// `memory` is a file that keeps the target workspace across host restarts.
    pub fn new(
        spec: impl Fn(Option<&Path>) -> SpawnSpec + Send + Sync + 'static,
        memory: Option<PathBuf>,
        changed: impl Fn(Value) + Send + Sync + 'static,
    ) -> Arc<Self> {
        let recent: Vec<PathBuf> = memory
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .map(|text| {
                text.lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
                    .take(CAPACITY)
                    .collect()
            })
            .unwrap_or_default();
        Arc::new(Self {
            spec: Box::new(spec),
            memory,
            inner: Mutex::new(Inner {
                slots: Vec::new(),
                generation: 0,
                error: None,
                failures: 0,
                taken: 0,
                recent,
                attaching: 0,
            }),
            changed: Box::new(changed),
            ready: Notify::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> Value {
        let inner = self.lock();
        Self::describe(&inner)
    }

    fn describe(inner: &Inner) -> Value {
        let next = inner.next().map(|index| &inner.slots[index]);
        json!({
            "state": inner.state().as_str(),
            "elapsedMs": next.map(|slot| slot.started_at.elapsed().as_millis() as u64),
            "readyMs": next.and_then(|slot| slot.ready_ms),
            "error": if inner.slots.is_empty() { inner.error.clone() } else { None },
            "taken": inner.taken,
            "pid": next.map(|slot| slot.runtime.pid()),
            "warm": inner.slots.len(),
            "workspace": next
                .and_then(|slot| slot.workspace.as_ref())
                .or(inner.recent.first())
                .map(|path| path.to_string_lossy().into_owned()),
            "ready": inner.slots.iter().filter(|slot| slot.ready_ms.is_some()).count(),
            "attaching": inner.attaching,
            "slots": inner.slots.iter().map(|slot| json!({
                "workspace": slot.workspace.as_ref().map(|path| path.to_string_lossy().into_owned()),
                "ready": slot.ready_ms.is_some(),
                "pid": slot.runtime.pid(),
            })).collect::<Vec<_>>(),
            "folders": inner.recent.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        })
    }

    fn notify(&self) {
        let status = self.status();
        (self.changed)(status);
    }

    /// Start a warm runtime when there is room and none is starting.
    pub fn fill(self: &Arc<Self>) {
        let (generation, workspace) = {
            let mut inner = self.lock();
            let starting = inner.slots.iter().any(|slot| slot.ready_ms.is_none());
            if starting || inner.attaching > 0 || inner.failures >= MAX_FAILURES {
                return;
            }
            // The first planned place without a runtime: the most recent folder first.
            let plan = plan(&inner.recent);
            let (_, covered) = assign(&plan, &inner.slots);
            let Some(place) = covered.iter().position(|covered| !covered) else {
                return;
            };
            inner.generation += 1;
            inner.error = None;
            (inner.generation, plan[place].clone())
        };
        let mut spec = (self.spec)(workspace.as_deref());
        // Below normal until someone waits for it (`hurry`, `take`): the spare
        // stays there, the first one is hurried by the loading screen.
        spec.low_priority = true;
        if let Err(error) = std::fs::create_dir_all(&spec.workspace) {
            self.failed(generation, format!("Could not prepare the warm-up folder: {error}"));
            return;
        }
        let (event_tx, mut event_rx) = mpsc::channel(256);
        let runtime = match RuntimeSupervisor::start(spec, event_tx) {
            Ok(runtime) => runtime,
            Err(error) => {
                self.failed(generation, format!("Could not start the runtime: {error}"));
                return;
            }
        };
        let target: Arc<Mutex<Option<mpsc::Sender<RuntimeEvent>>>> = Arc::new(Mutex::new(None));
        {
            let mut inner = self.lock();
            if inner.generation != generation {
                // Retired while spawning (aimed elsewhere, recycled, stopped).
                drop(inner);
                runtime.terminate();
                return;
            }
            inner.slots.push(Slot {
                generation,
                workspace,
                runtime: runtime.clone(),
                target: target.clone(),
                started_at: Instant::now(),
                ready_ms: None,
            });
        }
        self.notify();

        // Drain until a session takes the runtime, then forward everything.
        let pool = self.clone();
        let forward = target.clone();
        tokio::spawn(async move {
            let mut stderr_tail: Vec<String> = Vec::new();
            while let Some(event) = event_rx.recv().await {
                let sender = forward
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone();
                if let Some(sender) = sender {
                    if sender.send(event).await.is_err() {
                        return;
                    }
                    continue;
                }
                match event {
                    RuntimeEvent::Stderr(line) => {
                        stderr_tail.push(line);
                        if stderr_tail.len() > 20 {
                            stderr_tail.remove(0);
                        }
                    }
                    RuntimeEvent::Exited(code) => {
                        let tail = stderr_tail.join("\n");
                        let mut message = format!(
                            "The warm runtime exited before use (code {}).",
                            code.map(|code| code.to_string())
                                .unwrap_or_else(|| "none".to_string())
                        );
                        if !tail.is_empty() {
                            message.push('\n');
                            message.push_str(&tail);
                        }
                        pool.failed(generation, message);
                        return;
                    }
                    _ => {}
                }
            }
        });

        // Ready once it answers a request: Node is up and the extensions loaded.
        let pool = self.clone();
        tokio::spawn(async move {
            let result = runtime
                .request(
                    json!({ "id": format!("warm-{generation}"), "type": "get_state" }),
                    READY_TIMEOUT,
                )
                .await;
            match result {
                Ok(_) => {
                    {
                        let mut inner = pool.lock();
                        let Some(slot) = inner.slots.iter_mut().find(|slot| slot.generation == generation) else {
                            return;
                        };
                        // Failures are not forgiven here: a runtime that answers and
                        // then dies would otherwise be restarted forever. A session
                        // taking one, or a client asking again, resets them.
                        slot.ready_ms = Some(slot.started_at.elapsed().as_millis() as u64);
                    }
                    pool.ready.notify_waiters();
                    pool.notify();
                    // Room for the spare now that nothing else is starting.
                    pool.fill();
                }
                Err(error) => {
                    // A runtime that a session already took is that session's
                    // business now; only a waiting one is retired here.
                    let waiting = pool
                        .lock()
                        .slots
                        .iter()
                        .any(|slot| slot.generation == generation);
                    if waiting {
                        runtime.terminate();
                        pool.failed(generation, format!("The warm runtime did not answer: {error:?}"));
                    }
                }
            }
        });
    }

    fn failed(self: &Arc<Self>, generation: u64, message: String) {
        let retry = {
            let mut inner = self.lock();
            let before = inner.slots.len();
            inner.slots.retain(|slot| slot.generation != generation);
            let removed = inner.slots.len() != before;
            // A spawn that failed before it had a slot is only news if it is the
            // latest one; anything older was retired on purpose.
            if !removed && inner.generation != generation {
                return;
            }
            inner.error = Some(message);
            inner.failures += 1;
            inner.failures < MAX_FAILURES
        };
        self.ready.notify_waiters();
        self.notify();
        if retry {
            let pool = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                pool.fill();
            });
        }
    }

    /// Hand a warm runtime to a session: its events go to `events` from now on
    /// and it runs at normal priority. A ready one is preferred, one warmed for
    /// `workspace` before another; a runtime that is still starting is handed
    /// over too, since the session waits for less than it would for a new one.
    ///
    /// A runtime warmed for another folder is still handed over: the switch
    /// reloads the extensions, but the Node start is saved. The second value
    /// says whether it was warmed for `workspace`.
    pub fn take(
        self: &Arc<Self>,
        events: mpsc::Sender<RuntimeEvent>,
        workspace: &Path,
    ) -> Option<(Arc<RuntimeSupervisor>, bool, Attaching)> {
        let slot = {
            let mut inner = self.lock();
            let matches = |slot: &Slot| {
                slot.workspace
                    .as_deref()
                    .is_some_and(|warm| same_folder(warm, workspace))
            };
            // Same folder ready, then same folder starting (a cross-folder switch
            // costs more than the rest of a start), then any ready, then the oldest.
            let index = inner
                .slots
                .iter()
                .position(|slot| slot.ready_ms.is_some() && matches(slot))
                .or_else(|| inner.slots.iter().position(|slot| matches(slot)))
                .or_else(|| inner.next())?;
            let slot = inner.slots.remove(index);
            inner.taken += 1;
            inner.attaching += 1;
            // A session asking is a fresh reason to try again after failures.
            inner.failures = 0;
            slot
        };
        *slot
            .target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(events);
        process::set_low_priority(slot.runtime.pid(), false);
        self.notify();
        // The session refills the pool once its own runtime has answered.
        let matched = slot
            .workspace
            .as_deref()
            .is_some_and(|warm| same_folder(warm, workspace));
        Some((slot.runtime, matched, Attaching(Some(self.clone()))))
    }

    /// `workspace` is where the user works now: it becomes the most recent
    /// folder. Unused runtimes the new plan has no place for are retired (the
    /// folder that dropped out of the recent list, or a spare of the previous
    /// most recent folder); then the pool fills.
    pub fn aim(self: &Arc<Self>, workspace: &Path) {
        let stale = {
            let mut inner = self.lock();
            let already_first = inner
                .recent
                .first()
                .is_some_and(|first| same_folder(first, workspace));
            if !already_first {
                inner.recent.retain(|folder| !same_folder(folder, workspace));
                inner.recent.insert(0, workspace.to_path_buf());
                inner.recent.truncate(CAPACITY);
                if let Some(file) = &self.memory {
                    let text: Vec<String> = inner
                        .recent
                        .iter()
                        .map(|path| path.to_string_lossy().into_owned())
                        .collect();
                    let _ = std::fs::write(file, text.join("\n").as_bytes());
                }
            }
            let plan = plan(&inner.recent);
            let (assigned, _) = assign(&plan, &inner.slots);
            let mut keep = Vec::new();
            let mut stale = Vec::new();
            for (slot, place) in std::mem::take(&mut inner.slots).into_iter().zip(assigned) {
                if place.is_some() {
                    keep.push(slot);
                } else {
                    stale.push(slot);
                }
            }
            inner.slots = keep;
            if !stale.is_empty() {
                // Invalidates a spawn in flight that the plan may no longer want.
                inner.generation += 1;
            }
            stale
        };
        let retired = !stale.is_empty();
        for slot in stale {
            slot.runtime.terminate();
        }
        if retired {
            self.notify();
        }
        self.fill();
    }

    /// Someone is waiting for a warm runtime (the loading screen, a new
    /// session): run the one they would get at normal priority. Below normal it
    /// starves on a busy machine (measured: 83 s to ready using 9 s of CPU at
    /// 100% load).
    pub fn hurry(&self) {
        let pid = {
            let inner = self.lock();
            inner.next().map(|index| inner.slots[index].runtime.pid())
        };
        if let Some(pid) = pid {
            process::set_low_priority(pid, false);
        }
    }

    fn attached(self: &Arc<Self>) {
        {
            let mut inner = self.lock();
            inner.attaching = inner.attaching.saturating_sub(1);
        }
        self.notify();
        self.fill();
    }

    /// The folder the pool warms most for: the most recent one.
    pub fn target(&self) -> Option<PathBuf> {
        self.lock().recent.first().cloned()
    }

    /// Every folder the pool warms for, most recent first, in the spelling
    /// their runtimes use.
    pub fn folders(&self) -> Vec<PathBuf> {
        self.lock().recent.clone()
    }

    /// A session needs a runtime but none is warm: allow the pool to try again
    /// after earlier failures.
    pub fn reset_failures(&self) {
        self.lock().failures = 0;
    }

    /// Wait until a warm runtime is ready or the warm-up failed, up to
    /// `timeout`. Returns the state at that point.
    pub async fn wait_settled(&self, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            let notified = self.ready.notified();
            {
                let inner = self.lock();
                if !matches!(inner.state(), WarmState::Starting) {
                    return Self::describe(&inner);
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || tokio::time::timeout(left, notified).await.is_err() {
                return self.status();
            }
        }
    }

    /// Settings the runtime reads at start changed: replace the unused warm
    /// runtimes so the next session does not get the old settings.
    pub fn recycle(self: &Arc<Self>) {
        let slots = {
            let mut inner = self.lock();
            inner.failures = 0;
            inner.generation += 1;
            inner.error = None;
            std::mem::take(&mut inner.slots)
        };
        for slot in slots {
            slot.runtime.terminate();
        }
        self.notify();
        self.fill();
    }

    pub fn stop(&self) {
        let slots = {
            let mut inner = self.lock();
            inner.generation += 1;
            std::mem::take(&mut inner.slots)
        };
        for slot in slots {
            slot.runtime.terminate();
        }
    }

    /// The folder warm runtimes start in when no workspace is known yet.
    pub fn scratch(home: &std::path::Path) -> PathBuf {
        home.join("warm")
    }
}

/// A session attaching to a runtime it took from the pool. While any is held the
/// pool starts nothing; dropping it (attached, failed or stopped) lets it fill.
pub struct Attaching(Option<Arc<WarmPool>>);

impl Drop for Attaching {
    fn drop(&mut self) {
        if let Some(pool) = self.0.take() {
            pool.attached();
        }
    }
}

fn same_folder(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let text = path.to_string_lossy().replace('\\', "/");
        // Like Pi: `\\?\` is significant, so it is kept.
        let text = text.trim_end_matches('/').to_string();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    normalize(left) == normalize(right)
}

/// Whether two texts name one folder, whatever their spelling (`\\?\` or not).
/// Pi itself would treat them as two; this is for choosing which spelling to use.
pub fn same_place(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let text = path.to_string_lossy().replace('\\', "/");
        let text = text.strip_prefix("//?/").unwrap_or(&text);
        let text = text.trim_end_matches('/');
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text.to_string()
        }
    };
    normalize(left) == normalize(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_gives_each_recent_folder_a_place_and_the_rest_to_the_latest() {
        assert_eq!(plan(&[]), vec![None, None]);
        let a = PathBuf::from("/a");
        let b = PathBuf::from("/b");
        assert_eq!(plan(&[a.clone()]), vec![Some(a.clone()); 4]);
        assert_eq!(
            plan(&[b.clone(), a.clone()]),
            vec![Some(b.clone()), Some(a.clone()), Some(b.clone()), Some(b.clone())]
        );
        let many: Vec<PathBuf> = (0..6).map(|n| PathBuf::from(format!("/f{n}"))).collect();
        assert_eq!(plan(&many).len(), 4);
    }
}
