import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ValidationError } from "smart-mcp-core";
import { deployServer } from "../deploy.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const serverTypesList = [
  {
    id: 1,
    name: "cx22",
    cores: 2,
    memory: 4,
    disk: 40,
    cpu_type: "shared",
    architecture: "x86",
    storage_type: "local",
    deprecated: false,
    prices: [{ location: "nbg1", price_monthly: { net: "4.5900" }, price_hourly: { net: "0.0060" } }],
  },
  {
    id: 2,
    name: "cx32",
    cores: 4,
    memory: 8,
    disk: 80,
    cpu_type: "shared",
    architecture: "x86",
    storage_type: "local",
    deprecated: false,
    prices: [{ location: "nbg1", price_monthly: { net: "8.4900" }, price_hourly: { net: "0.0120" } }],
  },
];

const pricingFixture = {
  currency: "EUR",
  server_types: [
    { id: 1, name: "cx22", prices: [{ location: "nbg1", price_hourly: { net: "0.0060" }, price_monthly: { net: "4.5900" } }] },
    { id: 2, name: "cx32", prices: [{ location: "nbg1", price_hourly: { net: "0.0120" }, price_monthly: { net: "8.4900" } }] },
  ],
};

const rawServer = {
  id: 42,
  name: "web-1",
  status: "running",
  public_net: { ipv4: { ip: "1.2.3.4" }, ipv6: { ip: "2001:db8::1" } },
  server_type: { name: "cx22", cores: 2, memory: 4, disk: 40, architecture: "x86" },
  datacenter: { location: { name: "nbg1" } },
  image: { name: "ubuntu-24.04" },
  labels: {},
  protection: { delete: false, rebuild: false },
};

const successAction = {
  id: 1,
  command: "create_server",
  status: "success",
  progress: 100,
  started: "2026-05-01T00:00:00Z",
  finished: "2026-05-01T00:00:10Z",
  resources: [{ id: 42, type: "server" }],
  error: null,
};

const createBody = { server: rawServer, action: successAction, root_password: "s3cr3t" };

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    getAllPages: vi.fn((path: string) =>
      Promise.resolve(path === "/server_types" ? serverTypesList : []),
    ),
    createFirewall: vi.fn().mockResolvedValue({ firewall: { id: 77 }, actions: [] }),
    createServer: vi.fn().mockResolvedValue(createBody),
    getServer: vi.fn().mockResolvedValue(rawServer),
    getPricing: vi.fn().mockResolvedValue(pricingFixture),
    extractAction: vi.fn((body: unknown) => (body as { action?: unknown })?.action),
    waitForAction: vi.fn().mockResolvedValue(successAction),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

const OUTPUT_KEYS = [
  "server_id",
  "name",
  "status",
  "ipv4",
  "ipv6",
  "server_type",
  "location",
  "root_password",
  "monthly_cost_eur",
  "firewall_id",
  "action",
].sort();

// =============================================================================
// metadata + schema
// =============================================================================

describe("deployServer — metadata + schema", () => {
  it("has a snake_case name, short description, and zod schema", () => {
    expect(deployServer.name).toBe("deploy_server");
    expect(deployServer.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(deployServer.description).toBeTruthy();
    expect(deployServer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults arch, location, image, quick_firewall, and wait", () => {
    const parsed = deployServer.inputSchema.parse({ name: "web-1" }) as {
      arch: string;
      location: string;
      image: string;
      quick_firewall: boolean;
      wait: boolean;
    };
    expect(parsed.arch).toBe("x86");
    expect(parsed.location).toBe("nbg1");
    expect(parsed.image).toBe("ubuntu-24.04");
    expect(parsed.quick_firewall).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a missing name", () => {
    expect(() => deployServer.inputSchema.parse({})).toThrow();
  });
});

// =============================================================================
// handler
// =============================================================================

describe("deployServer — handler", () => {
  it("resolves the cheapest type when server_type is omitted", async () => {
    const ctx = makeCtx();
    const result = (await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1" }),
      ctx,
    )) as Record<string, unknown>;
    const client = ctx.client as unknown as FakeClient;
    expect(client.getAllPages).toHaveBeenCalledWith("/server_types", "server_types");
    expect(client.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ server_type: "cx22" }),
    );
    expect(result.server_type).toBe("cx22");
    expect(result.monthly_cost_eur).toBe(4.59);
  });

  it("uses an explicit server_type without ranking", async () => {
    const ctx = makeCtx();
    await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1", server_type: "cx32" }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.getAllPages).not.toHaveBeenCalled();
    expect(client.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ server_type: "cx32" }),
    );
  });

  it("creates a quick firewall and attaches it", async () => {
    const ctx = makeCtx();
    const result = (await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1", quick_firewall: true }),
      ctx,
    )) as Record<string, unknown>;
    const client = ctx.client as unknown as FakeClient;
    expect(client.createFirewall).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-1-fw" }),
    );
    const fwBody = client.createFirewall.mock.calls[0]?.[0] as {
      rules: Array<Record<string, unknown>>;
    };
    expect(fwBody.rules.map((r) => r.port)).toEqual(["22", "80", "443"]);
    expect(client.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ firewalls: [{ firewall: 77 }] }),
    );
    expect(result.firewall_id).toBe(77);
  });

  it("does not create a firewall by default", async () => {
    const ctx = makeCtx();
    const result = (await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1" }),
      ctx,
    )) as Record<string, unknown>;
    const client = ctx.client as unknown as FakeClient;
    expect(client.createFirewall).not.toHaveBeenCalled();
    expect(result.firewall_id).toBeNull();
    expect(client.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ firewalls: [] }),
    );
  });

  it("wraps ssh_key into an array and enables both public nets", async () => {
    const ctx = makeCtx();
    await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1", ssh_key: "my-key" }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        ssh_keys: ["my-key"],
        start_after_create: true,
        public_net: { enable_ipv4: true, enable_ipv6: true },
      }),
    );
  });

  it("settles the boot action, re-fetches for the IP, and strips to the slim shape", async () => {
    const ctx = makeCtx();
    const result = (await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1", wait: true }),
      ctx,
    )) as Record<string, unknown>;
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServer).toHaveBeenCalledWith(42);
    expect(Object.keys(result).sort()).toEqual(OUTPUT_KEYS);
    expect(result.server_id).toBe(42);
    expect(result.ipv4).toBe("1.2.3.4");
    expect(result.ipv6).toBe("2001:db8::1");
    expect(result.root_password).toBe("s3cr3t");
    expect((result.action as { status?: string })?.status).toBe("success");
  });

  it("does not re-fetch when wait is false", async () => {
    const ctx = makeCtx();
    await deployServer.handler(
      deployServer.inputSchema.parse({ name: "web-1", wait: false }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServer).not.toHaveBeenCalled();
  });

  it("throws ValidationError when no server type matches the filters", async () => {
    const ctx = makeCtx();
    await expect(
      deployServer.handler(
        deployServer.inputSchema.parse({ name: "web-1", min_cores: 999 }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const client = ctx.client as unknown as FakeClient;
    expect(client.createServer).not.toHaveBeenCalled();
  });
});
