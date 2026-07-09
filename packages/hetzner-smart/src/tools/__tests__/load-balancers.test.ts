import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listLoadBalancers,
  getLoadBalancer,
  createLoadBalancer,
  deleteLoadBalancer,
} from "../load-balancers.js";

// A full upstream load balancer, richer than the slim shape so the mapper's
// field-stripping is observable.
const sampleLb = {
  id: 4711,
  name: "web-frontend",
  load_balancer_type: { id: 1, name: "lb11", max_services: 5 },
  public_net: {
    enabled: true,
    ipv4: { ip: "1.2.3.4", dns_ptr: "static.hetzner.cloud" },
    ipv6: { ip: "2001:db8::1", dns_ptr: null },
  },
  location: { id: 1, name: "fsn1", city: "Falkenstein", country: "DE" },
  services: [{ protocol: "http" }, { protocol: "https" }],
  targets: [{ type: "server", server: { id: 42 } }],
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  algorithm: { type: "round_robin" },
  private_net: [{ network: 99 }],
  created: "2026-05-01T00:00:00Z",
  protection: { delete: false },
  outgoing_traffic: 123,
};

const expectedSlim = {
  id: 4711,
  name: "web-frontend",
  load_balancer_type: "lb11",
  public_ipv4: "1.2.3.4",
  location: "fsn1",
  services_count: 2,
  targets_count: 1,
  labels: { env: "prod" },
};

const SLIM_KEYS = Object.keys(expectedSlim).sort();

// A settled create action so settleAction resolves without waitForAction.
const successAction = {
  id: 88,
  command: "create_load_balancer",
  status: "success",
  progress: 100,
  started: "2026-05-01T00:00:00Z",
  finished: "2026-05-01T00:00:05Z",
  resources: [{ id: 4711, type: "load_balancer" }],
  error: null,
};

// Mirror of the real client.extractAction so the stub behaves faithfully:
// pull `body.action`, else the first of `body.actions`, else undefined.
function fakeExtractAction(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (rec.action && typeof rec.action === "object") return rec.action;
    if (Array.isArray(rec.actions) && rec.actions[0]) return rec.actions[0];
  }
  return undefined;
}

type FakeLbClient = {
  listLoadBalancers: ReturnType<typeof vi.fn>;
  getLoadBalancer: ReturnType<typeof vi.fn>;
  createLoadBalancer: ReturnType<typeof vi.fn>;
  deleteLoadBalancer: ReturnType<typeof vi.fn>;
  extractAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeLbClient> = {}): FakeLbClient {
  return {
    listLoadBalancers: vi
      .fn()
      .mockResolvedValue({ load_balancers: [sampleLb], meta: {} }),
    getLoadBalancer: vi.fn().mockResolvedValue(sampleLb),
    createLoadBalancer: vi
      .fn()
      .mockResolvedValue({ load_balancer: sampleLb, action: successAction }),
    deleteLoadBalancer: vi.fn().mockResolvedValue(undefined),
    extractAction: vi.fn(fakeExtractAction),
    waitForAction: vi.fn().mockResolvedValue(successAction),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeLbClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

const ACTION_KEYS = ["id", "command", "status", "progress", "finished"].sort();

// =============================================================================
// list_load_balancers
// =============================================================================

describe("listLoadBalancers — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listLoadBalancers.name).toBe("list_load_balancers");
    expect(listLoadBalancers.description).toBe("List load balancers.");
    expect(listLoadBalancers.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listLoadBalancers.inputSchema.parse({})).not.toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => listLoadBalancers.inputSchema.parse({ name: "" })).toThrow();
  });
});

