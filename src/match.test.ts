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

  it("starts a fresh record when a new match GUID shows up", () => {
    const t = kickedOff();
    t.handle(goal("Me", 0));
    t.handle(state(DUEL, "OTHER"));
    expect(t.record.guid).toBe("OTHER");
    expect(t.record.goals).toHaveLength(0);
  });
});
