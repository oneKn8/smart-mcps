import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { cheapestServerType, estimateCost } from "../pricing.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const serverTypesList = [
  {
    id: 1, name: "cx22", cores: 2, memory: 4, disk: 40,
    cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false,
    prices: [
      { location: "nbg1", price_monthly: { net: "4.5900" }, price_hourly: { net: "0.0060" } },
      { location: "fsn1", price_monthly: { net: "4.2000" }, price_hourly: { net: "0.0055" } },
    ],
  },
  {
    id: 2, name: "cx32", cores: 4, memory: 8, disk: 80,
    cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false,
    prices: [{ location: "nbg1", price_monthly: { net: "8.4900" }, price_hourly: { net: "0.0120" } }],
  },
  {
    id: 3, name: "cax11", cores: 2, memory: 4, disk: 40,
    cpu_type: "shared", architecture: "arm", storage_type: "local", deprecated: false,
    prices: [{ location: "fsn1", price_monthly: { net: "3.7900" }, price_hourly: { net: "0.0049" } }],
  },
  {
    id: 4, name: "cx11", cores: 1, memory: 2, disk: 20,
    cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: true,
    prices: [{ location: "nbg1", price_monthly: { net: "3.0000" }, price_hourly: { net: "0.0040" } }],
  },
  {
    id: 5, name: "ccx13", cores: 2, memory: 8, disk: 80,
    cpu_type: "dedicated", architecture: "x86", storage_type: "local", deprecated: false,
    prices: [{ location: "nbg1", price_monthly: { net: "12.4900" }, price_hourly: { net: "0.0190" } }],
  },
];

const pricingFixture = {
  currency: "EUR",
  server_types: [
    { id: 1, name: "cx22", prices: [
      { location: "nbg1", price_hourly: { net: "0.0060" }, price_monthly: { net: "4.5900" } },
      { location: "fsn1", price_hourly: { net: "0.0055" }, price_monthly: { net: "4.2000" } },
    ] },
    { id: 2, name: "cx32", prices: [
      { location: "nbg1", price_hourly: { net: "0.0120" }, price_monthly: { net: "8.4900" } },
    ] },
  ],
  volume: { price_per_gb_month: { net: "0.0440" } },
  server_backup: { percentage: "20.00" },
  primary_ips: [
    { type: "ipv4", prices: [
      { location: "nbg1", price_hourly: { net: "0.0008" }, price_monthly: { net: "0.5000" } },
      { location: "fsn1", price_hourly: { net: "0.0007" }, price_monthly: { net: "0.4000" } },
    ] },
  ],
  floating_ips: [
    { type: "ipv4", prices: [{ location: "nbg1", price_monthly: { net: "1.0000" } }] },
  ],
};

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    getAllPages: vi.fn((path: string) =>
      Promise.resolve(path === "/server_types" ? serverTypesList : []),
    ),
    getPricing: vi.fn().mockResolvedValue(pricingFixture),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

const PRICED_TYPE_KEYS = [
  "architecture",
  "cores",
  "cpu_type",
  "deprecated",
  "disk",
  "location",
  "memory",
  "name",
  "price_hourly_eur",
  "price_monthly_eur",
  "storage_type",
].sort();

// =============================================================================
// cheapest_server_type
// =============================================================================

