import { describe, expect, it } from "vitest";
import { freshRecord, type MatchRecord } from "./match";
import { SESSION_GAP_MS, computeSession, countsForSession, lastPlayedAt, nextSessionStart } from "./session";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 25, 12);

/** A 1v1 ranked duel you played as "Me" on blue, ending (or left) at `end`. */
function match(end: number, result: "win" | "loss" | "left", extra: Partial<MatchRecord> = {}): MatchRecord {
  const r = freshRecord("guid");
  const left = result === "left";
  // A left match has no end time, so it's dated by when it started.
  r.startedAt = left ? end : end - 6 * 60_000;
  r.endedAt = left ? null : end;
  r.playlistId = 10;
  r.meName = "Me";
  r.myTeam = 0;
  r.winner = left ? null : result === "win" ? 0 : 1;
  if (left) r.leftEarly = true;
  r.teams[0].score = result === "win" ? 3 : 1;
  r.teams[1].score = result === "win" ? 1 : 2;
  const line = (name: string, team: number) => ({
    name, team, platform: "", primaryId: "",
    points: 100, goals: 1, assists: 0, saves: 1, shots: 2,
    touches: 0, bumps: 0, demos: 0, demoed: 0, aerials: 0, firstTouches: 0,
    thirds: [0, 0, 0] as [number, number, number], hits: 0, hitSum: 0, topHit: 50, hardHits: 0,
    feats: {}, left: false,
  });
  r.players = { Me: line("Me", 0), Them: line("Them", 1) };
  return Object.assign(r, extra);
}

describe("countsForSession", () => {
  it("counts finished and left online matches", () => {
    expect(countsForSession(match(T0, "win"))).toBe(true);
    expect(countsForSession(match(T0, "loss"))).toBe(true);
    expect(countsForSession(match(T0, "left"))).toBe(true);
  });

  it("skips private, offline, training, and workshop playlists", () => {
    for (const playlistId of [6, 8, 9, 19]) expect(countsForSession(match(T0, "win", { playlistId }))).toBe(false);
  });

  it("skips free play, unfinished matches, and matches where you weren't found", () => {
    const solo = match(T0, "win");
    delete solo.players.Them;
    expect(countsForSession(solo)).toBe(false);
    expect(countsForSession(match(T0, "win", { winner: null }))).toBe(false);
    expect(countsForSession(match(T0, "win", { meName: null }))).toBe(false);
  });
});

describe("computeSession", () => {
  // Newest first, as the archive is kept.
  const archive = [
    match(T0 + 50 * 60_000, "left"),
    match(T0 + 40 * 60_000, "win"),
    match(T0 + 30 * 60_000, "win"),
    match(T0 + 20 * 60_000, "loss"),
    match(T0 + 10 * 60_000, "win", { playlistId: 6 }), // private: ignored
    match(T0 - HOUR, "win"), // before the session
  ];

  it("counts leaving as a loss and ignores matches outside the session", () => {
    const s = computeSession(archive, T0);
    expect([s.games, s.wins, s.losses]).toEqual([4, 2, 2]);
    expect(s.history.map((h) => h.left ?? false)).toEqual([true, false, false, false]);
    expect(s.goals).toBe(4);
  });

  it("tracks the current and best streaks", () => {
    const s = computeSession(archive, T0);
    expect(s.streak).toBe(-1); // the newest result is the left match
    expect(s.bestStreak).toBe(2);
    expect(computeSession(archive.slice(1), T0).streak).toBe(2);
  });

  it("prefers the replay's exact boost over the screen estimate", () => {
    const boost = { used: 500, time: 300 } as MatchRecord["boost"];
    const estimated = match(T0 + 1000, "win", { boost });
    const exact = match(T0 + 2000, "win", {
      boost,
      replayBoost: [{ name: "Me", used: 420, time: 310 } as NonNullable<MatchRecord["replayBoost"]>[number]],
    });
    const s = computeSession([exact, estimated], T0);
    expect(s.boostUsed).toBe(920);
    expect(s.boostTime).toBe(610);
  });

  it("is empty with no matches", () => {
    const s = computeSession([], T0);
    expect([s.games, s.streak, s.bestStreak]).toEqual([0, 0, 0]);
  });
});

describe("lastPlayedAt", () => {
  it("is the newest counted match, or 0", () => {
    expect(lastPlayedAt([match(T0, "win", { playlistId: 6 }), match(T0 - HOUR, "loss")])).toBe(T0 - HOUR);
    expect(lastPlayedAt([])).toBe(0);
  });
});

describe("nextSessionStart", () => {
  const start = T0;
  const played = T0 + HOUR;

  it("keeps the session while you're still playing", () => {
    expect(nextSessionStart(start, start - HOUR, played, played + 10 * 60_000)).toBeNull();
  });

  it("starts a new session when the game was reopened since", () => {
    expect(nextSessionStart(start, played + 20 * 60_000, played, played + 25 * 60_000)).toBe(played + 20 * 60_000);
  });

  it("starts a new session after a long break, even with the game left open", () => {
    const now = played + SESSION_GAP_MS;
    expect(nextSessionStart(start, start - HOUR, played, now)).toBe(now);
  });

  it("doesn't restart a session that began after your last match", () => {
    expect(nextSessionStart(played + HOUR, start, played, played + 5 * HOUR)).toBeNull();
  });

  it("does nothing before any game run or match", () => {
    expect(nextSessionStart(start, 0, 0, start + 10 * HOUR)).toBeNull();
  });
});
