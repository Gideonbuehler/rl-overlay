// Fake Rocket League Stats API feed for working on the overlay without the game.
// Plays short 2v2 matches on loop over a WebSocket, using the documented message shapes.
// Speeds are in km/h, which is what the live game sends (the docs say uu/s).
//
//   node mock/server.mjs              as a player (no boost/speed fields)
//   node mock/server.mjs --spectate   as a spectator (adds boost/speed for the camera target)
//   node mock/server.mjs --port 49124 --rate 30 --length 60 --post 8
//
// Close Rocket League first, or pick another port: they can't share one.

import crypto from "node:crypto";
import http from "node:http";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const PORT = opt("port", 49124);
const RATE = opt("rate", 30);
const MATCH_LENGTH = opt("length", 60);
const POST_MATCH = opt("post", 8); // seconds from MatchEnded to leaving the match
const SPECTATE = args.includes("--spectate");

// ---------- minimal WebSocket server (text frames out, ignore frames in) ----------

const clients = new Set();

function frame(text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

const server = http.createServer((_, res) => res.writeHead(426).end("WebSocket only"));
server.on("upgrade", (req, socket) => {
  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(socket);
  console.log(`client connected (${clients.size})`);
  // The first match waits for a viewer, so it's seen from kickoff.
  if (!match && !pendingStart) pendingStart = setTimeout(newMatch, 500);
  socket.on("data", (buf) => {
    if ((buf[0] & 0x0f) === 0x8) return socket.end(); // close frame
    const text = unmask(buf);
    if (text) onCommand(text);
  });
  const drop = () => clients.delete(socket);
  socket.on("close", drop);
  socket.on("error", drop);
});

/** Decodes one masked client text frame (commands are small, single frames). */
function unmask(buf) {
  if ((buf[0] & 0x0f) !== 0x1) return null;
  let len = buf[1] & 0x7f;
  let at = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    at = 4;
  }
  const mask = buf.subarray(at, at + 4);
  const data = buf.subarray(at + 4, at + 4 + len);
  return Buffer.from(data.map((b, i) => b ^ mask[i % 4])).toString();
}

// Commands from the overlay. LoadReplay pretends to open a replay: it pauses
// the fake match, announces the replay, and streams replay-style updates.
let replayTimer = null;
function onCommand(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return console.log("unparseable command:", text);
  }
  console.log("command:", JSON.stringify(msg));
  // Test helper: leave mid-match like a player quitting to the menu (no
  // MatchEnded), then go into free play, which is a "match" with just you.
  if (msg.Command === "MockLeave") {
    send("MatchDestroyed", { MatchGuid: match.guid });
    setTimeout(() => {
      newMatch();
      match.players = match.players.slice(0, 1);
      console.log("left the match; now in free play");
    }, 1500);
    return;
  }
  if (msg.Command === "LoadReplay") {
    replaying = true;
    send("MatchCreated", { MatchGuid: "" });
    send("ReplayCreated", { MatchGuid: "", FileName: "mock", Date: new Date().toISOString() });
    let frame = 0;
    clearInterval(replayTimer);
    replayTimer = setInterval(() => {
      frame += 30;
      send("UpdateState", {
        MatchGuid: "",
        Players: match.players.map((p) => ({ Name: p.Name, Shortcut: p.Shortcut, TeamNum: p.TeamNum })),
        Game: { ...state().Game, bReplay: true, Frame: frame, Elapsed: frame / 30 },
      });
    }, 1000);
    setTimeout(() => {
      clearInterval(replayTimer);
      send("MatchDestroyed", { MatchGuid: "" });
      replaying = false;
      console.log("replay closed");
    }, 12000);
  }
}
let replaying = false;

function send(Event, Data) {
  const msg = frame(JSON.stringify({ Event, Data }));
  for (const socket of clients) socket.write(msg);
}

// ---------- simulated match ----------

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const ref = (p) => ({ Name: p.Name, Shortcut: p.Shortcut, TeamNum: p.TeamNum });

let match;
let pendingStart = null;

function newMatch() {
  const guid = crypto.randomBytes(16).toString("hex").toUpperCase();
  const mk = (Name, Shortcut, TeamNum) => ({
    Name, PrimaryId: `Steam|${1000 + Shortcut}|0`, Shortcut, TeamNum,
    Score: 0, Goals: 0, Shots: 0, Assists: 0, Saves: 0, Touches: 0, CarTouches: 0, Demos: 0,
    Speed: 0, Boost: 33,
  });
  match = {
    guid,
    time: MATCH_LENGTH,
    overtime: false,
    ended: false,
    teams: [0, 0],
    lastTouch: 255,
    // Ball position random-walks so touches cluster like real play.
    ball: { X: 0, Y: 0 },
    players: [mk("You", 1, 0), mk("Teammate", 2, 0), mk("Rival", 3, 1), mk("Other Rival", 4, 1)],
  };
  send("MatchCreated", { MatchGuid: guid });
  send("MatchInitialized", { MatchGuid: guid });
  kickoff();
  console.log(`match ${guid.slice(0, 8)} started`);
}

