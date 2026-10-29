// Spots changes in your own play across a session, from the match archive.
// It only reports what the numbers show, with how many plays they rest on,
// and only calls a change out when it's bigger than chance would explain.
//
// What it can measure is limited by the Stats API, which says who touched the
// ball and where it was, but not where cars were:
// - 50/50s are both teams touching the ball within CHALLENGE_MS; won means
//   your team touched it next (or scored).
// - Positioning is where your touches happened, by third of the field.
// - Recovery is how long your team took to win the ball back after losing it.

import type { MatchRecord } from "./match";
import { SESSION_GAP_MS, countsForSession, isWin, matchEnd } from "./session";

/** One of your counted matches, reduced to what the tracker compares. */
export interface GameLine {
  endedAt: number;
  won: boolean;
  playlistId: number | undefined;
  /** Which game of its session this was, from 1. */
  nth: number;
  /** Sessions numbered oldest first; the current one is the highest. */
  session: number;
  /** Played straight after two or more losses in a row, in the same session. */
  afterLosses: boolean;
  goals: number;
  shots: number;
  /** Null on matches saved before 50/50s were tracked. */
  challenges: number | null;
  challengesWon: number | null;
  challengesLostDefence: number | null;
  thirds: [number, number, number];
  /** Your team's seconds spent winning the ball back, and how many times; null before it was tracked. */
  regainTime: number | null;
  regainCount: number | null;
}

export interface Metric {
  id: string;
  /** Short name for tables. */
  label: string;
  /** Lower-case name for sentences. */
  noun: string;
  /** 1 when higher is better, -1 when lower is, 0 when it's just a description. */
  better: 1 | -1 | 0;
  /** A share of something (shown as a percentage), or an average in seconds. */
  kind: "rate" | "seconds";
  /** What the share is of, or what was timed, for "based on" notes. */
  unit: string;
  /** Totals over some games: [part, whole] for a rate, [seconds, times] for an average. */
  total: (games: GameLine[]) => [number, number];
  /** Fewest plays (the whole, or the times) to say anything about a group of games. */
  min: number;
}

const add = (games: GameLine[], f: (g: GameLine) => number | null) => games.reduce((n, g) => n + (f(g) ?? 0), 0);
const touches = (g: GameLine) => g.thirds[0] + g.thirds[1] + g.thirds[2];

export const METRICS: Metric[] = [
  {
    id: "challenges", label: "50/50s won", noun: "50/50 success", better: 1, kind: "rate", unit: "50/50s", min: 15,
    total: (gs) => [add(gs, (g) => g.challengesWon), add(gs, (g) => g.challenges)],
  },
  {
    id: "risky", label: "50/50s lost near your goal", noun: "share of 50/50s lost near your own goal", better: -1, kind: "rate", unit: "50/50s", min: 15,
    total: (gs) => [add(gs, (g) => g.challengesLostDefence), add(gs, (g) => g.challenges)],
  },
  {
    id: "regain", label: "Time to get the ball back", noun: "team's time to get the ball back", better: -1, kind: "seconds", unit: "regains", min: 15,
    total: (gs) => [add(gs, (g) => g.regainTime), add(gs, (g) => g.regainCount)],
  },
  {
    id: "accuracy", label: "Shots that scored", noun: "share of shots that scored", better: 1, kind: "rate", unit: "shots", min: 8,
    total: (gs) => [add(gs, (g) => g.goals), add(gs, (g) => g.shots)],
  },
  {
    id: "defence", label: "Touches in your own end", noun: "share of touches in your own end", better: 0, kind: "rate", unit: "touches", min: 30,
    total: (gs) => [add(gs, (g) => g.thirds[0]), add(gs, touches)],
  },
  {
    id: "attack", label: "Touches in their end", noun: "share of touches in their end", better: 0, kind: "rate", unit: "touches", min: 30,
    total: (gs) => [add(gs, (g) => g.thirds[2]), add(gs, touches)],
  },
];

/**
 * Games won, for comparing groups of games. It's kept out of METRICS so that
 * results alone never suggest a break.
 */
export const WINS: Metric = {
  id: "wins", label: "Games won", noun: "win rate", better: 1, kind: "rate", unit: "games", min: 5,
  total: (gs) => [gs.filter((g) => g.won).length, gs.length],
};

/** How far apart two groups must be, in standard errors, to call it a change (two-sided 95%). */
const Z = 1.96;
/** And by at least this much: 5 points for a share, 10% for an average. */
const MIN_RATE_GAP = 0.05;
const MIN_SECONDS_GAP = 0.1;

