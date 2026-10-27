//! Start with Windows, open with Rocket League, close with it.
//!
//! When enabled, the app is registered to run at sign-in with `--auto`. It then
//! sits in the tray with no overlay window, and a watcher opens the overlay when
//! Rocket League's window appears and closes it again (freeing the webview)
//! once the game has gone. The tray icon stays, so the next launch of the game
//! is caught too. The setting lives in a small file next to the app's other
//! data, because it's needed before any page exists to read it from.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use windows::core::HSTRING;
use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Bumped whenever the overlay window is closed, so threads tied to that
/// window (the cursor watcher) know to stop.
pub static OVERLAY_GEN: AtomicU32 = AtomicU32::new(0);

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "RL Overlay";

/// Two missed checks two seconds apart before closing, so a brief window
/// change (the game restarting its window, a loading hitch) doesn't count.
const CLOSE_AFTER_MISSES: u32 = 2;

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("autorun.json"))
}

/// Reads the saved setting at startup.
pub fn load(app: &AppHandle) {
    let on = config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["enabled"].as_bool())
        .unwrap_or(false);
    ENABLED.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_auto_start() -> bool {
    enabled()
}

#[tauri::command]
pub fn set_auto_start(app: AppHandle, on: bool) -> Result<(), String> {
    set_run_at_sign_in(on)?;
    ENABLED.store(on, Ordering::Relaxed);
    if let Some(path) = config_path(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(path, serde_json::json!({ "enabled": on }).to_string()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Adds or removes the app from HKCU's Run key, which starts it at sign-in.
fn set_run_at_sign_in(on: bool) -> Result<(), String> {
    let key = HSTRING::from(RUN_KEY);
    let name = HSTRING::from(RUN_NAME);
    if !on {
        let _ = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &key, &name) };
        return Ok(()); // already absent is fine
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let value = format!("\"{}\" --auto", exe.display());
    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        RegSetKeyValueW(HKEY_CURRENT_USER, &key, &name, REG_SZ.0, Some(wide.as_ptr().cast()), (wide.len() * 2) as u32)
    };
    if result.is_err() {
        return Err(format!("Couldn't register to start with Windows ({})", result.0));
    }
    Ok(())
}

/// Opens the overlay when Rocket League starts and closes it when the game
/// has gone. A window you opened yourself without the game running is left
/// alone; it only closes once the game it was opened for has closed.
pub fn watch(app: AppHandle, open: fn(&AppHandle)) {
    std::thread::spawn(move || {
        let mut seen_game = false;
        let mut misses = 0;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if !enabled() {
                continue;
            }
            let running = crate::focus::rocket_league_running();
            match (running, app.get_webview_window("main")) {
                (true, None) => {
                    open(&app);
                    seen_game = true;
                    misses = 0;
                }
                (true, Some(_)) => {
                    seen_game = true;
                    misses = 0;
                }
                (false, Some(window)) if seen_game => {
                    misses += 1;
                    if misses >= CLOSE_AFTER_MISSES {
                        close(&window);
                        seen_game = false;
                        misses = 0;
                    }
                }
                _ => {}
            }
        }
    });
}

/// Closes the overlay window but keeps the app (and its tray icon) running.
pub fn close(window: &tauri::WebviewWindow) {
    OVERLAY_GEN.fetch_add(1, Ordering::Relaxed);
    crate::EDIT_MODE.store(false, Ordering::Relaxed);
    let _ = window.destroy();
}
