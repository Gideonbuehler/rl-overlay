// Mechanical execution: how reliably your touches come off, and under what
// conditions, from saved replays (src-tauri/src/mechanics.rs finds each touch
// and whiff and judges it clean or missed).
//
// Counting aerials or hard hits rewards volume: one flashy aerial among five
// whiffs counts the same as one clean one. This looks at every attempt, misses
// included, and splits them by what made them hard: car speed, approach angle,
// and the time before an opponent could get there. A rate resting on a few
// attempts is uncertain, so reliability is the low end of its 95% range (a
// Wilson interval): 3 clean of 3 can't outrank 18 of 22, and the odd success
// among misses reads as occasional, not as a skill.

import type { MatchRecord } from "./match";
import { countsForSession } from "./session";
import { fmtSpeed } from "./units";

/** One attempt as the Rust side sends it. */
export interface RawAttempt {
  time: number;
  kind: "ground" | "wall" | "air" | "high";
  dodge: boolean;
  /** km/h */
  speed: number;
  angle: number | null;
  timeAvailable: number | null;
  result: "clean" | "missed" | "unclear";
  whiff: boolean;
}

export interface RawPlayerMechanics {
  name: string;
  team: number;
  attempts: RawAttempt[];
}

type Kind = "g" | "w" | "a" | "h";
type Result = "c" | "m" | "w" | "u";

/**
 * One attempt, packed small for the match archive: kind (g ground, w wall,
 * a low air, h high air), dodged into it (1/0), car speed in km/h, approach
 * angle in degrees (-1 when the car was barely moving), time available in
 * tenths of a second (-1 with no opponents to go by), and the result (c clean,
 * m missed, w whiff, u unclear).
 */
export type MechAttempt = [kind: Kind, dodge: 0 | 1, speed: number, angle: number, time: number, result: Result];

const KINDS: Record<RawAttempt["kind"], Kind> = { ground: "g", wall: "w", air: "a", high: "h" };

/** Every player's attempts, packed, by name. */
export function pack(players: RawPlayerMechanics[]): Record<string, MechAttempt[]> {
  const out: Record<string, MechAttempt[]> = {};
  for (const p of players) {
    out[p.name] = p.attempts.map((a) => [
      KINDS[a.kind] ?? "g",
      a.dodge ? 1 : 0,
      Math.round(a.speed),
      a.angle === null ? -1 : Math.round(a.angle),
      a.timeAvailable === null ? -1 : Math.round(a.timeAvailable * 10),
      a.whiff ? "w" : a.result === "clean" ? "c" : a.result === "missed" ? "m" : "u",
    ]);
  }
  return out;
}

// ---------- conditions ----------

export interface Side {
  /** For a column heading. */
  label: string;
  /** For a sentence: "drop when rushed". */
  phrase: string;
  /** What it covers, for a tooltip. */
  about: () => string;
  test: (a: MechAttempt) => boolean;
}

const SLOW_KMH = 45;
const FAST_KMH = 70;

/** Each condition as two contrasting sides; attempts in between belong to neither. */
export const SPLITS: { id: string; label: string; sides: [Side, Side] }[] = [
  { id: "speed", label: "Car speed", sides: [
    { label: "Slow", phrase: "when slow", about: () => `Under ${fmtSpeed(SLOW_KMH)} km/h`, test: (a) => a[2] < SLOW_KMH },
    { label: "Fast", phrase: "at speed", about: () => `${fmtSpeed(FAST_KMH)} km/h or more (supersonic is about ${fmtSpeed(79)})`, test: (a) => a[2] >= FAST_KMH },
  ] },
  { id: "angle", label: "Approach", sides: [
    { label: "Straight", phrase: "straight on", about: () => "Within 25° of driving straight at the ball", test: (a) => a[3] >= 0 && a[3] <= 25 },
    { label: "Angled", phrase: "at an angle", about: () => "More than 45° off a straight line at the ball", test: (a) => a[3] > 45 },
  ] },
  { id: "time", label: "Time available", sides: [
    { label: "Plenty", phrase: "with time to set up", about: () => "The nearest opponent was 1.5 s or more from the ball", test: (a) => a[4] >= 15 },
    { label: "Rushed", phrase: "when rushed", about: () => "The nearest opponent was under 0.5 s from the ball", test: (a) => a[4] >= 0 && a[4] < 5 },
  ] },
];

export const MECHANICS: { id: string; label: string; test: (a: MechAttempt) => boolean }[] = [
  { id: "ground", label: "Ground touches", test: (a) => a[0] === "g" },
  { id: "wall", label: "Wall touches", test: (a) => a[0] === "w" },
  { id: "air", label: "Low aerials", test: (a) => a[0] === "a" },
  { id: "high", label: "High aerials", test: (a) => a[0] === "h" },
  { id: "dodge", label: "Dodging into it", test: (a) => a[1] === 1 },
];

// ---------- reliability ----------

export interface Rate {
  clean: number;
  /** Attempts judged clean or missed (whiffs included); unclear ones are left out. */
  judged: number;
  rate: number | null;
  /** The 95% range of the true rate. */
  low: number;
  high: number;
}

const Z = 1.96;

