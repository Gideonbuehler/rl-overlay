// Session, settings, and the match archive.
//
// In the desktop app they're saved as files in the app's data folder (see
// src-tauri/src/store.rs), so the dev build, the installed build, and later
// updates all share them. In a plain browser (OBS, the dev page) they fall back
// to localStorage.

import { DEFAULT_HUD_STATS } from "./hud";
import type { TrackerOverride } from "./names";
import { DEFAULT_COLUMNS, DEFAULT_TABS } from "./report";
import type { SpeedUnit } from "./units";
import { RECORD_VERSION, isRealMatch, mvpName, wasPlayed, type MatchRecord } from "./match";
import { arenaName, playlistName } from "./names";
import { mmrSince, type MmrReading } from "./mmr";

/** One finished match, as kept in the session history. */
export interface HistoryEntry {
  endedAt: number;
  /** False for a loss, including leaving early. */
  won: boolean;
  /** You left before full time; counted as a loss. */
  left?: boolean;
  /** [your team's goals, opponents' goals] */
  score: [number, number];
  playlist: string;
  arena: string;
  overtime: boolean;
  mvp: boolean;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  points: number;
}

export interface Session {
  startedAt: number;
  /** Your MMR at the first and latest queue this session, per playlist. */
  mmr: { playlist: number; from: number; to: number }[];
  games: number;
  wins: number;
  losses: number;
  /** Positive for a win streak, negative for a loss streak. */
  streak: number;
  bestStreak: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  demos: number;
  points: number;
  mvps: number;
  /** km/h */
  bestHit: number;
  bestGoal: number;
  /** Boost used across the session's finished matches, and the play time it was tracked over. */
  boostUsed: number;
  boostTime: number;
  /** Newest first, capped at HISTORY_LIMIT. */
  history: HistoryEntry[];
}

export interface Settings {
  /** Your in-game name. Empty means "use whoever the camera is on". */
  playerName: string;
  port: number;
  /** Global hotkey that shows or hides the report. */
  reportHotkey: string;
  /** Hide the post-match report after this many seconds. 0 keeps it up until the next match. */
  autoHideSecs: number;
  /** Global hotkey that shows or hides the compact HUD. */
  hudHotkey: string;
  hudVisible: boolean;
  /** Stat ids from HUD_STATS, in display order. */
  hudStats: string[];
  /** Stat ids that existed when the picker was last saved, so new defaults can be switched on once. */
  hudSeen: string[] | null;
  /** HUD size as a percentage. */
  hudScale: number;
  /** Stats in two columns, or in one row across. */
  hudLayout: "columns" | "row";
  /** Top-left corner as fractions of the screen, or null for the default spot. */
  hudPos: { x: number; y: number } | null;
  /** Where the boost meter's number is, as fractions of the screen. */
  boostRegion: { x: number; y: number; w: number; h: number } | null;
  /** Write every boost reading to boost-log.csv for checking accuracy. */
  boostLogging: boolean;
  /** Match report tab ids in display order; ones not listed are hidden. */
  reportTabs: string[];
  /** Player-table column ids. */
  reportColumns: string[];
  /** Seconds of play to show before a goal when jumping to it in a replay. */
  replayLeadIn: number;
  speedUnit: SpeedUnit;
  /** Corrected RL Tracker profiles, keyed by player id (or name when there's none). */
  trackerOverrides: Record<string, TrackerOverride>;
  /** Report your MMR to the shared service so other overlay users can see it. Off by default. */
  shareMmr: boolean;
  /** The shared MMR service's address. */
  serverUrl: string;
  /** Secret that claims your id on the shared service; generated on first use. */
  shareToken: string;
  /** Hold the game's Save Replay key after each match. Off by default. */
  autoSaveReplays: boolean;
  /** The first-run setup has been shown (or wasn't needed). */
  setupDone: boolean;
}

export const HISTORY_LIMIT = 30;

const SESSION_KEY = "rl-overlay.session";
const SETTINGS_KEY = "rl-overlay.settings";
const ARCHIVE_KEY = "rl-overlay.matches";

/** Full match records kept for the history selector. */
export const ARCHIVE_LIMIT = 100;

export const emptySession = (): Session => ({
  startedAt: Date.now(),
  mmr: [],
  games: 0,
  wins: 0,
  losses: 0,
  streak: 0,
  bestStreak: 0,
  goals: 0,
  assists: 0,
  saves: 0,
  shots: 0,
  demos: 0,
  points: 0,
  mvps: 0,
  bestHit: 0,
  bestGoal: 0,
  boostUsed: 0,
  boostTime: 0,
  history: [],
});

