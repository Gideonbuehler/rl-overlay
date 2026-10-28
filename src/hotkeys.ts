// Hotkeys as text ("Alt+Shift+S", "F2"), the way the global-shortcut parser in
// src-tauri reads them, made from the keys you press in settings.

/** The parts of a key press a hotkey is made from. */
export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Keys the shortcut parser knows by their KeyboardEvent.code, besides letters, digits, arrows, and F-keys. */
const OTHER_KEYS = new Set([
  "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal", "Minus", "Period", "Quote", "Semicolon", "Slash",
  "Backspace", "CapsLock", "Enter", "Space", "Tab", "Escape", "Delete", "End", "Home", "Insert", "PageDown", "PageUp",
  "PrintScreen", "ScrollLock", "Pause", "NumLock",
  "NumpadAdd", "NumpadDecimal", "NumpadDivide", "NumpadEnter", "NumpadEqual", "NumpadMultiply", "NumpadSubtract",
  "AudioVolumeDown", "AudioVolumeUp", "AudioVolumeMute",
  "MediaPlay", "MediaPause", "MediaPlayPause", "MediaStop", "MediaTrackNext", "MediaTrackPrevious",
]);

export const isModifierKey = (code: string) => /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code);

/** A key's name in a hotkey ("S", "1", "Num1", "Up", "F2", "PageUp"), or null if it can't be one. */
export function keyName(code: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit([0-9])$/))) return m[1];
  if ((m = code.match(/^Numpad([0-9])$/))) return `Num${m[1]}`;
  if ((m = code.match(/^Arrow(Up|Down|Left|Right)$/))) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return OTHER_KEYS.has(code) ? code : null;
}

/** The hotkey a key press makes, or null for a key that can't be one (or a modifier on its own). */
export function hotkeyFrom(e: KeyPress): string | null {
  const key = isModifierKey(e.code) ? null : keyName(e.code);
  if (!key) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", key].filter(Boolean).join("+");
}

/** Keys that type something, or that chat and menus need. */
const TYPING = /^([A-Z0-9]|Up|Down|Left|Right|Space|Enter|Tab|Backspace|Escape|Delete|CapsLock|NumLock|Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|Minus|Period|Quote|Semicolon|Slash)$/;

/**
 * Why a hotkey would get in the way, or null. A hotkey takes its keys away
 * from every other app while the overlay runs, so a typing key needs Ctrl or
 * Alt with it; F2, Insert, the numpad and the like are fine on their own.
 */
export function hotkeyProblem(hotkey: string): string | null {
  const parts = hotkey.split("+");
  const key = parts.pop() ?? "";
  if (!TYPING.test(key) || parts.some((m) => m === "Ctrl" || m === "Alt" || m === "Super")) return null;
  return parts.includes("Shift")
    ? `${hotkey} would go off every time you type a capital ${key}: add Ctrl or Alt, or use a key like F2.`
    : `${key} on its own would stop working in Rocket League's chat and everywhere else: add Ctrl or Alt, or use a key like F2.`;
}

/** The same hotkey however it was written: "alt+shift+s", "Control+KeyS", "ctrl+numpad1". */
function canonical(text: string): string {
  const parts = text.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const key = (parts.pop() ?? "")
    .replace(/^key([a-z])$/, "$1")
    .replace(/^digit([0-9])$/, "$1")
    .replace(/^numpad([0-9])$/, "num$1")
    .replace(/^arrow(up|down|left|right)$/, "$1")
    .replace(/^esc$/, "escape");
  const alias: Record<string, string> = { control: "ctrl", option: "alt", cmd: "super", command: "super" };
  const mods = new Set(parts.map((p) => alias[p] ?? p));
  return [...["ctrl", "alt", "shift", "super"].filter((m) => mods.has(m)), key].join("+");
}

/** Whether a key press is this hotkey (for the browser, where Tauri's global hotkeys don't exist). */
export function matchesHotkey(e: KeyPress, hotkey: string): boolean {
  const pressed = hotkeyFrom(e);
  return !!pressed && canonical(pressed) === canonical(hotkey);
}
