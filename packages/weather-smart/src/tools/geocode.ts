import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";

// Resolves a free-text location string to candidate matches via the
// Open-Meteo geocoding API. Returns up to `limit` candidates so callers can
// disambiguate when a name maps to multiple cities (e.g. "Springfield"). The
// upstream client already strips the noisy fields (country_code, feature_code,
// admin1_id, etc.); this tool layer additionally normalises every optional
// field to an explicit `null` so downstream consumers don't have to handle
// `undefined` and `missing-key` separately.
const inputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

type Input = z.infer<typeof inputSchema>;

type Output = {
  matches: Array<{
    name: string;
    lat: number;
    lng: number;
    country: string | null;
    admin1: string | null;
    admin2: string | null;
    timezone: string;
    elevation: number | null;
    population: number | null;
  }>;
  count: number;
};

export const geocode = defineTool<Input, Output, WeatherContext>({
  name: "geocode",
  description: "Resolve location name to candidates.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `limit | undefined` but its output type is the resolved number.
  inputSchema: inputSchema as unknown as z.ZodType<Input>,
  handler: async (input, ctx) => {
    const { matches } = await ctx.client.geocode(input.query, input.limit);
    return {
      matches: matches.map((m) => ({
        name: m.name,
        lat: m.lat,
        lng: m.lng,
        country: m.country ?? null,
        admin1: m.admin1 ?? null,
        admin2: m.admin2 ?? null,
        timezone: m.timezone,
        elevation: m.elevation ?? null,
        population: m.population ?? null,
      })),
      count: matches.length,
    };
  },
});
