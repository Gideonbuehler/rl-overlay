// Bundled, so the overlay looks the same offline.
import "@fontsource/oxanium/400.css";
import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";
import "@fontsource/oxanium/700.css";
import "@fontsource/oxanium/800.css";
import "./style.css";
import { BoostTracker, emptyBoost } from "./boost";
import { connect, speedKmh, type Envelope, type Feed, type Status } from "./feed";
import { DEFAULT_HUD_STATS, HUD_STATS, NEW_HUD_STATS, renderHud } from "./hud";
import { MatchTracker, duration, isRealMatch, wasPlayed, type MatchRecord, type PlayerBoost } from "./match";
import { trackerCandidates } from "./names";
import { setSpeedUnit, type SpeedUnit } from "./units";
import { DEFAULT_SERVER_URL, SharedMmr, latestReading, logIsLocal, matchMmr, newShareToken, readingTime, utcAt, type MmrReading } from "./mmr";
import { COLUMNS, TABS, ZONES_COLUMN, overrideKey, renderReport, type ReportEntry, type ReportView } from "./report";
import {
  ARCHIVE_LIMIT,
  computeSession,
  lastPlayedAt,
  nextSessionStart,
  emptySession,
  initStore,
  loadReadings,
  saveEventLog,
  saveReadings,
  loadArchive,
  loadSessionStart,
  loadSettings,
  saveArchive,
  saveSessionStart,
  saveSettings,
  type Settings,
} from "./session";

// Runs inside Tauri, or as a plain page (an OBS browser source, or `npm run dev`).
const inTauri = "__TAURI_INTERNALS__" in window;
const params = new URLSearchParams(location.search);

// Saved data comes from files shared by every build; load it before reading any.
await initStore(inTauri);

let settings = loadSettings();
setSpeedUnit(settings.speedUnit);
// Switch on stats added since the picker was last saved, if they're defaults.
{
  const seen = settings.hudSeen ?? HUD_STATS.map((s) => s.id).filter((id) => !NEW_HUD_STATS.includes(id));
  const added = DEFAULT_HUD_STATS.filter((id) => !seen.includes(id) && !settings.hudStats.includes(id));
  const chosen = [...settings.hudStats, ...added];
  settings = {
    ...settings,
    hudStats: HUD_STATS.map((s) => s.id).filter((id) => chosen.includes(id)),
    hudSeen: HUD_STATS.map((s) => s.id),
  };
  saveSettings(settings);
}
/** When the current session started; the rest of it is worked out from the archive. */
let sessionStart = loadSessionStart();
let session = emptySession();
/** Your MMR readings from the game log, oldest first. */
let readings = loadReadings();
if (!settings.shareToken) {
  settings = { ...settings, shareToken: newShareToken() };
  saveSettings(settings);
}
const sharedMmr = new SharedMmr(
  () => serverUrl(),
  () => scheduleRender(),
);
let shareError = "";

/** The shared MMR server: your own if set, otherwise the default one. */
function serverUrl() {
  return (settings.serverUrl.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}
/** True while you're typing in the report (the tracker correction box); it isn't redrawn meanwhile. */
let typing = false;
/** True while another app is in front on the overlay's screen; everything hides. */
let away = false;
/** Finished matches, newest first, for the history selector. */
const archive = loadArchive();

/** Recomputes the session from the matches since it started. */
function refreshSession() {
  session = computeSession(archive, sessionStart, readings);
}

/** When Rocket League was last opened (a restart within 5 minutes doesn't count), or 0. */
let gameRunStart = 0;

/** Starts a new session when the game has been reopened since this one began, or after a long break. */
function maybeNewSession() {
  const start = nextSessionStart(sessionStart, gameRunStart, lastPlayedAt(archive), Date.now());
  if (start === null) return;
  sessionStart = start;
  saveSessionStart(sessionStart);
  refreshSession();
}
maybeNewSession();
refreshSession();
let status: Status = "connecting";
let editMode = params.has("edit");

const tracker = new MatchTracker();
tracker.playerName = settings.playerName;

/**
 * The report appears on its own when a match ends, and its hotkey shows or
 * hides it at any time. The HUD is a separate small panel with its own hotkey.
 */
let reportVisible = params.has("report");
let hideTimer: number | undefined;
/** The record that has already been booked into the session. */
let finished: MatchRecord | null = null;
let finishTimer: number | undefined;
/** The match the report is showing. Null means the newest one. */
let selected: MatchRecord | null = null;
/** Which screen the report shows: a match, the list of all matches, or a player. */
let view: ReportView = { kind: "match" };
/** The match report's open tab. */
let reportTab = "overview";

// Live numbers for the HUD.
let lastHit: number | null = null;
let ballSpeed: number | null = null;
let inGoalReplay = false;

/** Boost for the match in progress; readings outside a live match go nowhere. */
const boost = new BoostTracker(() => {
  const r = tracker.record;
  return Object.keys(r.players).length && r.winner === null ? (r.boost ??= emptyBoost()) : null;
});
/** When spectating, the API sends boost directly and the screen reader steps aside. */
let apiBoostAt = 0;
let calibrating = false;
/** Recent raw readings; the median of the last three smooths out one-frame misreads. */
const recentReadings: number[] = [];

/** Saved replays found on disk, newest first (from src-tauri/src/replays.rs). */
interface ReplayInfo {
  path: string;
  id: string;
  matchGuid: string;
  /** Match start, unix seconds. */
  startEpoch: number;
  score: [number, number];
  fps: number;
  goals: { frame: number; player: string; team: number }[];
  /** Each player's real platform ("Steam", "Dingo" for Xbox, "PS4", "Epic") and id. */
  players: { name: string; platform: string; onlineId: string }[];
}
let replays: ReplayInfo[] = [];
/** Replay ids whose boost is being worked out. */
const boostPending = new Set<string>();
/** True while a replay is playing in the game, so its events aren't tracked as a match. */
let replayMode = false;
let loadedReplay: string | null = null;
/** Frame to jump to once the replay we asked for has loaded. */
let pendingSeek: number | null = null;
let feed: Feed | null = null;
let lastReading: { value: number | null; raw: string; learned: string } | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!inTauri) return undefined;
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

// ---------- report showing and hiding ----------

function showReport(auto: boolean) {
  reportVisible = true;
  selected = null;
  view = { kind: "match" };
  reportTab = settings.reportTabs[0] ?? "overview";
  window.clearTimeout(hideTimer);
  if (auto && settings.autoHideSecs > 0) {
    hideTimer = window.setTimeout(() => hideReport(), settings.autoHideSecs * 1000);
  }
  renderNow();
}

function hideReport() {
  reportVisible = false;
  window.clearTimeout(hideTimer);
  renderNow();
}

const toggleReport = () => (reportVisible ? hideReport() : showReport(false));

function toggleHud() {
  updateSettings({ hudVisible: !settings.hudVisible });
  renderNow();
}

/** Everything the selector can show: the match in progress (if any), then the archive. */
function reportEntries(): ReportEntry[] {
  const r = tracker.record;
  const entries: ReportEntry[] = [];
  const archived = r === finished || (!!r.guid && archive.some((a) => a.guid === r.guid));
  if (isRealMatch(r) && !archived) entries.push({ record: r, live: r.winner === null });
  for (const record of archive) entries.push({ record, live: false });
  return entries;
}

