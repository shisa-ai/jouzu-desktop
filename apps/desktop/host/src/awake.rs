//! Time the machine was awake, for idle timeouts.
//!
//! `std::time::Instant` on Windows reads the performance counter, which keeps
//! counting while the machine sleeps or hibernates. An idle timeout measured with
//! it expires the moment the machine resumes from a long sleep, although nobody
//! had a chance to use the app (issue #111). This clock leaves time asleep out on
//! every platform: Windows reads the unbiased interrupt time, which excludes
//! sleep and hibernation; Linux (`CLOCK_MONOTONIC`) and macOS (`CLOCK_UPTIME_RAW`)
//! already stop `Instant` while suspended.

use std::time::Duration;

/// A point on the awake-time clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct AwakeInstant(Duration);

impl AwakeInstant {
    pub fn now() -> Self {
        Self(awake_since_reference())
    }

    /// Awake time since this point.
    pub fn elapsed(self) -> Duration {
        Self::now().0.saturating_sub(self.0)
    }
}

#[cfg(windows)]
fn awake_since_reference() -> Duration {
    let mut units: u64 = 0;
    // SAFETY: the call writes one u64 to a valid pointer. It is available
    // since Windows 7 and cannot fail with a valid pointer.
    let _ = unsafe {
        windows::Win32::System::WindowsProgramming::QueryUnbiasedInterruptTime(&mut units)
    };
    // 100-nanosecond units since boot, sleep and hibernation excluded.
    Duration::from_nanos(units.saturating_mul(100))
}

#[cfg(not(windows))]
fn awake_since_reference() -> Duration {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed()
}

#[cfg(test)]
mod tests {
    use super::AwakeInstant;
    use std::time::Duration;

    #[test]
    fn awake_time_moves_forward_while_the_process_runs() {
        let start = AwakeInstant::now();
        std::thread::sleep(Duration::from_millis(30));
        let later = AwakeInstant::now();
        assert!(later > start);
        assert!(start.elapsed() >= Duration::from_millis(25));
    }
}
