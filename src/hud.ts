// The compact HUD: a small, draggable panel with the stats you pick in settings.
// Everything here is something the in-game scoreboard doesn't show.

import { averageBoost, boostPerMinute, type BoostStats } from "./boost";
import type { MatchRecord, PlayerLine } from "./match";
import type { Session } from "./session";
import { fmtSpeed, withUnitLabels } from "./units";
import { latestReading, signed, type MmrReading } from "./mmr";

export interface HudContext {
  record: MatchRecord;
  me: PlayerLine | undefined;
  session: Session;
  /** The match in progress's boost, until it's booked into the session. */
  liveBoost: BoostStats | null;
  /** Current boost level, if the boost reader can see it. */
  boostNow: number | null;
  /** km/h off your most recent touch. */
  lastHit: number | null;
  /** Live ball speed in km/h. */
  ballSpeed: number | null;
  /** Your MMR readings from the game log. */
  readings: MmrReading[];
  /** MMR change from your last finished match, when known. */
  lastGameMmr: number | null;
}

/** Your latest reading for the playlist you're in (or last played). */
const currentMmr = (c: HudContext) => latestReading(c.readings, c.record.playlistId) ?? latestReading(c.readings);
/** MMR change this session in the playlist you're in (or played last). */
const sessionMmr = (c: HudContext) => {
  const m = c.session.mmr.find((x) => x.playlist === c.record.playlistId) ?? c.session.mmr.at(-1);
  return m ? m.to - m.from : null;
};
const toneOf = (d: number | null): Tone => (d === null || d === 0 ? null : d > 0 ? "good" : "bad");

type Group = "Boost" | "You" | "Match" | "Session";
type Tone = "good" | "bad" | null;

