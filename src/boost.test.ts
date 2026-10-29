import { describe, expect, it } from "vitest";
import { BoostTracker, SpikeFilter, emptyBoost } from "./boost";

/** Feeds readings 0.1 s apart into a live tracker and returns its stats. */
function count(levels: number[]) {
  const stats = emptyBoost();
  const tracker = new BoostTracker(() => stats);
  tracker.live = true;
  levels.forEach((v, i) => tracker.reading(v, i * 100));
  return stats;
}

describe("BoostTracker", () => {
  it("counts boost burned while picking up a small pad", () => {
    // Boosting (about 3.4 a reading), then a pad: the meter only rises by 9.
    const s = count([50, 47, 56, 52]);
    expect(s.used).toBe(3 + 3 + 4);
    expect(s.collected).toBe(12);
  });

  it("takes a whole small pad and a big pad at face value", () => {
    const s = count([40, 52, 100, 100]);
    expect(s.used).toBe(0);
    expect(s.collected).toBe(12 + 48);
  });

  it("needs a second reading to believe a jump the game can't make", () => {
    const s = count([40, 75, 40, 40]);
    expect(s.used).toBe(0);
    expect(s.collected).toBe(0);
  });
});

describe("SpikeFilter", () => {
  const run = (levels: number[]) => {
    const f = new SpikeFilter();
    return levels.map((v) => f.push(v)).filter((v) => v !== null);
  };

  it("drops a one-frame misread", () => {
    expect(run([50, 47, 44, 30, 41, 38])).toEqual([50, 47, 44, 41]);
  });

  it("keeps real steps, like a pad picked up while boosting", () => {
    expect(run([50, 47, 56, 52, 49])).toEqual([50, 47, 56, 52]);
  });
});
