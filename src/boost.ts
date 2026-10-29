// Turns boost readings into boost used, collected, and time-at-level stats.
//
// Readings come from the screen reader (src-tauri/src/boost.rs) while you play,
// or from the Stats API's Boost field when you're spectating or in a replay.
// They're noisy: some frames can't be read and the odd one is misread, so
// changes the game couldn't produce need a second matching reading first.

export interface BoostStats {
  used: number;
  collected: number;
  /** Seconds of live play the level was tracked for. */
  time: number;
  /** Level integrated over time, for the average. */
  levelSum: number;
  /** Seconds spent at 0 and at 100. */
  empty: number;
  full: number;
}

export const emptyBoost = (): BoostStats => ({ used: 0, collected: 0, time: 0, levelSum: 0, empty: 0, full: 0 });

/** Boosting drains about 33.3 per second. */
const DRAIN_PER_SEC = 34;
const SMALL_PAD = 12;
/** Longest gap between readings that still counts as continuous. */
const MAX_GAP = 5;

export const boostPerMinute = (s: BoostStats) => (s.time > 5 ? (s.used / s.time) * 60 : 0);
export const averageBoost = (s: BoostStats) => (s.time ? s.levelSum / s.time : 0);

/** How far a reading can stray from both neighbours before it's taken for a misread. */
const SPIKE = 3.5;

/**
 * Drops one-frame misreads: a reading that jumps away from the one before and
 * straight back at the next. Holds each reading back one step to see what
 * follows; unlike a median, it leaves real steps alone, such as a pad picked
 * up while boosting.
 */
export class SpikeFilter {
  private prev: number | null = null;
  private held: number | null = null;

  /** Takes a reading; returns the one before it once it's been checked, or null. */
  push(value: number): number | null {
    const [a, b] = [this.prev, this.held];
    this.held = value;
    if (b === null) return null;
    this.prev = b;
    if (a !== null && (b - a) * (value - b) < 0 && Math.abs(b - a) > SPIKE && Math.abs(value - b) > SPIKE && Math.abs(value - a) <= SPIKE) {
      this.prev = a; // b was a misread
      return null;
    }
    return b;
  }

  reset() {
    this.prev = null;
    this.held = null;
  }
}

export class BoostTracker {
  /** The current level as best we know it, for display. */
  current: number | null = null;
  /** True while a round is being played; readings outside rounds don't count. */
  live = false;

  /** Last accepted level; null right after kickoff or a demo, until a fresh reading. */
  private level: number | null = null;
  private levelAt = 0;
  private pending: number | null = null;

  constructor(private stats: () => BoostStats | null) {}

  /** The meter jumps at kickoff and respawn without boost being used or collected. */
  rebase() {
    this.level = null;
    this.pending = null;
  }

  reset() {
    this.rebase();
    this.current = null;
    this.live = false;
  }

  reading(value: number | null, now = performance.now()) {
    if (value === null) return;
    const dt = this.level === null ? 0 : (now - this.levelAt) / 1000;

    if (this.level !== null && value !== this.level && !this.plausible(this.level, value, dt)) {
      // Unlikely jump: believe it only once a second reading agrees.
      if (value !== this.pending) {
        this.pending = value;
        return;
      }
    }
    this.pending = null;
    this.current = value;

    const s = this.stats();
    if (this.live && s && this.level !== null && dt <= MAX_GAP) {
      s.time += dt;
      s.levelSum += this.level * dt;
      if (this.level === 0) s.empty += dt;
      if (this.level >= 100) s.full += dt;
      const delta = value - this.level;
      if (delta < 0) s.used -= delta;
      else {
        // A rise that falls short of whole small pads means you were boosting
        // as you picked them up: count what was burned as well as the pads.
        const burned = this.burnedDuringPickup(delta, value, dt);
        s.used += burned;
        s.collected += delta + burned;
      }
    }
    this.level = value;
    this.levelAt = now;
  }

  /**
   * Boost burned while the meter rose by `gain`: small pads always give
   * exactly SMALL_PAD, so a rise of 9 is one pad with 3 burned. 0 when the
   * rise is whole pads, a big pad (the meter tops out at 100), or doesn't fit.
   */
  private burnedDuringPickup(gain: number, to: number, dt: number) {
    if (to >= 100) return 0;
    const pads = Math.ceil((gain - 1) / SMALL_PAD);
    const burned = pads * SMALL_PAD - gain;
    return burned > 1 && burned <= DRAIN_PER_SEC * Math.max(dt, 0.1) + 1 ? burned : 0;
  }

  /** Could the game have moved the meter from `from` to `to` in `dt` seconds? */
  private plausible(from: number, to: number, dt: number) {
    if (to < from) return from - to <= DRAIN_PER_SEC * Math.max(dt, 0.1) + 3;
    const gain = to - from;
    if (to === 100) return true;
    // Whole small pads, less whatever was burned while picking them up; more
    // than one pad only fits in a longer gap between readings.
    const pads = Math.ceil((gain - 2) / SMALL_PAD);
    const burned = pads * SMALL_PAD - gain;
    return pads <= Math.max(1, dt * 2) && burned >= -2 && burned <= DRAIN_PER_SEC * Math.max(dt, 0.1) + 2;
  }
}
