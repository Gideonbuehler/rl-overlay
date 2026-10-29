// Which saved replays the cleanup may send to the Recycle Bin.
//
// Only replays the overlay saved: it never names them, while ones you save
// yourself get the name you type. Matches from before the overlay kept track
// of its own saves count when their replay has no name.

import type { MatchRecord } from "./match";

/** What the cleanup needs to know about a replay on disk. */
export interface ReplayFile {
  id: string;
  path: string;
  /** The name typed when saving it; empty when saved without one. */
  name: string;
}

/** Whether the cleanup may recycle this match's replay. */
export function cleanable(r: MatchRecord, replays: ReplayFile[]): boolean {
  const file = r.replay && replays.find((x) => x.id === r.replay!.id);
  return !!file && !file.name && r.replayAutoSaved !== false && !r.keepReplay;
}

/**
 * The matches whose replays should go: the overlay's saves beyond the newest
 * `keep`, once their exact boost and mechanics have been read (both stay in
 * the match history). `keep` of 0 keeps everything.
 */
export function replaysToRecycle(archive: MatchRecord[], replays: ReplayFile[], keep: number): MatchRecord[] {
  if (keep <= 0) return [];
  return archive
    .filter((r) => cleanable(r, replays))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(keep)
    .filter((r) => r.replayBoost && r.mechanics !== undefined);
}
