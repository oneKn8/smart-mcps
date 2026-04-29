import type { Units } from "../client.js";

// Slim-shape formatters. Every weather tool emits compact, unit-suffixed
// strings (e.g. "78F", "12mph WSW", "0.05in") rather than raw numbers, so the
// LLM caller doesn't have to keep track of which axis a value lives on. These
// helpers centralise the formatting choices (rounding, decimal places, unit
// suffixes) so all tools render the same numeric in the same way.

export function formatTemp(value: number, units: Units): string {
  return `${Math.round(value)}${units === "imperial" ? "F" : "C"}`;
}

export function formatWind(
  speed: number,
  direction: number | undefined,
  units: Units,
): string {
  const unit = units === "imperial" ? "mph" : "km/h";
  const speedStr = `${Math.round(speed)}${unit}`;
  if (direction === undefined) return speedStr;
  return `${speedStr} ${compassDir(direction)}`;
}

export function formatPrecipitation(value: number, units: Units): string {
  // Imperial uses inches with two-decimal precision (rain rates are usually
  // sub-inch); metric uses millimetres with single-decimal precision.
  const unit = units === "imperial" ? "in" : "mm";
  return `${value.toFixed(units === "imperial" ? 2 : 1)}${unit}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatPressure(value: number): string {
  // Open-Meteo always returns pressure_msl in hPa regardless of unit system,
  // so the suffix is fixed.
  return `${Math.round(value)}hPa`;
}

// Renders an ISO-local hour string like "2026-04-29T17:00" as a friendly
// "5pm" / "noon" / "midnight" label. Open-Meteo returns local time when the
// request uses `timezone=auto`, so JavaScript's local-time Date parsing of a
// suffix-less ISO string is what we want here. Tests pin TZ=America/Chicago
// so the labels are deterministic across machines.
export function formatHourLabel(iso: string): string {
  const date = new Date(iso);
  const hour = date.getHours();
  if (hour === 0) return "midnight";
  if (hour === 12) return "noon";
  if (hour < 12) return `${hour}am`;
  return `${hour - 12}pm`;
}

export function formatVisibility(value: number, units: Units): string {
  // Open-Meteo returns visibility in feet for imperial units and metres for
  // metric units (verified against the live forecast endpoint — the
  // hourly_units payload reports "ft" / "m"). Convert to mi/km for slim
  // output so the surface unit matches the user's expected scale.
  if (units === "imperial") {
    const miles = value / 5280;
    return `${miles.toFixed(1)}mi`;
  }
  const km = value / 1000;
  return `${km.toFixed(1)}km`;
}

// 16-point compass rose. Resolves a bearing in degrees (0..360, where 0 is
// North) to its nearest cardinal/intercardinal label. Used by formatWind.
function compassDir(degrees: number): string {
  const dirs = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const idx = Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16;
  return dirs[idx]!;
}
