import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listNetworks,
  getNetwork,
  createNetwork,
  deleteNetwork,
} from "../networks.js";

// A full upstream Network with extra fields the slim mapper must strip.
const sampleNetwork = {
  id: 4711,
  name: "prod-vpc",
  ip_range: "10.0.0.0/16",
  subnets: [
    {
      type: "cloud",
      ip_range: "10.0.1.0/24",
      network_zone: "eu-central",
      gateway: "10.0.0.1",
    },
    {
      type: "cloud",
      ip_range: "10.0.2.0/24",
      network_zone: "eu-central",
      gateway: "10.0.0.1",
    },
  ],
  routes: [{ destination: "10.100.1.0/24", gateway: "10.0.1.1" }],
  servers: [101, 102, 103],
  protection: { delete: true },
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  load_balancers: [201],
  created: "2026-05-01T00:00:00+00:00",
  expose_routes_to_vswitch: false,
};

const SLIM_KEYS = [
  "id",
  "name",
  "ip_range",
  "subnets_count",
  "servers_count",
  "protection_delete",
  "labels",
].sort();

type FakeNetworkClient = {
  listNetworks: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
  createNetwork: ReturnType<typeof vi.fn>;
  deleteNetwork: ReturnType<typeof vi.fn>;
};

function makeClient(
  overrides: Partial<FakeNetworkClient> = {},
): FakeNetworkClient {
  return {
    listNetworks: vi
      .fn()
      .mockResolvedValue({ networks: [sampleNetwork], meta: {} }),
    getNetwork: vi.fn().mockResolvedValue(sampleNetwork),
    createNetwork: vi.fn().mockResolvedValue({ network: sampleNetwork }),
    deleteNetwork: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// =============================================================================
// list_networks
// =============================================================================

describe("listNetworks — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listNetworks.name).toBe("list_networks");
    expect(listNetworks.description.length).toBeGreaterThan(0);
    expect(listNetworks.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object (all filters optional)", () => {
    expect(() => listNetworks.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() =>
      listNetworks.inputSchema.parse({ name: 123 }),
    ).toThrow();
  });
});