export interface HudStat {
  id: string;
  label: string;
  group: Group;
  value: (c: HudContext) => string | null;
  /** Colours the value green or red when it's notably good or bad. */
  tone?: (c: HudContext) => Tone;
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const pct = (part: number, whole: number) => {
  const s = share(part, whole);
  return s === null ? null : `${Math.round(s * 100)}%`;
};
const num = (v: number | undefined | null) => (v === undefined || v === null ? null : Math.round(v).toLocaleString());
const kmh = (v: number | undefined | null) => (v ? fmtSpeed(v) : null);
const teamTouches = (c: HudContext) =>
  Object.values(c.record.players).filter((p) => p.team === c.me?.team).reduce((n, p) => n + p.touches, 0);
const myTeam = (c: HudContext) => c.record.myTeam ?? 0;

/** Session totals plus the match still in progress. */
const sessionBoost = (c: HudContext) => ({
  used: c.session.boostUsed + (c.liveBoost?.used ?? 0),
  time: c.session.boostTime + (c.liveBoost?.time ?? 0),
});

export const HUD_STATS: HudStat[] = [
  {
    id: "boostTotal", label: "Total boost used", group: "Boost",
    value: (c) => {
      const s = sessionBoost(c);
      return s.time > 0 ? num(s.used) : null;
    },
  },
  {
    id: "sessionBpm", label: "Session boost / min", group: "Boost",
    value: (c) => {
      const s = sessionBoost(c);
      return s.time > 5 ? num((s.used / s.time) * 60) : null;
    },
  },
  { id: "boostUsed", label: "Boost used (match)", group: "Boost", value: (c) => num(c.record.boost?.used) },
  { id: "bpm", label: "Boost / min", group: "Boost", value: (c) => (c.record.boost ? num(boostPerMinute(c.record.boost)) : null) },
  { id: "boostCollected", label: "Boost collected", group: "Boost", value: (c) => num(c.record.boost?.collected) },
  { id: "boostAvg", label: "Avg boost", group: "Boost", value: (c) => (c.record.boost ? num(averageBoost(c.record.boost)) : null) },
  {
    id: "boostEmpty", label: "Time at 0", group: "Boost",
    value: (c) => (c.record.boost ? pct(c.record.boost.empty, c.record.boost.time) : null),
    tone: (c) => ((share(c.record.boost?.empty ?? 0, c.record.boost?.time ?? 0) ?? 0) > 0.2 ? "bad" : null),
  },
  { id: "boostFull", label: "Time at 100", group: "Boost", value: (c) => (c.record.boost ? pct(c.record.boost.full, c.record.boost.time) : null) },

  {
    id: "touchShare", label: "Team touches", group: "You",
    value: (c) => (c.me ? pct(c.me.touches, teamTouches(c)) : null),
  },
  { id: "touches", label: "Touches", group: "You", value: (c) => num(c.me?.touches) },
  { id: "aerials", label: "Aerials", group: "You", value: (c) => num(c.me?.aerials) },
  { id: "firstTouches", label: "First to ball", group: "You", value: (c) => num(c.me?.firstTouches) },
  { id: "lastHit", label: "Last hit km/h", group: "You", value: (c) => kmh(c.lastHit), tone: (c) => ((c.lastHit ?? 0) >= 100 ? "good" : null) },
  { id: "avgHit", label: "Avg hit km/h", group: "You", value: (c) => (c.me?.hits ? kmh(c.me.hitSum / c.me.hits) : null) },
  { id: "topHit", label: "Top hit km/h", group: "You", value: (c) => kmh(c.me?.topHit) },
  { id: "hardHits", label: "100+ hits", group: "You", value: (c) => num(c.me?.hardHits) },
  {
    id: "attack", label: "Touches in attack", group: "You",
    value: (c) => (c.me ? pct(c.me.thirds[2], c.me.thirds[0] + c.me.thirds[1] + c.me.thirds[2]) : null),
  },
  { id: "bumps", label: "Bumps", group: "You", value: (c) => num(c.me?.bumps) },
  { id: "demoed", label: "Times demoed", group: "You", value: (c) => num(c.me?.demoed) },
  { id: "shotPct", label: "Shot %", group: "You", value: (c) => (c.me?.shots ? pct(c.me.goals, c.me.shots) : null) },

  {
    id: "possession", label: "Possession", group: "Match",
    value: (c) => pct(c.record.possession[myTeam(c)], c.record.possession[0] + c.record.possession[1]),
    tone: (c) => {
      const s = share(c.record.possession[myTeam(c)], c.record.possession[0] + c.record.possession[1]);
      return s === null ? null : s >= 0.55 ? "good" : s <= 0.45 ? "bad" : null;
    },
  },
  { id: "ballSpeed", label: "Ball km/h", group: "Match", value: (c) => kmh(c.ballSpeed) },
  {
    id: "kickoffs", label: "Kickoffs won", group: "Match",
    value: (c) => {
      const total = c.record.firstTouches[0] + c.record.firstTouches[1];
      return total ? `${c.record.firstTouches[myTeam(c)]}/${total}` : null;
    },
  },

  { id: "mmr", label: "MMR", group: "Session", value: (c) => { const r = currentMmr(c); return r ? Math.round(r.mmr).toLocaleString() : null; } },
  {
    id: "gameMmr", label: "Last game MMR", group: "Session",
    value: (c) => (c.lastGameMmr === null ? null : signed(c.lastGameMmr)),
    tone: (c) => toneOf(c.lastGameMmr),
  },
  {
    id: "mmrChange", label: "Session MMR", group: "Session",
    value: (c) => { const d = sessionMmr(c); return d === null ? null : signed(d); },
    tone: (c) => toneOf(sessionMmr(c)),
  },
  {
    id: "record", label: "Session", group: "Session",
    value: (c) => (c.session.games ? `${c.session.wins}-${c.session.losses}` : null),
    tone: (c) => (c.session.wins > c.session.losses ? "good" : c.session.wins < c.session.losses ? "bad" : null),
  },
  {
    id: "streak", label: "Streak", group: "Session",
    value: (c) => (c.session.streak ? `${c.session.streak > 0 ? "W" : "L"}${Math.abs(c.session.streak)}` : null),
    tone: (c) => (c.session.streak > 0 ? "good" : c.session.streak < 0 ? "bad" : null),
  },
];

export const DEFAULT_HUD_STATS = ["boostTotal", "boostUsed", "bpm", "touchShare", "lastHit", "avgHit", "possession", "mmr", "gameMmr", "mmrChange", "record"];

/** Stats added after the picker shipped; switched on once for existing setups if they're defaults. */
export const NEW_HUD_STATS = ["boostTotal", "sessionBpm", "mmr", "mmrChange"];

// ---------- arrangement ----------

/** Where each stat sits on the HUD: row and column, from 0. */
export type HudCells = Record<string, { row: number; col: number }>;

/** Ready-made layouts, or "custom" once stats have been dragged around. */
export type HudLayout = "columns" | "row" | "column" | "custom";

/** Rows and columns in use. */
export function hudSize(cells: HudCells): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const c of Object.values(cells)) {
    rows = Math.max(rows, c.row + 1);
    cols = Math.max(cols, c.col + 1);
  }
  return { rows, cols };
}

/** Starts the grid at 0, 0 and closes up rows and columns left empty. */
function compact(cells: HudCells): HudCells {
  const used = (key: "row" | "col") => [...new Set(Object.values(cells).map((c) => c[key]))].sort((a, b) => a - b);
  const rows = used("row");
  const cols = used("col");
  const out: HudCells = {};
  for (const [id, c] of Object.entries(cells)) out[id] = { row: rows.indexOf(c.row), col: cols.indexOf(c.col) };
  return out;
}

/** The stats `cols` wide, filling rows left to right. */
export function packHud(ids: string[], cols: number): HudCells {
  const out: HudCells = {};
  ids.forEach((id, i) => (out[id] = { row: Math.floor(i / cols), col: i % cols }));
  return out;
}

/** Stats in reading order: row by row, left to right. */
export const readingOrder = (cells: HudCells) =>
  Object.keys(cells).sort((a, b) => cells[a].row - cells[b].row || cells[a].col - cells[b].col);

/**
 * Saved spots for the stats shown, kept where they are. Stats without one go
 * after them: along the row if the HUD is a single row, otherwise into the
 * first free cell, filling rows left to right. Nothing saved is two columns.
 */
