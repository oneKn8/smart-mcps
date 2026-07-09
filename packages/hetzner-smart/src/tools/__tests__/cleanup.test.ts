import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import { cleanupWaste } from "../cleanup.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const serversList = [
  { id: 42, name: "web-1", status: "running" },
  { id: 43, name: "db-1", status: "off" }, // stopped -> reported only
];
const volumesList = [
  { id: 100, name: "vol-a", size: 50, server: 42 }, // attached
  { id: 101, name: "vol-b", size: 100, server: null }, // unattached
];
const floatingIpsList = [
  { id: 200, ip: "9.9.9.9", type: "ipv4", server: 42 }, // assigned
  { id: 201, ip: "9.9.9.10", type: "ipv4", server: null }, // unassigned
];
const primaryIpsList = [
  { id: 300, ip: "8.8.8.8", type: "ipv4", assignee_id: 42 }, // assigned
  { id: 301, ip: "8.8.8.9", type: "ipv4", assignee_id: null }, // unassigned
];

const pricingFixture = {
  currency: "EUR",
  volume: { price_per_gb_month: { net: "0.0440" } },
  primary_ips: [{ type: "ipv4", prices: [{ location: "nbg1", price_monthly: { net: "0.4000" } }] }],
  floating_ips: [{ type: "ipv4", prices: [{ location: "nbg1", price_monthly: { net: "0.9000" } }] }],
};

const BY_PATH: Record<string, unknown[]> = {
  "/servers": serversList,
  "/volumes": volumesList,
  "/floating_ips": floatingIpsList,
  "/primary_ips": primaryIpsList,
};

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    getAllPages: vi.fn((path: string) => Promise.resolve(BY_PATH[path] ?? [])),
    getPricing: vi.fn().mockResolvedValue(pricingFixture),
    deleteVolume: vi.fn().mockResolvedValue(undefined),
    deleteFloatingIp: vi.fn().mockResolvedValue(undefined),
    deletePrimaryIp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

function assertNoDeletes(client: FakeClient) {
  expect(client.deleteVolume).not.toHaveBeenCalled();
  expect(client.deleteFloatingIp).not.toHaveBeenCalled();
  expect(client.deletePrimaryIp).not.toHaveBeenCalled();
}

// =============================================================================
// metadata + schema
// =============================================================================

describe("cleanupWaste — metadata + schema", () => {
  it("has a snake_case name and short description", () => {
    expect(cleanupWaste.name).toBe("cleanup_waste");
    expect(cleanupWaste.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(cleanupWaste.description).toBeTruthy();
    expect(cleanupWaste.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults dry_run to true and confirm to false", () => {
    const parsed = cleanupWaste.inputSchema.parse({}) as {
      dry_run: boolean;
      confirm: boolean;
    };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.confirm).toBe(false);
  });
});

// =============================================================================
// dry_run path (default)
// =============================================================================

describe("cleanupWaste — dry_run (default)", () => {
  it("surfaces candidates + savings and deletes nothing", async () => {
    const ctx = makeCtx();
    const result = (await cleanupWaste.handler(
      cleanupWaste.inputSchema.parse({}),
      ctx,
    )) as {
      dry_run: boolean;
      candidates: {
        stopped_servers: unknown[];
        unattached_volumes: Array<Record<string, unknown>>;
        unassigned_floating_ips: Array<Record<string, unknown>>;
        unassigned_primary_ips: Array<Record<string, unknown>>;
      };
      estimated_monthly_savings_eur: number;
      deleted: unknown[];
    };
    expect(Object.keys(result).sort()).toEqual(
      ["candidates", "deleted", "dry_run", "estimated_monthly_savings_eur"].sort(),
    );
    expect(Object.keys(result.candidates).sort()).toEqual(
      [
        "stopped_servers",
        "unassigned_floating_ips",
        "unassigned_primary_ips",
        "unattached_volumes",
      ].sort(),
    );
    expect(result.dry_run).toBe(true);
    expect(result.candidates.stopped_servers).toEqual([{ id: 43, name: "db-1" }]);
    expect(result.candidates.unattached_volumes).toEqual([
      { id: 101, name: "vol-b", size: 100 },
    ]);
    expect(result.candidates.unassigned_floating_ips).toEqual([
      { id: 201, ip: "9.9.9.10" },
    ]);
    expect(result.candidates.unassigned_primary_ips).toEqual([
      { id: 301, ip: "8.8.8.9" },
    ]);
    // 0.044*100 (4.4) + 0.9 (floating) + 0.4 (primary) = 5.7
    expect(result.estimated_monthly_savings_eur).toBe(5.7);
    expect(result.deleted).toEqual([]);
    assertNoDeletes(ctx.client as unknown as FakeClient);
  });

  it("dry_run:true wins even when confirm:true", async () => {
    const ctx = makeCtx();
    const result = (await cleanupWaste.handler(
      cleanupWaste.inputSchema.parse({ dry_run: true, confirm: true }),
      ctx,
    )) as { deleted: unknown[] };
    expect(result.deleted).toEqual([]);
    assertNoDeletes(ctx.client as unknown as FakeClient);
  });
});

// =============================================================================
// confirm gate (dry_run:false without confirm)
// =============================================================================

describe("cleanupWaste — confirm gate", () => {
  it("throws ConfirmRequiredError and deletes nothing", async () => {
    const ctx = makeCtx();
    await expect(
      cleanupWaste.handler(
        cleanupWaste.inputSchema.parse({ dry_run: false, confirm: false }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    assertNoDeletes(ctx.client as unknown as FakeClient);
  });

  it("preview lists deletable counts and notes stopped servers are kept", async () => {
    const ctx = makeCtx();
    let caught: unknown;
    try {
      await cleanupWaste.handler(
        cleanupWaste.inputSchema.parse({ dry_run: false }),
        ctx,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const preview = (caught as ConfirmRequiredError).preview;
    expect(preview).toContain("volume");
    expect(preview).toMatch(/not deleted/i);
    expect(preview).toContain("5.7");
  });
});

// =============================================================================
// apply path (dry_run:false + confirm:true)
// =============================================================================

describe("cleanupWaste — apply path", () => {
  it("deletes each unattached volume and unassigned IP, never a server", async () => {
    const ctx = makeCtx();
    const result = (await cleanupWaste.handler(
      cleanupWaste.inputSchema.parse({ dry_run: false, confirm: true }),
      ctx,
    )) as { dry_run: boolean; deleted: Array<{ type: string; id: number }> };
    const client = ctx.client as unknown as FakeClient;
    expect(client.deleteVolume).toHaveBeenCalledWith(101);
    expect(client.deleteFloatingIp).toHaveBeenCalledWith(201);
    expect(client.deletePrimaryIp).toHaveBeenCalledWith(301);
    expect(client.deleteVolume).toHaveBeenCalledTimes(1);
    expect(result.dry_run).toBe(false);
    expect(result.deleted).toEqual([
      { type: "volume", id: 101 },
      { type: "floating_ip", id: 201 },
      { type: "primary_ip", id: 301 },
    ]);
  });
});
