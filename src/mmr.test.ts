import { describe, expect, it } from "vitest";
import { freshRecord, wasPlayed, type MatchRecord } from "./match";
import { matchMmr, mmrSince, type MmrReading } from "./mmr";
import { computeSession } from "./session";

/** "2026-10-25 17:44:46" style times, as the game logs them (UTC). */
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
