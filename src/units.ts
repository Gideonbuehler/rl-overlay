// Display units. Everything is stored in km/h; only what's shown changes.

export type SpeedUnit = "kmh" | "mph";

let unit: SpeedUnit = "kmh";

export const setSpeedUnit = (u: SpeedUnit) => {
  unit = u;
};

/** A km/h value in the chosen unit. */
export const toUnit = (kmh: number) => (unit === "mph" ? kmh * 0.621371 : kmh);

/** A km/h value formatted in the chosen unit, or "–" for none. */
export const fmtSpeed = (kmh: number | null | undefined) => (kmh ? `${Math.round(toUnit(kmh))}` : "–");

/** Rewrites "km/h" labels in rendered markup to the chosen unit. */
export const withUnitLabels = (html: string) => (unit === "mph" ? html.replaceAll("km/h", "mph") : html);
