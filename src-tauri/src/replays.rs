//! Saved replays: finds them, reads their headers, and works out exact boost
//! stats from their network data.
//!
//! Rocket League writes a replay to `Documents\My Games\Rocket League\TAGame\Demos`
//! when you save one at the end of a match or from Match History. The header
//! carries the match's GUID (the same one the Stats API sends, so replays link
//! to match records exactly) and the frame of every goal, which is what lets the
//! report jump the in-game replay viewer to a goal.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use boxcars::{HeaderProp, ParserBuilder};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayGoal {
    frame: i32,
    player: String,
    team: i32,
}

/// A player as the replay header records them: their real platform and id.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayPlayer {
    name: String,
    /// e.g. "Steam", "Dingo" (Xbox), "PS4", "Epic".
    platform: String,
    online_id: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayInfo {
    path: String,
    id: String,
    match_guid: String,
    /// As written in the header, e.g. "2026-10-24 13-31-45".
    date: String,
    map: String,
    fps: f32,
    num_frames: i32,
    team_size: i32,
    score: [i32; 2],
    goals: Vec<ReplayGoal>,
    players: Vec<ReplayPlayer>,
    /// When the match started, unix seconds. Links a replay to its match when
    /// the Stats API didn't provide a match GUID.
    start_epoch: u64,
}

/// Exact boost stats for one player, on the game's 0–100 scale.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerBoost {
    name: String,
    team: i32,
    used: f64,
    collected: f64,
    /// Collected from the opponent's half.
    stolen: f64,
    used_airborne: f64,
    used_supersonic: f64,
    big_pads: u64,
    small_pads: u64,
    /// Seconds tracked, and the level integrated over them.
    time: f64,
    level_sum: f64,
    empty: f64,
    full: f64,
}

/// Cache of parsed headers keyed by path and modification time.
static KNOWN: Mutex<Vec<(PathBuf, u64, Option<ReplayInfo>)>> = Mutex::new(Vec::new());

fn demo_dirs() -> Vec<PathBuf> {
    let Some(docs) = dirs::document_dir() else { return Vec::new() };
    let base = docs.join("My Games").join("Rocket League").join("TAGame");
    ["Demos", "DemosEpic"].iter().map(|d| base.join(d)).filter(|d| d.is_dir()).collect()
}

fn modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

/// Rescans the replay folders, parsing only headers it hasn't seen.
fn scan() -> Vec<ReplayInfo> {
    let mut known = KNOWN.lock().unwrap();
    let mut seen = Vec::new();
    for dir in demo_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("replay") {
                continue;
            }
            let mtime = modified(&path);
            let cached = known.iter().find(|(p, m, _)| *p == path && *m == mtime).map(|(_, _, i)| i.clone());
            let info = match cached {
                Some(info) => info,
                None => {
                    let info = read_header(&path);
                    known.retain(|(p, _, _)| *p != path);
                    known.push((path.clone(), mtime, info.clone()));
                    info
                }
            };
            if let Some(info) = info {
                seen.push((mtime, info));
            }
        }
    }
    seen.sort_by(|a, b| b.0.cmp(&a.0));
    seen.into_iter().map(|(_, i)| i).collect()
}

fn prop<'a>(props: &'a [(String, HeaderProp)], key: &str) -> Option<&'a HeaderProp> {
    props.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}
fn prop_i32(props: &[(String, HeaderProp)], key: &str) -> i32 {
    match prop(props, key) {
        Some(HeaderProp::Int(n)) => *n,
        _ => 0,
    }
}
fn prop_str(props: &[(String, HeaderProp)], key: &str) -> String {
    match prop(props, key) {
        Some(HeaderProp::Str(s)) | Some(HeaderProp::Name(s)) => s.clone(),
        _ => String::new(),
    }
}

fn read_header(path: &Path) -> Option<ReplayInfo> {
    let data = std::fs::read(path).ok()?;
    let replay = ParserBuilder::new(&data).never_parse_network_data().parse().ok()?;
    let p = &replay.properties;
    let goals = match prop(p, "Goals") {
        Some(HeaderProp::Array(list)) => list
            .iter()
            .map(|g| ReplayGoal { frame: prop_i32(g, "frame"), player: prop_str(g, "PlayerName"), team: prop_i32(g, "PlayerTeam") })
            .collect(),
        _ => Vec::new(),
    };
    let players = match prop(p, "PlayerStats") {
        Some(HeaderProp::Array(list)) => list
            .iter()
            .map(|pl| ReplayPlayer {
                name: prop_str(pl, "Name"),
                platform: match prop(pl, "Platform") {
                    Some(HeaderProp::Byte { value: Some(v), .. }) => v.trim_start_matches("OnlinePlatform_").to_string(),
                    _ => String::new(),
                },
                online_id: match prop(pl, "OnlineID") {
                    Some(HeaderProp::QWord(id)) => id.to_string(),
                    _ => String::new(),
                },
            })
            .collect(),
        _ => Vec::new(),
    };
    Some(ReplayInfo {
        path: path.to_string_lossy().into_owned(),
        id: prop_str(p, "Id"),
        match_guid: prop_str(p, "MatchGUID"),
        date: prop_str(p, "Date"),
        map: prop_str(p, "MapName"),
        fps: match prop(p, "RecordFPS") {
            Some(HeaderProp::Float(f)) => *f,
            _ => 30.0,
        },
        num_frames: prop_i32(p, "NumFrames"),
        team_size: prop_i32(p, "TeamSize"),
        score: [prop_i32(p, "Team0Score"), prop_i32(p, "Team1Score")],
        goals,
        players,
        start_epoch: match prop(p, "MatchStartEpoch") {
            Some(HeaderProp::QWord(t)) => *t,
            _ => 0,
        },
    })
}