// Countdown, then the first touch of the round comes from whoever wins the race.
function kickoff() {
  match.ball = { X: 0, Y: 0 };
  for (const p of match.players) Object.assign(p, { Boost: 33, boostF: 33, boosting: false });
  send("CountdownBegin", { MatchGuid: match.guid });
  setTimeout(() => {
    send("RoundStarted", { MatchGuid: match.guid });
    const p = pick(match.players);
    p.Touches++;
    // The server pays the first touch a moment later, as the real game does.
    setTimeout(() => (p.Score += 2), 400);
    send("BallHit", { MatchGuid: match.guid, Players: [ref(p)], Ball: { PreHitSpeed: 0, PostHitSpeed: rand(55, 90), Location: { X: 0, Y: 0, Z: 93 } } });
  }, 3000);
}

function state() {
  const target = match.players[0];
  return {
    MatchGuid: match.guid,
    Players: match.players.map((p) => {
      const { Speed, Boost, boosting, boostF, ...always } = p;
      // Car state is only sent to spectators, like the real API.
      return SPECTATE
        ? { ...always, bHasCar: true, Speed: Math.round(Speed * 0.036), Boost, bBoosting: !!boosting,
            bOnGround: true, bOnWall: false, bPowersliding: false, bDemolished: false,
            bSupersonic: Speed > 2200 }
        : always;
    }),
    Game: {
      Teams: [
        { Name: "Blue", TeamNum: 0, Score: match.teams[0], ColorPrimary: "1873FF", ColorSecondary: "0A3D8F" },
        { Name: "Orange", TeamNum: 1, Score: match.teams[1], ColorPrimary: "FF8A15", ColorSecondary: "8F4A0A" },
      ],
      PlaylistId: 11,
      TimeSeconds: match.time,
      bOvertime: match.overtime,
      Ball: { Speed: rand(0, 110), TeamNum: match.lastTouch },
      bReplay: false,
      bHasWinner: match.ended,
      Winner: match.ended ? (match.teams[0] > match.teams[1] ? "Blue" : "Orange") : "",
      Arena: "Stadium_P",
      bHasTarget: true,
      Target: ref(target),
    },
  };
}

function tickEvents() {
  if (match.ended) return;
  for (const p of match.players) {
    p.Speed = Math.max(0, Math.min(2300, p.Speed + rand(-300, 320)));
    // Boost like the game: drains ~33/s while boosting, pads give 12, big pads fill.
    if (Math.random() < 0.02) p.boosting = !p.boosting && p.Boost > 0;
    if (p.boosting) p.boostF = Math.max(0, (p.boostF ?? p.Boost) - 33.3 / RATE);
    if (Math.random() < 0.006) p.boostF = Math.min(100, (p.boostF ?? p.Boost) + 12);
    if (Math.random() < 0.0015) p.boostF = 100;
    p.Boost = Math.round(p.boostF ?? p.Boost);
    if (p.Boost === 0) p.boosting = false;
  }

  const b = match.ball;
  b.X = Math.max(-3900, Math.min(3900, b.X + rand(-320, 320)));
  b.Y = Math.max(-4900, Math.min(4900, b.Y + rand(-450, 450)));

  if (Math.random() < 0.01) pick(match.players).CarTouches++;

  // Someone hits the ball now and then.
  if (Math.random() < 0.06) {
    const p = pick(match.players);
    p.Touches++;
    match.lastTouch = p.TeamNum;
    const Z = Math.random() < 0.2 ? rand(320, 1600) : rand(93, 200);
    send("BallHit", {
      MatchGuid: match.guid,
      Players: [ref(p)],
      Ball: { PreHitSpeed: rand(0, 60), PostHitSpeed: rand(15, 175), Location: { X: b.X, Y: b.Y, Z } },
    });

    // Free play has no opponents: no shots, saves, or demos to simulate.
    if (match.players.some((o) => o.TeamNum !== p.TeamNum) && Math.random() < 0.25) {
      p.Shots++;
      p.Score += 20;
      send("StatfeedEvent", { MatchGuid: match.guid, EventName: "Shot", Type: "Shot on Goal", MainTarget: ref(p) });
      if (Math.random() < 0.4) goal(p);
      else {
        const keeper = pick(match.players.filter((o) => o.TeamNum !== p.TeamNum));
        keeper.Saves++;
        keeper.Score += 50;
        send("StatfeedEvent", { MatchGuid: match.guid, EventName: "Save", Type: "Save", MainTarget: ref(keeper) });
        if (Math.random() < 0.3) send("StatfeedEvent", { MatchGuid: match.guid, EventName: "EpicSave", Type: "Epic Save", MainTarget: ref(keeper) });
      }
    }
  }

  if (Math.random() < 0.003) {
    const p = pick(match.players);
    send("CrossbarHit", { MatchGuid: match.guid, BallLocation: { X: 0, Y: 5120, Z: 640 }, BallSpeed: rand(800, 3000), ImpactForce: rand(50, 300), BallLastTouch: { Player: ref(p), Speed: rand(800, 3000) } });
  }

  if (Math.random() < 0.01) {
    const p = pick(match.players);
    const [EventName, Type] = pick([["Clear", "Clear Ball"], ["Center", "Center Ball"], ["FirstTouch", "First Touch"]]);
    send("StatfeedEvent", { MatchGuid: match.guid, EventName, Type, MainTarget: ref(p) });
  }

  if (match.players.length > 1 && Math.random() < 0.004) {
    const [a, b] = [pick(match.players.filter((p) => p.TeamNum === 0)), pick(match.players.filter((p) => p.TeamNum === 1))];
    const [attacker, victim] = Math.random() < 0.5 ? [a, b] : [b, a];
    attacker.Demos++;
    send("StatfeedEvent", { MatchGuid: match.guid, EventName: "Demolish", Type: "Demolition", MainTarget: ref(attacker), SecondaryTarget: ref(victim) });
  }
}

