mod autorun;
mod boost;
mod focus;
mod gamerun;
mod mechanics;
mod mmr;
mod replays;
mod setup;
mod store;
mod update;

pub use boost::ocr_test;
pub use mechanics::mechanics_test;
pub use replays::replay_test;
pub use setup::enable_from_args;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Edit mode makes the overlay take the mouse so settings can be changed.
/// Outside it, every click passes straight through to the game.
pub(crate) static EDIT_MODE: AtomicBool = AtomicBool::new(false);

/// User-configurable hotkeys by name ("report", "hud"). Pressing one emits a
/// `hotkey` event carrying its name.
static HOTKEYS: Mutex<Vec<(String, Shortcut)>> = Mutex::new(Vec::new());

fn edit_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyO)
}

fn set_edit(window: &WebviewWindow, on: bool) {
    EDIT_MODE.store(on, Ordering::Relaxed);
    let _ = window.set_ignore_cursor_events(!on);
    // Only settings need keyboard focus. Otherwise clicks never take focus
    // from the game, so it keeps your controls after you click the report.
    let _ = window.set_focusable(on);
    if on {
        focus::remember_foreground();
        let _ = window.set_focus();
    } else {
        focus::restore_foreground();
    }
    let _ = window.emit("edit-mode", on);
}

fn toggle_edit(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(window) => set_edit(&window, !EDIT_MODE.load(Ordering::Relaxed)),
        // Closed, as it is between games when it opens and closes with Rocket League.
        // Opened off the hotkey's thread, like the window the game opens (autorun).
        None => {
            let app = app.clone();
            std::thread::spawn(move || open_settings(&app));
        }
    }
}

/// Opens the overlay on its settings, opening the window first if it's closed.
/// A page that's still loading asks for the state (get_edit_mode), since the
/// edit-mode event goes out before it listens.
fn open_settings(app: &AppHandle) {
    open_overlay(app);
    if let Some(window) = app.get_webview_window("main") {
        set_edit(&window, true);
    }
}

#[tauri::command]
fn set_edit_mode(window: WebviewWindow, on: bool) {
    set_edit(&window, on);
}

#[tauri::command]
fn get_edit_mode() -> bool {
    EDIT_MODE.load(Ordering::Relaxed)
}

/// Binds a named hotkey. On failure the previous binding stays in place.
#[tauri::command]
fn set_hotkey(app: AppHandle, name: String, accelerator: String) -> Result<(), String> {
    let new: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("\"{accelerator}\" isn't a hotkey this app understands"))?;
    if new == edit_shortcut() {
        return Err("That hotkey is already taken by the overlay".into());
    }

    let shortcuts = app.global_shortcut();
    let mut keys = HOTKEYS.lock().unwrap();
    if keys.iter().any(|(n, s)| *s == new && *n != name) {
        return Err("Another overlay hotkey already uses that".into());
    }
    let old = keys.iter().position(|(n, _)| *n == name);
    if let Some(i) = old {
        if keys[i].1 == new {
            return Ok(());
        }
        let _ = shortcuts.unregister(keys[i].1);
    }
    if let Err(e) = shortcuts.register(new) {
        if let Some(i) = old {
            let _ = shortcuts.register(keys[i].1);
        }
        return Err(format!("Couldn't claim {accelerator}: {e}"));
    }
    match old {
        Some(i) => keys[i].1 = new,
        None => keys.push((name, new)),
    }
    Ok(())
}

/// Lets go of the overlay's hotkeys while settings records a new one, so the
/// keys reach the page instead of firing, and takes them back after.
#[tauri::command]
fn pause_hotkeys(app: AppHandle, paused: bool) {
    let shortcuts = app.global_shortcut();
    for (_, s) in HOTKEYS.lock().unwrap().iter() {
        let _ = if paused { shortcuts.unregister(*s) } else { shortcuts.register(*s) };
    }
}