describe("cheapestServerType — metadata + schema", () => {
  it("has a snake_case name and short description", () => {
    expect(cheapestServerType.name).toBe("cheapest_server_type");
    expect(cheapestServerType.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(cheapestServerType.description).toBeTruthy();
    expect(cheapestServerType.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults arch to x86 and limit to 5", () => {
    const parsed = cheapestServerType.inputSchema.parse({}) as {
      arch: string;
      limit: number;
    };
    expect(parsed.arch).toBe("x86");
    expect(parsed.limit).toBe(5);
  });

  it("rejects an unknown arch", () => {
    expect(() => cheapestServerType.inputSchema.parse({ arch: "riscv" })).toThrow();
  });
});

describe("cheapestServerType — handler", () => {
  it("ranks x86 non-deprecated types cheapest-first with currency", async () => {
    const ctx = makeCtx();
    const result = (await cheapestServerType.handler(
      cheapestServerType.inputSchema.parse({}),
      ctx,
    )) as { server_types: Array<Record<string, unknown>>; count: number; currency: string };
    expect(Object.keys(result).sort()).toEqual(["count", "currency", "server_types"]);
    expect(result.currency).toBe("EUR");
    // cax11 is arm (excluded); cx11 deprecated (excluded).
    expect(result.server_types.map((s) => s.name)).toEqual(["cx22", "cx32", "ccx13"]);
    expect(result.count).toBe(3);
    expect(Object.keys(result.server_types[0]!).sort()).toEqual(PRICED_TYPE_KEYS);
  });

  it("honors limit", async () => {
    const result = (await cheapestServerType.handler(
      cheapestServerType.inputSchema.parse({ limit: 1 }),
      makeCtx(),
    )) as { server_types: unknown[]; count: number };
    expect(result.count).toBe(1);
  });

  it("filters by min_memory", async () => {
    const result = (await cheapestServerType.handler(
      cheapestServerType.inputSchema.parse({ min_memory: 8 }),
      makeCtx(),
    )) as { server_types: Array<{ name: string }> };
    expect(result.server_types.map((s) => s.name)).toEqual(["cx32", "ccx13"]);
  });
});

// =============================================================================
// estimate_cost
// =============================================================================

describe("estimateCost — metadata + schema", () => {
  it("has a snake_case name and short description", () => {
    expect(estimateCost.name).toBe("estimate_cost");
    expect(estimateCost.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(estimateCost.description).toBeTruthy();
    expect(estimateCost.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults volumes_gb, primary_ipv4, backups, and months", () => {
    const parsed = estimateCost.inputSchema.parse({ server_type: "cx22" }) as {
      volumes_gb: number;
      primary_ipv4: boolean;
      backups: boolean;
      months: number;
    };
    expect(parsed.volumes_gb).toBe(0);
    expect(parsed.primary_ipv4).toBe(true);
    expect(parsed.backups).toBe(false);
    expect(parsed.months).toBe(1);
  });

  it("rejects a missing server_type", () => {
    expect(() => estimateCost.inputSchema.parse({})).toThrow();
  });
});

describe("estimateCost — handler", () => {
  it("sums server + volume + ipv4 + backups and scales by months", async () => {
    const result = (await estimateCost.handler(
      estimateCost.inputSchema.parse({
        server_type: "cx22",
        location: "nbg1",
        volumes_gb: 100,
        primary_ipv4: true,
        backups: true,
        months: 3,
      }),
      makeCtx(),
    )) as {
      currency: string;
      location: string | null;
      monthly: Record<string, number | null>;
      total_for_months: number;
      months: number;
    };
    expect(Object.keys(result).sort()).toEqual(
      ["currency", "location", "monthly", "months", "server_type", "total_for_months"].sort(),
    );
    expect(Object.keys(result.monthly).sort()).toEqual(
      ["backups", "primary_ipv4", "server", "total", "volume"].sort(),
    );
    expect(result.monthly.server).toBe(4.59);
    expect(result.monthly.volume).toBe(4.4); // 0.044 * 100
    expect(result.monthly.primary_ipv4).toBe(0.5);
    expect(result.monthly.backups).toBe(0.92); // 4.59 * 20%
    expect(result.monthly.total).toBe(10.41);
    expect(result.total_for_months).toBe(31.23);
    expect(result.months).toBe(3);
    expect(result.location).toBe("nbg1");
  });

  it("applies defaults: no volume, ipv4 on, no backups, cheapest location", async () => {
    const result = (await estimateCost.handler(
      estimateCost.inputSchema.parse({ server_type: "cx22" }),
      makeCtx(),
    )) as { monthly: Record<string, number | null>; location: string | null; total_for_months: number };
    // No location pinned -> cheapest (fsn1 4.20) for server, cheapest ipv4 (0.40).
    expect(result.monthly.server).toBe(4.2);
    expect(result.monthly.volume).toBe(0);
    expect(result.monthly.primary_ipv4).toBe(0.4);
    expect(result.monthly.backups).toBe(0);
    expect(result.monthly.total).toBe(4.6);
    expect(result.total_for_months).toBe(4.6);
    expect(result.location).toBeNull();
  });

  it("returns a null server price for an unknown type", async () => {
    const result = (await estimateCost.handler(
      estimateCost.inputSchema.parse({ server_type: "nope", primary_ipv4: false }),
      makeCtx(),
    )) as { monthly: Record<string, number | null> };
    expect(result.monthly.server).toBeNull();
    expect(result.monthly.total).toBe(0);
  });
});
