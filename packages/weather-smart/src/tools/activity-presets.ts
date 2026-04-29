import type { Units, HourlyEntry } from "../client.js";

// Activity preset table for the `outdoor_window` smart shortcut. Each preset
// encodes a hard-constraint envelope under which the activity is "comfortable":
// wind ceiling, precipitation-probability ceiling, temperature band, plus
// activity-specific extras (UV cap for hike, cloud cap for picnic, visibility
// floor for drone). Thresholds are stored in IMPERIAL units (mph, F, mi) and
// converted to metric on the fly when a metric-units request comes in. This
// keeps a single source of truth — we don't double-maintain two tables.
export type ActivityName =
  | "hike"
  | "run"
  | "picnic"
  | "drone"
  | "bike"
  | "general";

export type ActivityPreset = {
  name: ActivityName;
  max_wind_mph: number;
  max_precip_pop: number; // 0-100
  min_temp_f: number;
  max_temp_f: number;
  max_uv?: number;
  max_cloud_cover?: number; // 0-100
  min_visibility_mi?: number;
};

export const ACTIVITY_PRESETS: Record<ActivityName, ActivityPreset> = {
  hike: {
    name: "hike",
    max_wind_mph: 20,
    max_precip_pop: 30,
    min_temp_f: 50,
    max_temp_f: 85,
    max_uv: 8,
  },
  run: {
    name: "run",
    max_wind_mph: 15,
    max_precip_pop: 20,
    min_temp_f: 40,
    max_temp_f: 75,
  },
  picnic: {
    name: "picnic",
    max_wind_mph: 12,
    max_precip_pop: 15,
    min_temp_f: 65,
    max_temp_f: 85,
    max_cloud_cover: 60,
  },
  drone: {
    name: "drone",
    max_wind_mph: 10,
    max_precip_pop: 5,
    min_temp_f: 40,
    max_temp_f: 95,
    min_visibility_mi: 5,
  },
  bike: {
    name: "bike",
    max_wind_mph: 18,
    max_precip_pop: 25,
    min_temp_f: 45,
    max_temp_f: 85,
  },
  general: {
    name: "general",
    max_wind_mph: 25,
    max_precip_pop: 40,
    min_temp_f: 35,
    max_temp_f: 95,
  },
};

// Open-Meteo unit quirks (verified live in Task 5):
//  - Imperial visibility comes back in FEET; metric visibility in METRES.
//  - Imperial wind is mph; metric wind is km/h.
//  - Imperial temp is F; metric temp is C.
// Preset thresholds are imperial-native (mi, mph, F), so for metric checks we
// convert each threshold to its metric equivalent before comparing against the
// hourly entry (which already arrives in the user's units).
const FT_PER_MI = 5280;
const M_PER_KM = 1000;
const KM_PER_MI = 1.609;

// Convert an imperial-native preset to its metric-axis equivalents. Pure
// helper — no side effects, no rounding past floating-point precision; the
// downstream comparison is `>` / `<` so tiny conversion noise is safe. Exposed
// so tests can sanity-check the derived metric thresholds.
export function toMetric(preset: ActivityPreset): {
  max_wind_kmh: number;
  max_precip_pop: number;
  min_temp_c: number;
  max_temp_c: number;
  max_uv?: number;
  max_cloud_cover?: number;
  min_visibility_km?: number;
} {
  return {
    max_wind_kmh: preset.max_wind_mph * KM_PER_MI,
    max_precip_pop: preset.max_precip_pop,
    min_temp_c: ((preset.min_temp_f - 32) * 5) / 9,
    max_temp_c: ((preset.max_temp_f - 32) * 5) / 9,
    max_uv: preset.max_uv,
    max_cloud_cover: preset.max_cloud_cover,
    min_visibility_km:
      preset.min_visibility_mi !== undefined
        ? preset.min_visibility_mi * KM_PER_MI
        : undefined,
  };
}

// Returns true iff the hourly entry passes EVERY applicable preset constraint.
// Optional preset fields (max_uv, max_cloud_cover, min_visibility) are only
// checked when defined on the preset; an undefined cap means "no constraint".
//
// Visibility special case: Open-Meteo reports visibility in feet for imperial
// and metres for metric. The preset's `min_visibility_mi` is in MILES, so we
// convert the entry value to miles (imperial) or kilometres (metric) before
// comparing against the corresponding metric/imperial cap.
export function passesPreset(
  entry: HourlyEntry,
  preset: ActivityPreset,
  units: Units,
): boolean {
  if (units === "imperial") {
    if (entry.wind_speed > preset.max_wind_mph) return false;
    if (entry.precipitation_probability > preset.max_precip_pop) return false;
    if (
      entry.temperature < preset.min_temp_f ||
      entry.temperature > preset.max_temp_f
    ) {
      return false;
    }
    if (preset.max_uv !== undefined && entry.uv_index > preset.max_uv) {
      return false;
    }
    if (
      preset.max_cloud_cover !== undefined &&
      entry.cloud_cover > preset.max_cloud_cover
    ) {
      return false;
    }
    if (
      preset.min_visibility_mi !== undefined &&
      entry.visibility / FT_PER_MI < preset.min_visibility_mi
    ) {
      return false;
    }
    return true;
  }
  const m = toMetric(preset);
  if (entry.wind_speed > m.max_wind_kmh) return false;
  if (entry.precipitation_probability > m.max_precip_pop) return false;
  if (entry.temperature < m.min_temp_c || entry.temperature > m.max_temp_c) {
    return false;
  }
  if (m.max_uv !== undefined && entry.uv_index > m.max_uv) return false;
  if (
    m.max_cloud_cover !== undefined &&
    entry.cloud_cover > m.max_cloud_cover
  ) {
    return false;
  }
  if (
    m.min_visibility_km !== undefined &&
    entry.visibility / M_PER_KM < m.min_visibility_km
  ) {
    return false;
  }
  return true;
}
