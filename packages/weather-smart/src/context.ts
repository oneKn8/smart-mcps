import type { WeatherClient } from "./client.js";

// WeatherContext is the shared per-request context exposed to every tool
// handler. It carries the live API client plus the resolved defaults sourced
// from optional WEATHER_DEFAULT_UNITS / WEATHER_DEFAULT_LOCATION env vars.
// Tools read defaults.units to format temperature/wind/precip values and
// defaults.location as the fallback location when the caller passes no
// {lat,lng} or {location}.
export type WeatherContext = {
  client: WeatherClient;
  defaults: {
    units: "metric" | "imperial";
    location: string | undefined;
  };
};
