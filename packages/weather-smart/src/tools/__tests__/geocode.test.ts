import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { geocode } from "../geocode.js";
import type { WeatherContext } from "../../context.js";
import type { WeatherClient, GeocodeMatch } from "../../client.js";

// Build a minimal WeatherContext with a stubbed geocode method. We don't
// import or instantiate the real WeatherClient here — tool-level tests stub
// the client directly and let client.test.ts cover the HTTP path via msw.
function makeCtx(matches: GeocodeMatch[]): {
  ctx: WeatherContext;
  geocodeFn: ReturnType<typeof vi.fn>;
} {
  const geocodeFn = vi.fn().mockResolvedValue({ matches });
  const ctx: WeatherContext = {
    client: { geocode: geocodeFn } as unknown as WeatherClient,
    defaults: { units: "imperial", location: undefined },
  };
  return { ctx, geocodeFn };
}

describe("geocode — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(geocode.name).toBe("geocode");
    expect(geocode.description).toBe("Resolve location name to candidates.");
    expect(geocode.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults limit to 5 when omitted", () => {
    const parsed = geocode.inputSchema.parse({ query: "Dallas" }) as {
      limit: number;
    };
    expect(parsed.limit).toBe(5);
  });

  it("schema rejects empty query", () => {
    const result = geocode.inputSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("schema rejects limit: 0 (below min 1)", () => {
    const result = geocode.inputSchema.safeParse({ query: "Dallas", limit: 0 });
    expect(result.success).toBe(false);
  });

  it("schema rejects limit: 11 (above max 10)", () => {
    const result = geocode.inputSchema.safeParse({
      query: "Dallas",
      limit: 11,
    });
    expect(result.success).toBe(false);
  });
});

describe("geocode — output shape", () => {
  it("returns object with exactly the keys ['count', 'matches']", async () => {
    const { ctx } = makeCtx([
      {
        name: "Dallas",
        lat: 32.78,
        lng: -96.8,
        timezone: "America/Chicago",
        country: "United States",
        admin1: "Texas",
      },
    ]);
    const result = await geocode.handler(
      { query: "Dallas", limit: 5 },
      ctx,
    );
    expect(Object.keys(result).sort()).toEqual(["count", "matches"]);
  });

  it("each match has exactly the 9 expected keys", async () => {
    const { ctx } = makeCtx([
      {
        name: "Dallas",
        lat: 32.78,
        lng: -96.8,
        timezone: "America/Chicago",
        country: "United States",
        admin1: "Texas",
        admin2: "Dallas County",
        elevation: 131,
        population: 1300000,
      },
    ]);
    const result = await geocode.handler(
      { query: "Dallas", limit: 5 },
      ctx,
    );
    const match = result.matches[0]!;
    expect(Object.keys(match).sort()).toEqual([
      "admin1",
      "admin2",
      "country",
      "elevation",
      "lat",
      "lng",
      "name",
      "population",
      "timezone",
    ]);
  });

  it("maps undefined optional fields to null", async () => {
    const { ctx } = makeCtx([
      {
        name: "Atlantis",
        lat: 0,
        lng: 0,
        timezone: "UTC",
        // country, admin1, admin2, elevation, population intentionally omitted
      },
    ]);
    const result = await geocode.handler(
      { query: "Atlantis", limit: 5 },
      ctx,
    );
    const match = result.matches[0]!;
    expect(match.country).toBeNull();
    expect(match.admin1).toBeNull();
    expect(match.admin2).toBeNull();
    expect(match.elevation).toBeNull();
    expect(match.population).toBeNull();
    // Required fields still pass through unchanged.
    expect(match.name).toBe("Atlantis");
    expect(match.lat).toBe(0);
    expect(match.lng).toBe(0);
    expect(match.timezone).toBe("UTC");
  });

  it("maps populated optional fields through unchanged", async () => {
    const { ctx } = makeCtx([
      {
        name: "Dallas",
        lat: 32.78,
        lng: -96.8,
        timezone: "America/Chicago",
        country: "United States",
        admin1: "Texas",
        admin2: "Dallas County",
        elevation: 131,
        population: 1300000,
      },
    ]);
    const result = await geocode.handler(
      { query: "Dallas", limit: 5 },
      ctx,
    );
    expect(result.matches[0]).toEqual({
      name: "Dallas",
      lat: 32.78,
      lng: -96.8,
      timezone: "America/Chicago",
      country: "United States",
      admin1: "Texas",
      admin2: "Dallas County",
      elevation: 131,
      population: 1300000,
    });
  });
});

describe("geocode — count + limit", () => {
  it("count matches matches.length for empty result", async () => {
    const { ctx } = makeCtx([]);
    const result = await geocode.handler(
      { query: "asdfqwerty", limit: 5 },
      ctx,
    );
    expect(result.count).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("count matches matches.length for single result", async () => {
    const { ctx } = makeCtx([
      {
        name: "Dallas",
        lat: 32.78,
        lng: -96.8,
        timezone: "America/Chicago",
      },
    ]);
    const result = await geocode.handler(
      { query: "Dallas", limit: 5 },
      ctx,
    );
    expect(result.count).toBe(1);
    expect(result.matches).toHaveLength(1);
  });

  it("count matches matches.length for five results", async () => {
    const matches: GeocodeMatch[] = Array.from({ length: 5 }, (_, i) => ({
      name: `City${i}`,
      lat: i,
      lng: i,
      timezone: "UTC",
    }));
    const { ctx } = makeCtx(matches);
    const result = await geocode.handler(
      { query: "City", limit: 5 },
      ctx,
    );
    expect(result.count).toBe(5);
    expect(result.matches).toHaveLength(5);
  });

  it("default limit 5 is forwarded to client.geocode when not specified", async () => {
    const { ctx, geocodeFn } = makeCtx([]);
    const parsed = geocode.inputSchema.parse({ query: "Dallas" }) as {
      query: string;
      limit: number;
    };
    await geocode.handler(parsed, ctx);
    expect(geocodeFn).toHaveBeenCalledTimes(1);
    expect(geocodeFn).toHaveBeenCalledWith("Dallas", 5);
  });

  it("custom limit is forwarded to client.geocode unchanged", async () => {
    const { ctx, geocodeFn } = makeCtx([]);
    await geocode.handler({ query: "Dallas", limit: 10 }, ctx);
    expect(geocodeFn).toHaveBeenCalledWith("Dallas", 10);
  });
});
