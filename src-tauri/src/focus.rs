//! Who gets the mouse and keyboard, and when the overlay should show at all.
//!
//! - Click zones: the overlay is click-through except over zones the page
//!   registers (the report), and there only while Ctrl is held, so it never
//!   swallows clicks meant for the game behind it.
//! - Foreground: the page is told to hide itself when Rocket League isn't
//!   running, or when another app comes to the front on the overlay's screen.
//!   Windows on other monitors don't count while the game is running.
//! - Focus hand-back: when the overlay borrows keyboard focus (settings, the
//!   tracker correction box), the window that had it gets it back afterwards.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MonitorFromWindow, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, SetForegroundWindow,
};

/// A screen area in physical pixels.
#[derive(Clone, Copy, serde::Deserialize)]
pub struct Zone {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

static ZONES: Mutex<Vec<Zone>> = Mutex::new(Vec::new());
/// Whether Ctrl must be held for a zone to take the mouse. Off while typing.
static REQUIRE_KEY: AtomicBool = AtomicBool::new(true);
/// The window that had focus before the overlay borrowed it.
static PREVIOUS_FOREGROUND: AtomicIsize = AtomicIsize::new(0);

#[tauri::command]
pub fn set_click_zones(zones: Vec<Zone>, require_key: Option<bool>) {
    *ZONES.lock().unwrap() = zones;
    REQUIRE_KEY.store(require_key.unwrap_or(true), Ordering::Relaxed);
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn is_ours(hwnd: HWND) -> bool {
    window_pid(hwnd) == std::process::id()
}

/// Remembers the focused window before the overlay takes focus.
pub fn remember_foreground() {
    let fg = unsafe { GetForegroundWindow() };
    if !fg.is_invalid() && !is_ours(fg) {
        PREVIOUS_FOREGROUND.store(fg.0 as isize, Ordering::Relaxed);
    }
}

/// Gives focus back to that window (usually Rocket League).
pub fn restore_foreground() {
    let raw = PREVIOUS_FOREGROUND.swap(0, Ordering::Relaxed);
    if raw != 0 {
        unsafe {
            let _ = SetForegroundWindow(HWND(raw as *mut _));
        }
    }
}

/// Whether a window is Rocket League's game window: Unreal's window class
/// and the game's title ("Rocket League (64-bit, DX11, Cooked)"). Reading these
/// is a plain window query; the game process itself is never opened.
fn is_rocket_league(hwnd: HWND) -> bool {
    let mut class = [0u16; 64];
    let mut title = [0u16; 64];
    let (c, t) = unsafe { (GetClassNameW(hwnd, &mut class), GetWindowTextW(hwnd, &mut title)) };
    let class = String::from_utf16_lossy(&class[..c.max(0) as usize]);
    let title = String::from_utf16_lossy(&title[..t.max(0) as usize]);
    class == "LaunchUnrealUWindowsClient" && title.starts_with("Rocket League")
}

/// Polls the cursor (for click zones) and the foreground window (for hiding).
/// Windows has no per-region click-through for a window like this, so polling
/// is the usual way overlays do it.
/// Whether Rocket League's game window exists at all (running, in front or not).
pub fn rocket_league_running() -> bool {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    match unsafe { FindWindowW(w!("LaunchUnrealUWindowsClient"), None) } {
        Ok(hwnd) => !hwnd.is_invalid() && is_rocket_league(hwnd),
        Err(_) => false,
    }
}

/// Runs until the overlay window it was started for is closed (`generation` changes).
pub fn watch(window: WebviewWindow, edit_mode: &'static AtomicBool, generation: u32) {
    std::thread::spawn(move || {
        let mut taking = false;
        let mut shown = true;
        let mut tick: u32 = 0;
        // The last window checked, and whether it was Rocket League.
        let mut checked: (isize, bool) = (0, false);
        loop {
            std::thread::sleep(Duration::from_millis(15));
            if crate::autorun::OVERLAY_GEN.load(Ordering::Relaxed) != generation {
                return;
            }
            tick = tick.wrapping_add(1);

            // About every 150 ms: should the overlay be showing?
            if tick.is_multiple_of(10) {
                let fg = unsafe { GetForegroundWindow() };
                if !fg.is_invalid() {
                    let pid = window_pid(fg);
                    let visible = if pid == std::process::id() {
                        true // settings or another overlay window
                    } else if !rocket_league_running() {
                        false // no game, no overlay
                    } else {
                        let ours_screen = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
                        let its_screen = unsafe { MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST) };
                        if its_screen != ours_screen {
                            true // something on another monitor; leave the overlay alone
                        } else {
                            if checked.0 != fg.0 as isize {
                                checked = (fg.0 as isize, is_rocket_league(fg));
                            }
                            checked.1
                        }
                    };
                    if visible != shown {
                        shown = visible;
                        let _ = window.emit("game-focus", visible);
                    }
                }
            }

            if edit_mode.load(Ordering::Relaxed) {
                taking = true;
                continue;
            }
            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_err() {
                continue;
            }
            let held = !REQUIRE_KEY.load(Ordering::Relaxed)
                || (unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } as u16 & 0x8000) != 0;
            let over = shown
                && held
                && ZONES
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|z| pt.x >= z.x && pt.x < z.x + z.w && pt.y >= z.y && pt.y < z.y + z.h);
            if over != taking {
                taking = over;
                let _ = window.set_ignore_cursor_events(!over);
            }
        }
    });
}

// ---------- saving the match's replay ----------

/// The keyboard key bound to Rocket League's "AutoSaveReplay" action (hold to
/// save the replay after a match), read from your input settings. Backspace is
/// the game's default.
fn save_replay_key() -> Result<(u16, String), String> {
    let path = dirs::document_dir()
        .map(|d| d.join("My Games").join("Rocket League").join("TAGame").join("Config").join("TAInput.ini"));
    let text = path.and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let name = text
        .lines()
        .filter(|l| l.trim_start().starts_with("PCBindings") && l.contains("Action=\"AutoSaveReplay\""))
        .find_map(|l| l.split("Key=\"").nth(1).and_then(|r| r.split('"').next()).map(str::to_string))
        .unwrap_or_else(|| "Backspace".into());
    let vk: u16 = match name.as_str() {
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" => 0x0D,
        "SpaceBar" => 0x20,
        "Home" => 0x24,
        "End" => 0x23,
        "Insert" => 0x2D,
        "Delete" => 0x2E,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        n if n.len() == 1 && n.chars().all(|c| c.is_ascii_alphabetic()) => n.to_ascii_uppercase().as_bytes()[0] as u16,
        n if n.starts_with('F') && n[1..].parse::<u16>().is_ok_and(|k| (1..=12).contains(&k)) => 0x6F + n[1..].parse::<u16>().unwrap(),
        other => return Err(format!("Save Replay is bound to {other}, which the overlay can't press")),
    };
    Ok((vk, name))
}

fn send_key(vk: u16, up: bool) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        MAPVK_VK_TO_VSC, VIRTUAL_KEY,
    };
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

/// Holds your Save Replay key long enough for the game's hold-to-save prompt,
/// the same as pressing it yourself. Only when Rocket League is the window in
/// front, so the key can't land in another app.
#[tauri::command]
pub fn press_save_replay() -> Result<String, String> {
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_invalid() || !is_rocket_league(fg) {
        return Err("Rocket League wasn't in front".into());
    }
    let (vk, name) = save_replay_key()?;
    std::thread::spawn(move || {
        send_key(vk, false);
        std::thread::sleep(Duration::from_millis(1600));
        send_key(vk, true);
    });
    Ok(name)
}