function selectedIndex(entries: ReportEntry[]) {
  const i = selected ? entries.findIndex((e) => e.record === selected) : 0;
  return Math.max(0, i);
}

/** Opens a player's RL Tracker profile in its own window (a new tab in a browser). */
/** The first candidate, carrying the full list so the page can try the next on "not found". */
const withFallbacks = (candidates: string[]) =>
  candidates.length ? `${candidates[0]}#rlo=${encodeURIComponent(JSON.stringify(candidates))}` : null;

function openTracker(name: string, primaryId: string) {
  // Older matches were saved without platform ids; any match with this player will do.
  const id = primaryId || reportEntries().map((e) => e.record.players[name]?.primaryId).find(Boolean) || "";
  const override = settings.trackerOverrides[overrideKey(name, id)] ?? settings.trackerOverrides[name];
  const url = withFallbacks(trackerCandidates(name, id, override));
  if (!url) return;
  if (inTauri) invoke("open_tracker", { url, title: `${name} · RL Tracker` });
  else window.open(url, "_blank", "noopener");
}

// ---------- match flow ----------

function handle(msg: Envelope) {
  logEvent(msg);
  // A new match, free play, or a replay replaces the current record; keep a
  // match you left early instead of losing it.
  if (msg.Event === "MatchCreated" || msg.Event === "ReplayCreated") saveLeftMatch();

  // Watching a replay plays the whole match's events again; keep them out of
  // the tracker and the session.
  if (msg.Event === "ReplayCreated") {
    replayMode = true;
    replayModeSeen = performance.now();
    replayShortcuts.clear();
    tracker.handle({ Event: "MatchCreated", Data: {} });
    if (pendingLoad) {
      // The replay we asked for opened: get the report out of the way.
      loadedReplay = pendingLoad.path;
      pendingSeek = pendingLoad.frame;
      clearPendingLoad();
      hideReport();
      window.setTimeout(seekPending, 2500);
    }
    return;
  }
  if (replayMode) {
    const inReplay = msg.Event !== "UpdateState" || msg.Data?.Game?.Frame !== undefined || msg.Data?.Game?.bReplay;
    if (msg.Event === "MatchDestroyed") {
      endReplayMode();
    } else if (msg.Event === "UpdateState" && pendingSeek !== null && msg.Data?.Game?.Frame !== undefined) {
      seekPending();
    }
    if (msg.Event === "UpdateState") {
      for (const p of msg.Data?.Players ?? []) if (p?.Name && typeof p.Shortcut === "number") replayShortcuts.set(p.Name, p.Shortcut);
      tryPov();
    }
    if (inReplay) {
      replayModeSeen = performance.now();
      return;
    }
    // Live match updates for a while: we're not in a replay after all.
    if (performance.now() - replayModeSeen < 10_000) return;
    endReplayMode();
  }
  const wasLive = boost.live;
  const changed = tracker.handle(msg);
  applyLoggedGuid();
  const { Event, Data } = msg;
  const me = tracker.record.meName;

  switch (Event) {
    case "MatchCreated":
      maybeNewSession();
      // A new match is starting; get out of the way.
      window.clearTimeout(finishTimer);
      if (reportVisible) hideReport();
      boost.reset();
      lastHit = null;
      break;

    case "CountdownBegin":
      // Everyone's meter resets to 33 at kickoff.
      boost.live = false;
      boost.rebase();
      scheduleReplaySave(500);
      break;

    case "RoundStarted":
      boost.live = true;
      break;

    case "GoalReplayStart":
      inGoalReplay = true;
      boost.live = false;
      break;

    case "GoalReplayEnd":
      inGoalReplay = false;
      break;

    case "GoalScored":
      boost.live = false;
      break;

    case "BallHit":
      if (inGoalReplay) break;
      boost.live = true; // joined mid-round
      if (me && (Data.Players ?? []).some((p: { Name: string }) => p.Name === me)) {
        lastHit = speedKmh("hit", Data.Ball?.PostHitSpeed ?? 0);
      }
      break;

    case "StatfeedEvent":
      // Respawning refills the meter to 33; that isn't boost collected.
      if (String(Data.EventName).toLowerCase() === "demolish" && Data.SecondaryTarget?.Name === me) boost.rebase();
      break;

    case "UpdateState": {
      ballSpeed = Data.Game?.Ball ? speedKmh("ball", Data.Game.Ball.Speed ?? 0) : null;
      const mine = (Data.Players ?? []).find((p: { Name: string }) => p.Name === me);
      if (typeof mine?.Boost === "number") {
        apiBoostAt = performance.now();
        boost.reading(mine.Boost);
      }
      break;
    }

    case "MatchEnded":
      boost.live = false;
      // The final goal's stats land in an UpdateState just after this event,
      // so give it a moment before booking the result.
      window.clearTimeout(finishTimer);
      finishTimer = window.setTimeout(finishMatch, 1500);
      // If no kickoff got it marked.
      scheduleReplaySave(300);
      break;

    case "PodiumStart":
      finishMatch();
      scheduleReplaySave(300);
      break;

    case "MatchDestroyed":
      // Leaving early never sends MatchEnded; without this the round would
      // count as live forever and the report would never take clicks.
      boost.live = false;
      finishMatch();
      saveLeftMatch();
      break;
  }

  if (changed) scheduleRender();
  if (boost.live !== wasLive) syncClickZones();
}

/** Books a finished match into the session and pops the report up, once per match. */
function finishMatch() {
  window.clearTimeout(finishTimer);
  const r = tracker.record;
  // Left early, free play, end-screen leftovers, or already done.
  if (r === finished || r.winner === null || !isRealMatch(r) || !wasPlayed(r)) return;
  finished = r;
  // Reconnected after this match was already booked.
  if (r.guid && archive.some((a) => a.guid === r.guid)) return;
  archive.unshift(structuredClone(r));
  archive.length = Math.min(archive.length, ARCHIVE_LIMIT);
  saveArchive(archive);

  refreshSession();
  showReport(true);
}

// ---------- boost reader ----------

/** The saved boost area in physical screen pixels, which is what the reader captures. */
function boostRegionPx() {
  const r = settings.boostRegion;
  if (!r) return null;
  const dpr = devicePixelRatio;
  return {
    x: Math.round(r.x * innerWidth * dpr),
    y: Math.round(r.y * innerHeight * dpr),
    w: Math.round(r.w * innerWidth * dpr),
    h: Math.round(r.h * innerHeight * dpr),
  };
}

/** The reader runs only when nothing of ours covers the meter. */
function syncBoostReader() {
  const paused = !settings.boostRegion || (!calibrating && (editMode || reportVisible || away));
  invoke("set_boost_paused", { paused });
}

function onBoostReading(r: { value: number | null; raw: string; learned: string }) {
  lastReading = r;
  // Spectator data from the API is exact; prefer it while it's arriving.
  if (r.value !== null) {
    recentReadings.push(r.value);
    if (recentReadings.length > 3) recentReadings.shift();
  }
  const smoothed = recentReadings.length === 3 ? [...recentReadings].sort((a, b) => a - b)[1] : r.value;
  if (r.value !== null && performance.now() - apiBoostAt > 2000) boost.reading(smoothed);
  if (calibrating) renderCalibration();
  else scheduleRender();
}

