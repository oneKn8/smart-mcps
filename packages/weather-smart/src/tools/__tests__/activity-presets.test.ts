import { describe, it, expect } from "vitest";
import { ACTIVITY_PRESETS, passesPreset } from "../activity-presets.js";
import type { HourlyEntry } from "../../client.js";

// Imperial baseline entry tuned to comfortably pass every preset by default.
// Visibility is in feet (Open-Meteo's imperial unit), 10mi = 52800 ft.
function imperialEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T12:00",
    temperature: 60,
    precipitation_probability: 10,
    precipitation: 0,
    weather_code: 1,
    wind_speed: 8,
    cloud_cover: 40,
    visibility: 52800,
    uv_index: 5,
    ...overrides,
  };
}

// Metric baseline entry. Visibility 16093 m = 10mi for parity with imperial.
function metricEntry(overrides: Partial<HourlyEntry> = {}): HourlyEntry {
  return {
    time: "2026-04-29T12:00",
    temperature: 15,
    precipitation_probability: 10,
    precipitation: 0,
    weather_code: 1,
    wind_speed: 12,
    cloud_cover: 40,
    visibility: 16093,
    uv_index: 5,
    ...overrides,
  };
}

describe("ACTIVITY_PRESETS — table integrity", () => {
  it("defines all six presets with documented thresholds", () => {
    expect(ACTIVITY_PRESETS.hike).toMatchObject({
      name: "hike",
      max_wind_mph: 20,
      max_precip_pop: 30,
      min_temp_f: 50,
      max_temp_f: 85,
      max_uv: 8,
    });
    expect(ACTIVITY_PRESETS.run).toMatchObject({
      name: "run",
      max_wind_mph: 15,
      max_precip_pop: 20,
      min_temp_f: 40,
      max_temp_f: 75,
    });
    expect(ACTIVITY_PRESETS.picnic).toMatchObject({
      name: "picnic",
      max_wind_mph: 12,
      max_precip_pop: 15,
      min_temp_f: 65,
      max_temp_f: 85,
      max_cloud_cover: 60,
    });
    expect(ACTIVITY_PRESETS.drone).toMatchObject({
      name: "drone",
      max_wind_mph: 10,
      max_precip_pop: 5,
      min_temp_f: 40,
      max_temp_f: 95,
      min_visibility_mi: 5,
    });
    expect(ACTIVITY_PRESETS.bike).toMatchObject({
      name: "bike",
      max_wind_mph: 18,
      max_precip_pop: 25,
      min_temp_f: 45,
      max_temp_f: 85,
    });
    expect(ACTIVITY_PRESETS.general).toMatchObject({
      name: "general",
      max_wind_mph: 25,
      max_precip_pop: 40,
      min_temp_f: 35,
      max_temp_f: 95,
    });
  });
});

describe("passesPreset — imperial branch", () => {
  it("ideal hike conditions pass", () => {
    const e = imperialEntry({
      temperature: 60,
      wind_speed: 8,
      precipitation_probability: 10,
      uv_index: 5,
      cloud_cover: 40,
      visibility: 52800,
    });
    expect(passesPreset(e, ACTIVITY_PRESETS.hike, "imperial")).toBe(true);
  });

  it("rejects hike when wind exceeds the cap", () => {
    const e = imperialEntry({ wind_speed: 25 }); // hike cap 20
    expect(passesPreset(e, ACTIVITY_PRESETS.hike, "imperial")).toBe(false);
  });

  it("drone fails on low visibility, passes on high", () => {
    // Drone preset is the strictest: cap 10mph wind, 5% precip pop, 5mi vis.
    // Pin the other axes within drone tolerances so vis is the only varying
    // axis under test.
    const lowVis = imperialEntry({
      wind_speed: 5,
      precipitation_probability: 2,
      visibility: 3 * 5280, // 3 mi < 5
    });
    expect(passesPreset(lowVis, ACTIVITY_PRESETS.drone, "imperial")).toBe(
      false,
    );
    const highVis = imperialEntry({
      wind_speed: 5,
      precipitation_probability: 2,
      visibility: 10 * 5280, // 10 mi > 5
    });
    expect(passesPreset(highVis, ACTIVITY_PRESETS.drone, "imperial")).toBe(
      true,
    );
  });

  it("drone precip-pop boundary: 5% passes, 6% fails", () => {
    // Strict `>` on the cap, so 5 (the cap) passes, 6 fails.
    const at = imperialEntry({ precipitation_probability: 5 });
    expect(passesPreset(at, ACTIVITY_PRESETS.drone, "imperial")).toBe(true);
    const over = imperialEntry({ precipitation_probability: 6 });
    expect(passesPreset(over, ACTIVITY_PRESETS.drone, "imperial")).toBe(false);
  });

  it("rejects run when temp is below the floor", () => {
    const e = imperialEntry({ temperature: 35 }); // run floor 40
    expect(passesPreset(e, ACTIVITY_PRESETS.run, "imperial")).toBe(false);
  });

  it("rejects hike when UV exceeds the cap", () => {
    const e = imperialEntry({ uv_index: 9 }); // hike cap 8
    expect(passesPreset(e, ACTIVITY_PRESETS.hike, "imperial")).toBe(false);
  });

  it("rejects picnic when cloud cover exceeds the cap", () => {
    const e = imperialEntry({
      temperature: 70,
      wind_speed: 5,
      precipitation_probability: 5,
      cloud_cover: 70, // picnic cap 60
    });
    expect(passesPreset(e, ACTIVITY_PRESETS.picnic, "imperial")).toBe(false);
  });
});

describe("passesPreset — metric branch", () => {
  it("ideal hike metric conditions pass", () => {
    // 10C ≈ 50F (hike floor); 8 km/h ≈ 5 mph; 10% pop; UV 5; cc 40; vis 16km
    const e = metricEntry({
      temperature: 10,
      wind_speed: 8,
      precipitation_probability: 10,
      uv_index: 5,
      cloud_cover: 40,
      visibility: 16093,
    });
    expect(passesPreset(e, ACTIVITY_PRESETS.hike, "metric")).toBe(true);
  });

  it("rejects hike when metric temp is below the converted floor", () => {
    // hike floor is 50F = 10C; -10C is far below.
    const e = metricEntry({ temperature: -10 });
    expect(passesPreset(e, ACTIVITY_PRESETS.hike, "metric")).toBe(false);
  });
});
