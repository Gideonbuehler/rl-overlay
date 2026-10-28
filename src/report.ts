// Renders the match report. It deliberately skips what the in-game scoreboard
// already shows (score, goals, assists, saves, shots) and shows what it doesn't.
// Sections and table columns are chosen and ordered in settings.

import { averageBoost, boostPerMinute } from "./boost";
import {
  HARD_HIT,
  MOMENTUM_BUCKET,
  duration,
  mvpName,
  type MatchRecord,
  type PlayerBoost,
  type PlayerLine,
} from "./match";
import { arenaName, isAnonymised, playlistName, platformName, trackerCandidates, type TrackerOverride } from "./names";
import type { Session } from "./session";
import { latestReading, signed, type MmrReading, type SharedPlayer } from "./mmr";
import { fmtSpeed, toUnit, withUnitLabels } from "./units";

export interface ReportEntry {
  record: MatchRecord;
  live: boolean;
}

/** Which screen the report panel shows. */
export type ReportView =
  | { kind: "match" }
  | { kind: "matches" }
  | { kind: "player"; name: string; primaryId: string };

export interface ReportOptions {
  reportHotkey: string;
  /** Tab ids in display order; hidden ones are left out. */
  tabs: string[];
  /** The open tab. */
  tab: string;
  /** Player-table column ids. */
  columns: string[];
  /** True during a live round of a match, when the report doesn't take clicks. */
  clicksPaused: boolean;
  /** Corrected RL Tracker profiles, keyed by player id or name. */
  trackerOverrides: Record<string, TrackerOverride>;
  /** Your MMR readings from the game log. */
  readings: MmrReading[];
  /** Your MMR going into and out of a match (see matchMmr). */
  mmr: (r: MatchRecord) => { before?: number; after?: number };
  /** Shared MMR for a player id, if they share it and it's been looked up. */
  shared: (primaryId: string) => SharedPlayer | null;
  /** A short message to show in the footer instead of the usual hint. */
  notice?: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const mmss = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const clockLabel = (clock: number, overtime: boolean) => (overtime ? `+${mmss(clock)}` : mmss(clock));
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
/** Speeds are stored in km/h and shown in the chosen unit. */
const kmh = (v: number) => fmtSpeed(v);
const speed = (v: number) => Math.round(toUnit(v));
const round = (v: number) => Math.round(v).toLocaleString();
const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const avgHit = (p: PlayerLine) => (p.hits ? p.hitSum / p.hits : 0);
const teamOf = (r: MatchRecord, team: number) => Object.values(r.players).filter((p) => p.team === team);
const sum = <T>(ps: T[], f: (p: T) => number) => ps.reduce((n, p) => n + f(p), 0);

/** "W 3-1" from your side, or the plain score if we don't know which side you're on. */
function resultLabel(r: MatchRecord, live: boolean): { text: string; tone: string } {
  const [a, b] = [r.teams[0].score, r.teams[1].score];
  if (live && r.winner === null) return { text: `Live ${a}-${b}`, tone: "live" };
  if (r.winner === null && r.leftEarly && r.myTeam !== null) {
    // Leaving counts as a loss, as Rocket League counts it.
    return { text: `L ${r.teams[r.myTeam].score}-${r.teams[1 - r.myTeam].score} left`, tone: "loss" };
  }
  if (r.winner === null) return { text: `Left ${a}-${b}`, tone: "" };
  if (r.myTeam === null) return { text: `${a}-${b}`, tone: "" };
  const mine = r.teams[r.myTeam].score;
  const theirs = r.teams[1 - r.myTeam].score;
  const won = r.winner === r.myTeam;
  return { text: `${won ? "W" : "L"} ${mine}-${theirs}${r.overtime ? " OT" : ""}`, tone: won ? "win" : "loss" };
}

// ---------- top bar ----------

/** The session's MMR change per playlist, e.g. "MMR +18" or "Doubles +18 · Standard −9". */
function sessionMmr(s: Session): string {
  const moved = s.mmr.filter((m) => m.to !== m.from);
  if (!moved.length) return "";
  const one = moved.length === 1;
  return moved
    .map((m) => {
      const d = m.to - m.from;
      return ` · ${one ? "MMR" : esc(playlistName(m.playlist))} <b class="${d > 0 ? "win-text" : "loss-text"}">${signed(d)}</b>`;
    })
    .join("");
}

function sessionSummary(s: Session) {
  return s.games
    ? `Session <b class="win-text">${s.wins}W</b> <b class="loss-text">${s.losses}L</b> · ${pct(s.wins, s.games)}%${
        s.streak ? ` · ${s.streak > 0 ? "W" : "L"}${Math.abs(s.streak)} streak` : ""}${sessionMmr(s)}`
    : "No finished matches this session";
}

/** All matches button (or Back), a title, and the session summary. */
function topBar(view: ReportView, entries: ReportEntry[], s: Session, title: string): string {
  const left = view.kind === "match"
    ? `<button class="nav-btn" data-view="matches" tabindex="-1"><span class="nav-icon list"></span>All matches <span class="count">${entries.length}</span></button>`
    : `<button class="nav-btn" data-view="match" tabindex="-1"><span class="nav-icon back"></span>Back to match</button>`;
  return `
    <nav class="topbar">
      ${left}
      <span class="topbar-title">${title}</span>
      <span class="strip-session">${sessionSummary(s)}</span>
    </nav>`;
}

// ---------- header ----------

function header(r: MatchRecord, live: boolean, o: ReportOptions): string {
  const ended = r.winner !== null;
  let verdict = r.leftEarly && r.myTeam !== null ? "Left (loss)" : "Match left";
  let tone = r.leftEarly && r.myTeam !== null ? "loss" : "";
  if (live && !ended) {
    verdict = "Live";
    tone = "live";
  } else if (ended && r.myTeam !== null) {
    const won = r.winner === r.myTeam;
    verdict = won ? "Victory" : "Defeat";
    tone = won ? "win" : "loss";
  } else if (ended) {
    verdict = `${r.teams[r.winner!].name} wins`;
  }

  const kicker = [playlistName(r.playlistId), arenaName(r.arena)].filter(Boolean).join(" · ");
  const timing = live && !ended
    ? r.overtime ? `Overtime ${clockLabel(r.clock, true)}` : `${mmss(r.clock)} left`
    : `${mmss(duration(r))} played${r.overtime ? ` · overtime ${clockLabel(r.clock, true)}` : ""}`;
  const meta = [timing, timeOfDay(r.endedAt ?? r.startedAt)].join(" · ");

  const team = (i: 0 | 1) => `
    <div class="team ${i ? "right" : ""}" style="--team:${r.teams[i].color}">
      <span class="team-name">${esc(r.teams[i].name)}</span>
      <span class="team-goals">${r.teams[i].score}</span>
    </div>`;

  return `
    <header class="head">
      <div class="verdict-block">
        <div class="kicker">${esc(kicker)}</div>
        <div class="verdict ${tone}">${verdict}</div>
        <div class="meta">${esc(meta)}</div>
      </div>
      <div class="scoreline">${team(0)}<span class="dash">–</span>${team(1)}</div>
      ${youCard(r, o)}
    </header>`;
}

/** Your boost: exact from the replay when there is one, else the screen reader's estimate. */
function myBoost(r: MatchRecord): { used: number; perMin: number; avg: number; exact: boolean } | null {
  const exact = r.replayBoost?.find((p) => p.name === r.meName);
  if (exact && exact.time > 0) {
    return { used: exact.used, perMin: (exact.used / exact.time) * 60, avg: exact.levelSum / exact.time, exact: true };
  }
  if (r.boost && r.boost.time > 5) {
    return { used: r.boost.used, perMin: boostPerMinute(r.boost), avg: averageBoost(r.boost), exact: false };
  }
  return null;
}

function youCard(r: MatchRecord, o: ReportOptions): string {
  const me = r.meName ? r.players[r.meName] : undefined;
  if (!me) return `<div class="you-card empty"><span class="muted">Set your name in settings to track your stats</span></div>`;
  const teamTouches = sum(teamOf(r, me.team), (p) => p.touches);
  const mvp = mvpName(r) === me.name;
  const mini = (label: string, value: string, cls = "") => `<div class="mini ${cls}"><b>${value}</b><span>${label}</span></div>`;
  const b = myBoost(r);
  const { before, after } = o.mmr(r);
  // The change is known once you queue again (the game logs MMR as you queue).
  const mmr = before
    ? mini(after !== undefined ? `MMR ${signed(after - before)}` : "MMR going in", round(after ?? before), after === undefined ? "" : after >= before ? "up" : "down")
    : "";
  return `
    <div class="you-card">
      <div class="you-name">${esc(me.name)}${mvp ? `<span class="pill gold">MVP</span>` : ""}</div>
      <div class="minis">
        ${mini("of team touches", `${pct(me.touches, teamTouches)}%`)}
        ${mini("top hit km/h", kmh(me.topHit))}
        ${b ? mini(b.exact ? "boost used" : "boost used (est.)", round(b.used), "boost") : mini("aerials", String(me.aerials))}
        ${b ? mini("boost / min", round(b.perMin), "boost") : ""}
        ${mmr}
      </div>
    </div>`;
}

// ---------- player breakdown ----------

interface Column {
  id: string;
  label: string;
  title: string;
  group: string;
  value: (p: PlayerLine) => number;
  format?: (v: number) => string;
  /** How the team row combines players. */
  team: (ps: PlayerLine[]) => number | null;
}

export const COLUMNS: Column[] = [
  { id: "touches", group: "Ball", label: "Touches", title: "Ball touches", value: (p) => p.touches, team: (ps) => sum(ps, (p) => p.touches) },
  { id: "aerials", group: "Ball", label: "Aerial", title: "Touches with the ball in the air", value: (p) => p.aerials, team: (ps) => sum(ps, (p) => p.aerials) },
  { id: "first", group: "Ball", label: "1st to ball", title: "Kickoffs where they touched the ball first", value: (p) => p.firstTouches, team: (ps) => sum(ps, (p) => p.firstTouches) },
  {
    id: "shotPct", group: "Shooting", label: "Shot %", title: "Goals per shot",
    value: (p) => (p.shots ? (p.goals / p.shots) * 100 : 0), format: (v) => (v ? `${Math.round(v)}%` : "–"),
    team: (ps) => { const s = sum(ps, (p) => p.shots); return s ? (sum(ps, (p) => p.goals) / s) * 100 : 0; },
  },
  {
    id: "avgHit", group: "Shooting", label: "Avg hit", title: "Average ball speed off a touch, km/h", value: avgHit, format: kmh,
    team: (ps) => { const h = sum(ps, (p) => p.hits); return h ? sum(ps, (p) => p.hitSum) / h : 0; },
  },
  { id: "topHit", group: "Shooting", label: "Top hit", title: "Hardest touch, km/h", value: (p) => p.topHit, format: kmh, team: (ps) => Math.max(0, ...ps.map((p) => p.topHit)) },
  {
    id: "hard", group: "Shooting",
    get label() { return `${speed(HARD_HIT)}+`; },
    get title() { return `Touches that sent the ball off at ${speed(HARD_HIT)} km/h or more`; }, value: (p) => p.hardHits, team: (ps) => sum(ps, (p) => p.hardHits) },
  { id: "bumps", group: "Physical", label: "Bumps", title: "Car-to-car contacts", value: (p) => p.bumps, team: (ps) => sum(ps, (p) => p.bumps) },
  { id: "demos", group: "Physical", label: "Demos", title: "Demolitions inflicted", value: (p) => p.demos, team: (ps) => sum(ps, (p) => p.demos) },
  { id: "demoed", group: "Physical", label: "Demoed", title: "Times demolished", value: (p) => p.demoed, team: (ps) => sum(ps, (p) => p.demoed) },
];
/** The zone split isn't a number column but can be toggled like one. */
export const ZONES_COLUMN = { id: "zones", group: "Position", label: "Def · Mid · Att %" };
export const DEFAULT_COLUMNS = [...COLUMNS.map((c) => c.id), ZONES_COLUMN.id];

function zoneBar(thirds: [number, number, number]): string {
  const total = thirds[0] + thirds[1] + thirds[2];
  if (!total) return `<td class="zones muted">–</td>`;
  const [d, m, a] = thirds.map((n) => (n / total) * 100);
  return `
    <td class="zones" title="Touches in defence / midfield / attack">
      <div class="zone-bar"><i class="z-def" style="width:${d}%"></i><i class="z-mid" style="width:${m}%"></i><i class="z-att" style="width:${a}%"></i></div>
      <span class="zone-text">${Math.round(d)} · ${Math.round(m)} · <b>${Math.round(a)}</b></span>
    </td>`;
}

/** A header row naming each run of columns from the same group. */
function groupRow(groups: string[], lead = 1): string {
  const runs: [string, number][] = [];
  for (const g of groups) {
    const last = runs[runs.length - 1];
    if (last && last[0] === g) last[1]++;
    else runs.push([g, 1]);
  }
  return `<tr class="groups"><th colspan="${lead}"></th>${runs.map(([g, n]) => `<th colspan="${n}"><span>${g}</span></th>`).join("")}</tr>`;
}

/** A small MMR tag for a player in a match. */
function mmrTag(r: MatchRecord, p: PlayerLine, o: ReportOptions): string {
  if (r.playlistId === undefined) return "";
  if (p.name === r.meName) {
    const { before } = o.mmr(r);
    return before ? `<span class="pill mmr" title="Your MMR going into this match">${round(before)}</span>` : "";
  }
  const shared = p.primaryId ? o.shared(p.primaryId)?.playlists[r.playlistId] : undefined;
  return shared ? `<span class="pill mmr shared" title="Shared by their overlay">${round(shared.mmr)}</span>` : "";
}

/** A player's name as a link to their player screen. */
const nameLink = (name: string, primaryId = "") =>
  `<button class="pname" data-player="${esc(name)}" data-pid="${esc(primaryId)}" tabindex="-1" title="Player details and RL Tracker">${esc(name)}</button>`;

function playerTags(r: MatchRecord, name: string, left: boolean) {
  const mvp = mvpName(r);
  return [
    name === r.meName ? `<span class="pill you">You</span>` : "",
    name === mvp ? `<span class="pill gold">MVP</span>` : "",
    left ? `<span class="pill muted-pill">Left</span>` : "",
  ].join("");
}

function breakdown(r: MatchRecord, columnIds: string[], o: ReportOptions): string {
  const players = Object.values(r.players);
  if (!players.length) return `<div class="empty-board muted">Waiting for match data</div>`;
  const cols = COLUMNS.filter((c) => columnIds.includes(c.id));
  const zones = columnIds.includes(ZONES_COLUMN.id);

  const leaders = cols.map((c) => Math.max(0, ...players.map(c.value)));
  const groups = [...cols.map((c) => c.group), ...(zones ? [ZONES_COLUMN.group] : [])];
  const head = `${groupRow(groups)}<tr class="cols"><th></th>${cols.map((c) => `<th title="${c.title}">${c.label}</th>`).join("")}${
    zones ? `<th title="Share of touches in each third of the field">${ZONES_COLUMN.label}</th>` : ""}</tr>`;

  const teamBlock = (team: 0 | 1) => {
    const members = teamOf(r, team).sort((a, b) => b.touches - a.touches);
    const teamThirds = [0, 1, 2].map((i) => sum(members, (p) => p.thirds[i])) as [number, number, number];
    const totals = cols.map((c) => {
      const v = members.length ? c.team(members) : null;
      return `<td>${v === null ? "" : c.format ? c.format(v) : v}</td>`;
    }).join("");

    const rows = members.map((p) => {
      const feats = Object.entries(p.feats)
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => (n > 1 ? `${esc(label)} ×${n}` : esc(label)))
        .join(" · ");
      const cells = cols.map((c, i) => {
        const v = c.value(p);
        const lead = v > 0 && v === leaders[i] ? " lead" : "";
        return `<td class="num${lead}">${c.format ? c.format(v) : v}</td>`;
      }).join("");
      return `
        <tr class="player ${p.name === r.meName ? "me" : ""} ${p.left ? "gone" : ""}">
          <td class="who">
            <div class="who-line">${nameLink(p.name, p.primaryId)}${mmrTag(r, p, o)}${playerTags(r, p.name, p.left)}${p.platform ? `<span class="platform">${p.platform}</span>` : ""}</div>
            ${feats ? `<div class="feats">${feats}</div>` : ""}
          </td>${cells}${zones ? zoneBar(p.thirds) : ""}
        </tr>`;
    }).join("");

    return `
      <tbody style="--team:${r.teams[team].color}">
        <tr class="team-row"><td class="who"><span class="team-chip"></span>${esc(r.teams[team].name)}</td>${totals}${zones ? zoneBar(teamThirds) : ""}</tr>
        ${rows || `<tr><td class="muted" colspan="${cols.length + 2}">No players</td></tr>`}
      </tbody>`;
  };

