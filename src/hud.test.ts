import { describe, expect, it } from "vitest";
import { arrangeHud, layoutHud, moveHudStat, packHud, readingOrder, type HudCells } from "./hud";

/** Cells as rows of ids, "." for an empty cell, to read the layouts at a glance. */
function grid(cells: HudCells): string[] {
  const rows: string[][] = [];
  for (const [id, { row, col }] of Object.entries(cells)) {
    while (rows.length <= row) rows.push([]);
    rows[row][col] = id;
  }
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ".").join(" "));
}

describe("arrangeHud", () => {
  it("puts stats in two columns until they're arranged", () => {
    expect(grid(arrangeHud(["a", "b", "c"], null))).toEqual(["a b", "c ."]);
  });

  it("keeps saved spots and fills the first free cell with new stats", () => {
    const saved = { a: { row: 0, col: 0 }, c: { row: 1, col: 1 } };
    expect(grid(arrangeHud(["a", "b", "c", "d"], saved))).toEqual(["a b", "d c"]);
  });

  it("adds new stats to the end of a single row", () => {
    const saved = packHud(["a", "b", "c"], 3);
    expect(grid(arrangeHud(["a", "b", "c", "d"], saved))).toEqual(["a b c d"]);
  });

  it("closes up rows and columns left by stats no longer shown", () => {
    const saved = { a: { row: 0, col: 0 }, gone: { row: 1, col: 0 }, b: { row: 2, col: 3 } };
    expect(grid(arrangeHud(["a", "b"], saved))).toEqual(["a .", ". b"]);
  });

  it("gives a shared spot to the first stat only", () => {
    const saved = { a: { row: 0, col: 0 }, b: { row: 0, col: 0 } };
    expect(grid(arrangeHud(["a", "b"], saved))).toEqual(["a", "b"]);
  });
});

describe("moveHudStat", () => {
  const two = packHud(["a", "b", "c", "d"], 2); // a b / c d

  it("swaps with the stat already there", () => {
    expect(grid(moveHudStat(two, "a", 1, 1))).toEqual(["d b", "c a"]);
  });

  it("adds a column past the right or left edge", () => {
    expect(grid(moveHudStat(two, "c", 0, 2))).toEqual(["a b c", ". d ."]);
    expect(grid(moveHudStat(two, "b", 1, -1))).toEqual([". a .", "b c d"]);
  });

  it("adds a row above or below", () => {
    expect(grid(moveHudStat(two, "d", 2, 0))).toEqual(["a b", "c .", "d ."]);
    expect(grid(moveHudStat(two, "c", -1, 1))).toEqual([". c", "a b", ". d"]);
  });

  it("closes up a row or column the move empties", () => {
    const tall = packHud(["a", "b", "c"], 1); // a / b / c
    expect(grid(moveHudStat(tall, "c", 0, 1))).toEqual(["a c", "b ."]);
  });
});

describe("layoutHud", () => {
  const ids = ["a", "b", "c", "d"];

  it("packs ready-made layouts in reading order", () => {
    const saved = moveHudStat(packHud(ids, 2), "a", 1, 1); // d b / c a
    expect(grid(layoutHud(ids, saved, "row"))).toEqual(["d b c a"]);
    expect(grid(layoutHud(ids, saved, "column"))).toEqual(["d", "b", "c", "a"]);
    expect(grid(layoutHud(ids, saved, "columns"))).toEqual(["d b", "c a"]);
  });

  it("keeps a ready-made layout tidy as stats come and go, and a custom one's gaps", () => {
    const saved = packHud(ids, 2);
    expect(grid(layoutHud(["a", "c", "d"], saved, "columns"))).toEqual(["a c", "d ."]);
    expect(grid(layoutHud(["a", "c", "d"], saved, "custom"))).toEqual(["a .", "c d"]);
  });

  it("reads row by row", () => {
    expect(readingOrder({ b: { row: 0, col: 1 }, c: { row: 1, col: 0 }, a: { row: 0, col: 0 } })).toEqual(["a", "b", "c"]);
  });
});
