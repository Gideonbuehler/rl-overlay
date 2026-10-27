//! First-run setup: finds Rocket League and turns on its Stats API.
//!
//! The Stats API ships switched off (`PacketSendRate=0` in
//! `TAGame\Config\DefaultStatsAPI.ini`, or `TAStatsAPI.ini` if that exists).
//! Installs are found through Steam's library list and the Epic launcher's
//! install manifests. Epic installs live under Program Files, which needs
//! admin rights to write; for those the app relaunches itself elevated just to
//! make that one edit.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Updates per second the overlay asks for; plenty for everything it shows.
const RATE: u32 = 30;
const SECTION: &str = "[TAGame.MatchStatsExporter_TA]";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    launcher: &'static str,
    /// The game's folder.
    path: String,
    /// The settings file the game reads.
    ini: String,
    /// Current updates per second; 0 means the Stats API is off.
    rate: u32,
}

/// Steam's install folder (from the registry), else the usual one.
fn steam_root() -> PathBuf {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(r"Software\Valve\Steam"),
            &HSTRING::from("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if result.is_ok() {
        let s = String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]);
        if !s.is_empty() {
            return PathBuf::from(s.replace('/', "\\"));
        }
    }
    PathBuf::from(r"C:\Program Files (x86)\Steam")
}

/// Every Steam library folder, from steamapps\libraryfolders.vdf.
fn steam_libraries() -> Vec<PathBuf> {
    let root = steam_root();
    let mut libs = vec![root.clone()];
    if let Ok(text) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for line in text.lines() {
            let parts: Vec<&str> = line.split('"').collect();
            // A line like:  "path"    "B:\\SteamLibrary"
            if parts.len() >= 4 && parts[1] == "path" {
                libs.push(PathBuf::from(parts[3].replace("\\\\", "\\")));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    libs.retain(|p| seen.insert(p.to_string_lossy().to_lowercase()));
    libs
}

/// Rocket League folders the Epic launcher knows about. Its app name there is "Sugar".
fn epic_installs() -> Vec<PathBuf> {
    let dir = Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let is_rl = json["AppName"].as_str() == Some("Sugar")
                || json["DisplayName"].as_str().is_some_and(|n| n.contains("Rocket League"));
            if let (true, Some(loc)) = (is_rl, json["InstallLocation"].as_str()) {
                out.push(PathBuf::from(loc));
            }
        }
    }
    out.push(PathBuf::from(r"C:\Program Files\Epic Games\rocketleague"));
    out
}

/// The settings file the game reads: TAStatsAPI.ini if present, else DefaultStatsAPI.ini.
fn stats_ini(game: &Path) -> Option<PathBuf> {
    let config = game.join("TAGame").join("Config");
    if !config.is_dir() {
        return None;
    }
    let custom = config.join("TAStatsAPI.ini");
    Some(if custom.exists() { custom } else { config.join("DefaultStatsAPI.ini") })
}

fn read_rate(ini: &Path) -> u32 {
    std::fs::read_to_string(ini)
        .ok()
        .and_then(|t| {
            t.lines()
                .find_map(|l| l.trim().strip_prefix("PacketSendRate=").map(|v| v.trim().parse::<f32>().unwrap_or(0.0)))
        })
        .map_or(0, |r| r as u32)
}

#[tauri::command]
pub fn find_rocket_league() -> Vec<Install> {
    let mut out: Vec<Install> = Vec::new();
    let candidates = steam_libraries()
        .into_iter()
        .map(|lib| ("Steam", lib.join("steamapps").join("common").join("rocketleague")))
        .chain(epic_installs().into_iter().map(|p| ("Epic", p)));
    for (launcher, game) in candidates {
        let Some(ini) = stats_ini(&game) else { continue };
        let path = game.to_string_lossy().into_owned();
        if out.iter().any(|i| i.path.eq_ignore_ascii_case(&path)) {
            continue;
        }
        let rate = read_rate(&ini);
        out.push(Install { launcher, path, ini: ini.to_string_lossy().into_owned(), rate });
    }
    out
}

/// Turns the Stats API on in one settings file, keeping a backup of the original.
pub fn enable(ini: &Path) -> Result<(), String> {
    let name = ini.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.eq_ignore_ascii_case("DefaultStatsAPI.ini") && !name.eq_ignore_ascii_case("TAStatsAPI.ini") {
        return Err("not a Stats API settings file".into());
    }
    let text = std::fs::read_to_string(ini).unwrap_or_else(|_| format!("{SECTION}\n"));
    let backup = ini.with_extension("ini.bak");
    if !backup.exists() {
        let _ = std::fs::copy(ini, &backup);
    }

    let mut found = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| {
            if l.trim().starts_with("PacketSendRate=") {
                found = true;
                format!("PacketSendRate={RATE}")
            } else {
                l.to_string()
            }
        })
        .collect();
    if !found {
        if !lines.iter().any(|l| l.trim() == SECTION) {
            lines.push(SECTION.into());
        }
        let at = lines.iter().position(|l| l.trim() == SECTION).map_or(lines.len(), |i| i + 1);
        lines.insert(at, format!("PacketSendRate={RATE}"));
    }
    std::fs::write(ini, lines.join("\r\n") + "\r\n").map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied { "needs-admin".to_string() } else { e.to_string() }
    })
}

#[tauri::command]
pub fn enable_stats_api(ini: String) -> Result<(), String> {
    enable(Path::new(&ini))
}

/// Relaunches this app with admin rights just to make the edit (Windows asks
/// first). Used for installs under Program Files.
#[tauri::command]
pub fn enable_stats_api_elevated(ini: String) -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = format!("--enable-stats-api \"{ini}\"");
    let result = unsafe { ShellExecuteW(None, w!("runas"), &HSTRING::from(exe.as_os_str()), &HSTRING::from(args), None, SW_HIDE) };
    // ShellExecute reports success with a value above 32.
    if result.0 as isize > 32 { Ok(()) } else { Err("Windows didn't allow the change".into()) }
}

/// `rl-overlay --enable-stats-api <ini>`: the elevated half of the above.
pub fn enable_from_args(args: &[String]) -> i32 {
    match args.first().map(|p| enable(Path::new(p))) {
        Some(Ok(())) => 0,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_rate_on_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join(format!("rlo-setup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ini = dir.join("DefaultStatsAPI.ini");
        std::fs::write(&ini, "[TAGame.MatchStatsExporter_TA]\n; comment\nPort=49123\nWebPort=49124\nPacketSendRate=0").unwrap();
        assert_eq!(read_rate(&ini), 0);
        enable(&ini).unwrap();
        assert_eq!(read_rate(&ini), RATE);
        let text = std::fs::read_to_string(&ini).unwrap();
        assert!(text.contains("WebPort=49124") && text.contains("; comment"));
        assert!(dir.join("DefaultStatsAPI.ini.bak").exists());

        // A file without the line gets it under the section.
        std::fs::write(&ini, "[TAGame.MatchStatsExporter_TA]\nPort=49123\n").unwrap();
        enable(&ini).unwrap();
        assert_eq!(read_rate(&ini), RATE);

        assert!(enable(&dir.join("Something.ini")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