describe("listLoadBalancers — handler", () => {
  it("forwards only provided filter params", async () => {
    const client = makeClient();
    await listLoadBalancers.handler(
      listLoadBalancers.inputSchema.parse({
        name: "web-frontend",
        label_selector: "env=prod",
      }),
      { client: client as unknown as never },
    );
    expect(client.listLoadBalancers).toHaveBeenCalledTimes(1);
    expect(client.listLoadBalancers).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-frontend", label_selector: "env=prod" }),
    );
  });

  it("passes an empty params object when no filters given", async () => {
    const client = makeClient();
    await listLoadBalancers.handler(listLoadBalancers.inputSchema.parse({}), {
      client: client as unknown as never,
    });
    expect(client.listLoadBalancers).toHaveBeenCalledWith({});
  });

  it("maps body.load_balancers to the slim shape and strips extras", async () => {
    const result = (await listLoadBalancers.handler(
      listLoadBalancers.inputSchema.parse({}),
      makeCtx(),
    )) as { load_balancers: Array<Record<string, unknown>>; count: number };

    expect(result.count).toBe(1);
    const slim = result.load_balancers[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual(expectedSlim);
    expect(slim).not.toHaveProperty("algorithm");
    expect(slim).not.toHaveProperty("private_net");
    expect(slim).not.toHaveProperty("created");
    expect(slim).not.toHaveProperty("protection");
  });

  it("guards a non-array body and returns an empty list", async () => {
    const result = (await listLoadBalancers.handler(
      listLoadBalancers.inputSchema.parse({}),
      makeCtx({ listLoadBalancers: vi.fn().mockResolvedValue({ meta: {} }) }),
    )) as { load_balancers: unknown[]; count: number };
    expect(result.load_balancers).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("null-safes nested fields when upstream omits them", async () => {
    const result = (await listLoadBalancers.handler(
      listLoadBalancers.inputSchema.parse({}),
      makeCtx({
        listLoadBalancers: vi
          .fn()
          .mockResolvedValue({ load_balancers: [{ id: 7, name: "bare" }] }),
      }),
    )) as { load_balancers: Array<Record<string, unknown>> };
    const slim = result.load_balancers[0]!;
    expect(slim.load_balancer_type).toBeNull();
    expect(slim.public_ipv4).toBeNull();
    expect(slim.location).toBeNull();
    expect(slim.services_count).toBe(0);
    expect(slim.targets_count).toBe(0);
    expect(slim.labels).toEqual({});
  });
});

// =============================================================================
// get_load_balancer
// =============================================================================

describe("getLoadBalancer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getLoadBalancer.name).toBe("get_load_balancer");
    expect(getLoadBalancer.description).toBe("Get a load balancer by ID.");
    expect(getLoadBalancer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-positive load_balancer_id", () => {
    expect(() =>
      getLoadBalancer.inputSchema.parse({ load_balancer_id: 0 }),
    ).toThrow();
  });

  it("rejects a non-integer load_balancer_id", () => {
    expect(() =>
      getLoadBalancer.inputSchema.parse({ load_balancer_id: 4.5 }),
    ).toThrow();
  });
});

