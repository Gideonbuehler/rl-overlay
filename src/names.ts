// Friendly names for the API's playlist ids and arena asset names. Anything
// unknown falls back to a tidied-up version of the raw value.

const PLAYLISTS: Record<number, string> = {
  1: "Duel",
  2: "Doubles",
  3: "Standard",
  4: "Chaos",
  6: "Private Match",
  7: "Season",
  8: "Exhibition",
  9: "Training",
  10: "Ranked Duel",
  11: "Ranked Doubles",
  13: "Ranked Standard",
  15: "Snow Day",
  16: "Rocket Labs",
  17: "Hoops",
  18: "Rumble",
  19: "Workshop",
  22: "Tournament",
  23: "Dropshot",
  27: "Ranked Hoops",
  28: "Ranked Rumble",
  29: "Ranked Dropshot",
  30: "Ranked Snow Day",
  34: "Tournament",
  38: "Heatseeker",
};

export const playlistName = (id: number | undefined) =>
  id === undefined ? "Match" : PLAYLISTS[id] ?? `Playlist ${id}`;

// Matched against the start of the lowercased asset name, longest first.
const ARENAS: [string, string][] = [
  ["stadium", "DFH Stadium"],
  ["eurostadium", "Mannfield"],
  ["park", "Beckwith Park"],
  ["trainstation", "Urban Central"],
  ["utopiastadium", "Utopia Coliseum"],
  ["cs_hw", "Rivals Arena"],
  ["cs", "Champions Field"],
  ["wasteland", "Wasteland"],
  ["neotokyo", "Neo Tokyo"],
  ["arc", "Starbase ARC"],
  ["farm", "Farmstead"],
  ["underwater", "AquaDome"],
  ["chinatown", "Forbidden Temple"],
  ["music", "Neon Fields"],
  ["beach", "Salty Shores"],
  ["outlaw", "Deadeye Canyon"],
  ["street", "Sovereign Heights"],
  ["woods", "Drift Woods"],
  ["fni", "Estadio Vida"],
  ["hoopsstadium", "Dunk House"],
  ["shattershot", "Core 707"],
  ["throwbackstadium", "Throwback Stadium"],
  ["labs", "Rocket Labs"],
].sort((a, b) => b[0].length - a[0].length) as [string, string][];

const VARIANTS: [string, string][] = [
  ["night", "Night"],
  ["dusk", "Dusk"],
  ["dawn", "Dawn"],
  ["day", "Day"],
  ["rain", "Stormy"],
  ["snow", "Snowy"],
  ["winter", "Snowy"],
  ["foggy", "Foggy"],
  ["_hw", "Spooky"],
];

export function arenaName(asset: string | undefined): string {
  if (!asset) return "";
  const lower = asset.toLowerCase();
  const base = ARENAS.find(([prefix]) => lower.startsWith(prefix));
  if (!base) return asset.replace(/_p$/i, "").replace(/_/g, " ");
  const rest = lower.slice(base[0].length);
  const variant = VARIANTS.find(([key]) => rest.includes(key));
  return variant ? `${base[1]} (${variant[1]})` : base[1];
}

/**
 * Platform from an id like "Steam|123|0". The game also uses internal
 * codenames: Dingo and Durango are Xbox, Orbis is PlayStation, NNX is Switch.
 */
type Platform = "steam" | "epic" | "psn" | "xbl" | "switch" | "";
function platformKey(primaryId: string | undefined): Platform {
  const p = (primaryId ?? "").split("|")[0].toLowerCase().replace("onlineplatform_", "");
  if (p === "steam") return "steam";
  if (p === "epic") return "epic";
  if (p.startsWith("ps") || p === "orbis") return "psn";
  if (p.startsWith("xbox") || p === "dingo" || p === "durango") return "xbl";
  if (p === "switch" || p === "nnx") return "switch";
  return "";
}

const PLATFORM_NAMES: Record<Platform, string> = {
  steam: "Steam", epic: "Epic", psn: "PlayStation", xbl: "Xbox", switch: "Switch", "": "",
};

export const platformName = (primaryId: string | undefined) => PLATFORM_NAMES[platformKey(primaryId)];

/** Names Rocket League shows instead of the real one when a player is anonymised. */
export const isAnonymised = (name: string) => /^User-[0-9a-f]{6,}$/i.test(name);

const TRACKER = "https://rocketleague.tracker.network/rocket-league/profile";

/** A saved correction: a platform and the handle RL Tracker knows them by. */
export interface TrackerOverride {
  platform: Exclude<Platform, "">;
  handle: string;
}

export const trackerProfile = (platform: string, handle: string) =>
  `${TRACKER}/${platform}/${encodeURIComponent(handle)}/overview`;

/**
 * RL Tracker profiles to try for a player, best guess first. Steam players go
 * by Steam ID, everyone else by display name on their platform. Since the
 * platform the game reports isn't always the one RL Tracker knows them on
 * (console players with Epic accounts), the other platforms follow as
 * fallbacks for the embedded page to try in turn.
 */
export function trackerCandidates(name: string, primaryId: string | undefined, override?: TrackerOverride): string[] {
  if (override) return [trackerProfile(override.platform, override.handle)];
  if (isAnonymised(name)) return [];
  const [, id = ""] = (primaryId ?? "").split("|");
  const platform = platformKey(primaryId);
  const list: string[] = [];
  if (platform === "steam" && id && id !== "0") list.push(trackerProfile("steam", id));
  if (platform && platform !== "steam") list.push(trackerProfile(platform, name));
  for (const p of ["epic", "psn", "xbl", "switch"]) list.push(trackerProfile(p, name));
  return [...new Set(list)];
}