#[tauri::command]
pub fn list_replays() -> Vec<ReplayInfo> {
    scan()
}

/// Watches the replay folders and emits `replays` whenever the list changes.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Vec<ReplayInfo> = Vec::new();
        loop {
            let now = scan();
            if now != last {
                let _ = app.emit("replays", &now);
                last = now;
            }
            std::thread::sleep(Duration::from_secs(4));
        }
    });
}

/// Exact per-player boost from a replay's network data. Takes a few seconds,
/// so it runs off the main thread and the result is cached by replay id.
#[tauri::command]
pub async fn replay_boost(app: AppHandle, path: String, id: String) -> Result<Vec<PlayerBoost>, String> {
    let cache = app.path().app_data_dir().ok().map(|d| d.join("replay-boost").join(format!("{id}.json")));
    if let Some(Ok(json)) = cache.as_ref().map(std::fs::read_to_string) {
        if let Ok(stats) = serde_json::from_str(&json) {
            return Ok(stats);
        }
    }
    let stats = tauri::async_runtime::spawn_blocking(move || compute_boost(&path))
        .await
        .map_err(|e| e.to_string())??;
    if let Some(cache) = cache {
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(cache, serde_json::to_string(&stats).unwrap_or_default());
    }
    Ok(stats)
}

fn compute_boost(path: &str) -> Result<Vec<PlayerBoost>, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let replay = ParserBuilder::new(&data)
        .must_parse_network_data()
        .parse()
        .map_err(|e| format!("couldn't parse replay: {e}"))?;
    let collector = subtr_actor::StatsCollector::with_builtin_module_names(["boost"])
        .map_err(|e| format!("couldn't compute boost: {e:?}"))?;
    let stats = collector.get_stats(&replay).map_err(|e| format!("couldn't compute boost: {e:?}"))?;

    // Player ids link the stats to names and teams in the replay metadata.
    let meta = serde_json::to_value(&stats.replay_meta).map_err(|e| e.to_string())?;
    let roster: Vec<(String, String, i32)> = [("team_zero", 0), ("team_one", 1)]
        .iter()
        .flat_map(|(key, team)| {
            meta[key].as_array().cloned().unwrap_or_default().into_iter().map(move |p| {
                (p["remote_id"].to_string(), p["name"].as_str().unwrap_or("?").to_string(), *team)
            })
        })
        .collect();

    // Replay units run 0–255; the game's meter shows 0–100.
    let k = 100.0 / 255.0;
    let all = serde_json::to_value(&stats).map_err(|e| e.to_string())?;
    let players = all["modules"]["boost"]["player_stats"].as_array().cloned().unwrap_or_default();
    Ok(players
        .iter()
        .map(|p| {
            let id = p["player_id"].to_string();
            let (name, team) = roster
                .iter()
                .find(|(r, _, _)| *r == id)
                .map(|(_, n, t)| (n.clone(), *t))
                .unwrap_or_else(|| (id.clone(), -1));
            let s = &p["stats"];
            let f = |key: &str| s[key].as_f64().unwrap_or(0.0);
            let n = |key: &str| s[key].as_u64().unwrap_or(0);
            PlayerBoost {
                name,
                team,
                used: f("amount_used") * k,
                collected: f("amount_collected") * k,
                stolen: f("amount_stolen") * k,
                used_airborne: f("amount_used_while_airborne") * k,
                used_supersonic: f("amount_used_while_supersonic") * k,
                big_pads: n("big_pads_collected"),
                small_pads: n("small_pads_collected"),
                time: f("tracked_time"),
                level_sum: f("boost_integral") * k,
                empty: f("time_zero_boost"),
                full: f("time_hundred_boost"),
            }
        })
        .collect())
}

/// `rl-overlay --replay-test <replay>`: prints the header info and boost stats
/// the overlay would use, for checking parsing without the app.
pub fn replay_test(path: &str) {
    match read_header(Path::new(path)) {
        Some(info) => println!("{}", serde_json::to_string_pretty(&info).unwrap_or_default()),
        None => println!("couldn't read the header"),
    }
    match compute_boost(path) {
        Ok(players) => {
            for p in players {
                println!(
                    "{:>16} team {}  used {:5.0}  collected {:5.0}  bpm {:4.0}  big {} small {}",
                    p.name, p.team, p.used, p.collected, p.used / p.time.max(1.0) * 60.0, p.big_pads, p.small_pads
                );
            }
        }
        Err(e) => println!("boost: {e}"),
    }
}
