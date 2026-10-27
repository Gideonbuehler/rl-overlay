//! Updates itself from the repo's GitHub releases, which the Release workflow
//! (.github/workflows/release.yml) builds and signs on every push to main.
//!
//! Checks at startup and every few hours, downloads in the background, and
//! installs only while Rocket League isn't running, so no match is cut short.
//! The installer then restarts the app with the same arguments, so a sign-in
//! start goes back to waiting in the tray. Only that workflow's builds update:
//! a build made anywhere else isn't replaced by the latest release.

use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Set by the Release workflow when it builds.
const ENABLED: bool = option_env!("RL_OVERLAY_UPDATES").is_some();
const CHECK_EVERY: Duration = Duration::from_secs(3 * 60 * 60);
/// How often to look whether the game has closed, with an update waiting.
const GAME_POLL: Duration = Duration::from_secs(30);

/// Where updating stands, for settings.
#[derive(Clone, Default, Serialize)]
pub struct UpdateStatus {
    /// This build's version.
    current: String,
    /// "off" (not a release build), "checking", "current", "downloading",
    /// "ready" (waiting for the game to close), "installing", or "failed".
    state: &'static str,
    /// The version being downloaded or installed.
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

static STATUS: Mutex<UpdateStatus> = Mutex::new(UpdateStatus { current: String::new(), state: "off", next: None, error: None });
/// Wakes the update thread for a check now.
static CHECK_NOW: Mutex<Option<Sender<()>>> = Mutex::new(None);

#[tauri::command]
pub fn update_status() -> UpdateStatus {
    STATUS.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Checks now instead of at the next scheduled check.
#[tauri::command]
pub fn check_update() {
    if let Some(tx) = CHECK_NOW.lock().ok().and_then(|t| t.clone()) {
        let _ = tx.send(());
    }
}

fn set(app: &AppHandle, state: &'static str, next: Option<String>, error: Option<String>) {
    let status = {
        let Ok(mut s) = STATUS.lock() else { return };
        s.state = state;
        s.next = next;
        s.error = error;
        s.clone()
    };
    let _ = app.emit("update-status", status);
}

pub fn watch(app: AppHandle) {
    if let Ok(mut s) = STATUS.lock() {
        s.current = app.package_info().version.to_string();
    }
    if !ENABLED {
        return;
    }
    let (tx, rx) = channel();
    if let Ok(mut c) = CHECK_NOW.lock() {
        *c = Some(tx);
    }
    std::thread::spawn(move || loop {
        if let Some((update, bytes)) = fetch(&app) {
            // Installing closes the overlay, so never while the game is open.
            while crate::focus::rocket_league_running() {
                std::thread::sleep(GAME_POLL);
            }
            set(&app, "installing", Some(update.version.clone()), None);
            // Exits, and the installer restarts the app.
            if let Err(e) = update.install(bytes) {
                set(&app, "failed", None, Some(e.to_string()));
            }
        }
        // Until the next check is due, or settings asks for one.
        let _ = rx.recv_timeout(CHECK_EVERY);
    });
}

/// The newest release, downloaded and its signature checked, if it's newer than this build.
fn fetch(app: &AppHandle) -> Option<(Update, Vec<u8>)> {
    set(app, "checking", None, None);
    let result = tauri::async_runtime::block_on(async {
        let Some(update) = app.updater()?.check().await? else { return Ok(None) };
        set(app, "downloading", Some(update.version.clone()), None);
        let bytes = update.download(|_, _| {}, || {}).await?;
        Ok::<_, tauri_plugin_updater::Error>(Some((update, bytes)))
    });
    match result {
        Ok(Some((update, bytes))) => {
            set(app, "ready", Some(update.version.clone()), None);
            Some((update, bytes))
        }
        Ok(None) => {
            set(app, "current", None, None);
            None
        }
        Err(e) => {
            set(app, "failed", None, Some(e.to_string()));
            None
        }
    }
}