/// Runs in RL Tracker pages the overlay opens. When the page says the player
/// wasn't found, it moves on to the next candidate profile (another platform),
/// handed over in the URL as `#rlo=<json list>`. It only navigates; it reads
/// nothing from the page beyond that one message.
const TRACKER_FALLBACK: &str = r##"
(() => {
  if (location.hostname !== "rocketleague.tracker.network") return;
  const KEY = "rlo-candidates";
  try {
    if (location.hash.startsWith("#rlo=")) sessionStorage.setItem(KEY, decodeURIComponent(location.hash.slice(5)));
  } catch (e) {}
  let tries = 0;
  const timer = setInterval(() => {
    if (++tries > 60) return clearInterval(timer);
    const text = document.body ? document.body.innerText : "";
    if (!/PLAYER NOT FOUND/i.test(text)) return;
    clearInterval(timer);
    let list = [];
    try { list = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (e) {}
    const at = list.indexOf(location.origin + location.pathname);
    if (at >= 0 && list[at + 1]) location.replace(list[at + 1]);
  }, 500);
})();
"##;

/// Lets the overlay take keyboard focus while you type in it (the tracker
/// correction box), and gives it back to the game afterwards.
#[tauri::command]
fn set_keyboard(app: AppHandle, window: WebviewWindow, on: bool) {
    if EDIT_MODE.load(Ordering::Relaxed) {
        return; // settings already have focus
    }
    let _ = window.set_focusable(on);
    if !on {
        focus::restore_foreground();
    }
    if on {
        focus::remember_foreground();
        let _ = window.set_focus();
        // The window holds two webviews when RL Tracker is embedded; focusing
        // the window alone can hand the keyboard to the tracker page.
        if let Some(main) = app.get_webview("main") {
            let _ = main.set_focus();
        }
    }
}

/// Shows a player's RL Tracker profile inside the overlay, as a webview laid
/// over a slot in the player screen. The rect is in CSS pixels, which are the
/// window's logical pixels. With no URL the embedded page is hidden.
/// Only tracker links are accepted, and the page gets no access to the app.
///
/// Async on purpose: creating a webview from a synchronous command deadlocks on
/// Windows (the builder waits on the main thread, which the command is holding).
#[tauri::command]
async fn show_tracker(app: AppHandle, url: Option<String>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl};

    let existing = app.get_webview("tracker-embed");
    let Some(url) = url else {
        if let Some(view) = existing {
            view.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    };
    if !url.starts_with("https://rocketleague.tracker.network/") {
        return Err("Not an RL Tracker link".into());
    }
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let (pos, size) = (LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)));

    if let Some(view) = existing {
        if view.url().map(|u| u != url).unwrap_or(true) {
            view.navigate(url).map_err(|e| e.to_string())?;
        }
        view.set_position(pos).map_err(|e| e.to_string())?;
        view.set_size(size).map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    window
        .add_child(
            WebviewBuilder::new("tracker-embed", WebviewUrl::External(url)).initialization_script(TRACKER_FALLBACK),
            pos,
            size,
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens a player's RL Tracker profile in its own window above the overlay.
/// Only tracker links are accepted, and the window gets no access to the app.
/// Async for the same deadlock reason as `show_tracker`.
#[tauri::command]
async fn open_tracker(app: AppHandle, url: String, title: String) -> Result<(), String> {
    if !url.starts_with("https://rocketleague.tracker.network/") {
        return Err("Not an RL Tracker link".into());
    }
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("tracker") {
        window.navigate(url).map_err(|e| e.to_string())?;
        let _ = window.set_title(&title);
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "tracker", tauri::WebviewUrl::External(url))
        .initialization_script(TRACKER_FALLBACK)
        .title(title)
        .inner_size(1000.0, 860.0)
        .always_on_top(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (by hand while the sign-in copy waits) opens the
        // overlay in this one instead of starting another overlay.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_overlay(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &edit_shortcut() {
                        toggle_edit(app);
                    } else {
                        let name = HOTKEYS.lock().unwrap().iter().find(|(_, s)| s == shortcut).map(|(n, _)| n.clone());
                        if let Some(name) = name {
                            let _ = app.emit("hotkey", name);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.global_shortcut().register(edit_shortcut())?;
            autorun::load(app.handle());
            replays::watch(app.handle().clone());
            mmr::watch(app.handle().clone());
            gamerun::watch(app.handle().clone());
            update::watch(app.handle().clone());

            // Started at sign-in (--auto), wait in the tray for the game.
            // Started by hand, open straight away.
            let at_sign_in = std::env::args().any(|a| a == "--auto");
            if !at_sign_in || focus::rocket_league_running() {
                open_overlay(app.handle());
            }
            autorun::watch(app.handle().clone(), open_overlay);

            // The window has no taskbar button, so the tray is the way back in.
            let open = MenuItem::with_id(app, "open", "Open overlay", true, None::<&str>)?;
            let hud = MenuItem::with_id(app, "hud", "Show/hide HUD", true, None::<&str>)?;
            let report = MenuItem::with_id(app, "report", "Show/hide match report", true, None::<&str>)?;
            let edit = MenuItem::with_id(app, "edit", "Settings (Ctrl+Shift+O)", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &hud, &report, &edit, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("RL Overlay")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "hud" | "report" => {
                        let _ = app.emit("hotkey", event.id.as_ref());
                    }
                    "open" => open_overlay(app),
                    "edit" => open_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_edit_mode,
            get_edit_mode,
            set_hotkey,
            pause_hotkeys,
            open_tracker,
            show_tracker,
            set_keyboard,
            boost::set_boost_region,
            boost::set_boost_paused,
            boost::reset_boost_digits,
            boost::set_boost_logging,
            replays::list_replays,
            replays::replay_boost,
            replays::recycle_replays,
            mechanics::replay_mechanics,
            focus::set_click_zones,
            focus::press_save_replay,
            setup::find_rocket_league,
            setup::enable_stats_api,
            setup::enable_stats_api_elevated,
            autorun::get_auto_start,
            gamerun::get_game_run,
            mmr::mmr_readings,
            autorun::set_auto_start,
            store::store_load,
            store::store_save,
            update::update_status,
            update::check_update,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building RL Overlay")
        .run(|_app, event| {
            // Closing the overlay window shouldn't end the app while it's
            // waiting for the game; Quit (an explicit exit code) still does.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
                if autorun::enabled() {
                    api.prevent_exit();
                }
            }
        });
}

/// Creates and sets up the overlay window, unless it's already open.
fn open_overlay(app: &AppHandle) {
    if app.get_webview_window("main").is_some() {
        return;
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return };
    let window = match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("couldn't open the overlay: {e}");
            return;
        }
    };
    // Cover the primary monitor. The game has to run borderless windowed;
    // nothing can draw over exclusive fullscreen.
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let _ = window.set_position(*monitor.position());
        let _ = window.set_size(*monitor.size());
    }
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_focusable(false);
    focus::watch(window, &EDIT_MODE, autorun::OVERLAY_GEN.load(Ordering::Relaxed));
}
