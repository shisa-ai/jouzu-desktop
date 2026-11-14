//! Which update feed this installation follows.
//!
//! QA is not a separate product: it is the same application, the same install directory
//! and the same user data, following a second feed. A tester switches an ordinary
//! installation to QA, upgrades in place, and switches back. Every stable release ships
//! on QA first, so the upgrade path a user takes has already run on a real installation.
//!
//! The QA feed sits beside the stable one in the same release repository: the
//! `desktop-update` tag becomes `desktop-update-qa`. Release assets are shared, so a
//! promoted build is byte for byte the build QA installed.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const FILE: &str = "update-channel.json";
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const STABLE_TAG: &str = "desktop-update";
const QA_TAG: &str = "desktop-update-qa";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Qa,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    channel: Channel,
}

fn path(managed: &Path) -> PathBuf {
    managed.join(FILE)
}

/// A missing or unreadable choice is stable: nobody is moved to QA by accident.
pub fn read(managed: &Path) -> Channel {
    std::fs::read(path(managed))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .map(|stored| stored.channel)
        .unwrap_or_default()
}

pub fn write(managed: &Path, channel: Channel) -> Result<(), String> {
    std::fs::create_dir_all(managed).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&Stored { channel }).map_err(|error| error.to_string())?;
    let target = path(managed);
    let temporary = target.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &target).map_err(|error| error.to_string())
}

/// The QA feed for a stable feed URL: the same repository, the `desktop-update-qa` tag.
/// Anything that is not a `.../releases/download/desktop-update/<file>` URL has no QA feed.
pub fn qa_endpoint(stable: &Url) -> Option<Url> {
    let segments: Vec<&str> = stable.path_segments()?.collect();
    let at = segments.len().checked_sub(2)?;
    if segments.get(at) != Some(&STABLE_TAG) || segments.get(at.checked_sub(1)?) != Some(&"download") {
        return None;
    }
    let mut changed: Vec<&str> = segments.clone();
    changed[at] = QA_TAG;
    let mut url = stable.clone();
    url.set_path(&changed.join("/"));
    Some(url)
}

fn stable_endpoint(app: &tauri::AppHandle) -> Result<Url, String> {
    let text = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value["endpoints"].get(0))
        .and_then(|value| value.as_str())
        .ok_or("Online updates are not configured for this build")?;
    Url::parse(text).map_err(|error| error.to_string())
}

/// What a check found. `downgrade` is set when the offer is older than what runs now:
/// that only happens when someone leaves QA for stable, and installing it is their choice.
#[derive(Serialize, Clone)]
pub struct Offer {
    version: String,
    notes: Option<String>,
    downgrade: bool,
    channel: Channel,
}

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

async fn check_feed(
    app: &tauri::AppHandle,
    endpoint: Url,
    accept_older: bool,
) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(CHECK_TIMEOUT)
        .version_comparator(move |current: Version, release| {
            if accept_older {
                release.version != current
            } else {
                release.version > current
            }
        })
        .build()
        .map_err(|error| error.to_string())?;
    updater.check().await.map_err(|error| error.to_string())
}

fn newer(a: Option<Update>, b: Option<Update>) -> Option<Update> {
    match (a, b) {
        (Some(a), Some(b)) => {
            let left = Version::parse(&a.version).ok();
            let right = Version::parse(&b.version).ok();
            if right > left { Some(b) } else { Some(a) }
        }
        (a, b) => a.or(b),
    }
}

/// The offer for a channel.
///
/// Stable offers the stable feed's build when it differs from what runs: newer is an
/// ordinary update, older means this installation came back from QA. QA offers the newest
/// of the QA and stable feeds, and never an older build, so a promoted release reaches QA
/// installations too.
async fn find(app: &tauri::AppHandle, channel: Channel) -> Result<Option<Update>, String> {
    let stable = stable_endpoint(app)?;
    match channel {
        Channel::Stable => check_feed(app, stable, true).await,
        Channel::Qa => {
            let qa = qa_endpoint(&stable).ok_or("This build has no QA feed")?;
            // A missing QA feed (nothing published yet) is not an error: stable still answers.
            let from_qa = check_feed(app, qa, false).await.ok().flatten();
            let from_stable = check_feed(app, stable, false).await?;
            Ok(newer(from_qa, from_stable))
        }
    }
}

fn managed() -> Result<PathBuf, String> {
    crate::runtime::managed_root()
}

#[tauri::command]
pub fn update_channel() -> Result<Channel, String> {
    Ok(read(&managed()?))
}

#[tauri::command]
pub fn update_channel_set(channel: Channel, pending: tauri::State<'_, Pending>) -> Result<Channel, String> {
    let managed = managed()?;
    write(&managed, channel)?;
    // An offer found on the other feed is no longer the one this installation follows.
    *pending.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    crate::logs::note(&managed, &format!("launcher update channel={channel:?}"));
    Ok(channel)
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<Offer>, String> {
    let channel = read(&managed()?);
    let update = find(&app, channel).await?;
    let offer = update.as_ref().map(|update| Offer {
        version: update.version.clone(),
        notes: update.body.clone(),
        downgrade: match (Version::parse(&update.version), Version::parse(&update.current_version)) {
            (Ok(offered), Ok(current)) => offered < current,
            _ => false,
        },
        channel,
    });
    *app.state::<Pending>().0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = update;
    Ok(offer)
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Install the offer the last check found. Progress arrives as `launcher-update-progress`.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .state::<Pending>()
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
        .ok_or("Check for updates again before installing")?;
    let mut downloaded = 0u64;
    let events = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = events.emit("launcher-update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    // Windows hands over to the installer and exits inside install; elsewhere restart here.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_qa_feed_sits_beside_the_stable_one() {
        let stable =
            Url::parse("https://github.com/shisa-ai/jouzu-desktop/releases/download/desktop-update/latest.json").unwrap();
        assert_eq!(
            qa_endpoint(&stable).unwrap().as_str(),
            "https://github.com/shisa-ai/jouzu-desktop/releases/download/desktop-update-qa/latest.json"
        );
    }

    #[test]
    fn an_unrecognised_feed_has_no_qa_twin() {
        for text in [
            "https://example.com/latest.json",
            "https://github.com/o/r/releases/download/v1.0.0/latest.json",
            "https://github.com/o/r/desktop-update/latest.json",
        ] {
            assert!(qa_endpoint(&Url::parse(text).unwrap()).is_none(), "{text}");
        }
    }

    #[test]
    fn the_choice_defaults_to_stable_and_round_trips() {
        let directory = std::env::temp_dir().join(format!("jouzu-channel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        assert_eq!(read(&directory), Channel::Stable);
        write(&directory, Channel::Qa).unwrap();
        assert_eq!(read(&directory), Channel::Qa);
        std::fs::write(path(&directory), b"not json").unwrap();
        assert_eq!(read(&directory), Channel::Stable);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