  return section("Players", `<table class="board">${`<thead>${head}</thead>`}${teamBlock(0)}${teamBlock(1)}</table>`);
}

// ---------- boost ----------

interface BoostColumn {
  label: string;
  title: string;
  group: string;
  value: (p: PlayerBoost) => number;
  format?: (v: number) => string;
}

const perMin = (p: PlayerBoost) => (p.time ? (p.used / p.time) * 60 : 0);
const share = (v: number) => `${Math.round(v * 100)}%`;
const BOOST_COLUMNS: BoostColumn[] = [
  { group: "Usage", label: "Used", title: "Total boost used", value: (p) => p.used, format: round },
  { group: "Usage", label: "Per min", title: "Boost used per minute", value: perMin, format: round },
  { group: "Usage", label: "In air", title: "Share of boost used while airborne", value: (p) => (p.used ? p.usedAirborne / p.used : 0), format: share },
  { group: "Usage", label: "Supersonic", title: "Share of boost used while already supersonic (often wasted)", value: (p) => (p.used ? p.usedSupersonic / p.used : 0), format: share },
  { group: "Collection", label: "Collected", title: "Total boost collected", value: (p) => p.collected, format: round },
  { group: "Collection", label: "Big", title: "Big pads (100)", value: (p) => p.bigPads },
  { group: "Collection", label: "Small", title: "Small pads (12)", value: (p) => p.smallPads },
  { group: "Collection", label: "Stolen", title: "Boost collected in the opponent's half", value: (p) => p.stolen, format: round },
  { group: "Level", label: "Avg", title: "Average boost level", value: (p) => (p.time ? p.levelSum / p.time : 0), format: round },
  { group: "Level", label: "At 0", title: "Share of time on empty", value: (p) => (p.time ? p.empty / p.time : 0), format: share },
  { group: "Level", label: "At 100", title: "Share of time full", value: (p) => (p.time ? p.full / p.time : 0), format: share },
];