function goal(scorer) {
  scorer.Goals++;
  scorer.Score += 100;
  match.teams[scorer.TeamNum]++;
  const mate = match.players.find((p) => p.TeamNum === scorer.TeamNum && p !== scorer);
  const assisted = Math.random() < 0.5;
  if (assisted) {
    mate.Assists++;
    mate.Score += 50;
  }
  const speed = rand(50, 180);
  send("GoalScored", {
    MatchGuid: match.guid,
    GoalSpeed: speed,
    GoalTime: rand(4, 40),
    ImpactLocation: { X: rand(-850, 850), Y: scorer.TeamNum === 0 ? 5120 : -5120, Z: rand(93, 600) },
    Scorer: ref(scorer),
    ...(assisted ? { Assister: ref(mate) } : {}),
    BallLastTouch: { Player: ref(scorer), Speed: speed },
  });
  // The live game follows each goal with a second, empty GoalScored.
  send("GoalScored", { MatchGuid: match.guid, GoalSpeed: 0, GoalTime: 0, ImpactLocation: { X: 0, Y: 0, Z: 0 },
    Scorer: { Name: "", Shortcut: 0, TeamNum: 0 }, BallLastTouch: { Player: { Name: "", Shortcut: 0, TeamNum: 0 }, Speed: 0 } });
  send("StatfeedEvent", { MatchGuid: match.guid, EventName: "Goal", Type: "Goal", MainTarget: ref(scorer) });
  if (Math.random() < 0.3) send("StatfeedEvent", { MatchGuid: match.guid, EventName: "AerialGoal", Type: "Aerial Goal", MainTarget: ref(scorer) });
  if (scorer.Goals === 3) send("StatfeedEvent", { MatchGuid: match.guid, EventName: "HatTrick", Type: "Hat Trick", MainTarget: ref(scorer) });
  if (assisted) send("StatfeedEvent", { MatchGuid: match.guid, EventName: "Assist", Type: "Assist", MainTarget: ref(mate) });
  if (match.overtime) return endMatch();
  send("GoalReplayStart", { MatchGuid: match.guid });
  setTimeout(() => {
    send("GoalReplayEnd", { MatchGuid: match.guid });
    kickoff();
  }, 2500);
}

function endMatch() {
  match.ended = true;
  const winner = match.teams[0] > match.teams[1] ? 0 : 1;
  send("MatchEnded", { MatchGuid: match.guid, WinnerTeamNum: winner });
  console.log(`match over ${match.teams[0]}-${match.teams[1]}, ${winner === 0 ? "Blue" : "Orange"} wins`);
  setTimeout(() => send("PodiumStart", { MatchGuid: match.guid }), 2000);
  setTimeout(() => {
    send("MatchDestroyed", { MatchGuid: match.guid });
    setTimeout(newMatch, 2000);
  }, POST_MATCH * 1000);
}

// Clock: one second per second, overtime if tied.
setInterval(() => {
  if (!match || match.ended) return;
  if (match.overtime) match.time++;
  else if (match.time > 0) match.time--;
  else if (match.teams[0] === match.teams[1]) match.overtime = true;
  else return endMatch();
  send("ClockUpdatedSeconds", { MatchGuid: match.guid, TimeSeconds: match.time, bOvertime: match.overtime });
}, 1000);

setInterval(() => {
  if (!match || replaying) return;
  tickEvents();
  send("UpdateState", state());
}, 1000 / RATE);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Stats API on ws://127.0.0.1:${PORT} (${SPECTATE ? "spectator" : "player"} view), waiting for a client`);
});
