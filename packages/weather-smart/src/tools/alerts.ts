import { defineTool } from "smart-mcp-core";
import type { z } from "zod";
import type { WeatherContext } from "../context.js";
import { locationInput } from "./location-input.js";
import { resolveLocation } from "../location-resolver.js";

// Active weather alerts for a US lat/lng. Backed by api.weather.gov, which
// only covers the United States — international queries get short-circuited
// before any HTTP call so we don't waste a roundtrip just to receive an
// empty array. The `note` field surfaces the short-circuit reason to the
// caller; absence of `note` means the call did reach NWS (which may still
// have returned zero alerts for a quiet US location).
const inputSchema = locationInput;

type Input = z.infer<typeof inputSchema>;

type Output = {
  location: { name: string; lat: number; lng: number; timezone: string };
  alerts: Array<{
    id: string;
    event: string;
    severity: string;
    urgency: string;
    certainty: string;
    headline: string;
    expires: string;
    areas: string;
  }>;
  note?: string;
};

// Lower-48 contiguous US bounding box. Inclusive on all four sides so the
// canonical southern (24.5°N, south Florida / Texas Gulf) and western
// (-125°W, Pacific coast) borders count as US. Phase 4 deferral: extend to
// AK/HI/PR — those territories have separate NWS coverage and require a
// non-rectangular check.
function isUsLatLng(lat: number, lng: number): boolean {
  return lat >= 24.5 && lat <= 49.4 && lng >= -125 && lng <= -66.9;
}

export const getAlerts = defineTool<Input, Output, WeatherContext>({
  name: "get_alerts",
  description: "Active weather alerts (US lower-48 only).",
  inputSchema,
  handler: async (input, ctx) => {
    const resolved = await resolveLocation(input, ctx.defaults, (q) =>
      ctx.client.geocode(q),
    );
    if (!isUsLatLng(resolved.lat, resolved.lng)) {
      return {
        location: {
          name: resolved.name,
          lat: resolved.lat,
          lng: resolved.lng,
          timezone: resolved.timezone,
        },
        alerts: [],
        note: "alerts only available for US locations",
      };
    }
    const { alerts } = await ctx.client.getNwsAlerts(
      resolved.lat,
      resolved.lng,
    );
    return {
      location: {
        name: resolved.name,
        lat: resolved.lat,
        lng: resolved.lng,
        timezone: resolved.timezone,
      },
      alerts,
    };
  },
});