function boostSection(r: MatchRecord): string {
  const exact = r.replayBoost;
  if (!exact?.length) {
    const est = myBoost(r);
    const how = card(
      "Exact boost for everyone",
      r.replay
        ? `<p class="muted">Reading the replay…</p>`
        : `<p class="how">Save the replay in Rocket League to fill this in.</p>`,
    );
    if (!est) {
      return section("Boost", `<div class="tab-grid boost-empty">${card("Your boost", `<p class="muted">No boost data for this match. Mark the boost meter in settings to track it live.</p>`)}${how}</div>`);
    }
    const b = r.boost!;
    const tile = (label: string, value: string) => `<div class="yg-stat boost-tile"><b>${value}</b><span>${label}</span></div>`;
    return section(
      "Boost",
      `<div class="tab-grid boost-empty">
         ${card("Your boost (read from the screen)", `<div class="yg-grid">
           ${tile("Used", round(est.used))}
           ${tile("Per minute", round(est.perMin))}
           ${tile("Collected", round(b.collected))}
           ${tile("Average level", round(est.avg))}
           ${tile("Time at 0", share(b.time ? b.empty / b.time : 0))}
           ${tile("Time at 100", share(b.time ? b.full / b.time : 0))}
         </div>`)}
         ${how}
       </div>`,
    );
  }

  const leaders = BOOST_COLUMNS.map((c) => Math.max(0, ...exact.map(c.value)));
  const head = `${groupRow(BOOST_COLUMNS.map((c) => c.group))}<tr class="cols"><th></th>${BOOST_COLUMNS.map((c) => `<th title="${c.title}">${c.label}</th>`).join("")}</tr>`;
  const teamBlock = (team: 0 | 1) => {
    const members = exact.filter((p) => p.team === team).sort((a, b) => b.used - a.used);
    const rows = members.map((p) => {
      const cells = BOOST_COLUMNS.map((c, i) => {
        const v = c.value(p);
        const lead = v > 0 && v === leaders[i] ? " lead" : "";
        return `<td class="num${lead}">${c.format ? c.format(v) : v}</td>`;
      }).join("");
      return `<tr class="player ${p.name === r.meName ? "me" : ""}"><td class="who"><div class="who-line">${nameLink(p.name, r.players[p.name]?.primaryId)}${playerTags(r, p.name, false)}</div></td>${cells}</tr>`;
    }).join("");
    const totals = BOOST_COLUMNS.map((c) =>
      c.format === share || c.label === "Avg" || c.label === "Per min" ? "<td></td>" : `<td>${(c.format ?? String)(sum(members, c.value))}</td>`,
    ).join("");
    return `<tbody style="--team:${r.teams[team].color}">
      <tr class="team-row"><td class="who"><span class="team-chip"></span>${esc(r.teams[team].name)}</td>${totals}</tr>${rows}</tbody>`;
  };

  // How far off the live screen reading was, so you can judge it.
  const mine = exact.find((p) => p.name === r.meName);
  const compare = mine && r.boost && r.boost.used > 0
    ? ` · the screen reader estimated ${round(r.boost.used)} for you (${r.boost.used >= mine.used ? "+" : ""}${Math.round(((r.boost.used - mine.used) / mine.used) * 100)}%)`
    : "";
  return section(
    "Boost",
    `<table class="board boost-board"><thead>${head}</thead>${teamBlock(0)}${teamBlock(1)}</table>
     ${compare ? `<p class="foot">${compare.replace(/^ · /, "")}</p>` : ""}`,
  );
}

