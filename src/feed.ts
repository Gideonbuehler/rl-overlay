// Connection to the Rocket League Stats API.
// Reference: https://www.rocketleague.com/developer/stats-api

export interface PlayerRef {
  Name: string;
  Shortcut: number;
  TeamNum: number;
}

export interface Envelope {
  Event: string;
  Data: any;
}

export type Status = "connecting" | "connected" | "disconnected";

/**
 * Pulls complete JSON objects out of a text stream. A frame may carry several
 * messages, or (over raw TCP) half of one, so we scan for balanced braces
 * instead of trusting one-message-per-frame.
 */
export class JsonSplitter {
  private buf = "";

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;

    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") {
        if (depth++ === 0) start = i;
      } else if (c === "}" && depth > 0 && --depth === 0) {
        try {
          out.push(JSON.parse(this.buf.slice(start, i + 1)));
        } catch {
          // Malformed object; drop it and keep going.
        }
      }
    }

    this.buf = depth > 0 ? this.buf.slice(start) : "";
    return out;
  }
}

export interface Feed {
  close: () => void;
  /** Sends a command to the game (LoadReplay, SeekReplay, ...). False if not connected. */
  send: (command: string, data: Record<string, unknown>) => boolean;
}

/** Connects to the game's WebSocket and keeps reconnecting. */
export function connect(
  port: number,
  onMessage: (msg: Envelope) => void,
  onStatus: (status: Status) => void,
): Feed {
  let socket: WebSocket | null = null;
  let retry: number | undefined;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    onStatus("connecting");
    const splitter = new JsonSplitter();
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onopen = () => onStatus("connected");
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      for (const obj of splitter.push(e.data)) {
        const msg = obj as Envelope;
        if (typeof msg?.Event !== "string") continue;
        // Be lenient if Data ever arrives as an encoded string.
        if (typeof msg.Data === "string") {
          try {
            msg.Data = JSON.parse(msg.Data);
          } catch {
            continue;
          }
        }
        onMessage(msg);
      }
    };
    socket.onclose = () => {
      onStatus("disconnected");
      if (!disposed) retry = window.setTimeout(open, 2000);
    };
  };

  open();
  return {
    close: () => {
      disposed = true;
      window.clearTimeout(retry);
      socket?.close();
    },
    send: (command, data) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ Command: command, Data: data }));
      return true;
    },
  };
}

/**
 * Speeds from the Stats API, in km/h.
 *
 * The docs say speeds are in Unreal units per second, but the live game sends
 * km/h: a hard shot arrives as ~110, which in uu/s would be 4 km/h. In km/h no
 * ball or car speed in the game exceeds about 250, while in uu/s nearly every
 * real hit does, so each field is taken as km/h until it shows a value over 300
 * and as uu/s after that. Detection resets each launch.
 */
export type SpeedField = "hit" | "goal" | "ball" | "car";
const inUnrealUnits: Partial<Record<SpeedField, boolean>> = {};

export function speedKmh(field: SpeedField, raw: number): number {
  if (raw > 300) inUnrealUnits[field] = true;
  return inUnrealUnits[field] ? raw * 0.036 : raw;
}
