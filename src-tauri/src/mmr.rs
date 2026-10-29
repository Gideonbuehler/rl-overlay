//! Your own MMR, read from Rocket League's log.
//!
//! Each time you queue, the game writes your skill value for that playlist:
//!
//!   Matchmaking: Post-divide PartyLeaderMMR: 48.0146
//!   Matchmaking: StartMatchmaking at ... for playlists 11 on game server
//!   Matchmaking: PreferredRegions.Length=(2) ... Party.GetOrderedPartyMemberIDs().Length=(1)
//!
//! The value is the internal rating; the MMR people know is value × 20 + 100
//! (checked against RL Tracker: 69.95 in Casual → 1,499 vs. their 1,489 a few
//! games later). In a party it's the party leader's value, so party queues
//! count only when you lead: the log names your id at sign-in and the party's
//! members by index, member 0 being the leader (whoever made the party). Queues
//! for several playlists at once log an average of them, so those are skipped.
//! The value is logged as you queue, so it's your MMR going into the match, and
//! the match's own change only shows at your next queue (see mmrTable in
//! src/mmr.ts for the estimate shown meanwhile). Today's
//! earlier logs (the game keeps a few backups) are read at startup too. The
//! logs are only read, never written.
//!
//! The queue's time can be UTC or the PC's local time. Readings caught as the
//! game writes them carry the time they were read (`seen`), which tells the
//! window which one it is (see logIsLocal in src/mmr.ts).
//!
//! The log also names each match as it loads ("ScriptLog: MatchGUID: …"),
//! which the Stats API doesn't reliably pass on; that's emitted as
//! `match-guid` so saved replays can be linked to the match.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct MmrReading {
    playlist: u32,
    mmr: f64,
    /// When the game logged it, as "YYYY-MM-DD HH:MM:SS" on the log's clock.
    at: String,
    /// When it was read (Unix ms), if it was read as the game wrote it.
    #[serde(skip_serializing_if = "Option::is_none")]
    seen: Option<u64>,
}

/// Every reading seen since the app started, so a window opened later still gets them.
static READINGS: Mutex<Vec<MmrReading>> = Mutex::new(Vec::new());

fn logs_dir() -> Option<PathBuf> {
    Some(dirs::document_dir()?.join("My Games").join("Rocket League").join("TAGame").join("Logs"))
}

#[tauri::command]
pub fn mmr_readings() -> Vec<MmrReading> {
    READINGS.lock().map(|r| r.clone()).unwrap_or_default()
}

/// Stores a reading and sends it to the window.
fn keep(app: &AppHandle, reading: MmrReading) {
    if let Ok(mut all) = READINGS.lock() {
        all.push(reading.clone());
    }
    let _ = app.emit("own-mmr", reading);
}

/// Readings from the game's backup logs (Launch-backup-<date>.log), oldest first.
/// Sent too, not just stored: the window may have asked for them before this finished.
fn read_backups(app: &AppHandle, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("Launch-backup-") && n.ends_with(".log")))
        .collect();
    files.sort(); // the date in the name sorts in time order
    for file in files {
        // A file OneDrive hasn't downloaded can't be read; skip it.
        let Ok(bytes) = std::fs::read(&file) else { continue };
        let mut parser = Parser::default();
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Some(reading) = parser.line(line) {
                keep(app, reading);
            }
        }
    }
}

/// Something worth knowing from one log line.
enum LogEvent {
    Mmr(MmrReading),
    MatchGuid(String),
}

/// Pulls readings out of log text, carrying a half-seen queue across chunks.
#[derive(Default)]
struct Parser {
    rating: Option<f64>,
    queue: Option<(u32, String)>,
    /// Your account id, from the sign-in line.
    me: Option<String>,
    /// Member 0 of the party you're in: its leader.
    leader: Option<String>,
}

/// The value after `key` in a log line, up to the next space.
fn field(text: &str, key: &str) -> Option<String> {
    text.split(key).nth(1)?.split_whitespace().next().map(str::to_string)
}

impl Parser {
    fn event(&mut self, line: &str) -> Option<LogEvent> {
        if let Some(rest) = line.split("ScriptLog: MatchGUID: ").nth(1) {
            let guid = rest.trim();
            return (guid.len() == 32 && guid.chars().all(|c| c.is_ascii_hexdigit())).then(|| LogEvent::MatchGuid(guid.to_string()));
        }
        self.line(line).map(LogEvent::Mmr)
    }