// ---------- touch map ----------

function touchMap(r: MatchRecord): string {
  // Seen from above with blue's goal on the left: SVG x is the field's Y axis, and
  // because the game's axes are left-handed, field +X points up the screen.
  const dots = r.hits.map((h) => {
    const me = h.name === r.meName;
    return `<circle cx="${h.y}" cy="${-h.x}" r="${me ? 120 : 95}" fill="${r.teams[h.team]?.color ?? "#888"}" class="${me ? "dot-me" : ""}" />`;
  }).join("");
  const blueAtt = r.hits.filter((h) => h.team === 0 && h.y > 0).length;
  const orangeAtt = r.hits.filter((h) => h.team === 1 && h.y < 0).length;
  const blueTotal = r.hits.filter((h) => h.team === 0).length;
  const orangeTotal = r.hits.filter((h) => h.team === 1).length;

  return card(
    "Touch map",
    `<svg class="pitch" viewBox="-6000 -4300 12000 8600">
       <rect x="-5120" y="-4096" width="10240" height="8192" rx="1150" class="field" />
       <line x1="0" y1="-4096" x2="0" y2="4096" class="mark" />
       <line x1="-1707" y1="-4096" x2="-1707" y2="4096" class="mark third" />
       <line x1="1707" y1="-4096" x2="1707" y2="4096" class="mark third" />
       <circle cx="0" cy="0" r="900" class="mark ring" />
       <rect x="-5900" y="-893" width="780" height="1786" class="goal" style="stroke:${r.teams[0].color}" />
       <rect x="5120" y="-893" width="780" height="1786" class="goal" style="stroke:${r.teams[1].color}" />
       ${dots}
     </svg>
     <p class="foot">Touches in the opponent's half: ${esc(r.teams[0].name)} ${pct(blueAtt, blueTotal)}% · ${esc(r.teams[1].name)} ${pct(orangeAtt, orangeTotal)}%${
       r.meName ? ` · <span class="me-key"></span> you` : ""}</p>`,
  );
}

// ---------- momentum + goal mouth ----------

