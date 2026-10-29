// A skill profile built from your matches. Each score says how you did against
// the other players in the same lobbies: the share of them you out-did on that
// measure, averaged over matches, so 50 is the middle of the lobbies you play.
//
// Some inputs are counted by the game (goals, shots, saves, touches, hit
// speeds) or read exactly from a saved replay (boost), and are "measured".
// Others are inferred from touch timing and ball positions, because the Stats
// API never says where cars are, or judged from a replay (whether a touch
// came off), and are "estimates".

import { duration, type MatchRecord, type PlayerLine } from "./match";
import { reliability, type MechAttempt } from "./mechanics";
import { countsForSession, matchEnd } from "./session";

export type Source = "measured" | "estimate";

export interface SkillInput {
  id: string;
  label: string;
  source: Source;
  /** What it is and, for an estimate, what it stands in for. */
  about: string;
  /** False when a lower value is better (time on empty, say). */
  higherIsBetter: boolean;
  /** A player's value in a match, or null when there's nothing to go on. */
  player?: (r: MatchRecord, p: PlayerLine, minutes: number) => number | null;
  /** A team's value in a match, compared against the other team's. */
  team?: (r: MatchRecord, team: 0 | 1) => number | null;
}

export interface SkillCategory {
  id: string;
  label: string;
  /** For the radar's axis labels. */
  short: string;
  inputs: SkillInput[];
  /** Shown when nothing in the window has data for this category. */
  empty: string;
}

const ratio = (part: number | undefined, whole: number | undefined, min = 1) =>
  whole !== undefined && part !== undefined && whole >= min ? part / whole : null;
const exactBoost = (r: MatchRecord, p: PlayerLine) => r.replayBoost?.find((b) => b.name === p.name && b.time > 0) ?? null;
const teamOf = (r: MatchRecord, team: number) => Object.values(r.players).filter((p) => p.team === team);
/** How reliably a player's attempts in a match came off (see mechanics.ts), optionally under one condition. */
const execution = (filter?: (a: MechAttempt) => boolean) => (r: MatchRecord, p: PlayerLine) => reliability(r.mechanics?.[p.name], filter);
const RELIABILITY_NOTE = "Scored by the low end of the likely range, so a few lucky touches can't outrank many that reliably come off.";