    fn line(&mut self, line: &str) -> Option<MmrReading> {
        if let Some(rest) = line.split("HandleLocalPlayerLoginStatusChanged ").nth(1) {
            if rest.contains("IsPrimary=True") {
                self.me = field(rest, "PlayerID=");
            }
        } else if let Some(rest) = line.split("HandleLobbyMemberStatusUpdate ").nth(1) {
            if rest.contains(" MemberIndex=0 ") {
                self.leader = field(rest, "MemberID=");
            }
        } else if let Some(rest) = line.split("Post-divide PartyLeaderMMR:").nth(1) {
            self.rating = rest.trim().parse().ok();
            self.queue = None;
        } else if let Some(rest) = line.split("StartMatchmaking at ").nth(1) {
            // "2026-10-24 13:23:52 in USE1,USE3 for playlists 11 on game server"
            let at = rest.get(..19).unwrap_or("").to_string();
            let playlist = rest.split("for playlists ").nth(1).and_then(|p| {
                // Several playlists queued at once can't be told apart; skip those.
                let first = p.split_whitespace().next()?;
                if first.contains(',') { None } else { first.parse().ok() }
            });
            self.queue = playlist.map(|p| (p, at));
        } else if let Some(rest) = line.split("GetOrderedPartyMemberIDs().Length=(").nth(1) {
            let solo = rest.starts_with("1)");
            let leading = self.me.is_some() && self.me == self.leader;
            // Queueing several playlists at once logs an average of their values.
            let one_playlist = !line.contains("PreferredPlaylists.Length=(") || line.contains("PreferredPlaylists.Length=(1)");
            if let (Some(rating), Some((playlist, at)), true) = (self.rating.take(), self.queue.take(), (solo || leading) && one_playlist) {
                return Some(MmrReading { playlist, mmr: (rating * 20.0 + 100.0).round(), at, seen: None });
            }
        }
        None
    }
}

