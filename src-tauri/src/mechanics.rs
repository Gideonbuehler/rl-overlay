//! Mechanical execution from a saved replay.
//!
//! The live Stats API never says where cars are, so it can count touches but
//! not judge them. A replay has every car and the ball frame by frame, and
//! subtr-actor finds each touch and each whiff (an attempt that committed to
//! the ball and missed). For every one of those this works out the conditions
//! it happened in, and whether it came off:
//!
//! - kind: ground, wall, low air, or high air, and whether the player dodged;
//! - car speed just before contact;
//! - approach angle: degrees between where the car was heading and the ball;
//! - time available: how long the nearest opponent needed to reach the ball,
//!   from their distance and how fast they were closing on it.
//!
//! A touch is clean when it did something useful: the player's team touched
//! the ball next or scored, it was a shot, save, or clear, or it moved the ball
//! well up the field. It's missed when the ball went straight to an opponent.
//! Whiffs are always missed. Anything else (the ball rolled loose and an
//! opponent picked it up later) is left unjudged. Kickoff touches are left out:
//! they say more about the kickoff than about execution.

use boxcars::{HeaderProp, ParserBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use subtr_actor::{Collector, FrameRateDecorator, NDArrayCollector};

/// One touch or whiff and the conditions it happened in.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    /// Seconds into the replay.
    pub time: f32,
    /// "ground", "wall", "air" (low in the air), or "high".
    pub kind: String,
    pub dodge: bool,
    /// Car speed just before contact, km/h.
    pub speed: f32,
    /// Degrees between the car's heading and the ball; None when barely moving.
    pub angle: Option<f32>,
    /// Seconds the nearest opponent needed to reach the ball, capped at MAX_TIME.
    pub time_available: Option<f32>,
    /// "clean", "missed", or "unclear".
    pub result: String,
    /// Committed to the ball and missed it.
    pub whiff: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMechanics {
    pub name: String,
    pub team: i32,
    pub attempts: Vec<Attempt>,
}

/// Whiffs the detector is less sure of than this are left out.
const MIN_WHIFF_CONFIDENCE: f64 = 0.7;
/// An opponent touching within this long after a touch took the ball off it.
const TURNOVER_SECS: f32 = 1.5;
/// Moving the ball this far up the field (uu, about a fifth of the pitch) counts as useful.
const ADVANCE_UU: f64 = 1500.0;
/// Below this speed (uu/s) the car's heading says nothing about its approach.
const MIN_HEADING_SPEED: f32 = 300.0;
/// Opponents closing slower than this (uu/s) are treated as closing at it.
const MIN_CLOSING: f32 = 700.0;
const MAX_TIME: f32 = 5.0;
/// How long before contact the car's speed and heading are read, so the hit itself doesn't show.
const BEFORE_CONTACT: f32 = 0.05;
const UU_TO_KMH: f32 = 0.036;

type V3 = [f32; 3];
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn len(a: V3) -> f32 {
    dot(a, a).sqrt()
}

/// Car and ball positions and velocities sampled through the match.
struct Frames {
    times: Vec<f32>,
    rows: ndarray::Array2<f32>,
    ball_pos: usize,
    /// Per player (in replay order): position and velocity columns.
    players: Vec<(usize, usize)>,
}

impl Frames {
    fn row_at(&self, t: f32) -> Option<usize> {
        let i = self.times.partition_point(|&x| x <= t);
        if i == 0 { None } else { Some(i - 1) }
    }
    fn vec(&self, row: usize, col: usize) -> V3 {
        [self.rows[[row, col]], self.rows[[row, col + 1]], self.rows[[row, col + 2]]]
    }
}

fn read_frames(replay: &boxcars::Replay) -> Result<Frames, String> {
    let mut collector = NDArrayCollector::<f32>::from_strings(&["CurrentTime", "BallRigidBody"], &["PlayerRigidBody"])
        .map_err(|e| format!("{e:?}"))?;
    FrameRateDecorator::new_from_fps(30.0, &mut collector).process_replay(replay).map_err(|e| format!("{e:?}"))?;
    let (meta, rows) = collector.get_meta_and_ndarray().map_err(|e| format!("{e:?}"))?;
    let headers: Vec<String> = meta.headers_vec().iter().map(|h| h.to_lowercase()).collect();
    let find = |prefix: &str, name: &str| headers.iter().position(|h| h.starts_with(prefix) && h.ends_with(name));
    let time = find("", "current time").ok_or("no time column")?;
    let ball_pos = find("ball", "position x").ok_or("no ball position")?;
    let players = (0..meta.replay_meta.player_count())
        .map(|i| {
            let p = format!("player {i} - ");
            Ok((find(&p, "position x").ok_or("no car position")?, find(&p, "linear velocity x").ok_or("no car velocity")?))
        })
        .collect::<Result<Vec<_>, &str>>()?;
    let times = rows.column(time).to_vec();
    Ok(Frames { times, rows, ball_pos, players })
}

/// Goal times and the scoring team, from the header and the frame clock.
fn goals(replay: &boxcars::Replay) -> Vec<(f32, i32)> {
    let frames = replay.network_frames.as_ref().map(|n| &n.frames);
    let Some((_, HeaderProp::Array(list))) = replay.properties.iter().find(|(k, _)| k == "Goals") else { return Vec::new() };
    list.iter()
        .filter_map(|g| {
            let get = |key: &str| g.iter().find(|(k, _)| k == key).and_then(|(_, v)| if let HeaderProp::Int(n) = v { Some(*n) } else { None });
            let frame = get("frame")? as usize;
            Some((frames?.get(frame)?.time, get("PlayerTeam")?))
        })
        .collect()
}

/// What a player was doing at time `t`: where the car was, its speed (km/h),
/// approach angle, and the time available before an opponent could get there.
struct Conditions {
    car: V3,
    speed: f32,
    angle: Option<f32>,
    time_available: Option<f32>,
}

fn conditions(f: &Frames, me: usize, team_of: &[i32], t: f32) -> Option<Conditions> {
    let row = f.row_at(t - BEFORE_CONTACT)?;
    let (pos, vel) = f.players[me];
    let car = f.vec(row, pos);
    let v = f.vec(row, vel);
    let ball = f.vec(row, f.ball_pos);
    let speed = len(v);
    let to_ball = sub(ball, car);
    let angle = (speed >= MIN_HEADING_SPEED && len(to_ball) > 1.0)
        .then(|| (dot(v, to_ball) / (speed * len(to_ball))).clamp(-1.0, 1.0).acos().to_degrees());
    let available = f
        .players
        .iter()
        .enumerate()
        .filter(|(j, _)| team_of[*j] != team_of[me])
        .filter_map(|(_, &(p, vcol))| {
            let them = f.vec(row, p);
            // A demolished car sits at the origin; skip it.
            if them == [0.0, 0.0, 0.0] {
                return None;
            }
            let gap = sub(ball, them);
            let dist = len(gap);
            let closing = if dist > 1.0 { dot(f.vec(row, vcol), gap) / dist } else { 0.0 };
            Some((dist / closing.max(MIN_CLOSING)).min(MAX_TIME))
        })
        .reduce(f32::min);
    Some(Conditions { car, speed: speed * UU_TO_KMH, angle, time_available: available })
}

fn tag<'a>(e: &'a Value, group: &str) -> Option<&'a str> {
    e["tags"].as_array()?.iter().find(|t| t["group"] == group).and_then(|t| t["value"].as_str())
}