export const CATEGORIES: SkillCategory[] = [
  {
    id: "mechanics", label: "Mechanical execution", short: "Mechanics", empty: "Needs saved replays: turn on auto-save in settings.",
    inputs: [
      { id: "clean", label: "Clean execution", source: "estimate", higherIsBetter: true,
        about: `Touches that did something useful (your team kept it, a shot, save, or clear, or the ball moved well up the field), out of every attempt including whiffs. From the saved replay. ${RELIABILITY_NOTE}`,
        player: execution() },
      { id: "pressure", label: "Under pressure", source: "estimate", higherIsBetter: true,
        about: `The same, for attempts with an opponent under a second from the ball. ${RELIABILITY_NOTE}`,
        player: execution((a) => a[4] >= 0 && a[4] < 10) },
      { id: "atSpeed", label: "At speed", source: "estimate", higherIsBetter: true,
        about: `The same, for attempts at 70 km/h or more. ${RELIABILITY_NOTE}`,
        player: execution((a) => a[2] >= 70) },
      { id: "inAir", label: "In the air", source: "estimate", higherIsBetter: true,
        about: `The same, for aerial attempts, low and high. ${RELIABILITY_NOTE}`,
        player: execution((a) => a[0] === "a" || a[0] === "h") },
      { id: "angles", label: "Awkward angles", source: "estimate", higherIsBetter: true,
        about: `The same, for attempts coming in more than 45° off a straight line at the ball. ${RELIABILITY_NOTE}`,
        player: execution((a) => a[3] > 45) },
    ],
  },
  {
    id: "positioning", label: "Positioning & rotations", short: "Positioning", empty: "No team matches yet.",
    inputs: [
      { id: "balance", label: "Touch balance", source: "estimate", higherIsBetter: false,
        about: "How far your share of your team's touches is from an even split. Far over is ball-chasing, far under is out of the play.",
        player: (r, p) => {
          const team = teamOf(r, p.team);
          const touches = team.reduce((n, q) => n + q.touches, 0);
          return team.length > 1 && touches >= 10 ? Math.abs(p.touches / touches - 1 / team.length) : null;
        } },
      { id: "possession", label: "Possession", source: "estimate", higherIsBetter: true,
        about: "Share of live play your team touched the ball last.",
        team: (r, t) => ratio(r.possession[t], r.possession[0] + r.possession[1], 10) },
      { id: "recovery", label: "Winning it back", source: "estimate", higherIsBetter: false,
        about: "Your team's average time to touch the ball again after losing it.",
        team: (r, t) => ratio(r.regain?.time[t], r.regain?.count[t], 3) },
    ],
  },
  {
    id: "challenges", label: "Challenge selection", short: "Challenges", empty: "50/50s are tracked from v0.1.7 on.",
    inputs: [
      { id: "won", label: "50/50s won", source: "estimate", higherIsBetter: true,
        about: "50/50s your team came out of with the ball. A 50/50 is worked out from both teams touching within half a second.",
        player: (_r, p) => ratio(p.challengesWon, p.challenges, 2) },
      { id: "deep", label: "Lost in own third", source: "estimate", higherIsBetter: false,
        about: "Share of your 50/50s lost with the ball in your own third.",
        player: (_r, p) => ratio(p.challengesLostDefence, p.challenges, 2) },
    ],
  },
  {
    id: "boost", label: "Boost efficiency", short: "Boost", empty: "Needs saved replays: turn on auto-save in settings.",
    inputs: [
      { id: "empty", label: "Time on empty", source: "measured", higherIsBetter: false,
        about: "Share of the match spent at 0 boost, from the saved replay.",
        player: (r, p) => { const b = exactBoost(r, p); return b ? b.empty / b.time : null; } },
      { id: "supersonic", label: "Used at supersonic", source: "measured", higherIsBetter: false,
        about: "Share of boost used while already supersonic, which mostly goes to waste. From the saved replay.",
        player: (r, p) => { const b = exactBoost(r, p); return b && b.used > 0 ? b.usedSupersonic / b.used : null; } },
    ],
  },
  {
    id: "shooting", label: "Shooting accuracy", short: "Shooting", empty: "No shots yet.",
    inputs: [
      { id: "accuracy", label: "Goals per shot", source: "measured", higherIsBetter: true,
        about: "Goals divided by shots on goal, as the scoreboard counts them.",
        player: (_r, p) => ratio(p.goals, p.shots) },
    ],
  },
  {
    id: "defence", label: "Defensive consistency", short: "Defence", empty: "No matches yet.",
    inputs: [
      { id: "saves", label: "Saves / min", source: "measured", higherIsBetter: true,
        about: "Saves, as the scoreboard counts them.",
        player: (_r, p, min) => p.saves / min },
      { id: "saveRate", label: "Team save rate", source: "measured", higherIsBetter: true,
        about: "Your team's saves over the other team's shots.",
        team: (r, t) => {
          const shots = teamOf(r, 1 - t).reduce((n, p) => n + p.shots, 0);
          return shots ? Math.min(1, teamOf(r, t).reduce((n, p) => n + p.saves, 0) / shots) : null;
        } },
    ],
  },
];

/** Measured, estimated, or a bit of both. */
export const categorySource = (c: SkillCategory): Source | "mixed" =>
  c.inputs.every((i) => i.source === "measured") ? "measured" : c.inputs.every((i) => i.source === "estimate") ? "estimate" : "mixed";

/** One match's scores, 0 to 1 against the lobby, per input and category; null without data. */
export interface MatchSkills {
  endedAt: number;
  inputs: Record<string, number | null>;
  categories: Record<string, number | null>;
}

/** The share of `others` that `mine` beats, ties counting half. */
export function beats(mine: number, others: number[], higherIsBetter: boolean): number | null {
  if (!others.length) return null;
  const won = others.reduce((n, v) => n + (v === mine ? 0.5 : (mine > v) === higherIsBetter ? 1 : 0), 0);
  return won / others.length;
}

/** Shorter matches say too little to score. */
const MIN_MINUTES = 1;

