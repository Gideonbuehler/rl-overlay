import { describe, expect, it } from "vitest";
import { METRICS, analyse, changesSentence, compare, gameLines, type GameLine } from "./consistency";
import { freshRecord, type MatchRecord } from "./match";

const HOUR = 3_600_000;
const metric = (id: string) => METRICS.find((m) => m.id === id)!;

interface Play {
  won?: boolean;
  /** 50/50s: [in, won, lost in your own third] */
  ch?: [number, number, number];
  /** Your team's [seconds, times] winning the ball back. */
  regain?: [number, number];
  shots?: [number, number];
  thirds?: [number, number, number];
  playlist?: number;
  sessionStart?: number;
}

/** A finished 2v2 you played, ending at `end`. */
function game(end: number, p: Play = {}): MatchRecord {
  const r = freshRecord(`g${end}`);
  r.startedAt = end - 6 * 60_000;
  r.endedAt = end;
  r.playlistId = p.playlist ?? 11;
  r.length = 300;
  r.meName = "Me";
  r.myTeam = 0;
  r.winner = p.won === false ? 1 : 0;
  r.sessionStart = p.sessionStart;
  const [ch, won, lost] = p.ch ?? [10, 5, 1];
  const [goals, shots] = p.shots ?? [1, 3];
  r.players = {
    Me: {
      ...freshPlayer("Me", 0),
      goals, shots,
      thirds: p.thirds ?? [10, 10, 10],
      challenges: ch, challengesWon: won, challengesLostDefence: lost,
    },
    Them: freshPlayer("Them", 1),
  };
  const [time, count] = p.regain ?? [60, 20];
  r.regain = { time: [time, 0], count: [count, 0] };
  return r;
}

function freshPlayer(name: string, team: number) {
  return {
    name, team, platform: "", primaryId: "", points: 0, goals: 0, assists: 0, saves: 0, shots: 0,
    touches: 0, bumps: 0, demos: 0, demoed: 0, aerials: 0, firstTouches: 0, thirds: [0, 0, 0] as [number, number, number],
    hits: 0, hitSum: 0, topHit: 0, hardHits: 0, feats: {}, left: false,
  };
}

/** Games ten minutes apart from `start`, newest first like the archive. */
const run = (start: number, plays: Play[]) => plays.map((p, i) => game(start + (i + 1) * 10 * 60_000, p)).reverse();

const line = (over: Partial<GameLine>): GameLine => ({
  endedAt: 0, won: true, playlistId: 11, nth: 1, session: 0, afterLosses: false, goals: 0, shots: 0,
  challenges: 0, challengesWon: 0, challengesLostDefence: 0, thirds: [0, 0, 0], regainTime: 0, regainCount: 0, ...over,
});

describe("compare", () => {
  it("calls a big drop on plenty of 50/50s a change, and a small sample nothing", () => {
    const m = metric("challenges");
    const c = compare(m, [line({ challenges: 60, challengesWon: 22 })], [line({ challenges: 150, challengesWon: 83 })]);
    expect([c.enough, c.significant, c.worse]).toEqual([true, true, true]);
    expect(changesSentence([c], 4)).toBe("Over the last 4 games, your 50/50 success fell from 55% to 37%.");

    const few = compare(m, [line({ challenges: 10, challengesWon: 2 })], [line({ challenges: 150, challengesWon: 83 })]);
    expect([few.enough, few.significant]).toEqual([false, false]);
  });

  it("doesn't call noise a change", () => {
    const c = compare(metric("challenges"), [line({ challenges: 40, challengesWon: 19 })], [line({ challenges: 200, challengesWon: 104 })]);
    expect([c.enough, c.significant]).toEqual([true, false]);
  });

  it("reads a longer wait for the ball as worse, and positioning as neither", () => {
    const slow = compare(metric("regain"), [line({ regainTime: 180, regainCount: 40 })], [line({ regainTime: 300, regainCount: 120 })]);
    expect([slow.value, slow.base, slow.worse]).toEqual([4.5, 2.5, true]);
    const deeper = compare(metric("defence"), [line({ thirds: [60, 20, 20] })], [line({ thirds: [100, 150, 150] })]);
    expect([deeper.significant, deeper.worse, deeper.improved]).toEqual([true, false, false]);
  });
});

describe("gameLines", () => {
  it("numbers games within sessions, splitting old matches at long breaks", () => {
    const old = run(0, [{}, {}]); // saved before sessions were recorded
    const later = run(5 * HOUR, [{}, {}, {}]);
    const lines = gameLines([...later, ...old], 5 * HOUR);
    expect(lines.map((g) => [g.session, g.nth])).toEqual([[0, 1], [0, 2], [1, 1], [1, 2], [1, 3]]);
  });

  it("keeps saved sessions apart even without a break, and marks games after two losses in a row", () => {
    const a = run(0, [{ sessionStart: 1 }, { sessionStart: 1, won: false }]);
    const b = run(HOUR / 2, [{ sessionStart: 2, won: false }, { sessionStart: 2, won: false }, { sessionStart: 2 }, { sessionStart: 2 }]);
    const lines = gameLines([...b, ...a], 10 * HOUR);
    expect(lines.map((g) => g.session)).toEqual([0, 0, 1, 1, 1, 1]);
    // The loss that ended session one doesn't carry into session two.
    expect(lines.map((g) => g.afterLosses)).toEqual([false, false, false, false, true, false]);
  });
});

describe("analyse", () => {
  const usual: Play = { ch: [12, 7, 1], regain: [50, 20] };
  const worse: Play = { ch: [12, 3, 3], regain: [100, 20], won: false };

  it("suggests a break when two of your own numbers fall over the last four games", () => {
    const history = run(0, Array(20).fill(usual));
    const now = 10 * HOUR;
    const session = run(now, [usual, usual, worse, worse, worse, worse]);
    const c = analyse([...session, ...history], now);
    expect(c.session).toHaveLength(6);
    expect(c.trend?.baseline).toBe("usual");
    expect(c.breakReasons.map((r) => r.metric.id).sort()).toEqual(["challenges", "regain", "risky"]);
  });

  it("compares with earlier in the session once there's enough of it", () => {
    const now = 10 * HOUR;
    const session = run(now, [...Array(5).fill(usual), usual, usual, usual, usual]);
    const c = analyse(session, now);
    expect(c.trend?.baseline).toBe("session");
    expect(c.breakReasons).toEqual([]);
  });

  it("waits for four games, and never suggests a break on results alone", () => {
    const now = 10 * HOUR;
    expect(analyse(run(now, [usual, usual, usual]), now).trend).toBeNull();
    const losing = run(now, Array(8).fill({ ...usual, won: false }));
    expect(analyse(losing, now).breakReasons).toEqual([]);
  });

  it("flags a game with unusually many 50/50s lost in your own third", () => {
    const now = 10 * HOUR;
    const c = analyse([...run(now, [usual, { ch: [10, 3, 5] }]), ...run(0, Array(10).fill(usual))], now);
    expect(c.flags.map((f) => [f.game.nth, f.metric.id, f.part, f.whole])).toEqual([[2, "risky", 5, 10]]);
  });

  it("groups games by how far into a session they came", () => {
    const now = 10 * HOUR;
    const c = analyse(run(now, Array(11).fill(usual)), now);
    expect(c.byLength.map((b) => b.games.length)).toEqual([3, 3, 3, 2]);
  });
});