/// Ground, wall, low air, or high air, from a touch's tags.
fn touch_kind(e: &Value) -> &'static str {
    match (tag(e, "surface"), tag(e, "height_band")) {
        (Some("wall"), _) => "wall",
        (_, Some("high_air")) => "high",
        (_, Some("low_air")) | (Some("air"), _) => "air",
        _ => "ground",
    }
}

/// Same for a whiff, which only says whether it was aerial; the rest is where the car was.
fn whiff_kind(e: &Value, car: V3) -> &'static str {
    let (x, y, z) = (car[0].abs(), car[1].abs(), car[2]);
    if e["aerial"].as_bool() == Some(true) {
        if z >= 600.0 { "high" } else { "air" }
    } else if z > 150.0 && (x > 3800.0 || y > 4900.0) {
        "wall"
    } else {
        "ground"
    }
}

/// The analysis itself. Slow (a few seconds), so callers run it off the main thread.
pub fn analyse(path: &str) -> Result<Vec<PlayerMechanics>, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let replay = ParserBuilder::new(&data).must_parse_network_data().parse().map_err(|e| format!("couldn't parse replay: {e}"))?;
    let stats = subtr_actor::StatsCollector::with_builtin_module_names(["touch", "whiff"])
        .map_err(|e| format!("{e:?}"))?
        .get_stats(&replay)
        .map_err(|e| format!("{e:?}"))?;
    let all = serde_json::to_value(&stats).map_err(|e| e.to_string())?;
    let frames = read_frames(&replay)?;
    let goals = goals(&replay);

    // Players in replay order, which is also the frame columns' order.
    let roster: Vec<(Value, String, i32)> = [("team_zero", 0), ("team_one", 1)]
        .iter()
        .flat_map(|(key, team)| {
            all["replay_meta"][key].as_array().cloned().unwrap_or_default().into_iter().map(move |p| {
                (p["remote_id"].clone(), p["name"].as_str().unwrap_or("?").to_string(), *team)
            })
        })
        .collect();
    let team_of: Vec<i32> = roster.iter().map(|(_, _, t)| *t).collect();
    let index_of = |e: &Value| roster.iter().position(|(id, _, _)| *id == e["player"]);
    let mut out: Vec<PlayerMechanics> =
        roster.iter().map(|(_, name, team)| PlayerMechanics { name: name.clone(), team: *team, attempts: Vec::new() }).collect();

    let mut touches: Vec<&Value> = all["modules"]["touch"]["events"].as_array().map(|v| v.iter().collect()).unwrap_or_default();
    touches.sort_by(|a, b| a["time"].as_f64().partial_cmp(&b["time"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    for (k, e) in touches.iter().enumerate() {
        let Some(me) = index_of(e) else { continue };
        let t = e["time"].as_f64().unwrap_or(0.0) as f32;
        let ball = |i: usize| e["ball_position"][i].as_f64().unwrap_or(0.0);
        if ball(0).abs() < 50.0 && ball(1).abs() < 50.0 && ball(2) < 150.0 {
            continue; // kickoff
        }
        let Some(c) = conditions(&frames, me, &team_of, t) else { continue };
        let team = team_of[me];
        let next = touches.get(k + 1).and_then(|n| Some((index_of(n)?, n["time"].as_f64()? as f32)));
        let next_goal = goals.iter().find(|(gt, _)| *gt > t && next.is_none_or(|(_, nt)| *gt < nt));
        // Blue attacks +y, orange -y.
        let advance = e["ball_movement"]["advance_distance"].as_f64().unwrap_or(0.0);
        let purposeful = matches!(tag(e, "action"), Some("shot" | "save" | "clear"));
        let result = match (next_goal, next) {
            (Some((_, scorer)), _) if *scorer == team => "clean",
            (Some(_), _) => "missed",
            (None, Some((j, _))) if team_of[j] == team => "clean",
            _ if purposeful || advance >= ADVANCE_UU => "clean",
            (None, Some((_, nt))) if nt - t <= TURNOVER_SECS => "missed",
            _ => "unclear",
        };
        out[me].attempts.push(Attempt {
            time: t,
            kind: touch_kind(e).into(),
            dodge: tag(e, "dodge_state") == Some("dodge"),
            speed: c.speed,
            angle: c.angle,
            time_available: c.time_available,
            result: result.into(),
            whiff: false,
        });
    }

    for e in all["modules"]["whiff"]["events"].as_array().cloned().unwrap_or_default() {
        if e["kind"] != "whiff" || e["confidence"].as_f64().unwrap_or(0.0) < MIN_WHIFF_CONFIDENCE {
            continue;
        }
        let Some(me) = index_of(&e) else { continue };
        let t = e["time"].as_f64().unwrap_or(0.0) as f32;
        let Some(c) = conditions(&frames, me, &team_of, t) else { continue };
        out[me].attempts.push(Attempt {
            time: t,
            kind: whiff_kind(&e, c.car).into(),
            dodge: e["dodge_active"].as_bool() == Some(true),
            speed: c.speed,
            angle: c.angle,
            time_available: c.time_available,
            result: "missed".into(),
            whiff: true,
        });
    }
    for p in &mut out {
        p.attempts.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    }
    Ok(out)
}

/// Bumped when the analysis changes, so cached results are worked out again.
const CACHE: &str = "replay-mechanics-v1";

/// Mechanics for every player in a replay. Takes a few seconds, so it runs off
/// the main thread, and the result is cached by replay id.
#[tauri::command]
pub async fn replay_mechanics(app: tauri::AppHandle, path: String, id: String) -> Result<Vec<PlayerMechanics>, String> {
    use tauri::Manager;
    let cache = app.path().app_data_dir().ok().map(|d| d.join(CACHE).join(format!("{id}.json")));
    if let Some(Ok(json)) = cache.as_ref().map(std::fs::read_to_string) {
        if let Ok(players) = serde_json::from_str(&json) {
            return Ok(players);
        }
    }
    let players = tauri::async_runtime::spawn_blocking(move || analyse(&path)).await.map_err(|e| e.to_string())??;
    if let Some(cache) = cache {
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(cache, serde_json::to_string(&players).unwrap_or_default());
    }
    Ok(players)
}

/// `rl-overlay --mechanics-test <file.replay>`: prints what the analysis finds.
pub fn mechanics_test(path: &str) {
    match analyse(path) {
        Ok(players) => {
            for p in players {
                let n = |r: &str| p.attempts.iter().filter(|a| a.result == r).count();
                let whiffs = p.attempts.iter().filter(|a| a.whiff).count();
                println!("{:>16} team {}  attempts {:3}  clean {:3}  missed {:3} (whiffs {:2})  unclear {:3}", p.name, p.team, p.attempts.len(), n("clean"), n("missed"), whiffs, n("unclear"));
                for a in p.attempts.iter().take(6) {
                    println!("    {:6.1}s {:6} dodge={:5} {:5.0} km/h  angle {:>5}  time {:>4}  {}{}", a.time, a.kind, a.dodge, a.speed,
                        a.angle.map_or("-".into(), |x| format!("{x:.0}")), a.time_available.map_or("-".into(), |x| format!("{x:.1}")), a.result, if a.whiff { " (whiff)" } else { "" });
                }
            }
        }
        Err(e) => println!("mechanics: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn touch(surface: &str, height: &str) -> Value {
        json!({ "tags": [{ "group": "surface", "value": surface }, { "group": "height_band", "value": height }] })
    }

    #[test]
    fn sorts_touches_by_where_they_happened() {
        assert_eq!(touch_kind(&touch("ground", "ground")), "ground");
        assert_eq!(touch_kind(&touch("wall", "low_air")), "wall");
        assert_eq!(touch_kind(&touch("air", "low_air")), "air");
        assert_eq!(touch_kind(&touch("air", "high_air")), "high");
    }

    #[test]
    fn sorts_whiffs_by_where_the_car_was() {
        let aerial = json!({ "aerial": true });
        let grounded = json!({ "aerial": false });
        assert_eq!(whiff_kind(&aerial, [0.0, 0.0, 900.0]), "high");
        assert_eq!(whiff_kind(&aerial, [0.0, 0.0, 300.0]), "air");
        assert_eq!(whiff_kind(&grounded, [4000.0, 0.0, 400.0]), "wall");
        assert_eq!(whiff_kind(&grounded, [100.0, 200.0, 17.0]), "ground");
    }
}