/** Scores for every match that counts and was played out, newest first. */
export function matchSkills(archive: MatchRecord[]): MatchSkills[] {
  const out: MatchSkills[] = [];
  for (const r of archive) {
    if (!countsForSession(r) || r.leftEarly) continue;
    const me = r.players[r.meName!];
    const minutes = duration(r) / 60;
    if (!me || minutes < MIN_MINUTES) continue;
    // Everyone who played it out, plus you.
    const field = Object.values(r.players).filter((p) => (p.team === 0 || p.team === 1) && (!p.left || p === me));
    const inputs: Record<string, number | null> = {};
    const categories: Record<string, number | null> = {};
    for (const c of CATEGORIES) {
      const scores: number[] = [];
      for (const i of c.inputs) {
        let s: number | null = null;
        if (i.player) {
          const mine = i.player(r, me, minutes);
          const others = field.filter((p) => p !== me).map((p) => i.player!(r, p, minutes)).filter((v): v is number => v !== null);
          s = mine === null ? null : beats(mine, others, i.higherIsBetter);
        } else if (i.team) {
          const mine = i.team(r, me.team as 0 | 1);
          const theirs = i.team(r, (1 - me.team) as 0 | 1);
          s = mine === null || theirs === null ? null : beats(mine, [theirs], i.higherIsBetter);
        }
        inputs[i.id] = s;
        if (s !== null) scores.push(s);
      }
      categories[c.id] = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    }
    out.push({ endedAt: matchEnd(r), inputs, categories });
  }
  return out;
}

export interface Score {
  /** 0 to 100, or null with no data. */
  value: number | null;
  /** Matches it rests on. */
  n: number;
  /** Standard error of the value, in the same 0–100 points. */
  se: number;
}

function score(values: (number | null)[]): Score {
  const xs = values.filter((v): v is number => v !== null).map((v) => v * 100);
  if (!xs.length) return { value: null, n: 0, se: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1) : 0;
  return { value: mean, n: xs.length, se: Math.sqrt(variance / xs.length) };
}

/** Fewest matches on each side to say a score has moved. */
const MIN_TREND = 5;
/** Two-sided 95%. */
const Z = 1.96;

export interface CategoryProfile {
  category: SkillCategory;
  now: Score;
  before: Score;
  inputs: { input: SkillInput; now: Score }[];
  /** Points up or down on the window before, when that's more than chance; else 0. Null without enough to compare. */
  change: number | null;
  /** This window's per-match scores, oldest first, smoothed over a few matches. */
  trail: number[];
}

export interface SkillProfile {
  /** The window asked for, and how many matches it actually has. */
  size: number;
  matches: number;
  previous: number;
  since: number | null;
  categories: CategoryProfile[];
}

/** How many matches the trail line averages over. */
const TRAIL = 5;

/** The profile over the newest `size` matches (scores newest first), against the `size` before. */
export function skillProfile(all: MatchSkills[], size: number): SkillProfile {
  const now = all.slice(0, size);
  const before = all.slice(size, size * 2);
  return {
    size,
    matches: now.length,
    previous: before.length,
    since: now.length ? now[now.length - 1].endedAt : null,
    categories: CATEGORIES.map((c) => {
      const a = score(now.map((m) => m.categories[c.id]));
      const b = score(before.map((m) => m.categories[c.id]));
      let change: number | null = null;
      if (a.n >= MIN_TREND && b.n >= MIN_TREND) {
        const gap = a.value! - b.value!;
        change = Math.abs(gap) > Z * Math.hypot(a.se, b.se) ? gap : 0;
      }
      const series = now.map((m) => m.categories[c.id]).filter((v): v is number => v !== null).reverse();
      const trail = series.map((_, i) => {
        const w = series.slice(Math.max(0, i - TRAIL + 1), i + 1);
        return (w.reduce((x, y) => x + y, 0) / w.length) * 100;
      });
      return {
        category: c,
        now: a,
        before: b,
        inputs: c.inputs.map((i) => ({ input: i, now: score(now.map((m) => m.inputs[i.id])) })),
        change,
        trail,
      };
    }),
  };
}

export const WINDOWS = [10, 25, 50];
