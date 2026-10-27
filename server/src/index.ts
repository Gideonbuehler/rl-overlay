// Shared MMR for RL Overlay users.
//
// Overlays that opt in report their own MMR (read from the game's log when
// they queue solo); any overlay can look players up by platform id. There are
// no accounts: the first overlay to report an id claims it with a random
// secret token, and only that token can update or delete it afterwards.
//
//   POST   /v1/mmr               { primaryId, name, playlist, mmr, at }   Authorization: Bearer <token>
//   GET    /v1/players?ids=a,b   up to 10 ids
//   DELETE /v1/me                { primaryId }                            Authorization: Bearer <token>

export interface Env {
  DB: D1Database;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (status: number, error: string) => json({ error }, status);

/** "Platform|Id|Splitscreen", as the Stats API and replays write them. */
const ID = /^[A-Za-z0-9]{2,16}\|[A-Za-z0-9._-]{1,64}\|\d{1,2}$/;
const MAX_LOOKUP = 10;

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(req: Request): string | null {
  const m = /^Bearer ([A-Za-z0-9]{32,128})$/.exec(req.headers.get("Authorization") ?? "");
  return m ? m[1] : null;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("Content-Length") ?? 0) > 2048) return null;
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The game logs "2026-10-24 13:23:52" in UTC. */
function parseAt(at: unknown): number | null {
  if (typeof at !== "string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(at)) return null;
  const ms = Date.parse(`${at.replace(" ", "T")}Z`);
  const now = Date.now();
  // Readings from the last 30 days, allowing an hour of clock drift ahead.
  return Number.isFinite(ms) && ms > now - 30 * 86_400_000 && ms < now + 3_600_000 ? ms : null;
}

/** Checks the token against the id's claim, claiming it if it's new. */
async function claim(env: Env, primaryId: string, name: string, token: string): Promise<boolean> {
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT token_hash FROM players WHERE primary_id = ?").bind(primaryId).first<{ token_hash: string }>();
  const now = Date.now();
  if (!row) {
    await env.DB.prepare("INSERT INTO players (primary_id, name, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(primaryId, name, hash, now, now)
      .run();
    return true;
  }
  if (row.token_hash !== hash) return false;
  await env.DB.prepare("UPDATE players SET name = ?, updated_at = ? WHERE primary_id = ?").bind(name, now, primaryId).run();
  return true;
}

async function report(req: Request, env: Env) {
  const token = bearer(req);
  if (!token) return fail(401, "missing token");
  const body = await readBody(req);
  if (!body) return fail(400, "bad body");

  const { primaryId, name, playlist, mmr } = body;
  const at = parseAt(body.at);
  if (typeof primaryId !== "string" || !ID.test(primaryId)) return fail(400, "bad primaryId");
  if (typeof name !== "string" || !name.trim() || name.length > 64) return fail(400, "bad name");
  if (!Number.isInteger(playlist) || (playlist as number) < 1 || (playlist as number) > 200) return fail(400, "bad playlist");
  if (typeof mmr !== "number" || mmr < 0 || mmr > 3000) return fail(400, "bad mmr");
  if (at === null) return fail(400, "bad at");

  if (!(await claim(env, primaryId, name.trim(), token))) return fail(403, "this id is claimed by another overlay");

  const rounded = Math.round(mmr);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO mmr (primary_id, playlist, mmr, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (primary_id, playlist) DO UPDATE SET mmr = excluded.mmr, at = excluded.at WHERE excluded.at > mmr.at`,
    ).bind(primaryId, playlist, rounded, at),
    env.DB.prepare("INSERT OR IGNORE INTO mmr_history (primary_id, playlist, mmr, at) VALUES (?, ?, ?, ?)").bind(primaryId, playlist, rounded, at),
  ]);
  return json({ ok: true });
}

async function lookup(url: URL, env: Env) {
  const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => ID.test(s)))].slice(0, MAX_LOOKUP);
  if (!ids.length) return json({ players: {} });
  const marks = ids.map(() => "?").join(",");
  const [players, rows] = await Promise.all([
    env.DB.prepare(`SELECT primary_id, name, updated_at FROM players WHERE primary_id IN (${marks})`).bind(...ids).all<{ primary_id: string; name: string; updated_at: number }>(),
    env.DB.prepare(`SELECT primary_id, playlist, mmr, at FROM mmr WHERE primary_id IN (${marks})`).bind(...ids).all<{ primary_id: string; playlist: number; mmr: number; at: number }>(),
  ]);
  const out: Record<string, { name: string; updatedAt: number; playlists: Record<string, { mmr: number; at: number }> }> = {};
  for (const p of players.results) out[p.primary_id] = { name: p.name, updatedAt: p.updated_at, playlists: {} };
  for (const r of rows.results) out[r.primary_id]?.playlists && (out[r.primary_id].playlists[r.playlist] = { mmr: r.mmr, at: r.at });
  return json({ players: out }, 200);
}

async function forget(req: Request, env: Env) {
  const token = bearer(req);
  const body = await readBody(req);
  const primaryId = body?.primaryId;
  if (!token || typeof primaryId !== "string" || !ID.test(primaryId)) return fail(400, "bad request");
  const row = await env.DB.prepare("SELECT token_hash FROM players WHERE primary_id = ?").bind(primaryId).first<{ token_hash: string }>();
  if (!row) return json({ ok: true });
  if (row.token_hash !== (await sha256(token))) return fail(403, "not yours");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mmr_history WHERE primary_id = ?").bind(primaryId),
    env.DB.prepare("DELETE FROM mmr WHERE primary_id = ?").bind(primaryId),
    env.DB.prepare("DELETE FROM players WHERE primary_id = ?").bind(primaryId),
  ]);
  return json({ ok: true });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === "/v1/mmr" && req.method === "POST") return await report(req, env);
      if (url.pathname === "/v1/players" && req.method === "GET") return await lookup(url, env);
      if (url.pathname === "/v1/me" && req.method === "DELETE") return await forget(req, env);
      if (url.pathname === "/") return json({ service: "rl-overlay shared MMR" });
      return fail(404, "not found");
    } catch (e) {
      console.error(e);
      return fail(500, "server error");
    }
  },
};
