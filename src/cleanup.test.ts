import { describe, expect, it } from "vitest";
import { replaysToRecycle, type ReplayFile } from "./cleanup";
import { freshRecord, type MatchRecord } from "./match";

/** A match started `n` minutes in, with a replay on disk (named or not) and exact boost read. */
function match(n: number, extra: Partial<MatchRecord> = {}): MatchRecord {
  const r = freshRecord(`guid${n}`);
  r.startedAt = n * 60_000;
  r.replay = { path: `C:/Demos/${n}.replay`, id: `id${n}`, fps: 30, goals: [] };
  r.replayBoost = [];
  r.mechanics = {};
  r.replayAutoSaved = true;
  return Object.assign(r, extra);
}
const files = (archive: MatchRecord[], named: number[] = []): ReplayFile[] =>
  archive.filter((r) => r.replay).map((r) => ({ id: r.replay!.id, path: r.replay!.path, name: named.includes(r.startedAt / 60_000) ? "flip reset" : "" }));
const ids = (rs: MatchRecord[]) => rs.map((r) => r.startedAt / 60_000);

describe("replaysToRecycle", () => {
  it("keeps the newest saves and recycles older ones", () => {
    const archive = [5, 4, 3, 2, 1].map((n) => match(n));
    expect(ids(replaysToRecycle(archive, files(archive), 2))).toEqual([3, 2, 1]);
  });

  it("never touches named replays, kept ones, or ones you saved yourself", () => {
    const archive = [
      match(6),
      match(5),
      match(4), // named: yours
      match(3, { keepReplay: true }),
      match(2, { replayAutoSaved: false }), // the overlay didn't press Save
      match(1),
    ];
    expect(ids(replaysToRecycle(archive, files(archive, [4]), 1))).toEqual([5, 1]);
  });

  it("counts matches from before the overlay kept track when the replay has no name", () => {
    const old = match(1);
    delete old.replayAutoSaved;
    const archive = [match(2), old];
    expect(ids(replaysToRecycle(archive, files(archive), 1))).toEqual([1]);
  });

  it("waits until a replay's exact boost and mechanics have been read", () => {
    const archive = [match(3), match(2, { replayBoost: null }), match(1)];
    delete archive[2].mechanics;
    expect(replaysToRecycle(archive, files(archive), 1)).toEqual([]);
  });

  it("skips replays that are no longer on disk, and keeps everything at 0", () => {
    const archive = [match(3), match(2), match(1)];
    expect(ids(replaysToRecycle(archive, files([archive[0], archive[1]]), 1))).toEqual([2]);
    expect(replaysToRecycle(archive, files(archive), 0)).toEqual([]);
  });
});
