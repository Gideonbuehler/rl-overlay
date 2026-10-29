import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshRecord, wasPlayed, type MatchRecord } from "./match";
import { DEFAULT_CHANGE, logIsLocal, matchMmr, mmrSince, mmrTable, usualChange, utcAt, type MmrReading } from "./mmr";
import { computeSession } from "./session";

/** "2026-10-25 17:44:46" style times, as the game logs them (UTC here). */
const at = (hhmm: string) => `2026-10-25 ${hhmm}:00`;
const ms = (hhmm: string) => Date.parse(`2026-10-25T${hhmm}:00Z`);
const reading = (hhmm: string, mmr: number, playlist = 2): MmrReading => ({ playlist, mmr, at: at(hhmm) });

function game(start: string, end: string, playlistId = 2): MatchRecord {
  const r = freshRecord();
  r.playlistId = playlistId;
  r.startedAt = ms(start);
  r.endedAt = ms(end);
  return r;
}

// Today's real queues: you queue, play, queue again.
const readings = [reading("17:44", 1463), reading("17:52", 1472), reading("18:05", 1454), reading("18:27", 1463)];

describe("matchMmr", () => {
  it("takes the queue before a match and the next queue after it", () => {
    const a = game("17:45", "17:51");
    expect(matchMmr(readings, a, [a])).toEqual({ before: 1463, after: 1472 });
  });

  it("leaves out an 'after' that also covers a later match", () => {
    // Two matches between the 17:52 and 18:05 queues (you stayed in the lobby).
    const a = game("17:53", "17:58");
    const b = game("17:59", "18:04");
    const all = [b, a];
    expect(matchMmr(readings, a, all)).toEqual({ before: 1472, after: undefined });
    // ...and the second one's "before" is stale for the same reason.
    expect(matchMmr(readings, b, all)).toEqual({ before: undefined, after: 1454 });
  });

  it("only looks at the match's own playlist", () => {
    const a = game("17:45", "17:51");
    const other = game("17:53", "17:58", 11);
    expect(matchMmr([...readings, reading("17:52", 1060, 11)], a, [other, a])).toEqual({ before: 1463, after: 1472 });
  });

  it("takes the next queue even when the match was booked after it", () => {
    // Left early, and only saved when the next match was created.
    const a = game("17:45", "17:55");
    expect(matchMmr(readings, a, [a])).toEqual({ before: 1463, after: 1472 });
  });
});

describe("the log's clock", () => {
  // Zurich is UTC+1 on 27 October 2026, so 17:44 local is 16:44 UTC.
  beforeAll(() => vi.stubEnv("TZ", "Europe/Zurich"));
  afterAll(() => vi.unstubAllEnvs());
  const utc = (hhmm: string) => Date.parse(`2026-10-27T${hhmm}:00Z`);
  const local = (hhmm: string, mmr: number, seen?: number): MmrReading => ({ playlist: 11, mmr, at: `2026-10-27 ${hhmm}:00`, seen });

  it("is local time when a reading caught as it was logged says so", () => {
    expect(logIsLocal([local("17:44", 1463, utc("16:44") + 1500)])).toBe(true);
    expect(logIsLocal([local("16:44", 1463, utc("16:44") + 1500)])).toBe(false);
    // Nothing caught live yet, or too far from either clock to tell: UTC, as before.
    expect(logIsLocal([local("17:44", 1463)])).toBe(false);
    expect(logIsLocal([local("17:44", 1463, utc("16:44")), local("19:00", 1472, utc("16:44"))])).toBe(true);
  });

  it("lines a local-time log up with your matches", () => {
    // Read as UTC, the 16:30 queue (15:30 UTC) looked like this match's, and
    // its own queue like the next one: 1400 → 1463 instead of 1463 → 1472.
    const log = [local("16:30", 1400), local("17:44", 1463), local("17:52", 1472, utc("16:52") + 800)];
    const r = freshRecord();
    r.playlistId = 11;
    r.startedAt = utc("16:45");
    r.endedAt = utc("16:51");
    expect(matchMmr(log, r, [r])).toEqual({ before: 1463, after: 1472 });
    // A session from 17:00 local leaves the 16:30 queue out.
    expect(mmrSince(log, utc("16:00"))).toEqual([{ playlist: 11, from: 1463, to: 1472 }]);
    expect(mmrSince(log, utc("15:25"))).toEqual([{ playlist: 11, from: 1400, to: 1472 }]);
  });

  it("formats times for the shared service in UTC", () => {
    expect(utcAt(utc("16:44") + 46_000)).toBe("2026-10-27 16:44:46");
  });
});

