// Builds a full record of one match out of the Stats API's messages. The focus is
// what the in-game scoreboard never shows: where touches happened, how hard,
// who won the race to the ball, possession over time, and where goals went in.

import type { BoostStats } from "./boost";
import { speedKmh, type Envelope, type PlayerRef } from "./feed";
import { platformName } from "./names";

export interface PlayerLine {
  name: string;
  team: number;
  platform: string;
  /** "Platform|Id|Splitscreen" from the Stats API, for linking to tracker profiles. */
  primaryId: string;
  // Scoreboard numbers, kept for context and the session totals.
  points: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  // Things the scoreboard doesn't show.
  touches: number;
  /** Car-to-car contacts, from the API's CarTouches. */
  bumps: number;
  demos: number;
  demoed: number;
  /** Touches with the ball well off the ground. */
  aerials: number;
  /** Rounds where this player touched the ball first after kickoff. */
  firstTouches: number;
  /** Touches per third of the field, from this player's point of view: [defence, middle, attack]. */
  thirds: [number, number, number];
  /** Ball hits we saw a speed for, to average. */
  hits: number;
  hitSum: number;
  /** km/h */
  topHit: number;
  /** Hits that sent the ball off at HARD_HIT km/h or more. */
  hardHits: number;
  /** Special stats from the stat feed, e.g. { "Epic Save": 2 }. */
  feats: Record<string, number>;
  left: boolean;
}

export interface HitPoint {
  /** Field position in unreal units. Y runs goal to goal (blue defends -Y). */
  x: number;
  y: number;
  name: string;
  team: number;
}

export interface GoalLine {
  team: number;
  scorer: string;
  assist: string | null;
  /** km/h */
  speed: number;
  clock: number;
  overtime: boolean;
  /** Seconds into the match. */
  at: number;
  /** Seconds from kickoff to this goal. */
  playLength: number;
  /** Where the ball crossed the goal line: x across the goal, z height (uu). */
  mouthX: number;
  mouthZ: number;
  /** Score after this goal, [blue, orange]. */
  score: [number, number];
}

/** Exact boost for one player, worked out from a saved replay (0–100 scale). */
export interface PlayerBoost {
  name: string;
  team: number;
  used: number;
  collected: number;
  stolen: number;
  usedAirborne: number;
  usedSupersonic: number;
  bigPads: number;
  smallPads: number;
  time: number;
  levelSum: number;
  empty: number;
  full: number;
}

/** The saved replay of a match, linked by match GUID. */
export interface ReplayLink {
  path: string;
  id: string;
  fps: number;
  /** Replay frame of each goal, in order, with who scored it. */
  goals: { frame: number; player: string; team: number }[];
}

export interface TeamLine {
  name: string;
  color: string;
  score: number;
}

export interface MatchRecord {
  /** Bumped when stored fields change meaning; see loadArchive. */
  version: number;
  guid: string;
  startedAt: number;
  endedAt: number | null;
  playlistId: number | undefined;
  arena: string;
  teams: [TeamLine, TeamLine];
  players: Record<string, PlayerLine>;
  goals: GoalLine[];
  hits: HitPoint[];
  winner: number | null;
  meName: string | null;
  myTeam: number | null;
  clock: number;
  overtime: boolean;
  /** Regulation length in seconds, taken from the first clock reading. */
  length: number;
  /** Seconds each team was last to touch the ball during live play. */
  possession: [number, number];
  /** The same, split into MOMENTUM_BUCKET-second slices of match time. */
  momentum: [number, number][];
  /** Rounds where each team touched the ball first after kickoff. */
  firstTouches: [number, number];
  ballTime: number;
  ballSpeedSum: number;
  /** km/h */
  ballTop: number;
  crossbars: [number, number];
  /** Your boost, when the boost reader (or spectator data) could see it. */
  boost: BoostStats | null;
  /** Set once a saved replay of this match turns up. */
  replay?: ReplayLink | null;
  /** Everyone's exact boost, from that replay. */
  replayBoost?: PlayerBoost[] | null;
  /** You left before full time (no result recorded). */
  leftEarly?: boolean;
}

