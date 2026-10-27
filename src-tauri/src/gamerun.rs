//! Game runs: one stretch of Rocket League being open, for sessions.
//!
//! Closing the game and opening it again starts a new run, unless it comes
//! back within a few minutes (a crash, an update, a quick restart). The run's
//! start and when the game was last seen are saved, so restarting or updating
//! the overlay itself doesn't count as the game reopening. The watcher runs for
//! the life of the app, whether or not the overlay window is open.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Closed for longer than this and the next launch is a new run.
const RESTART_GRACE_MS: u64 = 5 * 60_000;
const POLL: Duration = Duration::from_secs(3);
/// How often `last_seen` is written while the game stays open.
const SAVE_EVERY_MS: u64 = 30_000;

/// When the current run started (ms since the epoch), or 0 before any.
static STARTED_AT: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct Run {
    started_at: u64,
    last_seen: u64,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("game-run.json"))
}

fn save(app: &AppHandle, run: Run) {
    if let Some(p) = path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string(&run).unwrap_or_default());
    }
}

/// The run after seeing the game at `now`: the same one if it was seen
/// recently, else a new one starting now.
fn seen(run: Run, now: u64) -> Run {
    let fresh = run.started_at == 0 || now.saturating_sub(run.last_seen) > RESTART_GRACE_MS;
    Run { started_at: if fresh { now } else { run.started_at }, last_seen: now }
}

#[tauri::command]
pub fn get_game_run() -> u64 {
    STARTED_AT.load(Ordering::Relaxed)
}

/// Watches for the game and emits "game-run" with the start time when a new run begins.
pub fn watch(app: AppHandle) {
    let mut run: Run = path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    STARTED_AT.store(run.started_at, Ordering::Relaxed);
    std::thread::spawn(move || {
        let mut saved_at = 0;
        loop {
            if crate::focus::rocket_league_running() {
                let now = now_ms();
                let next = seen(run, now);
                if next.started_at != run.started_at {
                    STARTED_AT.store(next.started_at, Ordering::Relaxed);
                    let _ = app.emit("game-run", next.started_at);
                    saved_at = 0;
                }
                run = next;
                if now - saved_at >= SAVE_EVERY_MS {
                    save(&app, run);
                    saved_at = now;
                }
            }
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_within_the_grace_keep_the_run() {
        let first = seen(Run::default(), 1_000_000);
        assert_eq!(first.started_at, 1_000_000);
        // Still open at the next poll.
        let open = seen(first, 1_003_000);
        assert_eq!(open.started_at, 1_000_000);
        // Closed, back within five minutes: same run.
        let quick = seen(open, 1_003_000 + RESTART_GRACE_MS);
        assert_eq!(quick.started_at, 1_000_000);
        // Closed longer: a new run.
        let later = seen(quick, quick.last_seen + RESTART_GRACE_MS + 1);
        assert_eq!(later.started_at, later.last_seen);
    }
}