describe("session MMR", () => {
  it("runs from the first queue of the session to the latest, per playlist", () => {
    const all = [reading("16:00", 1400), ...readings, reading("18:10", 1060, 11), reading("18:40", 1071, 11)];
    expect(mmrSince(all, ms("17:00"))).toEqual([
      { playlist: 2, from: 1463, to: 1463 },
      { playlist: 11, from: 1060, to: 1071 },
    ]);
    expect(computeSession([], ms("17:50"), all).mmr[0]).toEqual({ playlist: 2, from: 1472, to: 1463 });
  });
});

describe("estimates until the next queue", () => {
  /** A finished match you played on blue: won or lost. */
  function played(start: string, end: string, won: boolean, playlistId = 2): MatchRecord {
    const r = game(start, end, playlistId);
    r.meName = "Me";
    r.myTeam = 0;
    r.players = { Me: { name: "Me", team: 0 } as MatchRecord["players"][string], Them: { name: "Them", team: 1 } as MatchRecord["players"][string] };
    r.winner = won ? 0 : 1;
    return r;
  }

  it("goes by your usual change for a win or a loss, recent ones first", () => {
    const known = [9, 11, 10, 30].map((change) => ({ playlist: 2, won: true, change }));
    expect(usualChange(known, 2, true)).toBe(11); // the median shrugs off the early-season 30
    expect(usualChange(known, 2, false)).toBe(DEFAULT_CHANGE);
    // Another playlist's wins stand in when this one has too few.
    expect(usualChange(known, 11, true)).toBe(11);
  });

  it("estimates only the newest match in a playlist, and only until its next queue", () => {
    // Queue 17:44 → win → queue 17:52 → win → queue 18:05 → win → (no queue yet).
    const log = [reading("17:44", 1463), reading("17:52", 1472), reading("18:05", 1481)];
    const a = played("17:45", "17:51", true);
    const b = played("17:53", "18:03", true);
    const c = played("18:06", "18:12", true);
    const archive = [c, b, a];
    const table = mmrTable(log, archive);
    expect(table.get(a)).toEqual({ before: 1463, after: 1472 });
    expect(table.get(b)).toEqual({ before: 1472, after: 1481 });
    expect(table.get(c)).toEqual({ before: 1481, estimate: DEFAULT_CHANGE });

    // Queue again and the real number replaces the estimate.
    const after = mmrTable([...log, reading("18:14", 1489)], archive);
    expect(after.get(c)).toEqual({ before: 1481, after: 1489 });
  });

  it("estimates a loss (or leaving) downwards, from your usual loss", () => {
    const log = [reading("17:00", 1500), reading("17:10", 1490), reading("17:20", 1480), reading("17:30", 1471), reading("17:40", 1460)];
    const losses = [played("17:01", "17:09", false), played("17:11", "17:19", false), played("17:21", "17:29", false), played("17:31", "17:39", false)];
    const left = played("17:41", "17:45", false);
    left.winner = null;
    left.leftEarly = true;
    const archive = [left, ...losses.reverse()];
    expect(mmrTable(log, archive).get(left)?.estimate).toBe(-10);
  });

  it("adds the pending estimate to the session's MMR", () => {
    const log = [reading("17:44", 1463), reading("17:52", 1472)];
    const a = played("17:45", "17:51", true);
    const b = played("17:53", "18:03", false);
    const archive = [b, a];
    const s = computeSession(archive, ms("17:30"), log, mmrTable(log, archive));
    expect(s.mmr).toEqual([{ playlist: 2, from: 1463, to: 1472, pending: -DEFAULT_CHANGE }]);
  });
});

describe("wasPlayed", () => {
  it("tells a real match from end-screen leftovers", () => {
    const leftover = freshRecord("NEXTMATCH");
    leftover.winner = 0;
    expect(wasPlayed(leftover)).toBe(false);
    const played = freshRecord();
    played.length = 300;
    expect(wasPlayed(played)).toBe(true);
  });
});
