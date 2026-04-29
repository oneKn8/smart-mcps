import { WeatherClient } from "./client.js";

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

// WeatherClient's constructor calls loadCreds() but treats every var as
// optional, so it never throws AuthError. Constructing here at startup keeps
// parity with runpod-smart / vercel-smart even though there are no required
// keys to surface — and lets us resolve defaults once at boot rather than per
// tool call. The "imperial" fallback matches the README default for users who
// don't set WEATHER_DEFAULT_UNITS.
export function buildContext(): WeatherContext {
  const client = new WeatherClient();
  return {
    client,
    defaults: {
      units: client.getDefaultUnits() ?? "imperial",
      location: client.getDefaultLocation(),
    },
  };
}
