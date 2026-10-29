import { describe, expect, it } from "vitest";
import type { Envelope } from "./feed";
import { MatchTracker, isRealMatch, mvpName } from "./match";

const GUID = "C9DFD30411F1D092EC9DDE98EFC67F54";
const ev = (Event: string, Data: Record<string, unknown> = {}, guid = GUID) =>
  ({ Event, Data: { MatchGuid: guid, ...Data } }) as Envelope;

const DUEL = [
  { Name: "Me", TeamNum: 0, Score: 300 },
  { Name: "Them", TeamNum: 1, Score: 120 },
];

function state(players = DUEL, guid = GUID) {
  return ev(
    "UpdateState",
    {
      Players: players,
      Game: {
        TimeSeconds: 300,
        bOvertime: false,
        PlaylistId: 10,
        Teams: [{ Name: "Blue", Score: 0 }, { Name: "Orange", Score: 0 }],
        bHasTarget: true,
        Target: { Name: "Me" },
      },
    },
    guid,
  );
}

const goal = (name: string, team: number, speed = 100) => ev("GoalScored", { Scorer: { Name: name, TeamNum: team }, GoalSpeed: speed });

/** A duel that has just kicked off. */
function kickedOff() {
  const t = new MatchTracker();
  t.handle(ev("MatchCreated"));
  t.handle(state());
  t.handle(ev("CountdownBegin"));
  t.handle(ev("RoundStarted"));
  return t;
}

