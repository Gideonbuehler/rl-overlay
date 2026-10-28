import { describe, expect, it } from "vitest";
import { freshRecord, type MatchRecord, type PlayerBoost, type PlayerLine } from "./match";
import { CATEGORIES, beats, categorySource, matchSkills, skillProfile, type MatchSkills } from "./skills";

function player(name: string, team: number, over: Partial<PlayerLine> = {}): PlayerLine {
  return {
    name, team, platform: "", primaryId: "", points: 0, goals: 0, assists: 0, saves: 0, shots: 0,
    touches: 10, bumps: 0, demos: 0, demoed: 0, aerials: 0, firstTouches: 0, thirds: [0, 0, 0],
    hits: 10, hitSum: 500, topHit: 0, hardHits: 0, feats: {}, left: false, ...over,
  };
}

/** A finished 2v2 of five minutes: you and Mate on blue. */
function match(end: number, me: Partial<PlayerLine> = {}, others: Partial<PlayerLine> = {}): MatchRecord {
  const r = freshRecord(`m${end}`);
  r.endedAt = end;
  r.startedAt = end - 400_000;
  r.playlistId = 11;
  r.length = 300;
  r.meName = "Me";
  r.myTeam = 0;
  r.winner = 0;
  r.players = {
    Me: player("Me", 0, me),
    Mate: player("Mate", 0, others),
    Opp1: player("Opp1", 1, others),
    Opp2: player("Opp2", 1, others),
  };
  return r;
}

describe("beats", () => {
  it("is the share of others you out-did, ties counting half", () => {
    expect(beats(5, [1, 5, 9], true)).toBeCloseTo(0.5);
    expect(beats(5, [1, 2, 3], true)).toBe(1);
    expect(beats(5, [1, 2, 3], false)).toBe(0);
    expect(beats(5, [], true)).toBeNull();
  });
});

describe("matchSkills", () => {
  it("scores you against the lobby, per player and per team", () => {
    const r = match(1, { aerials: 10, saves: 3 }, { aerials: 5, saves: 0, shots: 2 });
    r.regain = { time: [30, 60], count: [10, 10] }; // you win it back in 3 s, they take 6 s
    const [m] = matchSkills([r]);
    expect(m.inputs.aerials).toBe(1);
    expect(m.inputs.recovery).toBe(1);
    expect(m.inputs.hitSpeed).toBe(0.5); // everyone ties
    // Mechanics is the mean of its inputs that have data (hard hits all tie at 0).
    expect(m.categories.mechanics).toBeCloseTo((1 + 0.5 + 0.5 + 1) / 4);
    // Your team saved 3 of the 4 shots the other team took; they saved none of Mate's 2.
    expect(m.inputs.saveRate).toBe(1);
  });

  it("leaves out what a match has no data for, and players who left", () => {
    const r = match(1, { shots: 0 }, { shots: 3, goals: 1 });
    r.players.Opp1.left = true;
    r.players.Opp1.aerials = 99;
    const [m] = matchSkills([r]);
    expect(m.inputs.accuracy).toBeNull();
    expect(m.categories.shooting).toBeNull();
    expect(m.inputs.won).toBeNull(); // no 50/50s tracked
    expect(m.inputs.empty).toBeNull(); // no replay
    expect(m.inputs.aerials).toBe(0.5); // ties with Mate and Opp2; Opp1 left
  });

  it("reads boost from the saved replay", () => {
    const r = match(1);
    const b = (name: string, empty: number): PlayerBoost => ({
      name, team: 0, used: 1000, collected: 1000, stolen: 0, usedAirborne: 0, usedSupersonic: 100,
      bigPads: 0, smallPads: 0, time: 300, levelSum: 0, empty, full: 0,
    });
    r.replayBoost = [b("Me", 10), b("Mate", 30), b("Opp1", 30), b("Opp2", 60)];
    const [m] = matchSkills([r]);
    expect(m.inputs.empty).toBe(1);
    expect(m.inputs.supersonic).toBe(0.5);
  });

  it("skips matches you left, and ones too short to say anything", () => {
    const left = match(1);
    left.leftEarly = true;
    const short = match(2);
    short.length = 30;
    expect(matchSkills([left, short])).toEqual([]);
  });
});

describe("skillProfile", () => {
  const at = (n: number, mechanics: number | null): MatchSkills => ({ endedAt: n, inputs: {}, categories: { mechanics } });

  it("averages the window and calls a real move against the window before", () => {
    const recent = Array.from({ length: 10 }, (_, i) => at(100 - i, i % 2 ? 0.8 : 0.9));
    const older = Array.from({ length: 10 }, (_, i) => at(50 - i, i % 2 ? 0.3 : 0.4));
    const p = skillProfile([...recent, ...older], 10);
    const mech = p.categories.find((c) => c.category.id === "mechanics")!;
    expect([p.matches, p.previous, p.since]).toEqual([10, 10, 91]);
    expect(mech.now.value).toBeCloseTo(85);
    expect(mech.before.value).toBeCloseTo(35);
    expect(mech.change).toBeCloseTo(50);
    expect(mech.trail).toHaveLength(10);
  });

  it("calls noise no change, and needs five matches each side to compare", () => {
    const noisy = Array.from({ length: 20 }, (_, i) => at(100 - i, [0.2, 0.9, 0.5, 0.6][i % 4]));
    expect(skillProfile(noisy, 10).categories[0].change).toBe(0);
    expect(skillProfile(noisy.slice(0, 13), 10).categories[0].change).toBeNull();
    const none = skillProfile([at(1, null)], 10).categories[0];
    expect([none.now.value, none.now.n]).toEqual([null, 0]);
  });
});

describe("categories", () => {
  it("says which are measured, estimated, or both", () => {
    expect(Object.fromEntries(CATEGORIES.map((c) => [c.id, categorySource(c)]))).toEqual({
      mechanics: "mixed", positioning: "estimate", challenges: "estimate", boost: "measured", shooting: "measured", defence: "measured",
    });
  });
});
