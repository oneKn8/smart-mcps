import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { getHistorical } from "../historical.js";
import type { WeatherContext } from "../../context.js";
import type {
  WeatherClient,
  HistoricalEntry,
  GeocodeMatch,
} from "../../client.js";

// Tool-level test harness. Stubs the client directly. Date-lag handling is
// exercised against a fixed system clock via vi.useFakeTimers — start_date /
// end_date assumptions ride on "today = 2026-04-29".

function entry(overrides: Partial<HistoricalEntry> = {}): HistoricalEntry {
  return {
    date: "2026-04-01",
    temp_max: 75,
    temp_min: 55,
    precipitation_sum: 0.1,
    wind_speed_max: 12,
    ...overrides,
  };
}

function makeCtx(opts: {
  entries?: HistoricalEntry[];
  matches?: GeocodeMatch[];
  defaultUnits?: "metric" | "imperial";
  defaultLocation?: string | undefined;
}): {
  ctx: WeatherContext;
  getHistorical: ReturnType<typeof vi.fn>;
  geocode: ReturnType<typeof vi.fn>;
} {
  const getHistoricalStub = vi.fn().mockResolvedValue({
    entries: opts.entries ?? [entry()],
    timezone: "America/Chicago",
  });
  const geocode = vi.fn().mockResolvedValue({ matches: opts.matches ?? [] });
  const ctx: WeatherContext = {
    client: {
      geocode,
      getHistorical: getHistoricalStub,
    } as unknown as WeatherClient,
    defaults: {
      units: opts.defaultUnits ?? "imperial",
      location: opts.defaultLocation,
    },
  };
  return { ctx, getHistorical: getHistoricalStub, geocode };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Today = 2026-04-29. ERA5 cutoff = 2026-04-24. Anything > 2026-04-24
  // should be rejected.
  vi.setSystemTime(new Date("2026-04-29T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("get_historical — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getHistorical.name).toBe("get_historical");
    expect(getHistorical.description).toBe(
      "Past daily weather observations (ERA5).",
    );
  });

  it("schema rejects start_date that isn't YYYY-MM-DD format", () => {
    const r = getHistorical.inputSchema.safeParse({
      lat: 0,
      lng: 0,
      start_date: "04/01/2026",
      end_date: "2026-04-01",
    });
    expect(r.success).toBe(false);
  });

  it("schema rejects end_date that isn't a date string at all", () => {
    const r = getHistorical.inputSchema.safeParse({
      lat: 0,
      lng: 0,
      start_date: "2026-01-01",
      end_date: "not-a-date",
    });
    expect(r.success).toBe(false);
  });
});

describe("get_historical — handler date validation", () => {
  it("happy path: valid range returns mapped slim shape", async () => {
    const { ctx } = makeCtx({
      entries: [
        entry({ date: "2026-04-01", temp_max: 80, temp_min: 60 }),
        entry({ date: "2026-04-02", temp_max: 82, temp_min: 62 }),
      ],
    });
    const result = await getHistorical.handler(
      {
        lat: 32.78,
        lng: -96.8,
        start_date: "2026-04-01",
        end_date: "2026-04-02",
      },
      ctx,
    );
    expect(result.daily).toHaveLength(2);
    expect(Object.keys(result.daily[0]!).sort()).toEqual([
      "date",
      "high",
      "low",
      "precip_total",
      "wind_max",
    ]);
  });

  it("rejects end_date < start_date", async () => {
    const { ctx } = makeCtx({});
    await expect(
      getHistorical.handler(
        {
          lat: 0,
          lng: 0,
          start_date: "2026-04-10",
          end_date: "2026-04-05",
        },
        ctx,
      ),
    ).rejects.toThrow(/end_date must be on or after start_date/);
  });

  it("rejects end_date within last 5 days (ERA5 lag)", async () => {
    // Today is 2026-04-29; cutoff = 2026-04-24. 2026-04-25 should be rejected.
    const { ctx } = makeCtx({});
    await expect(
      getHistorical.handler(
        {
          lat: 0,
          lng: 0,
          start_date: "2026-04-01",
          end_date: "2026-04-25",
        },
        ctx,
      ),
    ).rejects.toThrow(/at least 5 days in the past/);
  });

  it("rejects range > 366 days", async () => {
    const { ctx } = makeCtx({});
    await expect(
      getHistorical.handler(
        {
          lat: 0,
          lng: 0,
          start_date: "2024-01-01",
          // ~480 days; well past 366 and still safely before the 5-day cutoff.
          end_date: "2025-04-25",
        },
        ctx,
      ),
    ).rejects.toThrow(/cannot exceed 366 days/);
  });

  it("allows end_date exactly 5 days in the past (ERA5 lag edge)", async () => {
    // Today = 2026-04-29. Cutoff = 2026-04-24. end_date = 2026-04-24 should
    // pass the strict `>` check (not `>=`). Hits the allowed-edge boundary.
    const { ctx } = makeCtx({
      entries: [entry({ date: "2026-04-24", temp_max: 78, temp_min: 58 })],
    });
    const result = await getHistorical.handler(
      {
        lat: 32.7767,
        lng: -96.797,
        start_date: "2026-04-20",
        end_date: "2026-04-24",
      },
      ctx,
    );
    expect(result.daily).toBeDefined();
  });

  it("allows date range of exactly 366 days", async () => {
    // Range cap is `> 366`, so a 366-day span must pass. Math: end - start in
    // days = 366 when start=2024-04-19, end=2025-04-20 (UTC midnight diff).
    // Both dates safely before the 2026-04-24 ERA5 cutoff.
    const { ctx } = makeCtx({
      entries: [entry({ date: "2024-04-19", temp_max: 70, temp_min: 50 })],
    });
    const result = await getHistorical.handler(
      {
        lat: 32.7767,
        lng: -96.797,
        start_date: "2024-04-19",
        end_date: "2025-04-20",
      },
      ctx,
    );
    expect(result.daily).toBeDefined();
  });
});

describe("get_historical — output formatting", () => {
  it("imperial: high/low formatted with F, precip with in, wind with mph", async () => {
    const { ctx } = makeCtx({
      entries: [
        entry({
          temp_max: 82.5,
          temp_min: 65.1,
          precipitation_sum: 0.12,
          wind_speed_max: 11.5,
        }),
      ],
      defaultUnits: "imperial",
    });
    const result = await getHistorical.handler(
      {
        lat: 0,
        lng: 0,
        start_date: "2026-04-01",
        end_date: "2026-04-01",
      },
      ctx,
    );
    expect(result.daily[0]!.high).toBe("83F");
    expect(result.daily[0]!.low).toBe("65F");
    expect(result.daily[0]!.precip_total).toBe("0.12in");
    expect(result.daily[0]!.wind_max).toBe("12mph");
  });

  it("metric: high/low formatted with C, precip with mm, wind with km/h", async () => {
    const { ctx } = makeCtx({
      entries: [
        entry({
          temp_max: 28.4,
          temp_min: 18.2,
          precipitation_sum: 5.4,
          wind_speed_max: 18.2,
        }),
      ],
      defaultUnits: "metric",
    });
    const result = await getHistorical.handler(
      {
        lat: 0,
        lng: 0,
        start_date: "2026-04-01",
        end_date: "2026-04-01",
      },
      ctx,
    );
    expect(result.daily[0]!.high).toBe("28C");
    expect(result.daily[0]!.low).toBe("18C");
    expect(result.daily[0]!.precip_total).toBe("5.4mm");
    expect(result.daily[0]!.wind_max).toBe("18km/h");
  });
});