/** Saved data by key, as JSON text. Filled once by initStore, then kept in step with every write. */
const cache = new Map<string, string>();
let persist: (key: string, value: string) => void = () => {};

const MMR_KEY = "rl-overlay.mmr";
const KEYS = [SESSION_KEY, SETTINGS_KEY, ARCHIVE_KEY, MMR_KEY];

/** Your MMR readings, oldest first. */
export function loadReadings(): MmrReading[] {
  try {
    const list = JSON.parse(cache.get(MMR_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
export const saveReadings = (list: MmrReading[]) => write(MMR_KEY, list.slice(-500));

/** The last few hundred game events (names and field names only), for diagnosing what the game sends. */
export const saveEventLog = (list: unknown[]) => write("rl-overlay.events", list.slice(-300));

const fromLocalStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked
  }
};

/**
 * Loads saved data; call before anything reads it. The first time the desktop
 * app runs with file storage, whatever this build had in browser storage is
 * copied into the files, so existing history and settings carry over.
 */
export async function initStore(desktop: boolean) {
  if (!desktop) {
    for (const key of KEYS) {
      const raw = fromLocalStorage(key);
      if (raw) cache.set(key, raw);
    }
    persist = (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Storage unavailable; the overlay still works, it just forgets.
      }
    };
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const saved = await invoke<Record<string, string>>("store_load").catch((e) => {
    console.warn("Couldn't read saved data:", e);
    return {} as Record<string, string>;
  });
  for (const [key, raw] of Object.entries(saved)) cache.set(key, raw);
  persist = (key, value) => {
    invoke("store_save", { key, value }).catch((e) => console.warn(`Couldn't save ${key}:`, e));
  };
  for (const key of KEYS) {
    if (cache.has(key)) continue;
    const raw = fromLocalStorage(key);
    if (raw) {
      cache.set(key, raw);
      persist(key, raw);
    }
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = cache.get(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  cache.set(key, raw);
  persist(key, raw);
}

/** When the current session started. Everything else about it is worked out from your matches. */
export const loadSessionStart = () => read(SESSION_KEY, { startedAt: Date.now() }).startedAt;
export const saveSessionStart = (startedAt: number) => write(SESSION_KEY, { startedAt });

/** Private matches, offline exhibitions against bots, training, and workshop maps don't count. */
const UNCOUNTED_PLAYLISTS = new Set([6, 8, 9, 19]);

/** Whether a match counts toward your session: a real, online match with a result (or one you left). */
export function countsForSession(r: MatchRecord): boolean {
  if (!r.meName || r.myTeam === null || !isRealMatch(r)) return false;
  if (r.playlistId !== undefined && UNCOUNTED_PLAYLISTS.has(r.playlistId)) return false;
  return r.winner !== null || !!r.leftEarly;
}

const matchEnd = (r: MatchRecord) => r.endedAt ?? r.startedAt;

/** Leaving early is a loss, as Rocket League itself counts it. */
const isWin = (r: MatchRecord) => !r.leftEarly && r.winner === r.myTeam;

/**
 * The session, worked out from the matches since it started (archive is
 * newest first). Deriving it rather than keeping running totals means it
 * always agrees with your match history.
 */
export function computeSession(archive: MatchRecord[], startedAt: number, readings: MmrReading[] = []): Session {
  const s = emptySession();
  s.startedAt = startedAt;
  s.mmr = mmrSince(readings, startedAt);
  const matches = archive.filter((r) => matchEnd(r) >= startedAt && countsForSession(r));

  for (const r of matches) {
    const me = r.players[r.meName!];
    const won = isWin(r);
    const mvp = !r.leftEarly && mvpName(r) === me.name;
    s.games++;
    if (won) s.wins++;
    else s.losses++;
    s.goals += me.goals;
    s.assists += me.assists;
    s.saves += me.saves;
    s.shots += me.shots;
    s.demos += me.demos;
    s.points += me.points;
    if (mvp) s.mvps++;
    s.bestHit = Math.max(s.bestHit, me.topHit);
    for (const g of r.goals) if (g.scorer === me.name) s.bestGoal = Math.max(s.bestGoal, g.speed);
    // Exact boost from the replay when there is one, else the screen estimate.
    const exact = r.replayBoost?.find((p) => p.name === me.name);
    s.boostUsed += exact ? exact.used : r.boost?.used ?? 0;
    s.boostTime += exact ? exact.time : r.boost?.time ?? 0;
    if (s.history.length < HISTORY_LIMIT) {
      const mine = r.myTeam!;
      s.history.push({
        endedAt: matchEnd(r),
        won,
        left: r.leftEarly || undefined,
        score: [r.teams[mine].score, r.teams[1 - mine].score],
        playlist: playlistName(r.playlistId),
        arena: arenaName(r.arena),
        overtime: r.overtime,
        mvp,
        goals: me.goals,
        assists: me.assists,
        saves: me.saves,
        shots: me.shots,
        points: me.points,
      });
    }
  }

  // Current streak: the newest results that match the newest one.
  for (const r of matches) {
    const won = isWin(r);
    if (s.streak === 0) s.streak = won ? 1 : -1;
    else if (won === s.streak > 0) s.streak += won ? 1 : -1;
    else break;
  }
  // Longest run of wins, oldest to newest.
  let run = 0;
  for (const r of [...matches].reverse()) {
    run = isWin(r) ? run + 1 : 0;
    s.bestStreak = Math.max(s.bestStreak, run);
  }
  return s;
}

/** A new session starts after this long without a match, even with the game left open. */
export const SESSION_GAP_MS = 2 * 3_600_000;

/**
 * When the session should restart, or null to keep it: now, after a long break
 * since your last match; or when the game was last opened, if that's since the
 * session began.
 */
export function nextSessionStart(sessionStart: number, gameRunStart: number, lastPlayed: number, now: number): number | null {
  if (lastPlayed && sessionStart <= lastPlayed && now - lastPlayed >= SESSION_GAP_MS) return now;
  if (gameRunStart > sessionStart) return gameRunStart;
  return null;
}

/** When your last counted match ended, or 0. */
export function lastPlayedAt(archive: MatchRecord[]): number {
  return archive.filter(countsForSession).reduce((t, r) => Math.max(t, matchEnd(r)), 0);
}

export const loadSettings = () =>
  read<Settings>(SETTINGS_KEY, {
    playerName: "",
    port: 49124,
    reportHotkey: "Alt+Shift+S",
    autoHideSecs: 0,
    hudHotkey: "Alt+Shift+D",
    hudVisible: true,
    hudStats: DEFAULT_HUD_STATS,
    hudPos: null,
    hudSeen: null,
    hudScale: 100,
    hudLayout: "columns",
    boostRegion: null,
    boostLogging: false,
    reportTabs: DEFAULT_TABS,
    reportColumns: DEFAULT_COLUMNS,
    replayLeadIn: 6,
    speedUnit: "kmh",
    trackerOverrides: {},
    shareMmr: false,
    serverUrl: "",
    shareToken: "",
    autoSaveReplays: false,
    setupDone: false,
  });
export const saveSettings = (s: Settings) => write(SETTINGS_KEY, s);

/** Finished matches, newest first. */
export function loadArchive(): MatchRecord[] {
  try {
    const raw = cache.get(ARCHIVE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    // Records saved before the touch map existed lack these fields, and
    // end-screen leftovers saved as matches (before wasPlayed) had no play.
    const usable = list.filter((r) => Array.isArray(r?.hits) && Array.isArray(r?.momentum) && wasPlayed(r));
    for (const r of usable) {
      // Version 1 stored goal placement mirrored left to right.
      if ((r.version ?? 1) < 2) for (const g of r.goals) g.mouthX = -g.mouthX;
      // Version 2 multiplied km/h hit and ball speeds by 0.036 again. A top hit
      // under 12 can only be that (12 / 0.036 = 333 km/h); undo it.
      if ((r.version ?? 1) < 3) undoDoubleConversion(r);
      // Version 3 recorded the game's empty duplicate of every goal.
      if ((r.version ?? 1) < 4) r.goals = r.goals.filter((g: { scorer?: string }) => g.scorer && g.scorer !== "Unknown");
      r.version = RECORD_VERSION;
    }
    return usable;
  } catch {
    return [];
  }
}

const KMH_FIX = 1 / 0.036;

function undoDoubleConversion(r: MatchRecord) {
  const players = Object.values(r.players);
  const top = Math.max(0, ...players.map((p) => p.topHit));
  if (top > 0 && top < 12) {
    for (const p of players) {
      p.topHit *= KMH_FIX;
      p.hitSum *= KMH_FIX;
    }
  }
  if (r.ballTop > 0 && r.ballTop < 12) {
    r.ballTop *= KMH_FIX;
    r.ballSpeedSum *= KMH_FIX;
  }
}

export function saveArchive(list: MatchRecord[]) {
  write(ARCHIVE_KEY, list.slice(0, ARCHIVE_LIMIT));
}