function momentum(r: MatchRecord): string {
  const W = 300;
  const H = 90;
  const mid = H / 2;
  const slots = Math.max(r.momentum.length, Math.ceil((r.length || 300) / MOMENTUM_BUCKET));
  const bw = W / slots;
  const span = slots * MOMENTUM_BUCKET;
  const watchable = !!r.replay;

  const bars = r.momentum.map(([a, b], i) => {
    const total = a + b;
    if (!total) return "";
    const lean = (a / total - 0.5) * 2; // +1 all blue, -1 all orange
    const h = Math.abs(lean) * (mid - 10);
    const color = lean >= 0 ? r.teams[0].color : r.teams[1].color;
    const y = lean >= 0 ? mid - h : mid;
    return `<rect x="${i * bw + 1}" y="${y}" width="${Math.max(bw - 2, 1)}" height="${Math.max(h, 1)}" rx="1.5" fill="${color}" />`;
  }).join("");

  // Goal markers are HTML buttons over the chart, so they can be clicked and
  // aren't stretched by the SVG's non-uniform scaling.
  const markers = r.goals.map((g, i) => {
    const x = Math.min(98.5, (g.at / span) * 100);
    const label = `${esc(g.scorer)} ${clockLabel(g.clock, g.overtime)}${watchable ? " · click to watch" : ""}`;
    return `<button class="g-marker ${g.team === 0 ? "top" : "bottom"} ${watchable ? "watch" : ""}" style="left:${x}%;--team:${r.teams[g.team].color}"
      data-goal="${i}" title="${label}" tabindex="-1"></button>`;
  }).join("");
  const ticks = r.goals.map((g) => {
    const x = Math.min(W - 4, (g.at / span) * W);
    return `<line x1="${x}" y1="${mid}" x2="${x}" y2="${g.team === 0 ? 5 : H - 5}" class="g-tick" />`;
  }).join("");

  const regEnd = r.overtime && r.length ? `<line x1="${(r.length / span) * W}" y1="0" x2="${(r.length / span) * W}" y2="${H}" class="ot-line" />` : "";
  const possTotal = r.possession[0] + r.possession[1];

  return `
    <div class="momentum-wrap">
      <svg class="momentum" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" class="mid-line" />${regEnd}${bars}${ticks}
      </svg>${markers}
    </div>
    <div class="axis"><span>0:00</span><span>${r.overtime ? "OT" : ""}</span><span>${mmss(span)}</span></div>
    <p class="poss">Possession <b style="color:${r.teams[0].color}">${pct(r.possession[0], possTotal)}%</b> – <b style="color:${r.teams[1].color}">${pct(r.possession[1], possTotal)}%</b></p>`;
}

function goalMouth(r: MatchRecord): string {
  // Goal is 1786 uu wide and 643 tall; z is flipped so the ground is at the bottom.
  const dots = r.goals.map((g) =>
    `<circle cx="${Math.max(-880, Math.min(880, g.mouthX))}" cy="${643 - Math.max(0, Math.min(643, g.mouthZ))}" r="48" fill="${r.teams[g.team].color}" class="${g.scorer === r.meName ? "dot-me" : ""}" />`,
  ).join("");
  return `
    <svg class="mouth" viewBox="-1000 -40 2000 720">
      <path d="M -893 643 L -893 0 L 893 0 L 893 643" class="posts" />
      <line x1="-1000" y1="643" x2="1000" y2="643" class="ground" />
      <line x1="-298" y1="0" x2="-298" y2="643" class="net" /><line x1="298" y1="0" x2="298" y2="643" class="net" />
      <line x1="-893" y1="321" x2="893" y2="321" class="net" />
      ${dots}
    </svg>
`;
}

const watchHint = (_r: MatchRecord) => "";

// ---------- head to head ----------

function headToHead(r: MatchRecord): string {
  const [blue, orange] = [teamOf(r, 0), teamOf(r, 1)];
  const both = (f: (ps: PlayerLine[]) => number): [number, number] => [f(blue), f(orange)];
  const teamAvgHit = (ps: PlayerLine[]) => { const h = sum(ps, (p) => p.hits); return h ? Math.round(sum(ps, (p) => p.hitSum) / h) : 0; };
  const attack = (ps: PlayerLine[]) => {
    const t = sum(ps, (p) => p.thirds[0] + p.thirds[1] + p.thirds[2]);
    return pct(sum(ps, (p) => p.thirds[2]), t);
  };
  const possTotal = r.possession[0] + r.possession[1];
  const teamBoost = (team: number) => Math.round(sum((r.replayBoost ?? []).filter((p) => p.team === team), (p) => p.used));

  const rows: [string, [number, number], (v: number) => string][] = [
    ["Possession", [pct(r.possession[0], possTotal), pct(r.possession[1], possTotal)], (v) => `${v}%`],
    ["Touches in attack", both(attack), (v) => `${v}%`],
    ["Touches", both((ps) => sum(ps, (p) => p.touches)), String],
    ["Aerials", both((ps) => sum(ps, (p) => p.aerials)), String],
    ["First to ball", [r.firstTouches[0], r.firstTouches[1]], String],
    ["Avg hit km/h", both(teamAvgHit), (v) => String(speed(v))],
    [`${speed(HARD_HIT)}+ km/h hits`, both((ps) => sum(ps, (p) => p.hardHits)), String],
    ...(r.replayBoost?.length ? [["Boost used", [teamBoost(0), teamBoost(1)], round] as [string, [number, number], (v: number) => string]] : []),
    ["Bumps", both((ps) => sum(ps, (p) => p.bumps)), String],
    ["Demos", both((ps) => sum(ps, (p) => p.demos)), String],
    ["Crossbars", r.crossbars, String],
  ];

  const bars = rows.map(([label, [a, b], fmt]) => {
    const total = a + b;
    const left = total ? (a / total) * 100 : 50;
    return `
      <div class="cmp">
        <span class="cmp-val ${a > b ? "ahead" : ""}">${fmt(a)}</span>
        <div class="cmp-mid">
          <span class="cmp-label">${label}</span>
          <div class="cmp-bar"><i style="width:${left}%;background:${r.teams[0].color}"></i><i style="width:${100 - left}%;background:${r.teams[1].color}"></i></div>
        </div>
        <span class="cmp-val right ${b > a ? "ahead" : ""}">${fmt(b)}</span>
      </div>`;
  }).join("");

  const ballAvg = r.ballTime ? r.ballSpeedSum / r.ballTime : 0;
  return card("Head to head", `${bars}<p class="foot">Ball speed avg ${speed(ballAvg)} km/h · top ${speed(r.ballTop)} km/h</p>`);
}

const card = (title: string, body: string) => `<section class="card"><h3>${title}</h3>${body}</section>`;
/** Tab content; the tab bar already names it. */
const section = (_title: string, body: string) => `<div class="tab-body">${body}</div>`;

