//! When a session's runtime may be restarted after it dies.
//!
//! A runtime that dies is restarted, but one that keeps dying is not: three
//! starts within five minutes stop the session with an error the user can
//! retry. Attempts stay counted through the window even after a restart reaches
//! idle, because a runtime that comes up and dies again is flapping, not healthy.
//! At most one restart is scheduled at a time.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const WINDOW: Duration = Duration::from_secs(300);
pub const LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Another restart is already on its way.
    AlreadyScheduled,
    /// Restart now; this is attempt `n` in the window.
    Restart(usize),
    /// Too many restarts in the window: give up.
    GiveUp,
}

#[derive(Default)]
pub struct RestartBudget {
    attempts: Mutex<Vec<Instant>>,
    scheduled: AtomicBool,
}

impl RestartBudget {
    pub fn decide(&self) -> Decision {
        self.decide_at(Instant::now())
    }

    fn decide_at(&self, now: Instant) -> Decision {
        if self.scheduled.swap(true, Ordering::SeqCst) {
            return Decision::AlreadyScheduled;
        }
        let count = {
            let mut attempts = self.attempts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            attempts.retain(|attempt| now.duration_since(*attempt) < WINDOW);
            attempts.push(now);
            attempts.len()
        };
        if count >= LIMIT {
            self.scheduled.store(false, Ordering::SeqCst);
            return Decision::GiveUp;
        }
        Decision::Restart(count)
    }

    /// Attempts counted in the current window.
    pub fn attempts(&self) -> usize {
        self.attempts.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len()
    }

    pub fn exhausted(&self) -> bool {
        self.attempts() >= LIMIT
    }

    /// The scheduled restart happened (or was abandoned); another may be scheduled.
    pub fn settle(&self) {
        self.scheduled.store(false, Ordering::SeqCst);
    }

    /// The session was stopped on purpose: forget its history of crashes.
    pub fn reset(&self) {
        self.settle();
        self.attempts.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flapping_runtime_gets_two_restarts_in_five_minutes() {
        let budget = RestartBudget::default();
        let start = Instant::now();
        assert_eq!(budget.decide_at(start), Decision::Restart(1));
        assert_eq!(budget.decide_at(start), Decision::AlreadyScheduled);
        budget.settle();
        assert_eq!(budget.decide_at(start + Duration::from_secs(10)), Decision::Restart(2));
        budget.settle();
        assert_eq!(budget.decide_at(start + Duration::from_secs(20)), Decision::GiveUp);
        assert!(budget.exhausted());
    }

    #[test]
    fn old_attempts_leave_the_window_and_a_stop_forgets_them() {
        let budget = RestartBudget::default();
        let start = Instant::now();
        assert_eq!(budget.decide_at(start), Decision::Restart(1));
        budget.settle();
        assert_eq!(budget.decide_at(start + Duration::from_secs(1)), Decision::Restart(2));
        budget.settle();
        assert_eq!(budget.decide_at(start + WINDOW + Duration::from_secs(2)), Decision::Restart(1));
        budget.reset();
        assert_eq!(budget.attempts(), 0);
    }
}