export function rate(attempts: MechAttempt[]): Rate {
  const judged = attempts.filter((a) => a[5] !== "u");
  const n = judged.length;
  const clean = judged.filter((a) => a[5] === "c").length;
  if (!n) return { clean: 0, judged: 0, rate: null, low: 0, high: 1 };
  const p = clean / n;
  const denom = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return { clean, judged: n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Fewest judged attempts to call anything. */
export const MIN_JUDGED = 8;

export type Verdict = "reliable" | "usually" | "hit-or-miss" | "occasional" | "few";

export const VERDICT_LABEL: Record<Verdict, string> = {
  reliable: "Reliable",
  usually: "Usually works",
  "hit-or-miss": "Hit or miss",
  occasional: "Occasional",
  few: "Too few to tell",
};

/** Reliable when even the low end of the range is high; occasional when even the high end is low. */
export function verdict(r: Rate): Verdict {
  if (r.judged < MIN_JUDGED) return "few";
  if (r.low >= 0.6) return "reliable";
  if (r.low >= 0.4) return "usually";
  if (r.high < 0.45) return "occasional";
  return "hit-or-miss";
}

/**
 * Reliability for the skill radar: the low end of the clean rate's range, so
 * it rewards doing it often and well over a few lucky touches. Null with
 * fewer than 3 judged attempts.
 */
export function reliability(attempts: MechAttempt[] | null | undefined, filter: (a: MechAttempt) => boolean = () => true): number | null {
  if (!attempts) return null;
  const r = rate(attempts.filter(filter));
  return r.judged >= 3 ? r.low : null;
}

// ---------- your profile ----------

export interface SplitResult {
  id: string;
  label: string;
  sides: [{ label: string; phrase: string; rate: Rate }, { label: string; phrase: string; rate: Rate }];
  /** First side's rate minus the second's, when both have enough attempts and the gap is more than chance. */
  gap: number | null;
}

export interface MechRow {
  id: string;
  label: string;
  all: Rate;
  verdict: Verdict;
  splits: SplitResult[];
}

export interface MechanicsProfile {
  /** Matches in the window, those with replay data, and attempts across them. */
  window: number;
  matches: number;
  attempts: number;
  overall: Rate;
  rows: MechRow[];
}

/** Two proportions differ by more than chance (95%) and by at least 15 points. */
function differs(a: Rate, b: Rate): boolean {
  if (a.judged < MIN_JUDGED || b.judged < MIN_JUDGED || a.rate === null || b.rate === null) return false;
  const p = (a.clean + b.clean) / (a.judged + b.judged);
  const se = Math.sqrt(p * (1 - p) * (1 / a.judged + 1 / b.judged));
  const gap = a.rate - b.rate;
  return Math.abs(gap) >= 0.15 && se > 0 && Math.abs(gap) / se >= Z;
}

/**
 * Your attempts over the same window as the skill radar: your newest `size`
 * online matches played out (archive is newest first), of which those with
 * replay data count.
 */
export function mechanicsProfile(archive: MatchRecord[], size: number): MechanicsProfile {
  const window = archive.filter((r) => countsForSession(r) && !r.leftEarly).slice(0, size);
  const mine = window.filter((r) => r.mechanics?.[r.meName!]).map((r) => r.mechanics![r.meName!]);
  const attempts = mine.flat();
  return {
    window: window.length,
    matches: mine.length,
    attempts: attempts.length,
    overall: rate(attempts),
    rows: MECHANICS.map((m) => {
      const own = attempts.filter(m.test);
      const all = rate(own);
      return {
        id: m.id,
        label: m.label,
        all,
        verdict: verdict(all),
        splits: SPLITS.map((s) => {
          const [a, b] = s.sides.map((side) => ({ label: side.label, phrase: side.phrase, rate: rate(own.filter(side.test)) })) as SplitResult["sides"];
          return { id: s.id, label: s.label, sides: [a, b], gap: differs(a.rate, b.rate) ? a.rate.rate! - b.rate.rate! : null };
        }),
      };
    }),
  };
}

const pctOf = (r: Rate) => `${Math.round((r.rate ?? 0) * 100)}%`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`);

/** Plain sentences: what's reliable, what only comes off now and then, and where things break down. */
export function mechanicsNotes(p: MechanicsProfile): string[] {
  const notes: string[] = [];
  const by = (v: Verdict) => p.rows.filter((r) => r.verdict === v);
  const reliable = by("reliable");
  if (reliable.length) notes.push(`Reliable: ${list(reliable.map((r) => `${lower(r.label)} (${pctOf(r.all)} of ${r.all.judged})`))}.`);
  for (const r of by("occasional")) {
    notes.push(`${r.label} come off now and then, not yet reliably: ${r.all.clean} clean of ${r.all.judged} (${pctOf(r.all)}).`);
  }
  for (const r of p.rows) {
    for (const s of r.splits) {
      if (s.gap === null) continue;
      const [good, bad] = s.gap > 0 ? s.sides : [s.sides[1], s.sides[0]];
      notes.push(`${r.label}: ${pctOf(bad.rate)} clean ${bad.phrase} (of ${bad.rate.judged}), against ${pctOf(good.rate)} ${good.phrase}.`);
    }
  }
  return notes;
}