// ---------- all matches ----------

/** Your boost for a match: exact from its replay, else the screen estimate. */
const boostFor = (r: MatchRecord) => myBoost(r);

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function matchesView(entries: ReportEntry[], o: ReportOptions): string {
  if (!entries.length) return `<p class="muted empty-board">No matches yet.</p>`;
  let lastDay = "";
  const rows = entries.map((e, i) => {
    const r = e.record;
    const when = r.endedAt ?? r.startedAt;
    const day = e.live ? "Now" : dayLabel(when);
    const heading = day !== lastDay ? `<tr class="day"><td colspan="9">${day}</td></tr>` : "";
    lastDay = day;
    const { text, tone } = resultLabel(r, e.live);
    const me = r.meName ? r.players[r.meName] : undefined;
    const teamTouches = me ? sum(teamOf(r, me.team), (p) => p.touches) : 0;
    const b = boostFor(r);
    return `${heading}
      <tr class="m-row" data-open="${i}">
        <td class="m-time">${e.live ? "Live" : timeOfDay(when)}</td>
        <td><span class="result ${tone}">${text}</span></td>
        <td>${esc(playlistName(r.playlistId))}<span class="muted"> · ${esc(arenaName(r.arena))}</span></td>
        <td class="num">${mmss(duration(r))}</td>
        <td class="num">${me ? `${pct(me.touches, teamTouches)}%` : "–"}</td>
        <td class="num">${me ? kmh(me.topHit) : "–"}</td>
        <td class="num">${b ? `${round(b.used)}${b.exact ? "" : "<sup>est</sup>"}` : "–"}</td>
        <td class="num">${(() => {
          const { before, after } = o.mmr(r);
          if (before === undefined) return "–";
          if (after === undefined) return round(before);
          return `<span class="${after >= before ? "win-text" : "loss-text"}">${signed(after - before)}</span>`;
        })()}</td>
        <td class="m-replay">${r.replay ? `<span class="has-replay" title="Replay saved"></span>Replay` : ""}</td>
      </tr>`;
  }).join("");
  return `
    <div class="matches-scroll">
      <table class="board matches">
        <thead><tr class="cols"><th>Time</th><th>Result</th><th>Playlist</th><th>Length</th><th>Team touches</th><th>Top hit</th><th>Boost used</th><th>MMR</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
`;
}

// ---------- player screen ----------

/** MMR per playlist: yours from the game log, anyone else's if they share it. */
function mmrStrip(isMe: boolean, pid: string, o: ReportOptions): string {
  const items: { playlist: number; mmr: number }[] = [];
  if (isMe) {
    const seen = new Set<number>();
    for (let i = o.readings.length - 1; i >= 0; i--) {
      const r = o.readings[i];
      if (seen.has(r.playlist)) continue;
      seen.add(r.playlist);
      items.push({ playlist: r.playlist, mmr: latestReading(o.readings, r.playlist)!.mmr });
    }
  } else {
    const shared = pid ? o.shared(pid) : null;
    for (const [playlist, v] of Object.entries(shared?.playlists ?? {})) items.push({ playlist: Number(playlist), mmr: v.mmr });
  }
  if (!items.length) return "";
  items.sort((a, b) => a.playlist - b.playlist);
  return `<div class="mmr-strip">${items
    .map((i) => `<div class="mmr-item"><b>${round(i.mmr)}</b><span>${esc(playlistName(i.playlist))}</span></div>`)
    .join("")}<em>${isMe ? "From your game log" : "Shared by their overlay"}</em></div>`;
}

/** Key for a player's saved tracker correction. */
export const overrideKey = (name: string, primaryId: string) => primaryId || name;