/** A real match has at least two players; free play and training have just you. */
export const isRealMatch = (r: MatchRecord) => Object.keys(r.players).length >= 2;

/**
 * Whether any play was seen: a clock, a touch, or a goal. The end screen keeps
 * sending state (with a winner) after a match, which can otherwise look like a
 * new match that's already over.
 */
export const wasPlayed = (r: MatchRecord) => r.length > 0 || r.hits.length > 0 || r.goals.length > 0;

export const MOMENTUM_BUCKET = 20;
export const HARD_HIT = 100;
/** Ball centre height above which a touch counts as aerial (the ball rests at ~93). */
const AERIAL_Z = 300;
/** Field half-length; thirds split at a third of that either side of centre. */
const THIRD_Y = 5120 / 3;
const HIT_LIMIT = 800;

const TEAM_FALLBACK = ["#2f7dff", "#ff8a1f"];

export const RECORD_VERSION = 4;

export function freshRecord(guid = ""): MatchRecord {
  return {
    version: RECORD_VERSION,
    guid,
    startedAt: Date.now(),
    endedAt: null,
    playlistId: undefined,
    arena: "",
    teams: [
      { name: "Blue", color: TEAM_FALLBACK[0], score: 0 },
      { name: "Orange", color: TEAM_FALLBACK[1], score: 0 },
    ],
    players: {},
    goals: [],
    hits: [],
    winner: null,
    meName: null,
    myTeam: null,
    clock: 0,
    overtime: false,
    length: 0,
    possession: [0, 0],
    momentum: [],
    firstTouches: [0, 0],
    ballTime: 0,
    ballSpeedSum: 0,
    ballTop: 0,
    crossbars: [0, 0],
    boost: null,
  };
}

function blankPlayer(name: string, team: number): PlayerLine {
  return {
    name, team, platform: "", primaryId: "",
    points: 0, goals: 0, assists: 0, saves: 0, shots: 0,
    touches: 0, bumps: 0, demos: 0, demoed: 0, aerials: 0, firstTouches: 0,
    thirds: [0, 0, 0], hits: 0, hitSum: 0, topHit: 0, hardHits: 0,
    feats: {}, left: false,
  };
}

// Stat feed entries the scoreboard already covers, or that we show elsewhere.
const BASIC_FEATS = new Set([
  "goal", "assist", "save", "shot", "shotongoal", "shot on goal", "demolish", "demolition",
  "mvp", "win", "firsttouch", "first touch",
]);
const isBasicFeat = (eventName: string, label: string) =>
  BASIC_FEATS.has(eventName.toLowerCase()) || BASIC_FEATS.has(label.toLowerCase());

/** Match time played so far in seconds, including overtime. */
export const duration = (m: MatchRecord) =>
  m.overtime ? m.length + m.clock : Math.max(0, m.length - m.clock);

/** The game's MVP: top score on the winning team. */
export function mvpName(m: MatchRecord): string | null {
  if (m.winner === null) return null;
  const winners = Object.values(m.players).filter((p) => p.team === m.winner);
  winners.sort((a, b) => b.points - a.points);
  return winners[0]?.name ?? null;
}

export class MatchTracker {
  record = freshRecord();
  /** Set by the caller; "" means follow the camera target. */
  playerName = "";

  private roundActive = false;
  private inReplay = false;
  private awaitingFirstTouch = false;
  /** One goal per kickoff: the game sends a second, empty GoalScored per goal. */
  private goalThisRound = false;
  private roundStartedAt = 0;
  private lastTick = 0;
  /** True when we saw MatchCreated, so the first clock reading is the full length. */
  private sawStart = false;

  private player(ref: { Name: string; TeamNum?: number }): PlayerLine {
    return (this.record.players[ref.Name] ??= blankPlayer(ref.Name, ref.TeamNum ?? 0));
  }

