// Your MMR history (read from the game's log; see src-tauri/src/mmr.rs) and
// the shared MMR service other overlay users report to (see server/).

import type { MatchRecord } from "./match";

/** One solo queue as the game logged it: playlist, MMR, and the log's time. */
export interface MmrReading {
  playlist: number;
  mmr: number;
  /** "2026-10-24 13:23:52", on the log's clock (see logIsLocal). */
  at: string;
  /** When the overlay read it (ms), if it read it as the game wrote it. */
  seen?: number;
}

/** A player as the shared service returns them. */
export interface SharedPlayer {
  name: string;
  updatedAt: number;
  playlists: Record<string, { mmr: number; at: number }>;
}

/** A reading's time, reading the log's "2026-10-24 13:23:52" as UTC or as this PC's local time. */
export function readingTime(r: MmrReading, local = false): number {
  if (!local) return Date.parse(`${r.at.replace(" ", "T")}Z`);
  const [y, mo, d, h, mi, s] = r.at.split(/[- :]/).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** How close a reading caught as it was logged must be to a clock to say which one the log uses. */
const CLOCK_SLACK = 15 * 60_000;

/**
 * Whether the log's times are this PC's local time rather than UTC. The newest
 * reading the overlay caught as the game wrote it settles it: its time is
 * right now on whichever clock the log uses. Until there's one, UTC.
 */
export function logIsLocal(readings: MmrReading[]): boolean {
  for (let i = readings.length - 1; i >= 0; i--) {
    const { seen } = readings[i];
    if (seen === undefined) continue;
    const utc = Math.abs(readingTime(readings[i]) - seen);
    const local = Math.abs(readingTime(readings[i], true) - seen);
    if (Math.min(utc, local) < CLOCK_SLACK) return local < utc;
  }
  return false;
}

/** A time as "2026-10-24 13:23:52" in UTC, the shared service's format. */
export const utcAt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Your latest reading, for one playlist or any. */
export function latestReading(readings: MmrReading[], playlist?: number): MmrReading | undefined {
  for (let i = readings.length - 1; i >= 0; i--) {
    if (playlist === undefined || readings[i].playlist === playlist) return readings[i];
  }
  return undefined;
}

/**
 * Your MMR going into a match and coming out of it. The game logs it as you
 * queue, so "before" is the queue for this match and "after" the queue for
 * your next one: the first after this match started, since you can't queue
 * while you play. Either is left out when another match in the same playlist
 * came in between (you stayed in the lobby, or a queue went unseen), because
 * the difference would then cover more than this match. `matches` is the rest
 * of your history, to check that against.
 */
export function matchMmr(readings: MmrReading[], r: MatchRecord, matches: MatchRecord[] = []): { before?: number; after?: number } {
  if (r.playlistId === undefined) return {};
  const local = logIsLocal(readings);
  const start = r.startedAt;
  let prevStart = -Infinity;
  let nextStart = Infinity;
  for (const m of matches) {
    if (m.playlistId !== r.playlistId || m.startedAt === start) continue;
    if (m.startedAt < start) prevStart = Math.max(prevStart, m.startedAt);
    else nextStart = Math.min(nextStart, m.startedAt);
  }
  const same = readings.filter((x) => x.playlist === r.playlistId);
  const at = (x: MmrReading) => readingTime(x, local);
  const before = [...same].reverse().find((x) => at(x) <= start && at(x) > prevStart);
  const after = same.find((x) => at(x) > start && at(x) < nextStart);
  return { before: before?.mmr, after: after?.mmr };
}

/** MMR at the first and latest queue since `since`, per playlist, in first-played order. */
export function mmrSince(readings: MmrReading[], since: number): { playlist: number; from: number; to: number }[] {
  const local = logIsLocal(readings);
  const by = new Map<number, { playlist: number; from: number; to: number }>();
  for (const x of readings) {
    if (readingTime(x, local) < since) continue;
    const e = by.get(x.playlist);
    if (e) e.to = x.mmr;
    else by.set(x.playlist, { playlist: x.playlist, from: x.mmr, to: x.mmr });
  }
  return [...by.values()];
}

export const signed = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}`;

/** A random secret that claims your id on the shared service. */
export function newShareToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The shared MMR service (server/ in this repo, on Cloudflare Workers). */
export const DEFAULT_SERVER_URL = "https://rl-overlay.gideon-buehler.workers.dev";

const LOOKUP_TTL = 5 * 60_000;
const MAX_LOOKUP = 10;

/** Talks to the shared MMR service, caching lookups for a few minutes. */
export class SharedMmr {
  private cache = new Map<string, { player: SharedPlayer | null; at: number }>();
  private inFlight = new Set<string>();

  constructor(
    private base: () => string,
    private onUpdate: () => void,
  ) {}

  get(id: string): SharedPlayer | null {
    return this.cache.get(id)?.player ?? null;
  }

  /** Asks for any of these ids not looked up recently; re-renders when they arrive. */
  want(ids: string[]) {
    const base = this.base();
    if (!base) return;
    const now = Date.now();
    const stale = [...new Set(ids)].filter((id) => {
      if (!id || this.inFlight.has(id)) return false;
      const hit = this.cache.get(id);
      return !hit || now - hit.at > LOOKUP_TTL;
    });
    for (let i = 0; i < stale.length; i += MAX_LOOKUP) this.fetchBatch(base, stale.slice(i, i + MAX_LOOKUP));
  }

  private async fetchBatch(base: string, ids: string[]) {
    ids.forEach((id) => this.inFlight.add(id));
    try {
      const res = await fetch(`${base}/v1/players?ids=${ids.map(encodeURIComponent).join(",")}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { players } = (await res.json()) as { players: Record<string, SharedPlayer> };
      const at = Date.now();
      for (const id of ids) this.cache.set(id, { player: players[id] ?? null, at });
      this.onUpdate();
    } catch (e) {
      console.warn("Shared MMR lookup failed:", e);
    } finally {
      ids.forEach((id) => this.inFlight.delete(id));
    }
  }

  /** Reports one of your readings. Resolves to an error message, or null. */
  async report(token: string, primaryId: string, name: string, r: MmrReading): Promise<string | null> {
    const base = this.base();
    if (!base) return "No server set";
    try {
      const res = await fetch(`${base}/v1/mmr`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ primaryId, name, playlist: r.playlist, mmr: r.mmr, at: r.at }),
      });
      if (res.ok) {
        this.cache.delete(primaryId);
        return null;
      }
      return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    } catch (e) {
      return String(e);
    }
  }

  /** Deletes everything shared for your id. */
  async forget(token: string, primaryId: string): Promise<string | null> {
    const base = this.base();
    if (!base) return null;
    try {
      const res = await fetch(`${base}/v1/me`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ primaryId }),
      });
      this.cache.delete(primaryId);
      return res.ok ? null : `HTTP ${res.status}`;
    } catch (e) {
      return String(e);
    }
  }
}