function playerView(view: Extract<ReportView, { kind: "player" }>, entries: ReportEntry[], o: ReportOptions): string {
  const overrides = o.trackerOverrides;
  const games = entries
    .map((e, i) => ({ e, i, p: e.record.players[view.name] }))
    .filter((g): g is { e: ReportEntry; i: number; p: PlayerLine } => !!g.p);
  const isMe = games.some((g) => g.e.record.meName === view.name);
  const pid = view.primaryId || games.find((g) => g.p.primaryId)?.p.primaryId || "";
  const key = overrideKey(view.name, pid);
  const override = overrides[key] ?? overrides[view.name];
  const candidates = trackerCandidates(view.name, pid, override);
  const anonymised = isAnonymised(view.name) && !override;
  const platform = platformName(pid);

  const finished = games.filter((g) => g.e.record.winner !== null);
  const relation = (g: (typeof games)[number]) =>
    g.e.record.myTeam === null || isMe ? null : g.p.team === g.e.record.myTeam ? "with" : "against";
  const record = (kind: "with" | "against") => {
    const list = finished.filter((g) => relation(g) === kind);
    const wins = list.filter((g) => g.e.record.winner === g.e.record.myTeam).length;
    return { n: list.length, wins, losses: list.length - wins };
  };
  const together = record("with");
  const against = record("against");

  const avg = (f: (p: PlayerLine) => number) => (games.length ? sum(games, (g) => f(g.p)) / games.length : 0);
  const boostGames = games
    .map((g) => g.e.record.replayBoost?.find((b) => b.name === view.name))
    .filter((b): b is PlayerBoost => !!b && b.time > 0);
  const bpm = boostGames.length ? sum(boostGames, (b) => (b.used / b.time) * 60) / boostGames.length : null;

  const stat = (label: string, value: string, sub = "") =>
    `<div class="p-stat"><b>${value}</b><span>${label}</span>${sub ? `<em>${sub}</em>` : ""}</div>`;
  const wl = (r: { n: number; wins: number; losses: number }) =>
    r.n ? `<span class="win-text">${r.wins}W</span> <span class="loss-text">${r.losses}L</span>` : "–";

  const rows = games.slice(0, 8).map((g) => {
    const r = g.e.record;
    const { text, tone } = resultLabel(r, g.e.live);
    const rel = relation(g);
    const b = r.replayBoost?.find((x) => x.name === view.name);
    return `<tr class="m-row" data-open="${g.i}">
      <td class="m-time">${g.e.live ? "Live" : `${dayLabel(r.endedAt ?? r.startedAt)} ${timeOfDay(r.endedAt ?? r.startedAt)}`}</td>
      <td><span class="result ${tone}">${text}</span></td>
      <td>${rel === "with" ? "Teammate" : rel === "against" ? "Opponent" : isMe ? "You" : "–"}</td>
      <td class="num">${g.p.touches}</td><td class="num">${g.p.aerials}</td><td class="num">${kmh(g.p.topHit)}</td>
      <td class="num">${b ? round(b.used) : "–"}</td>
    </tr>`;
  }).join("");

  return `
    <header class="p-head">
      <div>
        <div class="kicker">${platform || "Player"}${isMe ? " · you" : ""}${anonymised ? " · name hidden" : ""}</div>
        <div class="p-name">${esc(view.name)}</div>
        <div class="meta">${games.length} of your saved matches${isMe ? "" : ` · ${together.n} together, ${against.n} against`}</div>
      </div>
      <button class="nav-btn" data-tracker="${esc(view.name)}" data-pid="${esc(pid)}" tabindex="-1">Open RL Tracker in a window</button>
    </header>
    ${mmrStrip(isMe, pid, o)}
    <div class="p-layout">
    <div class="p-left">
    <div class="p-stats">
      ${isMe ? "" : stat("As your teammate", wl(together), together.n ? `${pct(together.wins, together.n)}% win rate` : "")}
      ${isMe ? "" : stat("As your opponent", wl(against), against.n ? `you won ${pct(against.wins, against.n)}%` : "")}
      ${stat("Touches / game", avg((p) => p.touches).toFixed(1))}
      ${stat("Aerials / game", avg((p) => p.aerials).toFixed(1))}
      ${stat("Avg hit km/h", kmh(avg((p) => (p.hits ? p.hitSum / p.hits : 0))))}
      ${stat("Top hit km/h", kmh(Math.max(0, ...games.map((g) => g.p.topHit))))}
      ${stat("Demos / game", avg((p) => p.demos).toFixed(1))}
      ${stat("Boost / min", bpm === null ? "–" : round(bpm), bpm === null ? "needs saved replays" : `from ${boostGames.length} replay${boostGames.length === 1 ? "" : "s"}`)}
    </div>
    ${rows ? `<section class="block"><h3>${isMe ? "Your recent matches" : `Matches with ${esc(view.name)}`}</h3>
      <table class="board matches">
        <thead><tr class="cols"><th>When</th><th>Result</th><th>Role</th><th>Touches</th><th>Aerials</th><th>Top hit</th><th>Boost used</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></section>` : ""}
    </div>
    <div class="p-right">
      <div class="tracker-slot" id="tracker-slot" data-candidates="${esc(JSON.stringify(candidates))}">
        <b>Rank and MMR</b>
        ${candidates.length
          ? `<p class="muted">Loading RL Tracker's page for ${esc(view.name)}…</p>`
          : `<p class="muted">Name hidden by Rocket League.</p>`}
      </div>
      <form class="override" data-key="${esc(key)}" autocomplete="off">
        <span class="muted">${override ? "Saved profile" : "Wrong profile?"}</span>
        <select name="platform" tabindex="-1">
          ${(["epic", "steam", "psn", "xbl", "switch"] as const).map((p) => `<option value="${p}" ${override?.platform === p ? "selected" : ""}>${{ epic: "Epic", steam: "Steam ID", psn: "PlayStation", xbl: "Xbox", switch: "Switch" }[p]}</option>`).join("")}
        </select>
        <input name="handle" placeholder="Name on that platform" value="${esc(override?.handle ?? "")}" spellcheck="false" />
        <button class="nav-btn" type="submit" tabindex="-1">Save</button>
        ${override ? `<button class="link" type="button" data-clear-override="${esc(key)}" tabindex="-1">Undo</button>` : ""}
      </form>
    </div>
    </div>`;
}

// ---------- tabs ----------

/** Your numbers, each with where it placed among everyone in the lobby. */
function yourGame(r: MatchRecord): string {
  const me = r.meName ? r.players[r.meName] : undefined;
  if (!me) return card("Your game", `<p class="muted">Set your in-game name in settings to see your game here.</p>`);
  const players = Object.values(r.players);
  const teamTouches = (p: PlayerLine) => sum(teamOf(r, p.team), (q) => q.touches);
  const attack = (p: PlayerLine) => { const t = p.thirds[0] + p.thirds[1] + p.thirds[2]; return t ? p.thirds[2] / t : 0; };
  const exact = r.replayBoost ?? [];
  const bpmOf = (name: string) => { const b = exact.find((x) => x.name === name); return b && b.time ? (b.used / b.time) * 60 : null; };

  const stats: { label: string; value: (p: PlayerLine) => number | null; fmt: (v: number) => string; lowerIsBetter?: boolean }[] = [
    { label: "Touches", value: (p) => p.touches, fmt: String },
    { label: "Share of team touches", value: (p) => (teamTouches(p) ? p.touches / teamTouches(p) : 0), fmt: (v) => `${Math.round(v * 100)}%` },
    { label: "Aerial touches", value: (p) => p.aerials, fmt: String },
    { label: "First to ball", value: (p) => p.firstTouches, fmt: String },
    { label: "Avg hit km/h", value: avgHit, fmt: kmh },
    { label: "Top hit km/h", value: (p) => p.topHit, fmt: kmh },
    { label: "Touches in attack", value: attack, fmt: (v) => `${Math.round(v * 100)}%` },
    { label: "Demos", value: (p) => p.demos, fmt: String },
    { label: "Times demoed", value: (p) => p.demoed, fmt: String, lowerIsBetter: true },
    ...(exact.length ? [{ label: "Boost / min", value: (p: PlayerLine) => bpmOf(p.name), fmt: round }] : []),
  ];

  const tiles = stats.map((st) => {
    const mine = st.value(me);
    if (mine === null) return "";
    const values = players.map(st.value).filter((v): v is number => v !== null);
    const better = values.filter((v) => (st.lowerIsBetter ? v < mine : v > mine)).length;
    const place = better + 1;
    const top = place === 1 && values.length > 1;
    return `<div class="yg-stat ${top ? "top" : ""}"><b>${st.fmt(mine)}</b><span>${st.label}</span><em>${top ? "Best in lobby" : `${ordinal(place)} of ${values.length}`}</em></div>`;
  }).join("");
  return card("Your game", `<div class="yg-grid">${tiles}</div>`);
}

const ordinal = (n: number) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
};

/** Goals at a glance: the momentum chart and the goal list in one card. */
function goalsCompact(r: MatchRecord): string {
  if (!r.goals.length) return card("Goals", `${momentum(r)}<p class="muted">No goals yet</p>`);
  const rows = r.goals.slice(-6).map((g) => goalRow(r, g, r.goals.indexOf(g))).join("");
  return card("Goals", `${momentum(r)}<ol class="goals">${rows}</ol>${watchHint(r)}`);
}

function goalRow(r: MatchRecord, g: MatchRecord["goals"][number], i: number): string {
  const watchable = !!r.replay;
  return `
    <li style="--team:${r.teams[g.team].color}" data-goal="${i}" class="${watchable ? "watch" : ""}" title="${watchable ? "Click to watch in the replay" : ""}">
      <span class="g-clock">${clockLabel(g.clock, g.overtime)}</span>
      <span class="g-dot"></span>
      <span class="g-who"><b>${esc(g.scorer)}</b>
        <em>${g.assist ? `from ${esc(g.assist)} · ` : ""}${Math.round(g.playLength)}s play</em></span>
      <span class="g-speed">${speed(g.speed)}<small>km/h</small></span>
    </li>`;
}

function overviewTab(r: MatchRecord): string {
  return `<div class="tab-grid overview">${yourGame(r)}${headToHead(r)}${goalsCompact(r)}</div>`;
}

function goalsTab(r: MatchRecord): string {
  const list = r.goals.length
    ? `<ol class="goals">${r.goals.map((g, i) => goalRow(r, g, i)).join("")}</ol>`
    : `<p class="muted">No goals yet</p>`;
  const fastest = r.goals.length ? r.goals.reduce((a, b) => (b.speed > a.speed ? b : a)) : null;
  const quickest = r.goals.length ? r.goals.reduce((a, b) => (b.playLength < a.playLength ? b : a)) : null;
  return `
    <div class="tab-grid goals-tab">
      ${card("Momentum", `<div class="big-momentum">${momentum(r)}</div>${watchHint(r)}`)}
      ${card("Every goal", `${list}${fastest && quickest ? `<p class="foot">Hardest <b>${esc(fastest.scorer)}</b> ${speed(fastest.speed)} km/h · quickest <b>${esc(quickest.scorer)}</b> ${Math.round(quickest.playLength)}s</p>` : ""}`)}
      ${card("Where they went in", r.goals.length ? goalMouth(r) : `<p class="muted">No goals yet</p>`)}
    </div>`;
}

function fieldTab(r: MatchRecord): string {
  const players = [0, 1].flatMap((t) => teamOf(r, t).sort((a, b) => b.touches - a.touches));
  const rows = players.map((p) => {
    const total = p.thirds[0] + p.thirds[1] + p.thirds[2];
    const [d, m, a] = p.thirds.map((n) => (total ? (n / total) * 100 : 0));
    return `<div class="zone-row" style="--team:${r.teams[p.team].color}">
      <span class="zone-name">${nameLink(p.name, p.primaryId)}</span>
      <div class="zone-bar"><i class="z-def" style="width:${d}%"></i><i class="z-mid" style="width:${m}%"></i><i class="z-att" style="width:${a}%"></i></div>
      <span class="zone-text">${Math.round(d)} · ${Math.round(m)} · <b>${Math.round(a)}</b></span>
    </div>`;
  }).join("");
  return `
    <div class="tab-grid field-tab">
      ${touchMap(r)}
      ${card("Def · Mid · Att", rows)}
    </div>`;
}

export interface TabDef {
  id: string;
  label: string;
  render: (r: MatchRecord, o: ReportOptions) => string;
}

export const TABS: TabDef[] = [
  { id: "overview", label: "Overview", render: overviewTab },
  { id: "players", label: "Players", render: (r, o) => breakdown(r, o.columns, o) },
  { id: "boost", label: "Boost", render: boostSection },
  { id: "goals", label: "Goals", render: goalsTab },
  { id: "field", label: "Field", render: fieldTab },
];
export const DEFAULT_TABS = TABS.map((t) => t.id);

export function renderReport(
  entries: ReportEntry[],
  index: number,
  s: Session,
  o: ReportOptions,
  view: ReportView = { kind: "match" },
): string {
  const hint = o.clicksPaused
    ? ""
    : `<footer class="hint">${o.notice ? `<b>${esc(o.notice)}</b>` : "Hold Ctrl to click"}</footer>`;
  if (view.kind === "matches") return withUnitLabels(`${topBar(view, entries, s, "All matches")}${matchesView(entries, o)}${hint}`);
  if (view.kind === "player") return withUnitLabels(`${topBar(view, entries, s, "Player")}${playerView(view, entries, o)}${hint}`);

  const entry = entries[index];
  if (!entry) {
    return `${topBar(view, entries, s, "")}<header class="head"><div class="verdict-block"><div class="verdict">No matches yet</div>
      <div class="meta">The report fills in once a match starts.</div></div></header>${hint}`;
  }
  const r = entry.record;
  const tabs = TABS.filter((t) => o.tabs.includes(t.id)).sort((a, b) => o.tabs.indexOf(a.id) - o.tabs.indexOf(b.id));
  const open = tabs.find((t) => t.id === o.tab) ?? tabs[0];
  const bar = tabs
    .map((t) => `<button class="r-tab ${t === open ? "on" : ""}" data-tab="${t.id}" tabindex="-1">${t.label}${
      t.id === "boost" && r.replayBoost?.length ? `<span class="has-replay" title="Exact, from the replay"></span>` : ""}</button>`)
    .join("");

  const title = `${resultLabel(r, entry.live).text} · ${esc(playlistName(r.playlistId))} · ${entry.live ? "now" : `${dayLabel(r.endedAt ?? r.startedAt)} ${timeOfDay(r.endedAt ?? r.startedAt)}`}`;
  return withUnitLabels(`${topBar(view, entries, s, title)}${header(r, entry.live, o)}
    <nav class="r-tabs">${bar}</nav>
    <div class="tab-content">${open ? open.render(r, o) : `<p class="muted">All tabs are hidden in settings.</p>`}</div>
    ${hint}`);
}