describe("getLoadBalancer — handler", () => {
  it("calls client.getLoadBalancer with the id and maps the unwrapped body", async () => {
    const client = makeClient();
    const result = (await getLoadBalancer.handler(
      getLoadBalancer.inputSchema.parse({ load_balancer_id: 4711 }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(client.getLoadBalancer).toHaveBeenCalledWith(4711);
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).toEqual(expectedSlim);
  });

  it("propagates NotFoundError from the client", async () => {
    await expect(
      getLoadBalancer.handler(
        getLoadBalancer.inputSchema.parse({ load_balancer_id: 999 }),
        makeCtx({
          getLoadBalancer: vi
            .fn()
            .mockRejectedValue(new NotFoundError("Load balancer not found: 999")),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// create_load_balancer
// =============================================================================

describe("createLoadBalancer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(createLoadBalancer.name).toBe("create_load_balancer");
    expect(createLoadBalancer.description).toBe("Create a load balancer.");
    expect(createLoadBalancer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults public_interface to true and wait to true", () => {
    const parsed = createLoadBalancer.inputSchema.parse({
      name: "lb",
      load_balancer_type: "lb11",
    }) as { public_interface: boolean; wait: boolean };
    expect(parsed.public_interface).toBe(true);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a missing load_balancer_type", () => {
    expect(() =>
      createLoadBalancer.inputSchema.parse({ name: "lb" }),
    ).toThrow();
  });

  it("rejects an unknown algorithm", () => {
    expect(() =>
      createLoadBalancer.inputSchema.parse({
        name: "lb",
        load_balancer_type: "lb11",
        algorithm: "random",
      }),
    ).toThrow();
  });
});

describe("createLoadBalancer — handler", () => {
  it("builds the request body, wrapping algorithm in { type }", async () => {
    const client = makeClient();
    await createLoadBalancer.handler(
      createLoadBalancer.inputSchema.parse({
        name: "web-frontend",
        load_balancer_type: "lb11",
        location: "fsn1",
        algorithm: "least_connections",
        network: 99,
        labels: { env: "prod" },
      }),
      { client: client as unknown as never },
    );
    expect(client.createLoadBalancer).toHaveBeenCalledTimes(1);
    expect(client.createLoadBalancer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "web-frontend",
        load_balancer_type: "lb11",
        location: "fsn1",
        public_interface: true,
        algorithm: { type: "least_connections" },
        network: 99,
        labels: { env: "prod" },
      }),
    );
  });

  it("omits optional fields that were not provided", async () => {
    const client = makeClient();
    await createLoadBalancer.handler(
      createLoadBalancer.inputSchema.parse({
        name: "lb",
        load_balancer_type: "lb11",
        network_zone: "eu-central",
      }),
      { client: client as unknown as never },
    );
    const body = client.createLoadBalancer.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      name: "lb",
      load_balancer_type: "lb11",
      public_interface: true,
      network_zone: "eu-central",
    });
    expect(body).not.toHaveProperty("algorithm");
    expect(body).not.toHaveProperty("services");
    expect(body).not.toHaveProperty("location");
  });

  it("returns the slim load_balancer plus a settled action", async () => {
    const result = (await createLoadBalancer.handler(
      createLoadBalancer.inputSchema.parse({
        name: "web-frontend",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
      makeCtx(),
    )) as {
      load_balancer: Record<string, unknown>;
      action: Record<string, unknown> | null;
    };
    expect(Object.keys(result).sort()).toEqual(["action", "load_balancer"]);
    expect(Object.keys(result.load_balancer).sort()).toEqual(SLIM_KEYS);
    expect(result.load_balancer).toEqual(expectedSlim);
    expect(result.action).not.toBeNull();
    expect(Object.keys(result.action!).sort()).toEqual(ACTION_KEYS);
    expect(result.action).toMatchObject({ id: 88, status: "success" });
  });

  it("returns load_balancer: null when the body carries no resource", async () => {
    const result = (await createLoadBalancer.handler(
      createLoadBalancer.inputSchema.parse({
        name: "lb",
        load_balancer_type: "lb11",
      }),
      makeCtx({
        createLoadBalancer: vi
          .fn()
          .mockResolvedValue({ action: successAction }),
      }),
    )) as { load_balancer: unknown; action: unknown };
    expect(result.load_balancer).toBeNull();
    expect(result.action).not.toBeNull();
  });
});

// =============================================================================
// delete_load_balancer
// =============================================================================

describe("deleteLoadBalancer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteLoadBalancer.name).toBe("delete_load_balancer");
    expect(deleteLoadBalancer.description).toBe("Delete a load balancer.");
    expect(deleteLoadBalancer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false and wait to true", () => {
    const parsed = deleteLoadBalancer.inputSchema.parse({
      load_balancer_id: 4711,
    }) as { confirm: boolean; wait: boolean };
    expect(parsed.confirm).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive load_balancer_id", () => {
    expect(() =>
      deleteLoadBalancer.inputSchema.parse({ load_balancer_id: -1 }),
    ).toThrow();
  });
});

describe("deleteLoadBalancer — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteLoadBalancer.handler(
        deleteLoadBalancer.inputSchema.parse({ load_balancer_id: 4711 }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteLoadBalancer).not.toHaveBeenCalled();
  });

  it("preview names the action and the load balancer id", async () => {
    const client = makeClient();
    try {
      await deleteLoadBalancer.handler(
        deleteLoadBalancer.inputSchema.parse({ load_balancer_id: 4711 }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("4711");
    }
  });
});

describe("deleteLoadBalancer — past confirm gate", () => {
  it("with confirm: true deletes and returns the confirmation shape", async () => {
    const client = makeClient();
    const result = (await deleteLoadBalancer.handler(
      deleteLoadBalancer.inputSchema.parse({
        load_balancer_id: 4711,
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as { load_balancer_id: number; action: unknown; deleted: boolean };
    expect(client.deleteLoadBalancer).toHaveBeenCalledWith(4711);
    expect(Object.keys(result).sort()).toEqual(
      ["action", "deleted", "load_balancer_id"].sort(),
    );
    // Hetzner DELETE /load_balancers is synchronous (204) — no action.
    expect(result.action).toBeNull();
    expect(result.load_balancer_id).toBe(4711);
    expect(result.deleted).toBe(true);
  });

  it("propagates NotFoundError from the client", async () => {
    await expect(
      deleteLoadBalancer.handler(
        deleteLoadBalancer.inputSchema.parse({
          load_balancer_id: 999,
          confirm: true,
        }),
        makeCtx({
          deleteLoadBalancer: vi
            .fn()
            .mockRejectedValue(new NotFoundError("Load balancer not found: 999")),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
