import { describe, expect, it } from "vitest";
import { hotkeyFrom, hotkeyProblem, matchesHotkey, type KeyPress } from "./hotkeys";

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe("hotkeyFrom", () => {
  it("names keys the way the shortcut parser reads them", () => {
    expect(hotkeyFrom(press("F2"))).toBe("F2");
    expect(hotkeyFrom(press("KeyS", { altKey: true, shiftKey: true }))).toBe("Alt+Shift+S");
    expect(hotkeyFrom(press("Numpad7", { ctrlKey: true }))).toBe("Ctrl+Num7");
    expect(hotkeyFrom(press("ArrowUp", { altKey: true }))).toBe("Alt+Up");
    expect(hotkeyFrom(press("PageDown"))).toBe("PageDown");
    expect(hotkeyFrom(press("F24"))).toBe("F24");
  });

  it("waits for a key while only modifiers are held, and skips keys that can't be hotkeys", () => {
    expect(hotkeyFrom(press("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(hotkeyFrom(press("ContextMenu"))).toBeNull();
    expect(hotkeyFrom(press("F25"))).toBeNull();
  });
});

describe("hotkeyProblem", () => {
  it("lets keys nobody types work on their own", () => {
    for (const k of ["F2", "Insert", "Num5", "NumpadAdd", "MediaPlayPause", "PageUp"]) expect(hotkeyProblem(k)).toBeNull();
  });

  it("keeps typing keys for chat unless Ctrl or Alt comes with them", () => {
    expect(hotkeyProblem("S")).toMatch(/on its own/);
    expect(hotkeyProblem("Space")).toMatch(/on its own/);
    expect(hotkeyProblem("Escape")).toMatch(/on its own/);
    expect(hotkeyProblem("Shift+S")).toMatch(/capital S/);
    expect(hotkeyProblem("Alt+Shift+S")).toBeNull();
    expect(hotkeyProblem("Ctrl+1")).toBeNull();
  });
});

describe("matchesHotkey", () => {
  it("matches however the hotkey was written", () => {
    expect(matchesHotkey(press("KeyS", { altKey: true, shiftKey: true }), "alt+shift+s")).toBe(true);
    expect(matchesHotkey(press("KeyS", { altKey: true, shiftKey: true }), "Shift+Alt+KeyS")).toBe(true);
    expect(matchesHotkey(press("F2"), "F2")).toBe(true);
    expect(matchesHotkey(press("F2", { ctrlKey: true }), "F2")).toBe(false);
    expect(matchesHotkey(press("Numpad1", { ctrlKey: true }), "Control+Numpad1")).toBe(true);
  });
});