/** The window "recent" covers, and the fewest games to compare it with. */
export const RECENT_GAMES = 4;
/** Losses in a row before the next game counts as "after losses". */
export const LOSS_RUN = 2;

export interface Comparison {
  metric: Metric;
  /** The value for the group being looked at, and for what it's compared with; null without data. */
  value: number | null;
  base: number | null;
  /** Plays behind each (the whole of a rate, the times of an average). */
  n: number;
  baseN: number;
  /** Both groups have enough plays to compare. */
  enough: boolean;
  /** The gap is bigger than chance would explain. */
  significant: boolean;
  /** Significant, and in the direction that's worse for you. */
  worse: boolean;
  /** Significant, and in the direction that's better for you. */
  improved: boolean;
}

const valueOf = ([part, whole]: [number, number]) => (whole > 0 ? part / whole : null);

/** Compares one group of games with another on one metric. */
export function compare(m: Metric, games: GameLine[], base: GameLine[]): Comparison {
  const a = m.total(games);
  const b = m.total(base);
  const value = valueOf(a);
  const baseValue = valueOf(b);
  const enough = a[1] >= m.min && b[1] >= m.min && value !== null && baseValue !== null;
  let significant = false;
  if (enough) {
    const gap = value - baseValue;
    let se: number;
    if (m.kind === "rate") {
      // Two-proportion z-test.
      const p = (a[0] + b[0]) / (a[1] + b[1]);
      se = Math.sqrt(p * (1 - p) * (1 / a[1] + 1 / b[1]));
      significant = Math.abs(gap) >= MIN_RATE_GAP;
    } else {
      // Waiting times spread roughly like an exponential, whose spread equals its mean.
      se = Math.sqrt((value * value) / a[1] + (baseValue * baseValue) / b[1]);
      significant = Math.abs(gap) >= MIN_SECONDS_GAP * baseValue;
    }
    significant &&= se > 0 && Math.abs(gap) / se >= Z;
  }
  const up = value !== null && baseValue !== null && value > baseValue;
  return {
    metric: m,
    value,
    base: baseValue,
    n: a[1],
    baseN: b[1],
    enough,
    significant,
    worse: significant && m.better !== 0 && up === (m.better < 0),
    improved: significant && m.better !== 0 && up === (m.better > 0),
  };
}

/** Your counted matches, oldest first, numbered within their sessions. */
export function gameLines(archive: MatchRecord[], sessionStart: number): GameLine[] {
  const counted = archive.filter(countsForSession).sort((a, b) => matchEnd(a) - matchEnd(b));
  const lines: GameLine[] = [];
  let session = -1;
  let nth = 0;
  let lossRun = 0;
  let prev: MatchRecord | null = null;
  for (const r of counted) {
    if (!prev || sessionOf(r, sessionStart) !== sessionOf(prev, sessionStart) || startsAfterGap(prev, r, sessionStart)) {
      session++;
      nth = 0;
      lossRun = 0;
    }
    const me = r.players[r.meName!];
    const team = r.myTeam!;
    const won = isWin(r);
    lines.push({
      endedAt: matchEnd(r),
      won,
      playlistId: r.playlistId,
      nth: ++nth,
      session,
      afterLosses: lossRun >= LOSS_RUN,
      goals: me.goals,
      shots: me.shots,
      challenges: me.challenges ?? null,
      challengesWon: me.challengesWon ?? null,
      challengesLostDefence: me.challengesLostDefence ?? null,
      thirds: me.thirds,
      regainTime: r.regain?.time[team] ?? null,
      regainCount: r.regain?.count[team] ?? null,
    });
    lossRun = won ? 0 : lossRun + 1;
    prev = r;
  }
  return lines;
}

/** The session a match was saved in: the current one, the start it was saved with, or unknown. */
function sessionOf(r: MatchRecord, current: number): number | null {
  if (matchEnd(r) >= current) return current;
  return r.sessionStart ?? null;
}

/** Matches saved before sessions were recorded split where there was a long break. */
function startsAfterGap(prev: MatchRecord, r: MatchRecord, current: number): boolean {
  return sessionOf(r, current) === null && r.startedAt - matchEnd(prev) >= SESSION_GAP_MS;
}

export interface Trend {
  /** The latest games of this session. */
  recent: GameLine[];
  /** What they're compared with: the rest of this session, or your other games in the same playlists. */
  baseline: "session" | "usual";
  base: GameLine[];
  rows: Comparison[];
}

/** A single game that stood out from your usual. */
export interface Flag {
  game: GameLine;
  metric: Metric;
  /** The game's [part, whole] (or [seconds, times]) and your usual value. */
  part: number;
  whole: number;
  usual: number;
}