// ---------- first-run setup: the Stats API ----------

/** A Rocket League install and its Stats API rate (0 = off), from src-tauri/src/setup.rs. */
interface Install {
  launcher: string;
  path: string;
  ini: string;
  rate: number;
}
let installs: Install[] = [];
let installNote = "";
/** True while the first-run setup card is up. */
let setupActive = false;

async function refreshInstalls() {
  installs = (await invoke<Install[]>("find_rocket_league")) ?? [];
  renderInstalls();
}

/** Status and an Enable button per install, in both the setup card and settings. */
function renderInstalls() {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = !inTauri
    ? ""
    : !installs.length
      ? `<p class="muted">Rocket League not found. <button class="link" data-rescan>Look again</button></p>`
      : installs
          .map((i, n) => `<div class="install">
              <span><b>${esc(i.launcher)}</b> <span class="muted">${esc(i.path)}</span></span>
              ${i.rate > 0 ? `<span class="on">On</span>` : `<button class="primary" data-enable="${n}">Enable</button>`}
            </div>`)
          .join("") + (installNote ? `<p class="muted">${esc(installNote)}</p>` : "");
  for (const el of document.querySelectorAll<HTMLElement>(".installs")) el.innerHTML = html;
}

async function enableInstall(i: Install) {
  try {
    await invoke("enable_stats_api", { ini: i.ini });
  } catch (e) {
    if (String(e) !== "needs-admin") {
      installNote = String(e);
      renderInstalls();
      return;
    }
    // Under Program Files: Windows asks for permission, then the change is made.
    try {
      await invoke("enable_stats_api_elevated", { ini: i.ini });
    } catch (err) {
      installNote = String(err);
      renderInstalls();
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await refreshInstalls();
  installNote = installs.some((x) => x.rate > 0) && !away ? "Restart Rocket League to apply." : installNote;
  renderInstalls();
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const enable = target.closest<HTMLElement>("[data-enable]");
  if (enable) enableInstall(installs[Number(enable.dataset.enable)]);
  if (target.closest("[data-rescan]")) refreshInstalls();
});

function endSetup() {
  setupActive = false;
  updateSettings({ setupDone: true });
  setEditMode(false);
}

// ---------- saving replays automatically ----------

/** The match whose replay is marked to save, so the key is held once per match. */
let replaySavedFor: MatchRecord | null = null;
let replaySaveTimer: number | undefined;

/**
 * Holds the game's Save Replay key for you, if that's switched on. Held during
 * a match, it marks the replay to save itself when the match ends, so leaving
 * the end screen early still keeps it. It's tried at each kickoff countdown
 * (you can't drive then anyway) until it lands, and once more at full time.
 * The key only goes to Rocket League (checked on the Rust side), so it fails
 * while another window is in front.
 */
function scheduleReplaySave(delayMs: number) {
  const r = tracker.record;
  if (!settings.autoSaveReplays || !inTauri || replayMode || !isRealMatch(r)) return;
  if (replaySavedFor === r || replaySaveTimer !== undefined) return;
  replaySaveTimer = window.setTimeout(async () => {
    replaySaveTimer = undefined;
    if (tracker.record !== r || replaySavedFor === r) return;
    try {
      await invoke("press_save_replay");
      replaySavedFor = r;
    } catch (e) {
      // Mid-match, the next kickoff tries again; at full time, say so.
      if (r.winner !== null) showNotice(`Replay not saved: ${e}`);
    }
  }, delayMs);
}

// ---------- matches you leave early ----------

/** Shortest play worth keeping when you leave; quick backs-out aren't matches. */
const MIN_PLAYED_SECS = 30;

/**
 * Saves the current match if you left before full time: no result, so no win
 * or loss in the session, but its stats, boost, and replay link are kept.
 */
function saveLeftMatch() {
  const r = tracker.record;
  if (r === finished || r.winner !== null || !isRealMatch(r) || duration(r) < MIN_PLAYED_SECS) return;
  finished = r;
  r.leftEarly = true;
  r.endedAt ??= Date.now();
  if (!(r.guid && archive.some((a) => a.guid === r.guid))) {
    archive.unshift(structuredClone(r));
    archive.length = Math.min(archive.length, ARCHIVE_LIMIT);
    saveArchive(archive);
    refreshSession();
    onReplays(replays);
  }
  showReport(true);
}

// ---------- match id from the game log ----------

/**
 * The game logs each online match's GUID as it loads; the Stats API doesn't
 * reliably pass it on. It arrives around MatchCreated, in either order, so
 * it's held briefly and applied to the record once there is one.
 */
let loggedGuid: { guid: string; at: number } | null = null;
const GUID_WINDOW_MS = 120_000;

function applyLoggedGuid() {
  const r = tracker.record;
  // A match that's already over is the last one's end screen, not the one being joined.
  if (!loggedGuid || r.guid || !isRealMatch(r) || r.winner !== null) return;
  if (Date.now() - loggedGuid.at > GUID_WINDOW_MS) return;
  r.guid = loggedGuid.guid;
}

// ---------- event log, for diagnosing what the game really sends ----------

let eventLog: unknown[] = [];
let eventLogDirty = false;
const seenStateShape = new Set<string>();

function logEvent({ Event, Data }: Envelope) {
  const keys = Data && typeof Data === "object" ? Object.keys(Data) : [];
  if (Event === "UpdateState") {
    // One sample of the state's shape per match is enough.
    const shape = `${Data?.MatchGuid ?? ""}|${keys.join(",")}|${Object.keys(Data?.Game ?? {}).join(",")}`;
    if (seenStateShape.has(shape)) return;
    seenStateShape.add(shape);
    eventLog.push({ t: new Date().toISOString(), e: Event, keys, game: Object.keys(Data?.Game ?? {}), guid: Data?.MatchGuid ?? null, players: (Data?.Players ?? []).length });
  } else {
    eventLog.push({
      t: new Date().toISOString(),
      e: Event,
      keys,
      ...(Data?.WinnerTeamNum !== undefined ? { winner: Data.WinnerTeamNum } : {}),
      ...(Data?.MatchGuid !== undefined ? { guid: Data.MatchGuid } : {}),
    });
  }
  eventLog = eventLog.slice(-300);
  eventLogDirty = true;
}
window.setInterval(() => {
  if (!eventLogDirty) return;
  eventLogDirty = false;
  saveEventLog(eventLog);
}, 5000);

// ---------- your MMR ----------

/** You, as the latest match saw you: the id and name your MMR is shared under. */
function myIdentity(): { primaryId: string; name: string } | null {
  for (const r of [tracker.record, ...archive]) {
    const me = r.meName ? r.players[r.meName] : undefined;
    if (me?.primaryId) return { primaryId: me.primaryId, name: me.name };
  }
  return null;
}

/** Adds readings from the game log, skipping ones we have. Only a playlist's newest is shared. */
function onOwnMmr(...list: MmrReading[]) {
  const fresh = list.filter((r) => !readings.some((x) => x.playlist === r.playlist && x.at === r.at));
  if (!fresh.length) return;
  readings = [...readings, ...fresh].sort((a, b) => readingTime(a) - readingTime(b));
  saveReadings(readings);
  refreshSession();
  scheduleRender();
  for (const r of fresh) if (latestReading(readings, r.playlist) === r) shareReading(r);
}

/** The match's MMR change, checked against the rest of your history. */
const mmrFor = (r: MatchRecord) => matchMmr(readings, r, archive);

async function shareReading(r: MmrReading) {
  const me = myIdentity();
  if (!settings.shareMmr || !me) return;
  // The service takes UTC; the log may be on local time.
  const at = utcAt(readingTime(r, logIsLocal(readings)));
  shareError = (await sharedMmr.report(settings.shareToken, me.primaryId, me.name, { ...r, at })) ?? "";
  renderEditor();
}

/** Shares your latest MMR in each playlist, e.g. right after turning sharing on. */
function shareLatest() {
  const latest = new Map<number, MmrReading>();
  for (const r of readings) latest.set(r.playlist, r);
  latest.forEach((r) => shareReading(r));
}

// ---------- updates ----------

/** What the updater (src-tauri/src/update.rs) last reported. */
interface UpdateStatus {
  current: string;
  state: "off" | "checking" | "current" | "downloading" | "ready" | "installing" | "failed";
  next?: string;
  error?: string;
}
let update: UpdateStatus | null = null;

function updateLine(): string {
  if (!inTauri) return "Updates need the desktop app.";
  if (!update) return "";
  const v = `Version ${update.current}`;
  switch (update.state) {
    case "off": return `${v} · local build, doesn't update itself`;
    case "checking": return `${v} · checking for updates…`;
    case "current": return `${v} · up to date`;
    case "downloading": return `${v} · downloading ${update.next}…`;
    case "ready": return `${v} · ${update.next} installs when Rocket League closes`;
    case "installing": return `Installing ${update.next}…`;
    case "failed": return `${v} · update failed: ${update.error}`;
  }
}

// ---------- replays ----------

/**
 * Whether a replay is this match: by GUID when both have one, otherwise by start
 * time and players (and the score, unless you left early, since the match went
 * on without you and the replay has the final score).
 */
function replayIsMatch(info: ReplayInfo, r: MatchRecord): boolean {
  if (r.guid && info.matchGuid) return info.matchGuid.toUpperCase() === r.guid.toUpperCase();
  if (!info.startEpoch || !r.meName) return false;
  const names = new Set((info.players ?? []).map((p) => p.name));
  if (!names.has(r.meName)) return false;
  const ours = Object.keys(r.players);
  const shared = ours.filter((n) => names.has(n)).length;
  const close = Math.abs(info.startEpoch * 1000 - r.startedAt) < 15 * 60_000;
  if (r.leftEarly) return close && shared >= Math.min(3, ours.length);
  const sameScore = info.score?.[0] === r.teams[0].score && info.score?.[1] === r.teams[1].score;
  return close && sameScore && shared >= Math.min(2, ours.length);
}

/** Links saved replays to match records, then works out exact boost. */
function onReplays(list: ReplayInfo[]) {
  replays = list;
  let linked = false;
  for (const r of archive) {
    const info = replays.find((x) => replayIsMatch(x, r));
    if (!info) continue;
    if (!r.replay) {
      r.replay = { path: info.path, id: info.id, fps: info.fps, goals: info.goals };
      linked = true;
    }
    // The replay knows each player's real platform, which picks the right
    // RL Tracker profile more often than the Stats API's id does.
    for (const rp of info.players ?? []) {
      const p = r.players[rp.name];
      const id = rp.onlineId && rp.onlineId !== "0" ? `${rp.platform}|${rp.onlineId}|0` : "";
      if (p && id && p.primaryId !== id) {
        p.primaryId = id;
        linked = true;
      }
    }
  }
  for (const r of archive) {
    if (r.replay && !r.replayBoost && !boostPending.has(r.replay.id)) fetchReplayBoost(r);
  }
  if (linked) {
    saveArchive(archive);
    scheduleRender();
  }
  renderEditor();
}

async function fetchReplayBoost(r: MatchRecord) {
  const link = r.replay!;
  boostPending.add(link.id);
  try {
    const stats = await invoke<PlayerBoost[]>("replay_boost", { path: link.path, id: link.id });
    if (!stats) return;
    r.replayBoost = stats;
    refreshSession();
    saveArchive(archive);
    scheduleRender();
  } catch (e) {
    console.warn(`Couldn't read boost from replay ${link.id}:`, e);
  } finally {
    boostPending.delete(link.id);
  }
}


/** Opens the match's replay in the game, a few seconds before goal `index`. */
/** Spectator numbers of the players in the replay that's open, by name. */
const replayShortcuts = new Map<string, number>();
/** Whose view to switch to once the seek has settled. */
let pendingPov: { name: string; after: number } | null = null;

/** Switches the replay camera to the scorer's own view (ChangePOV), once we know their number. */
function tryPov() {
  if (!pendingPov || performance.now() < pendingPov.after) return;
  const shortcut = replayShortcuts.get(pendingPov.name);
  if (shortcut === undefined) return;
  feed?.send("ChangePOV", { Focus: String(shortcut), Perspective: "PlayerView" });
  const name = pendingPov.name;
  pendingPov = null;
  // Seeking can reset the camera a moment later; set it once more.
  window.setTimeout(() => {
    const again = replayShortcuts.get(name);
    if (replayMode && again !== undefined) feed?.send("ChangePOV", { Focus: String(again), Perspective: "PlayerView" });
  }, 1500);
}

/** A replay we've asked the game to open, until it confirms (ReplayCreated) or we give up. */
let pendingLoad: { path: string; frame: number; timer: number } | null = null;
/** Last time anything replay-like arrived while in replay mode. */
let replayModeSeen = 0;
/** A short message for the report's footer, e.g. when a replay didn't open. */
let notice = "";
let noticeTimer: number | undefined;
const REPLAY_OPEN_TIMEOUT_MS = 15_000;

function clearPendingLoad() {
  if (pendingLoad) window.clearTimeout(pendingLoad.timer);
  pendingLoad = null;
}

function endReplayMode() {
  replayShortcuts.clear();
  pendingPov = null;
  replayMode = false;
  loadedReplay = null;
  pendingSeek = null;
  syncClickZones();
}

function showNotice(text: string) {
  notice = text;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice = "";
    renderNow();
  }, 6000);
  renderNow();
}