describe("MatchTracker", () => {
  it("finds you from the camera target and reads the playlist", () => {
    const r = kickedOff().record;
    expect([r.meName, r.myTeam, r.playlistId, r.length]).toEqual(["Me", 0, 10, 300]);
    expect(isRealMatch(r)).toBe(true);
  });

  it("books one goal per kickoff, ignoring the game's empty duplicate and the replay", () => {
    const t = kickedOff();
    t.handle(goal("Me", 0));
    t.handle(goal("", 0, 0));
    t.handle(ev("GoalReplayStart"));
    t.handle(goal("Me", 0));
    t.handle(ev("GoalReplayEnd"));
    expect(t.record.goals).toHaveLength(1);
    expect(t.record.goals[0].score).toEqual([1, 0]);

    // The next kickoff can score again.
    t.handle(ev("CountdownBegin"));
    t.handle(ev("RoundStarted"));
    t.handle(goal("Them", 1, 90));
    expect(t.record.goals.map((g) => g.scorer)).toEqual(["Me", "Them"]);
  });

  it("records the winner and MVP at full time", () => {
    const t = kickedOff();
    t.handle(ev("MatchEnded", { WinnerTeamNum: 0 }));
    expect(t.record.winner).toBe(0);
    expect(t.record.endedAt).not.toBeNull();
    expect(mvpName(t.record)).toBe("Me");
  });

  it("treats free play (just you) as not a match", () => {
    const t = new MatchTracker();
    t.handle(ev("MatchCreated"));
    t.handle(state([DUEL[0]]));
    expect(isRealMatch(t.record)).toBe(false);
  });

  describe("50/50s and regains", () => {
    /** A kicked-off duel on a clock the test moves. */
    function timed() {
      const t = kickedOff();
      let clock = 0;
      t.now = () => clock;
      const hit = (at: number, name: string, team: number, y = 0) => {
        clock = at;
        t.handle(ev("BallHit", { Players: [{ Name: name, TeamNum: team }], Ball: { PostHitSpeed: 1000, Location: { X: 0, Y: y, Z: 100 } } }));
      };
      return { t, hit, me: () => t.record.players.Me, them: () => t.record.players.Them };
    }

    it("books a 50/50 to the team that comes away with the ball", () => {
      const { hit, me, them } = timed();
      hit(0, "Me", 0);
      hit(200, "Them", 1);
      hit(1500, "Me", 0);
      expect([me().challenges, me().challengesWon]).toEqual([1, 1]);
      expect([them().challenges, them().challengesWon, them().challengesLostDefence]).toEqual([1, 0, 0]);
    });

    it("counts a lost 50/50 in your own third", () => {
      const { hit, me } = timed();
      hit(0, "Me", 0, -4000);
      hit(100, "Them", 1, -4000);
      hit(1200, "Them", 1, -4500);
      expect([me().challenges, me().challengesWon, me().challengesLostDefence]).toEqual([1, 0, 1]);
    });

    it("gives a 50/50 that goes straight in to the scorers, and drops one cut off by a kickoff", () => {
      const { t, hit, me, them } = timed();
      hit(0, "Me", 0);
      hit(300, "Them", 1);
      t.handle(goal("Them", 1));
      expect([them().challenges, them().challengesWon, me().challengesWon]).toEqual([1, 1, 0]);

      t.handle(ev("CountdownBegin"));
      t.handle(ev("RoundStarted"));
      hit(10_000, "Me", 0);
      hit(10_100, "Them", 1);
      t.handle(ev("CountdownBegin"));
      hit(20_000, "Me", 0);
      expect([me().challenges, them().challenges]).toEqual([1, 1]);
    });

    it("leaves touches far apart out of 50/50s", () => {
      const { hit, me, them } = timed();
      hit(0, "Me", 0);
      hit(800, "Them", 1);
      hit(1600, "Me", 0);
      expect([me().challenges, them().challenges]).toEqual([0, 0]);
    });

    it("times how long each team takes to win the ball back, capped", () => {
      const { t, hit } = timed();
      hit(0, "Me", 0);
      hit(2000, "Them", 1); // blue lost it
      hit(5000, "Me", 0); // 3 s to win it back; orange lost it
      hit(40_000, "Them", 1); // capped at 15 s
      hit(40_300, "Me", 0); // a quick exchange isn't a regain
      expect(t.record.regain).toEqual({ time: [3, 15], count: [1, 1] });
    });
  });

  describe("first to ball", () => {
    const SQUAD = [
      { Name: "Me", TeamNum: 0 },
      { Name: "Mate", TeamNum: 0 },
      { Name: "Them", TeamNum: 1 },
      { Name: "Other", TeamNum: 1 },
    ];

    /** A 2v2 on a clock the test moves, with points the test sets. */
    function squad() {
      const t = new MatchTracker();
      let clock = 0;
      t.now = () => clock;
      const scores = (at: number, points: Record<string, number>) => {
        clock = at;
        t.handle(state(SQUAD.map((p) => ({ ...p, Score: points[p.Name] ?? 0 }))));
      };
      const hit = (at: number, name: string, team: number) => {
        clock = at;
        t.handle(ev("BallHit", { Players: [{ Name: name, TeamNum: team }], Ball: { PostHitSpeed: 50, Location: { X: 0, Y: 0, Z: 100 } } }));
      };
      const kickoff = () => {
        t.handle(ev("CountdownBegin"));
        t.handle(ev("RoundStarted"));
      };
      const firsts = () => Object.fromEntries(Object.values(t.record.players).map((p) => [p.name, p.firstTouches]));
      t.handle(ev("MatchCreated"));
      scores(0, {});
      return { t, scores, hit, kickoff, firsts };
    }

    it("follows the server's award when your game saw someone else touch first", () => {
      const { t, scores, hit, kickoff, firsts } = squad();
      kickoff();
      // Your game sees your touch first; the server paid your teammate.
      hit(0, "Me", 0);
      hit(60, "Mate", 0);
      expect(firsts()).toMatchObject({ Me: 1, Mate: 0 });
      scores(500, { Mate: 2 });
      expect(firsts()).toMatchObject({ Me: 0, Mate: 1 });
      expect(t.record.firstTouches).toEqual([1, 0]);

      // Across teams too, and a later +2 doesn't move it again.
      kickoff();
      hit(10_000, "Them", 1);
      scores(10_400, { Mate: 2, Me: 2 });
      scores(10_900, { Mate: 2, Me: 2, Them: 2 });
      expect(firsts()).toMatchObject({ Me: 1, Mate: 1, Them: 0 });
      expect(t.record.firstTouches).toEqual([2, 0]);
    });

    it("keeps your game's view when no award turns up in time", () => {
      const { t, scores, hit, kickoff, firsts } = squad();
      kickoff();
      hit(0, "Other", 1);
      scores(1_600, {});
      scores(1_700, { Me: 2 }); // too late: a touch later in the play
      expect(firsts()).toMatchObject({ Other: 1, Me: 0 });
      expect(t.record.firstTouches).toEqual([0, 1]);
    });
  });

  it("starts a fresh record when a new match GUID shows up", () => {
    const t = kickedOff();
    t.handle(goal("Me", 0));
    t.handle(state(DUEL, "OTHER"));
    expect(t.record.guid).toBe("OTHER");
    expect(t.record.goals).toHaveLength(0);
  });
});