  /** Feeds one message in. Returns true when the record changed. */
  handle({ Event, Data }: Envelope): boolean {
    const r = this.record;
    const guid: string = Data?.MatchGuid ?? "";

    switch (Event) {
      case "MatchCreated":
        this.reset(guid);
        this.sawStart = true;
        return true;

      case "CountdownBegin":
        this.roundActive = false;
        this.awaitingFirstTouch = true;
        this.goalThisRound = false;
        return false;

      case "RoundStarted":
        this.roundActive = true;
        this.goalThisRound = false;
        this.roundStartedAt = duration(r);
        return false;

      case "GoalReplayStart":
        this.inReplay = true;
        return false;

      case "GoalReplayEnd":
        this.inReplay = false;
        return false;

      case "UpdateState":
        // Joined mid-match, or missed MatchCreated.
        if (guid && guid !== r.guid) this.reset(guid);
        this.applyState(Data);
        return true;

      case "BallHit":
        if (this.inReplay || Data.bReplay) return false;
        this.applyHit(Data);
        return true;

      case "GoalScored": {
        // The live game sends a second GoalScored for each goal with an empty
        // scorer, no speed, and no play length; and the instant replay can
        // repeat it. Only the first one per kickoff counts.
        if (this.inReplay || this.goalThisRound || !Data.Scorer?.Name) return false;
        this.goalThisRound = true;
        this.roundActive = false;
        const scorer: PlayerRef | undefined = Data.Scorer;
        const team = scorer?.TeamNum ?? 0;
        const score: [number, number] = [r.teams[0].score, r.teams[1].score];
        score[team]++;
        const at = duration(r);
        const impact = Data.ImpactLocation ?? {};
        r.goals.push({
          team,
          scorer: scorer?.Name ?? "Unknown",
          assist: Data.Assister?.Name ?? null,
          speed: speedKmh("goal", Data.GoalSpeed ?? 0),
          clock: r.clock,
          overtime: r.overtime,
          at,
          playLength: Data.GoalTime ?? Math.max(0, at - this.roundStartedAt),
          // From the shooter's side, positive is their right. Blue attacks +Y, and
          // in the game's left-handed axes the right-hand side facing +Y is -X.
          mouthX: (impact.X ?? 0) * (team === 0 ? -1 : 1),
          mouthZ: impact.Z ?? 0,
          score,
        });
        return true;
      }

      case "StatfeedEvent": {
        const main: PlayerRef | undefined = Data.MainTarget;
        const eventName = String(Data.EventName ?? "");
        const label = String(Data.Type ?? eventName);
        if (eventName.toLowerCase() === "demolish" && Data.SecondaryTarget) {
          this.player(Data.SecondaryTarget).demoed++;
        }
        if (main && label && !isBasicFeat(eventName, label)) {
          const feats = this.player(main).feats;
          feats[label] = (feats[label] ?? 0) + 1;
        }
        return true;
      }

      case "CrossbarHit": {
        if (this.inReplay) return false;
        const team = Data.BallLastTouch?.Player?.TeamNum;
        if (team === 0 || team === 1) r.crossbars[team]++;
        return true;
      }

      case "PlayerLeft": {
        const p = r.players[Data.PlayerName];
        if (p) p.left = true;
        return true;
      }

      case "PlayerJoined": {
        const p = r.players[Data.PlayerName];
        if (p) p.left = false;
        return true;
      }

      case "MatchEnded":
        this.roundActive = false;
        r.winner = Data.WinnerTeamNum ?? null;
        r.endedAt = Date.now();
        return true;
    }
    return false;
  }

  private reset(guid: string) {
    this.goalThisRound = false;
    this.record = freshRecord(guid);
    this.roundActive = false;
    this.inReplay = false;
    this.awaitingFirstTouch = false;
    this.roundStartedAt = 0;
    this.lastTick = 0;
    this.sawStart = false;
  }

