//! Saved data (settings, session, match history) as JSON files in the app's
//! data folder, so every build of the app sees the same data. Browser storage
//! is per origin, and the dev build (localhost) and the installed build
//! (tauri://) are different origins.
//!
//! Each key is one file. Writes go to a temporary file first and are then
//! renamed over the old one, so a crash mid-write can't leave a half file.

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("store");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Keys are the page's storage names, like "rl-overlay.session".
fn valid(key: &str) -> bool {
    !key.is_empty() && key.len() < 100 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// Everything saved, as raw JSON strings by key.
#[tauri::command]
pub fn store_load(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for entry in std::fs::read_dir(dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(key) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else { continue };
        if let Ok(text) = std::fs::read_to_string(&path) {
            out.insert(key, text);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn store_save(app: AppHandle, key: String, value: String) -> Result<(), String> {
    if !valid(&key) {
        return Err(format!("bad store key {key:?}"));
    }
    let dir = dir(&app)?;
    let tmp = dir.join(format!("{key}.json.tmp"));
    std::fs::write(&tmp, value).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("{key}.json"))).map_err(|e| e.to_string())
}