export interface SessionLengthRow {
  label: string;
  games: GameLine[];
  wins: number;
  /** These games' win rate against all your others. */
  winRate: Comparison;
  rows: Comparison[];
}

export interface Consistency {
  games: GameLine[];
  /** This session's games, oldest first. */
  session: GameLine[];
  /** Null until this session has RECENT_GAMES games. */
  trend: Trend | null;
  /** The worse-off rows of the trend, when there are at least two. */
  breakReasons: Comparison[];
  flags: Flag[];
  /** Games straight after LOSS_RUN or more losses in a row, against all the others. */
  afterLosses: { games: GameLine[]; winRate: Comparison; rows: Comparison[] };
  /** Games by how far into a session they were, each against the rest. */
  byLength: SessionLengthRow[];
}

const BUCKETS: { label: string; from: number; to: number }[] = [
  { label: "1–3", from: 1, to: 3 },
  { label: "4–6", from: 4, to: 6 },
  { label: "7–9", from: 7, to: 9 },
  { label: "10+", from: 10, to: Infinity },
];

/** The metrics a break suggestion and the per-game flags look at: ones with a better direction. */
const JUDGED = METRICS.filter((m) => m.better !== 0);

export function analyse(archive: MatchRecord[], sessionStart: number): Consistency {
  const games = gameLines(archive, sessionStart);
  const current = games.length ? games[games.length - 1].session : -1;
  const session = games.filter((g) => g.session === current && g.endedAt >= sessionStart);
  const others = (gs: GameLine[]) => games.filter((g) => !gs.includes(g));

  let trend: Trend | null = null;
  if (session.length >= RECENT_GAMES) {
    const recent = session.slice(-RECENT_GAMES);
    const earlier = session.slice(0, -RECENT_GAMES);
    // Your usual in the same playlists, since 1v1 and 3v3 play very differently.
    const playlists = new Set(recent.map((g) => g.playlistId));
    const sameModes = others(recent).filter((g) => playlists.has(g.playlistId));
    const usual = sameModes.length >= RECENT_GAMES ? sameModes : others(recent);
    const baseline = earlier.length >= RECENT_GAMES ? "session" : "usual";
    const base = baseline === "session" ? earlier : usual;
    trend = { recent, baseline, base, rows: METRICS.map((m) => compare(m, recent, base)) };
  }
  const worse = trend?.rows.filter((c) => c.worse) ?? [];

  const flags: Flag[] = [];
  for (const g of session) {
    const usual = others([g]);
    for (const m of JUDGED.filter((m) => m.id === "risky" || m.id === "regain")) {
      const c = compare({ ...m, min: m.id === "risky" ? 5 : m.min }, [g], usual);
      const [part, whole] = m.total([g]);
      // A risky game needs a few own-third losses, not one unlucky bounce.
      if (c.worse && (m.id !== "risky" || part >= 3)) flags.push({ game: g, metric: m, part, whole, usual: c.base! });
    }
  }

  const after = games.filter((g) => g.afterLosses);
  return {
    games,
    session,
    trend,
    breakReasons: worse.length >= 2 ? worse : [],
    flags,
    afterLosses: { games: after, winRate: compare(WINS, after, others(after)), rows: METRICS.map((m) => compare(m, after, others(after))) },
    byLength: BUCKETS.map((b) => {
      const gs = games.filter((g) => g.nth >= b.from && g.nth <= b.to);
      return {
        label: b.label,
        games: gs,
        wins: gs.filter((g) => g.won).length,
        winRate: compare(WINS, gs, others(gs)),
        rows: METRICS.map((m) => compare(m, gs, others(gs))),
      };
    }),
  };
}

// ---------- wording ----------

export const fmtValue = (m: Metric, v: number | null) =>
  v === null ? "–" : m.kind === "rate" ? `${Math.round(v * 100)}%` : `${v.toFixed(1)} s`;

/** A plain clause for a change, e.g. "your 50/50 success fell from 55% to 37%". */
export function changeClause(c: Comparison): string {
  const m = c.metric;
  const verb = c.value! > c.base! ? "rose" : "fell";
  return `your ${m.noun} ${verb} from ${fmtValue(m, c.base)} to ${fmtValue(m, c.value)}`;
}

/** Changes as one sentence: "Over the last 4 games, a, b, and c." */
export function changesSentence(rows: Comparison[], games: number): string {
  const parts = rows.map(changeClause);
  const list = parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `Over the last ${games} games, ${list}.`;
}