  private applyHit(data: any) {
    const r = this.record;
    // A touch means the round is live, even if we connected mid-round.
    this.roundActive = true;
    const speed = speedKmh("hit", data.Ball?.PostHitSpeed ?? 0);
    const loc = data.Ball?.Location;
    const refs = (data.Players ?? []) as PlayerRef[];

    if (this.awaitingFirstTouch && refs[0]) {
      this.awaitingFirstTouch = false;
      this.player(refs[0]).firstTouches++;
      if (refs[0].TeamNum === 0 || refs[0].TeamNum === 1) r.firstTouches[refs[0].TeamNum]++;
    }

    for (const ref of refs) {
      const p = this.player(ref);
      p.hits++;
      p.hitSum += speed;
      p.topHit = Math.max(p.topHit, speed);
      if (speed >= HARD_HIT) p.hardHits++;
      if (!loc) continue;
      if ((loc.Z ?? 0) > AERIAL_Z) p.aerials++;
      // Blue attacks +Y, orange attacks -Y.
      const forward = (loc.Y ?? 0) * (ref.TeamNum === 0 ? 1 : -1);
      p.thirds[forward < -THIRD_Y ? 0 : forward > THIRD_Y ? 2 : 1]++;
      if (r.hits.length < HIT_LIMIT) {
        r.hits.push({ x: Math.round(loc.X ?? 0), y: Math.round(loc.Y ?? 0), name: ref.Name, team: ref.TeamNum });
      }
    }
  }

  private applyState(data: any) {
    const r = this.record;
    const game = data.Game ?? {};
    const now = performance.now();
    const dt = this.lastTick ? Math.min((now - this.lastTick) / 1000, 0.5) : 0;
    this.lastTick = now;

    r.playlistId = game.PlaylistId ?? r.playlistId;
    r.arena = game.Arena ?? r.arena;
    r.clock = game.TimeSeconds ?? r.clock;
    r.overtime = !!game.bOvertime;
    if (!r.length && r.clock > 0) {
      // Seen from the start, the first reading is the full length. Joined mid-match,
      // a whole-minute reading is still the kickoff clock; otherwise assume 5 minutes.
      r.length = r.overtime ? 300
        : this.sawStart || r.clock % 60 === 0 ? r.clock
        : Math.max(300, Math.ceil(r.clock / 60) * 60);
    }

    (game.Teams ?? []).forEach((t: any, i: number) => {
      if (i > 1) return;
      r.teams[i] = {
        name: t.Name || r.teams[i].name,
        color: t.ColorPrimary ? `#${t.ColorPrimary}` : r.teams[i].color,
        score: t.Score ?? r.teams[i].score,
      };
    });

    // Connected after MatchEnded: the state still says who won.
    if (game.bHasWinner && r.winner === null) {
      const i = r.teams.findIndex((t) => t.name === game.Winner);
      if (i >= 0) r.winner = i;
    }

    for (const p of data.Players ?? []) {
      const line = this.player(p);
      line.team = p.TeamNum ?? line.team;
      line.platform = platformName(p.PrimaryId) || line.platform;
      line.primaryId = p.PrimaryId || line.primaryId;
      line.points = p.Score ?? line.points;
      line.goals = p.Goals ?? line.goals;
      line.assists = p.Assists ?? line.assists;
      line.saves = p.Saves ?? line.saves;
      line.shots = p.Shots ?? line.shots;
      line.touches = p.Touches ?? line.touches;
      line.bumps = p.CarTouches ?? line.bumps;
      line.demos = p.Demos ?? line.demos;
    }

    const me = this.findMe(data.Players ?? [], game);
    if (me) {
      r.meName = me.Name;
      r.myTeam = me.TeamNum;
    }

    // Possession and ball speed only count during live play.
    const live = this.roundActive && !this.inReplay && !game.bReplay && r.winner === null;
    const ball = game.Ball;
    if (live && dt > 0 && ball) {
      if (ball.TeamNum === 0 || ball.TeamNum === 1) {
        const team = ball.TeamNum as 0 | 1;
        r.possession[team] += dt;
        const bucket = Math.floor(duration(r) / MOMENTUM_BUCKET);
        while (r.momentum.length <= bucket) r.momentum.push([0, 0]);
        r.momentum[bucket][team] += dt;
      }
      const speed = speedKmh("ball", ball.Speed ?? 0);
      r.ballTime += dt;
      r.ballSpeedSum += speed * dt;
      r.ballTop = Math.max(r.ballTop, speed);
    }
  }

  private findMe(players: any[], game: any) {
    const wanted = this.playerName.trim().toLowerCase();
    if (wanted) return players.find((p) => String(p.Name).toLowerCase() === wanted);
    // No name set: follow whoever the camera is on. While playing that should be you.
    if (game?.bHasTarget && game.Target?.Name)
      return players.find((p) => p.Name === game.Target.Name);
    return undefined;
  }
}