/**
 * Rocket League decodes a command's JSON, then re-encodes the Data part
 * without restoring escapes before decoding it again, so a Windows path's
 * backslashes arrive as invalid escapes ("LoadRepaly missing FileName or
 * Path" in its log). Doubling them survives that; Windows reads doubled
 * separators as single ones, so this keeps working if the game is fixed.
 */
const pathForGame = (path: string) => path.replace(/\\/g, "\\\\");

function watchGoal(r: MatchRecord, index: number) {
  const link = r.replay;
  const goal = r.goals[index];
  if (!link || !goal) return;
  // Same order in both; fall back to the scorer's nth goal if the counts differ.
  let frame = link.goals.length === r.goals.length ? link.goals[index]?.frame : undefined;
  if (frame === undefined) {
    const nth = r.goals.slice(0, index).filter((g) => g.scorer === goal.scorer).length;
    frame = link.goals.filter((g) => g.player === goal.scorer)[nth]?.frame;
  }
  if (frame === undefined) return;
  const target = Math.max(0, Math.round(frame - settings.replayLeadIn * link.fps));

  // Watch it from the scorer's seat.
  pendingPov = { name: goal.scorer, after: Infinity };
  if (replayMode && loadedReplay === link.path) {
    feed?.send("SeekReplay", { Frame: target });
    pendingPov.after = performance.now() + 800;
    hideReport();
    return;
  }
  if (!feed?.send("LoadReplay", { Path: pathForGame(link.path) })) {
    showNotice("Not connected to Rocket League");
    return;
  }
  // Wait for the game to confirm before treating it as open; if it doesn't,
  // nothing changes except a short notice.
  clearPendingLoad();
  pendingLoad = {
    path: link.path,
    frame: target,
    timer: window.setTimeout(() => {
      pendingLoad = null;
      showNotice("The replay didn't open. Try from the main menu.");
    }, REPLAY_OPEN_TIMEOUT_MS),
  };
  showNotice("Opening the replay…");
}

