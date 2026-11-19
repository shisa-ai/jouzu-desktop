//! A failed webview process otherwise closes the interface with nothing on disk. WebView2 reports it
//! with `ProcessFailed` on the controller, which Tauri hands over in `with_webview`; Tauri has no hook
//! of its own, so the handler is registered here and writes a crash record.

use crate::logs;
use std::path::PathBuf;

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
    COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED as BROWSER_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED as FRAME_RENDER_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED as GPU_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED as PPAPI_BROKER_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED as PPAPI_PLUGIN_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED as RENDER_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE as RENDER_UNRESPONSIVE,
    COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED as SANDBOX_HELPER_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED as UNKNOWN_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED as UTILITY_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_REASON as FAILED_REASON,
    COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED as REASON_CRASHED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED as REASON_LAUNCH_FAILED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY as REASON_OUT_OF_MEMORY,
    COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED as REASON_PROFILE_DELETED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED as REASON_TERMINATED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED as REASON_UNEXPECTED,
    COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE as REASON_UNRESPONSIVE,
};
#[cfg(windows)]
use webview2_com::ProcessFailedEventHandler;
#[cfg(windows)]
use windows::core::Interface;

/// Register the handler on the window's controller. Windows only; elsewhere the app does not use
/// a WebView2 at all.
#[cfg(windows)]
pub fn watch(window: &tauri::WebviewWindow, managed: Option<PathBuf>) {
    let Some(managed) = managed else {
        return;
    };
    let _ = window.with_webview(move |webview| {
        let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else {
            return;
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            let _ = unsafe { args.ProcessFailedKind(&mut kind) };
            logs::write_crash(
                &managed,
                &failure(kind, &args),
                "webview process",
                env!("CARGO_PKG_VERSION"),
            );
            Ok(())
        }));
        let mut token = 0i64;
        let _ = unsafe { core.add_ProcessFailed(&handler, &mut token) };
    });
}

#[cfg(not(windows))]
pub fn watch(_window: &tauri::WebviewWindow, _managed: Option<PathBuf>) {}

#[cfg(windows)]
fn failure(kind: COREWEBVIEW2_PROCESS_FAILED_KIND, args: &ICoreWebView2ProcessFailedEventArgs) -> String {
    let mut message = format!("webview {}", kind_name(kind));
    // The reason and the exit code live on the extended interface; a runtime without it still records
    // which process went away.
    if let Ok(extended) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
        let mut reason = FAILED_REASON::default();
        if unsafe { extended.Reason(&mut reason) }.is_ok() {
            message.push_str(&format!(", {}", reason_name(reason)));
        }
        let mut code = 0;
        if unsafe { extended.ExitCode(&mut code) }.is_ok() {
            message.push_str(&format!(", exit code {code}"));
        }
    }
    message
}

/// The SDK's own name for the failure, so a record reads without looking a number up.
#[cfg(windows)]
fn kind_name(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match kind {
        BROWSER_EXITED => "browser process exited",
        RENDER_EXITED => "render process exited",
        RENDER_UNRESPONSIVE => "render process stopped responding",
        FRAME_RENDER_EXITED => "frame render process exited",
        UTILITY_EXITED => "utility process exited",
        SANDBOX_HELPER_EXITED => "sandbox helper process exited",
        GPU_EXITED => "gpu process exited",
        PPAPI_PLUGIN_EXITED => "plugin process exited",
        PPAPI_BROKER_EXITED => "plugin broker process exited",
        UNKNOWN_EXITED => "an unknown process exited",
        _ => "process failed",
    }
}

#[cfg(windows)]
fn reason_name(reason: FAILED_REASON) -> &'static str {
    match reason {
        REASON_UNEXPECTED => "unexpected",
        REASON_UNRESPONSIVE => "unresponsive",
        REASON_TERMINATED => "terminated",
        REASON_CRASHED => "crashed",
        REASON_LAUNCH_FAILED => "launch failed",
        REASON_OUT_OF_MEMORY => "out of memory",
        REASON_PROFILE_DELETED => "profile deleted",
        _ => "reason unknown",
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn names_the_failure_and_its_reason_as_the_sdk_does() {
        assert_eq!(kind_name(RENDER_EXITED), "render process exited");
        assert_eq!(kind_name(RENDER_UNRESPONSIVE), "render process stopped responding");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND(999)), "process failed");
        assert_eq!(reason_name(REASON_CRASHED), "crashed");
        assert_eq!(reason_name(FAILED_REASON(99)), "reason unknown");
    }
}
