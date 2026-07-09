import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { costAudit, dailyStatus } from "../ops.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const serversList = [
  {
    id: 42, name: "web-1", status: "running",
    public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: { ip: "2001:db8::1" } },
    server_type: { name: "cx22", cores: 2, memory: 4, disk: 40, architecture: "x86" },
    datacenter: { location: { name: "nbg1" } },
    image: { name: "ubuntu-24.04" }, labels: {}, protection: { delete: false, rebuild: false },
  },
  {
    id: 43, name: "db-1", status: "off",
    public_net: { ipv4: { ip: "5.6.7.8" }, ipv6: null },
    server_type: { name: "cx32", cores: 4, memory: 8, disk: 80, architecture: "x86" },
    datacenter: { location: { name: "nbg1" } },
    image: { name: "ubuntu-24.04" }, labels: {}, protection: { delete: false, rebuild: false },
  },
];

const volumesList = [
  { id: 100, name: "vol-a", size: 50, server: 42 },
  { id: 101, name: "vol-b", size: 100, server: null },
];
const floatingIpsList = [
  { id: 200, ip: "9.9.9.9", type: "ipv4", server: 42 },
  { id: 201, ip: "9.9.9.10", type: "ipv4", server: null },
];
const primaryIpsList = [
  { id: 300, ip: "8.8.8.8", type: "ipv4", assignee_id: 42 },
  { id: 301, ip: "8.8.8.9", type: "ipv4", assignee_id: null },
];
const networksList = [{ id: 400, name: "net-1" }];
const loadBalancersList = [{ id: 500, name: "lb-1" }];

const pricingFixture = {
  currency: "EUR",
  server_types: [
    { id: 1, name: "cx22", prices: [{ location: "nbg1", price_hourly: { net: "0.0060" }, price_monthly: { net: "4.5900" } }] },
    { id: 2, name: "cx32", prices: [{ location: "nbg1", price_hourly: { net: "0.0120" }, price_monthly: { net: "8.4900" } }] },
  ],
  volume: { price_per_gb_month: { net: "0.0440" } },
  primary_ips: [{ type: "ipv4", prices: [{ location: "nbg1", price_monthly: { net: "0.5000" } }] }],
  floating_ips: [{ type: "ipv4", prices: [{ location: "nbg1", price_monthly: { net: "1.0000" } }] }],
};

const BY_PATH: Record<string, unknown[]> = {
  "/servers": serversList,
  "/volumes": volumesList,
  "/floating_ips": floatingIpsList,
  "/primary_ips": primaryIpsList,
  "/networks": networksList,
  "/load_balancers": loadBalancersList,
};

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    getAllPages: vi.fn((path: string) => Promise.resolve(BY_PATH[path] ?? [])),
    getPricing: vi.fn().mockResolvedValue(pricingFixture),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

// =============================================================================
// cost_audit
// =============================================================================

describe("costAudit — metadata + schema", () => {
  it("has a snake_case name and short description", () => {
    expect(costAudit.name).toBe("cost_audit");
    expect(costAudit.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(costAudit.description).toBeTruthy();
    expect(costAudit.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => costAudit.inputSchema.parse({})).not.toThrow();
  });
});

describe("costAudit — handler", () => {
  it("totals monthly cost, counts running, and flags stopped-but-charged", async () => {
    const ctx = makeCtx();
    const result = (await costAudit.handler(costAudit.inputSchema.parse({}), ctx)) as {
      currency: string;
      total_monthly_eur: number;
      server_count: number;
      running_count: number;
      per_server: Array<Record<string, unknown>>;
      stopped_but_charged: Array<Record<string, unknown>>;
    };
    expect(Object.keys(result).sort()).toEqual(
      [
        "currency",
        "per_server",
        "running_count",
        "server_count",
        "stopped_but_charged",
        "total_monthly_eur",
      ].sort(),
    );
    expect(result.currency).toBe("EUR");
    expect(result.total_monthly_eur).toBe(13.08); // 4.59 + 8.49
    expect(result.server_count).toBe(2);
    expect(result.running_count).toBe(1);
    expect(Object.keys(result.per_server[0]!).sort()).toEqual(
      ["id", "location", "monthly_eur", "name", "server_type", "status"].sort(),
    );
    expect(result.stopped_but_charged).toEqual([
      { id: 43, name: "db-1", monthly_eur: 8.49 },
    ]);
  });
});

// =============================================================================
// daily_status
// =============================================================================

describe("dailyStatus — metadata + schema", () => {
  it("has a snake_case name and short description", () => {
    expect(dailyStatus.name).toBe("daily_status");
    expect(dailyStatus.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(dailyStatus.description).toBeTruthy();
    expect(dailyStatus.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("dailyStatus — handler", () => {
  it("aggregates inventory with unattached/unassigned counts and cost", async () => {
    const ctx = makeCtx();
    const result = (await dailyStatus.handler(dailyStatus.inputSchema.parse({}), ctx)) as {
      servers: { total: number; by_status: Record<string, number> };
      volumes: { total: number; unattached: number };
      floating_ips: { total: number; unassigned: number };
      primary_ips: { total: number; unassigned: number };
      networks: number;
      load_balancers: number;
      estimated_monthly_eur: number;
    };
    expect(Object.keys(result).sort()).toEqual(
      [
        "estimated_monthly_eur",
        "floating_ips",
        "load_balancers",
        "networks",
        "primary_ips",
        "servers",
        "volumes",
      ].sort(),
    );
    expect(result.servers).toEqual({ total: 2, by_status: { running: 1, off: 1 } });
    expect(result.volumes).toEqual({ total: 2, unattached: 1 });
    expect(result.floating_ips).toEqual({ total: 2, unassigned: 1 });
    expect(result.primary_ips).toEqual({ total: 2, unassigned: 1 });
    expect(result.networks).toBe(1);
    expect(result.load_balancers).toBe(1);
    expect(result.estimated_monthly_eur).toBe(13.08);
  });
});