function seekPending() {
  if (pendingSeek === null) return;
  feed?.send("SeekReplay", { Frame: pendingSeek });
  pendingSeek = null;
  if (pendingPov) pendingPov.after = performance.now() + 800;
}

/**
 * Lays RL Tracker's page over the player screen's slot (src-tauri show_tracker).
 * It's a native webview above the page, so it's hidden whenever anything of
 * ours (settings, calibration) would need to be on top of it.
 */
let lastEmbed = "";
function syncTrackerEmbed() {
  if (!inTauri) return;
  const slot = reportVisible && !away && view.kind === "player" && !editMode && !calibrating ? $("tracker-slot") : null;
  const r = slot?.getBoundingClientRect();
  const candidates: string[] = slot ? JSON.parse(slot.dataset.candidates || "[]") : [];
  const url = withFallbacks(candidates);
  const args = slot && r && url
    ? { url, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    : { url: null, x: 0, y: 0, w: 0, h: 0 };
  const key = JSON.stringify(args);
  if (key === lastEmbed) return;
  lastEmbed = key;
  invoke("show_tracker", args).catch((e) => console.warn("RL Tracker embed:", e));
}

/**
 * A round of a match is being played. Free play and training count as live
 * from the first touch and never stop, but there's no match there to protect.
 */
const inLiveRound = () => boost.live && isRealMatch(tracker.record);

/** Lets the report take clicks when the pointer is over it, but never during a live round. */
let lastZones = "";
function syncClickZones() {
  const zones: { x: number; y: number; w: number; h: number }[] = [];
  if (reportVisible && !away && !inLiveRound() && !calibrating && !replayMode) {
    const r = $("report").getBoundingClientRect();
    const dpr = devicePixelRatio;
    zones.push({ x: Math.round(r.left * dpr), y: Math.round(r.top * dpr), w: Math.round(r.width * dpr), h: Math.round(r.height * dpr) });
  }
  // Ctrl must be held to click the report, so it never swallows clicks meant
  // for the game; not while typing in it, though.
  const requireKey = !typing;
  const key = JSON.stringify([zones, requireKey]);
  if (key === lastZones) return;
  lastZones = key;
  invoke("set_click_zones", { zones, requireKey });
}

// ---------- rendering ----------

// UpdateState arrives up to 120 times a second; nothing here needs that.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  window.setTimeout(() => {
    renderQueued = false;
    renderNow();
  }, 250);
}

let lastReportHtml = "";

function renderNow() {
  const report = $("report");
  report.hidden = !reportVisible;
  if (reportVisible) {
    const entries = reportEntries();
    // Look up shared MMR for everyone on screen (cached; re-renders when it arrives).
    const shown = view.kind === "player" ? [view.primaryId] : Object.values(entries[selectedIndex(entries)]?.record.players ?? {}).map((p) => p.primaryId);
    sharedMmr.want(shown.filter(Boolean));
    const html = renderReport(
      entries,
      selectedIndex(entries),
      session,
      {
        reportHotkey: settings.reportHotkey,
        tabs: settings.reportTabs,
        tab: reportTab,
        columns: settings.reportColumns,
        clicksPaused: inLiveRound(),
        trackerOverrides: settings.trackerOverrides,
        readings,
        mmr: mmrFor,
        shared: (id) => sharedMmr.get(id),
        notice,
      },
      view,
    );
    // Live data re-renders four times a second; replacing identical markup
    // would still recreate every element and could swallow clicks and hovers.
    if (html !== lastReportHtml && !typing) {
      report.innerHTML = html;
      lastReportHtml = html;
      fitReport();
    }
  } else {
    lastReportHtml = "";
  }
  renderHudPanel();
  renderEditor();
  syncClickZones();
  syncTrackerEmbed();
  syncBoostReader();
}

function renderHudPanel() {
  const hud = $("hud");
  hud.hidden = calibrating || !(settings.hudVisible || editMode);
  if (hud.hidden) return;
  const live = tracker.record;
  const hasLive = Object.keys(live.players).length > 0;
  const record = hasLive ? live : archive[0] ?? live;
  // The session total already includes booked matches; only add one still being played.
  const booked = live === finished || (!!live.guid && archive.some((a) => a.guid === live.guid));
  const team = record.myTeam ?? 0;
  hud.innerHTML = renderHud(
    settings.hudStats,
    {
      record,
      me: record.meName ? record.players[record.meName] : undefined,
      session,
      liveBoost: hasLive && !booked ? live.boost : null,
      boostNow: boost.current,
      lastHit,
      ballSpeed,
      readings,
      lastGameMmr: lastGameMmr(),
    },
    !!settings.boostRegion || inTauri === false,
    record.teams[team]?.color ?? "#5aa9ff",
  );
  // Scaled from the top-left corner so the saved position stays put.
  hud.style.transform = `scale(${settings.hudScale / 100})`;
  placeHud();
}

/** The MMR change from your last finished match with an MMR (not private or training), when it's known. */
function lastGameMmr(): number | null {
  const rated = new Set(readings.map((x) => x.playlist));
  const last = archive.find((r) => r.myTeam !== null && r.playlistId !== undefined && rated.has(r.playlistId));
  if (!last) return null;
  const { before, after } = mmrFor(last);
  return before !== undefined && after !== undefined ? after - before : null;
}

/** Saved spot, or by default the right edge, below the game's own scoreboard. */
function placeHud() {
  const hud = $("hud");
  const pos = settings.hudPos;
  if (pos) {
    hud.style.left = `${pos.x * 100}%`;
    hud.style.top = `${pos.y * 100}%`;
    return;
  }
  hud.style.top = "30%";
  hud.style.left = `${innerWidth * 0.985 - hud.getBoundingClientRect().width}px`;
}
addEventListener("resize", () => !$("hud").hidden && placeHud());

