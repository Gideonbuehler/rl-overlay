import { describe, expect, it } from "vitest";
import { freshRecord, type MatchRecord } from "./match";
import { mechanicsNotes, mechanicsProfile, pack, rate, reliability, verdict, type MechAttempt } from "./mechanics";

/** `clean` clean and `missed` missed attempts of one kind, in given conditions. */
function attempts(kind: MechAttempt[0], clean: number, missed: number, speed = 60, angle = 30, time = 10): MechAttempt[] {
  return [
    ...Array.from({ length: clean }, (): MechAttempt => [kind, 0, speed, angle, time, "c"]),
    ...Array.from({ length: missed }, (): MechAttempt => [kind, 0, speed, angle, time, "m"]),
  ];
}

describe("reliability", () => {
  it("doesn't let a few lucky touches outrank many reliable ones", () => {
    const flashy = attempts("h", 1, 0);
    const steady = attempts("h", 18, 4);
    expect(rate(flashy).rate).toBe(1);
    expect(reliability(flashy)).toBeNull(); // too few to score at all
    expect(reliability(attempts("h", 3, 0))!).toBeLessThan(reliability(steady)!);
  });

  it("counts whiffs as misses and leaves unclear touches out", () => {
    const r = rate([["a", 0, 50, 20, 10, "c"], ["a", 0, 50, 20, 10, "w"], ["a", 0, 50, 20, 10, "u"]]);
    expect([r.clean, r.judged]).toEqual([1, 2]);
  });

  it("calls a mechanic reliable, occasional, or too few to tell from its range", () => {
    expect(verdict(rate(attempts("g", 40, 8)))).toBe("reliable");
    expect(verdict(rate(attempts("h", 3, 17)))).toBe("occasional");
    expect(verdict(rate(attempts("a", 10, 10)))).toBe("hit-or-miss");
    expect(verdict(rate(attempts("w", 4, 1)))).toBe("few");
  });
});

describe("pack", () => {
  it("packs the analysis small, marking whiffs", () => {
    const packed = pack([{ name: "Me", team: 0, attempts: [
      { time: 1, kind: "high", dodge: true, speed: 71.4, angle: 18.6, timeAvailable: 0.43, result: "clean", whiff: false },
      { time: 2, kind: "air", dodge: false, speed: 30, angle: null, timeAvailable: null, result: "missed", whiff: true },
    ] }]);
    expect(packed.Me).toEqual([["h", 1, 71, 19, 4, "c"], ["a", 0, 30, -1, -1, "w"]]);
  });
});

describe("mechanicsProfile", () => {
  /** An online match of yours, played out, whose attempts are given. */
  function match(mine: MechAttempt[] | null) {
    const r = freshRecord();
    r.playlistId = 11;
    r.meName = "Me";
    r.myTeam = 0;
    r.winner = 0;
    r.players = { Me: { name: "Me", team: 0 }, Them: { name: "Them", team: 1 } } as unknown as MatchRecord["players"];
    if (mine) r.mechanics = { Me: mine };
    return r;
  }

  it("finds where a mechanic breaks down, and only when the gap is real", () => {
    const archive = [
      // Low aerials: reliable with time, mostly missed when rushed.
      match([...attempts("a", 18, 2, 60, 30, 20), ...attempts("a", 4, 12, 60, 30, 2)]),
      // Ground touches: much the same fast or slow.
      match([...attempts("g", 20, 5, 30), ...attempts("g", 19, 6, 75)]),
    ];
    const p = mechanicsProfile(archive, 10);
    expect([p.window, p.matches, p.attempts]).toEqual([2, 2, 86]);
    const air = p.rows.find((r) => r.id === "air")!;
    expect(air.splits.find((s) => s.id === "time")!.gap).toBeCloseTo(0.9 - 0.25);
    const ground = p.rows.find((r) => r.id === "ground")!;
    expect(ground.splits.find((s) => s.id === "speed")!.gap).toBeNull();
    expect(ground.verdict).toBe("reliable");

    const notes = mechanicsNotes(p);
    expect(notes[0]).toBe("Reliable: ground touches (78% of 50).");
    expect(notes).toContain("Low aerials: 25% clean when rushed (of 16), against 90% with time to set up.");
  });

  it("uses the radar's window, counting the matches in it that have replay data", () => {
    const p = mechanicsProfile([match(null), match(attempts("g", 9, 1)), match(attempts("g", 5, 5))], 2);
    expect([p.window, p.matches, p.overall.clean]).toEqual([2, 1, 9]);
  });
});