export function arrangeHud(ids: string[], saved: HudCells | null): HudCells {
  const kept: HudCells = {};
  const taken = new Set<string>();
  for (const id of ids) {
    const c = saved?.[id];
    if (!c || taken.has(`${c.row},${c.col}`)) continue;
    kept[id] = { row: c.row, col: c.col };
    taken.add(`${c.row},${c.col}`);
  }
  const cells = compact(kept);
  const { rows, cols } = hudSize(cells);
  const used = new Set(Object.values(cells).map((c) => `${c.row},${c.col}`));
  const width = cols || 2;
  let end = cols;
  let next = 0;
  for (const id of ids) {
    if (cells[id]) continue;
    if (rows === 1 && cols > 1) {
      cells[id] = { row: 0, col: end++ };
      continue;
    }
    while (used.has(`${Math.floor(next / width)},${next % width}`)) next++;
    cells[id] = { row: Math.floor(next / width), col: next % width };
    used.add(`${cells[id].row},${cells[id].col}`);
  }
  return cells;
}

/**
 * The HUD's arrangement. A ready-made layout packs the stats in reading order
 * (so it stays tidy as stats come and go); a custom one keeps its gaps.
 */
export function layoutHud(ids: string[], saved: HudCells | null, layout: HudLayout): HudCells {
  const placed = arrangeHud(ids, saved);
  if (layout === "custom") return placed;
  const width = layout === "row" ? Math.max(1, ids.length) : layout === "column" ? 1 : 2;
  return packHud(readingOrder(placed), width);
}

/**
 * Where a dragged stat lands. A row or column of -1, or one past the end, adds
 * one on that side. `push` says which way a stat already there makes room.
 */
export type HudDrop = { row: number; col: number; push?: "right" | "down" };

/**
 * Puts a stat where it was dropped. Whatever is in the way moves along one
 * step (right unless `push` says down), and so does each stat right behind it
 * up to the first gap, which the stat's old spot can be. Pushing past the end
 * adds a column or row.
 */
export function dropHudStat(cells: HudCells, id: string, drop: HudDrop): HudCells {
  if (!cells[id]) return cells;
  const pushed = new Set(pushedBy(cells, id, drop));
  const down = drop.push === "down";
  const out: HudCells = {};
  for (const [k, c] of Object.entries(cells)) {
    if (k === id) continue;
    out[k] = !pushed.has(k) ? { ...c } : down ? { row: c.row + 1, col: c.col } : { row: c.row, col: c.col + 1 };
  }
  out[id] = { row: drop.row, col: drop.col };
  return compact(out);
}

/** The stats a drop moves along to make room, nearest first. */
export function pushedBy(cells: HudCells, id: string, drop: HudDrop): string[] {
  const at = (row: number, col: number) => Object.keys(cells).find((k) => k !== id && cells[k].row === row && cells[k].col === col);
  const run: string[] = [];
  for (let { row, col } = drop, k = at(row, col); k; k = at(row, col)) {
    run.push(k);
    if (drop.push === "down") row++;
    else col++;
  }
  return run;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The stats, at their cells. While arranging, empty cells show and a tab moves the whole HUD. */
export function renderHud(ids: string[], cells: HudCells, c: HudContext, boostEnabled: boolean, teamColor: string, arranging = false): string {
  return withUnitLabels(renderHudStats(ids, cells, c, boostEnabled, teamColor, arranging));
}

function renderHudStats(ids: string[], cells: HudCells, c: HudContext, boostEnabled: boolean, teamColor: string, arranging: boolean): string {
  const stats = ids.map((id) => HUD_STATS.find((s) => s.id === id)).filter((s): s is HudStat => !!s && !!cells[s.id]);
  if (!stats.length) return `<p class="hud-empty">Pick stats in settings (Ctrl+Shift+O)</p>`;
  const at = (row: number, col: number) => `data-row="${row}" data-col="${col}" style="grid-row:${row + 1};grid-column:${col + 1}`;
  const tiles = stats
    .map((s) => {
      const v = s.value(c);
      const missing = v === null;
      const hint = missing && s.group === "Boost" && !boostEnabled ? "set up" : "–";
      const tone = missing ? null : s.tone?.(c) ?? null;
      const { row, col } = cells[s.id];
      const group = s.group === "Match" ? `;--group:${teamColor}` : "";
      return `<div class="hud-stat g-${s.group.toLowerCase()} ${missing ? "missing" : ""} ${tone ?? ""}" data-stat="${s.id}" ${at(row, col)}${group}">
        <b>${missing ? hint : esc(v)}</b><span>${esc(s.label)}</span></div>`;
    })
    .join("");
  if (!arranging) return tiles;
  const { rows, cols } = hudSize(cells);
  const taken = new Set(Object.values(cells).map((p) => `${p.row},${p.col}`));
  let slots = "";
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) if (!taken.has(`${row},${col}`)) slots += `<div class="hud-slot" ${at(row, col)}"></div>`;
  }
  return `<div class="hud-grip">Move HUD</div>${tiles}${slots}`;
}