describe("listNetworks — handler", () => {
  it("forwards name and label_selector filters to the client", async () => {
    const client = makeClient();
    await listNetworks.handler(
      listNetworks.inputSchema.parse({
        name: "prod-vpc",
        label_selector: "env=prod",
      }),
      { client: client as unknown as never },
    );
    expect(client.listNetworks).toHaveBeenCalledTimes(1);
    expect(client.listNetworks).toHaveBeenCalledWith({
      name: "prod-vpc",
      label_selector: "env=prod",
    });
  });

  it("omits undefined filters (empty params when none given)", async () => {
    const client = makeClient();
    await listNetworks.handler(listNetworks.inputSchema.parse({}), {
      client: client as unknown as never,
    });
    expect(client.listNetworks).toHaveBeenCalledWith({});
  });

  it("maps body.networks to the slim shape and strips extras", async () => {
    const client = makeClient();
    const result = (await listNetworks.handler(
      listNetworks.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { networks: Array<Record<string, unknown>>; count: number };

    expect(result.networks).toHaveLength(1);
    expect(result.count).toBe(1);
    const slim = result.networks[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 4711,
      name: "prod-vpc",
      ip_range: "10.0.0.0/16",
      subnets_count: 2,
      servers_count: 3,
      protection_delete: true,
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("subnets");
    expect(slim).not.toHaveProperty("routes");
    expect(slim).not.toHaveProperty("servers");
    expect(slim).not.toHaveProperty("created");
    expect(slim).not.toHaveProperty("load_balancers");
  });

  it("null-safes optional fields and defaults counts to 0", async () => {
    const client = makeClient({
      listNetworks: vi.fn().mockResolvedValue({ networks: [{ id: 9 }] }),
    });
    const result = (await listNetworks.handler(
      listNetworks.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { networks: SlimNetworkShape[] };
    const slim = result.networks[0]!;
    expect(slim.id).toBe(9);
    expect(slim.name).toBe("");
    expect(slim.ip_range).toBeNull();
    expect(slim.subnets_count).toBe(0);
    expect(slim.servers_count).toBe(0);
    expect(slim.protection_delete).toBe(false);
    expect(slim.labels).toEqual({});
  });

  it("returns empty list with count 0 when upstream lacks a networks array", async () => {
    const client = makeClient({
      listNetworks: vi.fn().mockResolvedValue({ meta: {} }),
    });
    const result = (await listNetworks.handler(
      listNetworks.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { networks: unknown[]; count: number };
    expect(result.networks).toEqual([]);
    expect(result.count).toBe(0);
  });
});

type SlimNetworkShape = {
  id: number;
  name: string;
  ip_range: string | null;
  subnets_count: number;
  servers_count: number;
  protection_delete: boolean;
  labels: Record<string, string>;
};

// =============================================================================
// get_network
// =============================================================================

describe("getNetwork — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(getNetwork.name).toBe("get_network");
    expect(getNetwork.description.length).toBeGreaterThan(0);
    expect(getNetwork.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-integer network_id", () => {
    expect(() =>
      getNetwork.inputSchema.parse({ network_id: 4.5 }),
    ).toThrow();
  });

  it("rejects a non-positive network_id", () => {
    expect(() =>
      getNetwork.inputSchema.parse({ network_id: -1 }),
    ).toThrow();
  });

  it("rejects a string network_id", () => {
    expect(() =>
      getNetwork.inputSchema.parse({ network_id: "4711" }),
    ).toThrow();
  });
});

describe("getNetwork — handler", () => {
  it("calls client.getNetwork with the input id (already-unwrapped)", async () => {
    const client = makeClient();
    await getNetwork.handler(
      getNetwork.inputSchema.parse({ network_id: 4711 }),
      { client: client as unknown as never },
    );
    expect(client.getNetwork).toHaveBeenCalledTimes(1);
    expect(client.getNetwork).toHaveBeenCalledWith(4711);
  });

  it("returns the slim shape (only listed keys)", async () => {
    const client = makeClient();
    const result = (await getNetwork.handler(
      getNetwork.inputSchema.parse({ network_id: 4711 }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).not.toHaveProperty("created");
    expect(result).not.toHaveProperty("subnets");
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getNetwork: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Network not found: 4711")),
    });
    await expect(
      getNetwork.handler(getNetwork.inputSchema.parse({ network_id: 4711 }), {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// create_network
// =============================================================================

describe("createNetwork — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createNetwork.name).toBe("create_network");
    expect(createNetwork.description.length).toBeGreaterThan(0);
    expect(createNetwork.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects an empty name", () => {
    expect(() =>
      createNetwork.inputSchema.parse({ name: "", ip_range: "10.0.0.0/16" }),
    ).toThrow();
  });

  it("rejects an empty ip_range", () => {
    expect(() =>
      createNetwork.inputSchema.parse({ name: "vpc", ip_range: "" }),
    ).toThrow();
  });

  it("rejects a subnet missing network_zone", () => {
    expect(() =>
      createNetwork.inputSchema.parse({
        name: "vpc",
        ip_range: "10.0.0.0/16",
        subnets: [{ type: "cloud", ip_range: "10.0.1.0/24" }],
      }),
    ).toThrow();
  });

  it("accepts a full body with subnets, routes, and labels", () => {
    expect(() =>
      createNetwork.inputSchema.parse({
        name: "vpc",
        ip_range: "10.0.0.0/16",
        subnets: [
          {
            type: "cloud",
            ip_range: "10.0.1.0/24",
            network_zone: "eu-central",
          },
        ],
        routes: [{ destination: "10.100.1.0/24", gateway: "10.0.1.1" }],
        labels: { env: "prod" },
      }),
    ).not.toThrow();
  });
});

describe("createNetwork — handler", () => {
  it("forwards only name and ip_range when no optional fields given", async () => {
    const client = makeClient();
    await createNetwork.handler(
      createNetwork.inputSchema.parse({
        name: "prod-vpc",
        ip_range: "10.0.0.0/16",
      }),
      { client: client as unknown as never },
    );
    expect(client.createNetwork).toHaveBeenCalledTimes(1);
    expect(client.createNetwork).toHaveBeenCalledWith({
      name: "prod-vpc",
      ip_range: "10.0.0.0/16",
    });
  });

  it("forwards subnets, routes, and labels when provided", async () => {
    const client = makeClient();
    const subnets = [
      { type: "cloud", ip_range: "10.0.1.0/24", network_zone: "eu-central" },
    ];
    const routes = [{ destination: "10.100.1.0/24", gateway: "10.0.1.1" }];
    await createNetwork.handler(
      createNetwork.inputSchema.parse({
        name: "prod-vpc",
        ip_range: "10.0.0.0/16",
        subnets,
        routes,
        labels: { env: "prod" },
      }),
      { client: client as unknown as never },
    );
    expect(client.createNetwork).toHaveBeenCalledWith({
      name: "prod-vpc",
      ip_range: "10.0.0.0/16",
      subnets,
      routes,
      labels: { env: "prod" },
    });
  });

  it("pulls body.network and returns the slim shape (only listed keys)", async () => {
    const client = makeClient();
    const result = (await createNetwork.handler(
      createNetwork.inputSchema.parse({
        name: "prod-vpc",
        ip_range: "10.0.0.0/16",
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).toEqual({
      id: 4711,
      name: "prod-vpc",
      ip_range: "10.0.0.0/16",
      subnets_count: 2,
      servers_count: 3,
      protection_delete: true,
      labels: { env: "prod" },
    });
  });

  it("null-safes when body.network is absent", async () => {
    const client = makeClient({
      createNetwork: vi.fn().mockResolvedValue({}),
    });
    const result = (await createNetwork.handler(
      createNetwork.inputSchema.parse({
        name: "prod-vpc",
        ip_range: "10.0.0.0/16",
      }),
      { client: client as unknown as never },
    )) as SlimNetworkShape;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result.id).toBe(0);
    expect(result.ip_range).toBeNull();
  });
});

// =============================================================================
// delete_network
// =============================================================================

describe("deleteNetwork — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(deleteNetwork.name).toBe("delete_network");
    expect(deleteNetwork.description.length).toBeGreaterThan(0);
    expect(deleteNetwork.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteNetwork.inputSchema.parse({
      network_id: 4711,
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive network_id", () => {
    expect(() =>
      deleteNetwork.inputSchema.parse({ network_id: 0, confirm: true }),
    ).toThrow();
  });
});

describe("deleteNetwork — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteNetwork.handler(
        deleteNetwork.inputSchema.parse({ network_id: 4711 }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteNetwork).not.toHaveBeenCalled();
  });

  it("preview names the network id and warns of permanent deletion", async () => {
    const client = makeClient();
    try {
      await deleteNetwork.handler(
        deleteNetwork.inputSchema.parse({ network_id: 4711 }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("4711");
      expect(preview).toContain("PERMANENTLY DELETE");
    }
  });
});

describe("deleteNetwork — past confirm gate", () => {
  it("with confirm: true deletes and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deleteNetwork.handler(
      deleteNetwork.inputSchema.parse({ network_id: 4711, confirm: true }),
      { client: client as unknown as never },
    )) as { network_id: number; deleted: boolean };
    expect(client.deleteNetwork).toHaveBeenCalledWith(4711);
    expect(result).toEqual({ network_id: 4711, deleted: true });
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      deleteNetwork: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Network not found: 4711")),
    });
    await expect(
      deleteNetwork.handler(
        deleteNetwork.inputSchema.parse({ network_id: 4711, confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