/// Follows the log, emitting `own-mmr` for every solo queue, including the
/// ones already in today's log when the app starts.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(dir) = logs_dir() else { return };
        read_backups(&app, &dir);
        let path = dir.join("Launch.log");
        let mut offset = 0u64;
        let mut parser = Parser::default();
        let mut partial = String::new();
        let mut first_read = true;
        loop {
            if let Ok(mut file) = std::fs::File::open(&path) {
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                if len < offset {
                    // The game started a new log.
                    offset = 0;
                    parser = Parser::default();
                    partial.clear();
                }
                if len > offset && file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut bytes = Vec::new();
                    if file.take(len - offset).read_to_end(&mut bytes).is_ok() {
                        offset += bytes.len() as u64;
                        partial.push_str(&String::from_utf8_lossy(&bytes));
                        // Keep an unfinished last line for the next read.
                        let complete = partial.rfind('\n').map(|i| i + 1).unwrap_or(0);
                        let text: String = partial.drain(..complete).collect();
                        // Old match ids in the log (from before the app started)
                        // are skipped: only the match being joined now matters.
                        let catching_up = first_read;
                        first_read = false;
                        for line in text.lines() {
                            match parser.event(line) {
                                Some(LogEvent::Mmr(mut reading)) => {
                                    // Logged moments ago, so its time is now on the log's clock.
                                    if !catching_up {
                                        reading.seen = Some(crate::gamerun::now_ms());
                                    }
                                    keep(&app, reading);
                                }
                                Some(LogEvent::MatchGuid(guid)) if !catching_up => {
                                    let _ = app.emit("match-guid", guid);
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::Parser;

    #[test]
    fn reads_match_ids() {
        let mut p = Parser::default();
        match p.event("[0096.72] ScriptLog: MatchGUID: 00EDA6EA11F1D012B843F390531CA76A") {
            Some(super::LogEvent::MatchGuid(g)) => assert_eq!(g, "00EDA6EA11F1D012B843F390531CA76A"),
            _ => panic!("no match id"),
        }
        assert!(p.event("[0094.10] EOSVoice: Not requesting voice token, no MatchGUID").is_none());
    }

    #[test]
    fn reads_solo_queues_only() {
        let log = "\
[0061.10] Matchmaking: Pre-divide PartyLeaderMMR: 48.0146
[0061.10] Matchmaking: Post-divide PartyLeaderMMR: 48.0146
[0061.10] Matchmaking: PartyLeaderTier=(15)
[0061.10] Matchmaking: StartMatchmaking at 2026-10-24 13:23:52 in USE1,USE3 for playlists 11 on game server
[0061.10] Matchmaking: PreferredRegions.Length=(2) PreferredPlaylists.Length=(1) Party.GetOrderedPartyMemberIDs().Length=(1)
[0595.13] Matchmaking: Post-divide PartyLeaderMMR: 69.9509
[0595.13] Matchmaking: StartMatchmaking at 2026-10-24 13:32:46 in USE1,USE3 for playlists 2 on game server
[0595.13] Matchmaking: PreferredRegions.Length=(2) PreferredPlaylists.Length=(1) Party.GetOrderedPartyMemberIDs().Length=(2)
";
        let mut p = Parser::default();
        let got: Vec<_> = log.lines().filter_map(|l| p.line(l)).collect();
        assert_eq!(got.len(), 1, "the party queue is skipped");
        assert_eq!(got[0].playlist, 11);
        assert_eq!(got[0].mmr, 1060.0);
        assert_eq!(got[0].at, "2026-10-24 13:23:52");
    }

    #[test]
    fn skips_queues_for_several_playlists() {
        let log = "\
[0061.10] Matchmaking: Post-divide PartyLeaderMMR: 52.5
[0061.10] Matchmaking: StartMatchmaking at 2026-10-24 13:23:52 in USE1,USE3 for playlists 11 on game server
[0061.10] Matchmaking: PreferredRegions.Length=(2) PreferredPlaylists.Length=(2) Party.GetOrderedPartyMemberIDs().Length=(1)
";
        let mut p = Parser::default();
        assert!(log.lines().all(|l| p.line(l).is_none()), "an average of two playlists is nobody's MMR");
    }

    #[test]
    fn reads_party_queues_you_lead() {
        let me = "[0013.34] Party: HandleLocalPlayerLoginStatusChanged PlayerName=FluxxF PlayerID=Steam|7656|0 LoginStatus=LS_LoggedIn IsPrimary=True IsInParty=False";
        let queue = "[0352.41] Matchmaking: Post-divide PartyLeaderMMR: 68.1445
[0352.41] Matchmaking: StartMatchmaking at 2026-10-25 17:44:46 in EU7,EU9 for playlists 2 on game server
[0352.41] Matchmaking: PreferredRegions.Length=(5) PreferredPlaylists.Length=(1) Party.GetOrderedPartyMemberIDs().Length=(2)
";
        let lead = "[0134.73] Party: HandleLobbyMemberStatusUpdate LobbyUID=PsyNet-4RBLJfry Members=1 MemberIndex=0 MemberID=Steam|7656|0";
        let joined = "[0134.73] Party: HandleLobbyMemberStatusUpdate LobbyUID=PsyNet-xyz Members=2 MemberIndex=0 MemberID=Epic|abc|0";
        let run = |party: &str| {
            let mut p = Parser::default();
            [me, party].iter().chain(queue.lines().collect::<Vec<_>>().iter()).filter_map(|l| p.line(l)).collect::<Vec<_>>()
        };
        let led = run(lead);
        assert_eq!(led.len(), 1);
        assert_eq!(led[0].mmr, 1463.0);
        assert!(run(joined).is_empty(), "someone else's party: their MMR, not yours");
    }

    #[test]
    fn sends_seen_only_for_readings_caught_live() {
        let log = "\
[0061.10] Matchmaking: Post-divide PartyLeaderMMR: 48.0146
[0061.10] Matchmaking: StartMatchmaking at 2026-10-24 13:23:52 in USE1,USE3 for playlists 11 on game server
[0061.10] Matchmaking: PreferredRegions.Length=(2) PreferredPlaylists.Length=(1) Party.GetOrderedPartyMemberIDs().Length=(1)
";
        let mut p = Parser::default();
        let mut r = log.lines().find_map(|l| p.line(l)).expect("a reading");
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"playlist":11,"mmr":1060.0,"at":"2026-10-24 13:23:52"}"#);
        r.seen = Some(1_761_312_232_000);
        assert!(serde_json::to_string(&r).unwrap().ends_with(r#","seen":1761312232000}"#));
    }
}
