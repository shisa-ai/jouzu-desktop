//! A Windows Job Object that owns the runtime tree, or a no-op elsewhere.

#[cfg(windows)]
mod platform {
    use std::{io, mem::size_of, os::windows::io::RawHandle};

    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct Job {
        handle: isize,
    }

    // The handle is an owned kernel handle; it is safe to move/share across tasks.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(None, windows::core::PCWSTR::null())
                    .map_err(|error| io::Error::other(error.to_string()))?;
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|error| {
                    let _ = CloseHandle(job);
                    io::Error::other(error.to_string())
                })?;
                Ok(Self {
                    handle: job.0 as isize,
                })
            }
        }

        pub fn assign(&self, process: RawHandle) -> io::Result<()> {
            unsafe {
                AssignProcessToJobObject(HANDLE(self.handle as *mut _), HANDLE(process))
                    .map_err(|error| io::Error::other(error.to_string()))
            }
        }

        pub fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(HANDLE(self.handle as *mut _), 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(HANDLE(self.handle as *mut _));
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::io;

    #[derive(Default)]
    pub struct Job;

    impl Job {
        pub fn new() -> io::Result<Self> {
            Ok(Self)
        }

        pub fn assign(&self, _process: ()) -> io::Result<()> {
            Ok(())
        }

        pub fn terminate(&self) {}
    }
}

pub use platform::Job;