/** Scales the panel down to fit smaller screens. */
function fitReport() {
  const report = $("report");
  report.style.transform = "translate(-50%, -50%)";
  const scale = Math.min(1, (innerWidth - 32) / report.offsetWidth, (innerHeight - 32) / report.offsetHeight);
  report.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
addEventListener("resize", () => {
  if (!reportVisible) return;
  fitReport();
  syncTrackerEmbed();
});

function renderEditor() {
  document.body.classList.toggle("edit", editMode && !calibrating);
  document.body.classList.toggle("calibrating", calibrating);
  $("setup").hidden = !editMode || calibrating || !setupActive;
  $("editor").hidden = !editMode || calibrating || setupActive;
  // Only worth a line when something's wrong.
  $("status").hidden = status === "connected";
  $("status").textContent = `Not connected to Rocket League (port ${settings.port})`;
  $("status").dataset.status = status;
  $("preview-report").textContent = reportVisible ? "Hide report" : "Show report";
  $<HTMLInputElement>("hud-visible").checked = settings.hudVisible;
  $("share-status").textContent = shareError;
  $("share-status").hidden = !shareError;
  $("update-status").textContent = updateLine();
  $("update-check").hidden = !update || update.state === "off" || update.state === "installing";
  $<HTMLButtonElement>("update-check").disabled = update?.state === "checking" || update?.state === "downloading";
  const linked = archive.filter((r) => r.replay).length;
  $("replay-status").textContent = !inTauri
    ? "Replays need the desktop app."
    : `${replays.length} saved replay${replays.length === 1 ? "" : "s"} found · ${linked} of your last ${archive.length} matches have one`;
  $("boost-status").textContent = !inTauri
    ? "The boost reader needs the desktop app."
    : !settings.boostRegion
      ? "Not set up. Mark where the boost number sits on your screen."
      : `Set up${lastReading?.learned ? ` · digits learned: ${lastReading.learned}` : ""}`;
}

// ---------- dragging (HUD in edit mode, boost box while calibrating) ----------

/** Drags `el` by its top-left corner; `resize` drags its bottom-right instead. */
function draggable(el: HTMLElement, onDone: () => void, enabled: () => boolean, handle?: HTMLElement) {
  el.addEventListener("pointerdown", (down) => {
    if (!enabled()) return;
    const resize = !!handle && (down.target as HTMLElement) === handle;
    const rect = el.getBoundingClientRect();
    const [ox, oy] = [down.clientX, down.clientY];
    el.setPointerCapture(down.pointerId);
    down.preventDefault();

    const move = (e: PointerEvent) => {
      const dx = e.clientX - ox;
      const dy = e.clientY - oy;
      if (resize) {
        el.style.width = `${Math.max(16, rect.width + dx)}px`;
        el.style.height = `${Math.max(12, rect.height + dy)}px`;
      } else {
        el.style.left = `${Math.min(Math.max(rect.left + dx, 0), innerWidth - rect.width)}px`;
        el.style.top = `${Math.min(Math.max(rect.top + dy, 0), innerHeight - rect.height)}px`;
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      onDone();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
  });
}

draggable(
  $("hud"),
  () => {
    const r = $("hud").getBoundingClientRect();
    updateSettings({ hudPos: { x: r.left / innerWidth, y: r.top / innerHeight } });
  },
  () => editMode,
);

// ---------- boost meter calibration ----------

const box = $("boost-box");

/** Default guess: the boost number on a 16:9 screen at the default HUD scale. */
const DEFAULT_BOOST_REGION = { x: 0.885, y: 0.82, w: 0.055, h: 0.07 };

function startCalibration() {
  calibrating = true;
  const r = settings.boostRegion ?? DEFAULT_BOOST_REGION;
  Object.assign(box.style, {
    left: `${r.x * innerWidth}px`,
    top: `${r.y * innerHeight}px`,
    width: `${r.w * innerWidth}px`,
    height: `${r.h * innerHeight}px`,
  });
  box.hidden = false;
  $("calib-bar").hidden = false;
  applyBoxRegion(false);
  renderNow();
  renderCalibration();
}

function boxRegion() {
  const r = box.getBoundingClientRect();
  return { x: r.left / innerWidth, y: r.top / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight };
}

/** Points the reader at the box so the readout is live while you adjust it. */
function applyBoxRegion(save: boolean) {
  const region = boxRegion();
  if (save) updateSettings({ boostRegion: region });
  const dpr = devicePixelRatio;
  invoke("set_boost_region", {
    region: {
      x: Math.round(region.x * innerWidth * dpr),
      y: Math.round(region.y * innerHeight * dpr),
      w: Math.round(region.w * innerWidth * dpr),
      h: Math.round(region.h * innerHeight * dpr),
    },
  });
}

function endCalibration(save: boolean) {
  if (save) applyBoxRegion(true);
  else invoke("set_boost_region", { region: boostRegionPx() });
  calibrating = false;
  box.hidden = true;
  $("calib-bar").hidden = true;
  renderNow();
}

function renderCalibration() {
  const r = lastReading;
  $("calib-reading").textContent = !inTauri
    ? "The boost reader needs the desktop app."
    : !r
      ? "Waiting for a reading…"
      : `${r.value ?? "–"}  ·  ${r.raw}${r.learned ? `  ·  learned ${r.learned}` : ""}`;
}

draggable(box, () => applyBoxRegion(false), () => calibrating, $("boost-box-handle"));

// ---------- hotkeys ----------

async function registerHotkey(name: string, accelerator: string): Promise<string | null> {
  try {
    await invoke("set_hotkey", { name, accelerator });
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Browser fallback: match a KeyboardEvent against "Alt+Shift+S"-style text. */
function matchesHotkey(e: KeyboardEvent, accelerator: string) {
  const parts = accelerator.toLowerCase().split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const want = (m: string) => parts.some((p) => p === m || (m === "ctrl" && p === "control"));
  if (want("ctrl") !== e.ctrlKey || want("alt") !== e.altKey || want("shift") !== e.shiftKey) return false;
  if (/^[a-z]$/.test(key)) return e.code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}`;
  return e.key.toLowerCase() === key || e.code.toLowerCase() === key;
}

async function setEditMode(on: boolean) {
  if (inTauri) {
    await invoke("set_edit_mode", { on }); // echoes back through the edit-mode event
  } else {
    editMode = on;
    renderNow();
  }
}

if (inTauri) {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<boolean>("edit-mode", (e) => {
    editMode = e.payload;
    if (!editMode && calibrating) endCalibration(true);
    renderNow();
  });
  await listen<string>("hotkey", (e) => (e.payload === "hud" ? toggleHud() : toggleReport()));
  await listen<MmrReading>("own-mmr", (e) => onOwnMmr(e.payload));
  // Readings the app found before this window was listening (it can open after the game).
  onOwnMmr(...((await invoke<MmrReading[]>("mmr_readings")) ?? []));
  await listen<UpdateStatus>("update-status", (e) => {
    update = e.payload;
    renderEditor();
  });
  update = (await invoke<UpdateStatus>("update_status")) ?? null;
  // Reopening the game starts a new session.
  await listen<number>("game-run", (e) => {
    gameRunStart = e.payload;
    maybeNewSession();
    renderNow();
  });
  gameRunStart = (await invoke<number>("get_game_run")) ?? 0;
  maybeNewSession();
  refreshSession();
  await listen<string>("match-guid", (e) => {
    loggedGuid = { guid: e.payload, at: Date.now() };
    applyLoggedGuid();
  });
  // Another app in front on this screen hides the overlay; back in the game, it returns.
  await listen<boolean>("game-focus", (e) => {
    away = !e.payload;
    document.body.classList.toggle("away", away);
    renderNow();
  });
  await listen<{ value: number | null; raw: string; learned: string }>("boost-reading", (e) => onBoostReading(e.payload));
} else {
  // Global hotkeys belong to Tauri; in a browser, catch them when focused.
  addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyO") setEditMode(!editMode);
    else if (matchesHotkey(e, settings.reportHotkey)) toggleReport();
    else if (matchesHotkey(e, settings.hudHotkey)) toggleHud();
  });
}

// ---------- settings panel ----------

function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
}

const nameInput = $<HTMLInputElement>("player-name");
const portInput = $<HTMLInputElement>("port");
const reportHotkeyInput = $<HTMLInputElement>("report-hotkey");
const hudHotkeyInput = $<HTMLInputElement>("hud-hotkey");
const autoHideInput = $<HTMLInputElement>("auto-hide");
const hotkeyError = $("hotkey-error");

nameInput.value = settings.playerName;
portInput.value = String(settings.port);
reportHotkeyInput.value = settings.reportHotkey;
hudHotkeyInput.value = settings.hudHotkey;
autoHideInput.value = String(settings.autoHideSecs);

nameInput.addEventListener("change", () => {
  updateSettings({ playerName: nameInput.value.trim() });
  tracker.playerName = settings.playerName;
  tracker.record.meName = null;
  tracker.record.myTeam = null;
  renderNow();
});

for (const [input, name, key] of [
  [reportHotkeyInput, "report", "reportHotkey"],
  [hudHotkeyInput, "hud", "hudHotkey"],
] as const) {
  input.addEventListener("change", async () => {
    const accelerator = input.value.trim();
    const error = await registerHotkey(name, accelerator);
    hotkeyError.textContent = error ?? "";
    if (error) return;
    updateSettings({ [key]: accelerator });
    renderNow();
  });
}

autoHideInput.addEventListener("change", () => {
  const secs = Number(autoHideInput.value);
  if (Number.isFinite(secs) && secs >= 0) updateSettings({ autoHideSecs: Math.round(secs) });
});

// HUD stat picker, grouped. Order follows the catalogue.
const picker = $("hud-stats");
const groups = [...new Set(HUD_STATS.map((s) => s.group))];
picker.innerHTML = groups
  .map(
    (g) => `<fieldset><legend>${g}</legend>${HUD_STATS.filter((s) => s.group === g)
      .map((s) => `<label class="check"><input type="checkbox" value="${s.id}" ${settings.hudStats.includes(s.id) ? "checked" : ""}/>${s.label}</label>`)
      .join("")}</fieldset>`,
  )
  .join("");
picker.addEventListener("change", () => {
  const chosen = [...picker.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
  updateSettings({ hudStats: HUD_STATS.map((s) => s.id).filter((id) => chosen.includes(id)), hudSeen: HUD_STATS.map((s) => s.id) });
  renderNow();
});
$<HTMLInputElement>("hud-visible").addEventListener("change", (e) => {
  updateSettings({ hudVisible: (e.target as HTMLInputElement).checked });
  renderNow();
});
const scaleInput = $<HTMLInputElement>("hud-scale");
scaleInput.value = String(settings.hudScale);
$("hud-scale-value").textContent = `${settings.hudScale}%`;
scaleInput.addEventListener("input", () => {
  updateSettings({ hudScale: Number(scaleInput.value) });
  $("hud-scale-value").textContent = `${settings.hudScale}%`;
  renderNow();
});
$("hud-reset-pos").addEventListener("click", () => {
  updateSettings({ hudPos: null });
  renderNow();
});

// Tabs.
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t === tab);
    for (const pane of document.querySelectorAll<HTMLElement>(".pane")) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  });
}

// Report sections: shown ones in their order, then the hidden ones.
function renderSectionList() {
  const shown = settings.reportTabs.filter((id) => TABS.some((s) => s.id === id));
  const order = [...shown, ...TABS.map((s) => s.id).filter((id) => !shown.includes(id))];
  $("report-sections").innerHTML = order
    .map((id, i) => {
      const def = TABS.find((s) => s.id === id)!;
      const on = shown.includes(id);
      return `<li class="${on ? "" : "off"}">
        <label class="check"><input type="checkbox" data-section="${id}" ${on ? "checked" : ""}/>${def.label}</label>
        <span class="order">
          <button data-move="${id}" data-by="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">&uarr;</button>
          <button data-move="${id}" data-by="1" ${i === order.length - 1 ? "disabled" : ""} aria-label="Move down">&darr;</button>
        </span>
      </li>`;
    })
    .join("");
}
renderSectionList();
$("report-sections").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-move]");
  if (!btn) return;
  const shown = settings.reportTabs;
  const order = [...shown, ...TABS.map((s) => s.id).filter((id) => !shown.includes(id))];
  const i = order.indexOf(btn.dataset.move!);
  const j = i + Number(btn.dataset.by);
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  updateSettings({ reportTabs: order.filter((id) => shown.includes(id)) });
  renderSectionList();
  renderNow();
});
$("report-sections").addEventListener("change", () => {
  const boxes = [...$("report-sections").querySelectorAll<HTMLInputElement>("input[data-section]")];
  updateSettings({ reportTabs: boxes.filter((b) => b.checked).map((b) => b.dataset.section!) });
  renderSectionList();
  renderNow();
});

// Player-table columns, grouped like the table.
const allColumns = [...COLUMNS, ZONES_COLUMN];
const columnGroups = [...new Set(allColumns.map((c) => c.group))];
$("report-columns").innerHTML = columnGroups
  .map((g) => `<fieldset><legend>${g}</legend>${allColumns.filter((c) => c.group === g)
    .map((c) => `<label class="check"><input type="checkbox" value="${c.id}" ${settings.reportColumns.includes(c.id) ? "checked" : ""}/>${c.label}</label>`)
    .join("")}</fieldset>`)
  .join("");
$("report-columns").addEventListener("change", () => {
  const chosen = [...$("report-columns").querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
  updateSettings({ reportColumns: allColumns.map((c) => c.id).filter((id) => chosen.includes(id)) });
  renderNow();
});

// Starts with Windows, waits in the tray, and opens and closes with the game.
// The setting lives on the Rust side, which needs it before any page exists.
const autoInput = $<HTMLInputElement>("auto-start");
autoInput.disabled = !inTauri;
invoke<boolean>("get_auto_start").then((on) => (autoInput.checked = !!on));
autoInput.addEventListener("change", async () => {
  try {
    await invoke("set_auto_start", { on: autoInput.checked });
    hotkeyError.textContent = "";
  } catch (e) {
    autoInput.checked = !autoInput.checked;
    hotkeyError.textContent = String(e);
  }
});

// Sharing your MMR with other overlay users (opt-in).
const shareInput = $<HTMLInputElement>("share-mmr");
const serverInput = $<HTMLInputElement>("server-url");
shareInput.checked = settings.shareMmr;
serverInput.value = settings.serverUrl;
serverInput.placeholder = DEFAULT_SERVER_URL;
shareInput.addEventListener("change", () => {
  updateSettings({ shareMmr: shareInput.checked });
  if (settings.shareMmr) shareLatest();
  renderEditor();
});
serverInput.addEventListener("change", () => {
  updateSettings({ serverUrl: serverInput.value.trim() });
  if (settings.shareMmr) shareLatest();
});
$("share-forget").addEventListener("click", async () => {
  const me = myIdentity();
  if (!me) return;
  shareInput.checked = false;
  updateSettings({ shareMmr: false });
  shareError = (await sharedMmr.forget(settings.shareToken, me.primaryId)) ?? "Your shared MMR was deleted.";
  renderEditor();
});

$("update-check").addEventListener("click", () => invoke("check_update"));

const unitInput = $<HTMLSelectElement>("speed-unit");
unitInput.value = settings.speedUnit;
unitInput.addEventListener("change", () => {
  updateSettings({ speedUnit: unitInput.value as SpeedUnit });
  setSpeedUnit(settings.speedUnit);
  renderNow();
});

const leadInput = $<HTMLInputElement>("replay-lead");
leadInput.value = String(settings.replayLeadIn);
leadInput.addEventListener("change", () => {
  const secs = Number(leadInput.value);
  if (Number.isFinite(secs) && secs >= 0 && secs <= 30) updateSettings({ replayLeadIn: secs });
});

const autoSaveInput = $<HTMLInputElement>("auto-save-replays");
autoSaveInput.checked = settings.autoSaveReplays;
autoSaveInput.disabled = !inTauri;
autoSaveInput.addEventListener("change", () => updateSettings({ autoSaveReplays: autoSaveInput.checked }));

const loggingInput = $<HTMLInputElement>("boost-logging");
loggingInput.checked = settings.boostLogging;
loggingInput.addEventListener("change", () => {
  updateSettings({ boostLogging: loggingInput.checked });
  invoke("set_boost_logging", { on: settings.boostLogging });
});

const startFeed = () => {
  feed?.close();
  // ?port= overrides the saved port, for pointing a browser at the mock feed.
  feed = connect(Number(params.get("port")) || settings.port, handle, (s) => {
    status = s;
    renderEditor();
  });
};

portInput.addEventListener("change", () => {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
  updateSettings({ port });
  startFeed();
});

$("reset-session").addEventListener("click", () => {
  sessionStart = Date.now();
  saveSessionStart(sessionStart);
  refreshSession();
  renderNow();
});
$("preview-report").addEventListener("click", toggleReport);
$("boost-mark").addEventListener("click", startCalibration);
$("boost-clear").addEventListener("click", () => {
  updateSettings({ boostRegion: null });
  invoke("set_boost_region", { region: null });
  renderNow();
});
$("calib-done").addEventListener("click", () => endCalibration(true));
$("calib-cancel").addEventListener("click", () => endCalibration(false));
$("calib-relearn").addEventListener("click", () => invoke("reset_boost_digits"));

// The report takes clicks while the pointer is over it (see syncClickZones).
// Acting on pointerdown, not click: a click needs press and release on the same
// element, and a live re-render in between would lose it.
$("report").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  // The overlay normally can't take keyboard focus (so the game keeps it);
  // borrow it while you type in the correction box.
  const field = target.closest<HTMLElement>("input, select");
  if (field) {
    typing = true;
    syncClickZones();
    // Focus again once the window has switched, and once more shortly after:
    // Windows applies the switch asynchronously.
    invoke("set_keyboard", { on: true })?.then(() => {
      field.focus();
      window.setTimeout(() => field.focus(), 120);
    });
    return;
  }
  // Clicking anywhere else on the report finishes typing.
  if (typing && !target.closest(".override")) endTyping();
  const clear = target.closest<HTMLElement>("[data-clear-override]");
  if (clear) {
    const { [clear.dataset.clearOverride!]: _, ...rest } = settings.trackerOverrides;
    updateSettings({ trackerOverrides: rest });
    lastEmbed = "";
    renderNow();
    return;
  }
  const tab = target.closest<HTMLElement>("[data-tab]");
  if (tab) {
    reportTab = tab.dataset.tab!;
    renderNow();
    return;
  }
  const nav = target.closest<HTMLElement>("[data-view]");
  if (nav) {
    view = { kind: nav.dataset.view === "matches" ? "matches" : "match" };
    renderNow();
    return;
  }
  const row = target.closest<HTMLElement>("[data-open]");
  if (row) {
    selected = reportEntries()[Number(row.dataset.open)]?.record ?? null;
    view = { kind: "match" };
    renderNow();
    return;
  }
  // A player's name opens their screen, with their RL Tracker page embedded.
  const player = target.closest<HTMLElement>("[data-player]");
  if (player) {
    view = { kind: "player", name: player.dataset.player!, primaryId: player.dataset.pid ?? "" };
    renderNow();
    return;
  }
  const tracker = target.closest<HTMLElement>("[data-tracker]");
  if (tracker) {
    openTracker(tracker.dataset.tracker!, tracker.dataset.pid ?? "");
    return;
  }
  const goal = target.closest<HTMLElement>("[data-goal]");
  if (goal) {
    const entries = reportEntries();
    const record = entries[selectedIndex(entries)]?.record;
    if (record) watchGoal(record, Number(goal.dataset.goal));
  }
});
$("report").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  const handle = String(data.get("handle") ?? "").trim();
  if (!handle) return;
  const platform = String(data.get("platform")) as "epic" | "steam" | "psn" | "xbl" | "switch";
  updateSettings({ trackerOverrides: { ...settings.trackerOverrides, [form.dataset.key!]: { platform, handle } } });
  endTyping();
  lastEmbed = "";
  renderNow();
});
// Typing ends on save, on Escape, on a click elsewhere in the report, or when
// you switch back to the game. Not on the box losing focus: that also happens
// briefly while Windows hands the keyboard over, and ended typing too early.
$("report").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && typing) {
    endTyping();
    (document.activeElement as HTMLElement | null)?.blur();
  }
});
addEventListener("blur", () => endTyping());
function endTyping() {
  if (!typing) return;
  typing = false;
  invoke("set_keyboard", { on: false });
  syncClickZones();
}

$("done").addEventListener("click", () => setEditMode(false));

const quit = $("quit");
quit.hidden = !inTauri;
quit.addEventListener("click", () => invoke("quit"));

hotkeyError.textContent =
  [await registerHotkey("report", settings.reportHotkey), await registerHotkey("hud", settings.hudHotkey)]
    .filter(Boolean)
    .join(" · ");
invoke("set_boost_region", { region: boostRegionPx() });
invoke("set_boost_logging", { on: settings.boostLogging });
if (inTauri) {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<ReplayInfo[]>("replays", (e) => onReplays(e.payload));
  onReplays((await invoke<ReplayInfo[]>("list_replays")) ?? []);
}
// First run: show the setup card, unless the Stats API is already on somewhere.
const setupName = $<HTMLInputElement>("setup-name");
setupName.value = settings.playerName;
setupName.addEventListener("change", () => {
  updateSettings({ playerName: setupName.value.trim() });
  nameInput.value = settings.playerName;
  tracker.playerName = settings.playerName;
});
$("setup-done").addEventListener("click", endSetup);
if (inTauri) {
  await refreshInstalls();
  if (!settings.setupDone) {
    if (installs.some((i) => i.rate > 0)) updateSettings({ setupDone: true });
    else {
      setupActive = true;
      setEditMode(true);
    }
  }
}
renderNow();
startFeed();
