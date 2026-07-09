import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  listFloatingIps,
  createFloatingIp,
  deleteFloatingIp,
  assignFloatingIp,
  unassignFloatingIp,
} from "../floating-ips.js";

// A full upstream Floating IP with extra fields the slim mapper must strip.
const sampleFloatingIp = {
  id: 4711,
  name: "web-frontend",
  ip: "131.232.99.1",
  type: "ipv4",
  server: 42,
  home_location: { id: 1, name: "fsn1", city: "Falkenstein" },
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  description: "primary edge IP",
  blocked: false,
  protection: { delete: false },
  dns_ptr: [{ ip: "131.232.99.1", dns_ptr: "server.example.com" }],
  created: "2026-05-01T00:00:00+00:00",
};

// A settled action envelope (status "success" so settleAction never polls).
const sampleAction = {
  id: 13,
  command: "assign_floating_ip",
  status: "success",
  progress: 100,
  started: "2026-05-01T00:00:00+00:00",
  finished: "2026-05-01T00:00:05+00:00",
  resources: [{ id: 42, type: "server" }],
  error: null,
};

const ACTION_KEYS = ["id", "command", "status", "progress", "finished"].sort();
const SLIM_KEYS = [
  "id",
  "name",
  "ip",
  "type",
  "server",
  "home_location",
  "labels",
].sort();

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function extractActionImpl(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const rec = body as Record<string, unknown>;
  if (rec.action && typeof rec.action === "object" && !Array.isArray(rec.action))
    return rec.action;
  if (Array.isArray(rec.actions) && rec.actions[0]) return rec.actions[0];
  return undefined;
}

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listFloatingIps: vi
      .fn()
      .mockResolvedValue({ floating_ips: [sampleFloatingIp], meta: {} }),
    createFloatingIp: vi
      .fn()
      .mockResolvedValue({ floating_ip: sampleFloatingIp, action: sampleAction }),
    deleteFloatingIp: vi.fn().mockResolvedValue(undefined),
    floatingIpAction: vi.fn().mockResolvedValue({ action: sampleAction }),
    extractAction: vi.fn(extractActionImpl),
    waitForAction: vi.fn().mockResolvedValue(sampleAction),
    ...overrides,
  };
}

function ctx(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

// =============================================================================
// list_floating_ips
// =============================================================================

describe("listFloatingIps — metadata + schema", () => {
  it("has the expected name and non-empty description", () => {
    expect(listFloatingIps.name).toBe("list_floating_ips");
    expect(listFloatingIps.description.length).toBeGreaterThan(0);
    expect(listFloatingIps.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listFloatingIps.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() => listFloatingIps.inputSchema.parse({ name: 123 })).toThrow();
  });
});

describe("listFloatingIps — handler", () => {
  it("forwards label_selector and name when provided", async () => {
    const client = makeClient();
    await listFloatingIps.handler(
      listFloatingIps.inputSchema.parse({
        label_selector: "env=prod",
        name: "web-frontend",
      }),
      ctx(client),
    );
    expect(client.listFloatingIps).toHaveBeenCalledWith({
      label_selector: "env=prod",
      name: "web-frontend",
    });
  });

  it("forwards an empty params object when nothing provided", async () => {
    const client = makeClient();
    await listFloatingIps.handler(
      listFloatingIps.inputSchema.parse({}),
      ctx(client),
    );
    expect(client.listFloatingIps).toHaveBeenCalledWith({});
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient();
    const result = (await listFloatingIps.handler(
      listFloatingIps.inputSchema.parse({}),
      ctx(client),
    )) as { floating_ips: Array<Record<string, unknown>>; count: number };

    expect(result.count).toBe(1);
    const slim = result.floating_ips[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 4711,
      name: "web-frontend",
      ip: "131.232.99.1",
      type: "ipv4",
      server: 42,
      home_location: "fsn1",
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("description");
    expect(slim).not.toHaveProperty("dns_ptr");
    expect(slim).not.toHaveProperty("protection");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient({
      listFloatingIps: vi
        .fn()
        .mockResolvedValue({ floating_ips: [{ id: 5 }] }),
    });
    const result = (await listFloatingIps.handler(
      listFloatingIps.inputSchema.parse({}),
      ctx(client),
    )) as { floating_ips: SlimShape[] };
    const slim = result.floating_ips[0]!;
    expect(slim.id).toBe(5);
    expect(slim.name).toBeNull();
    expect(slim.ip).toBe("");
    expect(slim.type).toBe("");
    expect(slim.server).toBeNull();
    expect(slim.home_location).toBeNull();
    expect(slim.labels).toEqual({});
  });

  it("returns an empty list with count 0 when upstream is empty", async () => {
    const client = makeClient({
      listFloatingIps: vi.fn().mockResolvedValue({ floating_ips: [] }),
    });
    const result = (await listFloatingIps.handler(
      listFloatingIps.inputSchema.parse({}),
      ctx(client),
    )) as { floating_ips: unknown[]; count: number };
    expect(result.floating_ips).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("tolerates a missing floating_ips array", async () => {
    const client = makeClient({
      listFloatingIps: vi.fn().mockResolvedValue({ meta: {} }),
    });
    const result = (await listFloatingIps.handler(
      listFloatingIps.inputSchema.parse({}),
      ctx(client),
    )) as { floating_ips: unknown[]; count: number };
    expect(result.floating_ips).toEqual([]);
    expect(result.count).toBe(0);
  });
});

type SlimShape = {
  id: number;
  name: string | null;
  ip: string;
  type: string;
  server: number | null;
  home_location: string | null;
  labels: Record<string, string>;
};

// =============================================================================
// create_floating_ip
// =============================================================================

describe("createFloatingIp — metadata + schema", () => {
  it("has the expected name and non-empty description", () => {
    expect(createFloatingIp.name).toBe("create_floating_ip");
    expect(createFloatingIp.description.length).toBeGreaterThan(0);
    expect(createFloatingIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = createFloatingIp.inputSchema.parse({ type: "ipv4" }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("requires type", () => {
    expect(() => createFloatingIp.inputSchema.parse({})).toThrow();
  });

  it("rejects an unknown type value", () => {
    expect(() =>
      createFloatingIp.inputSchema.parse({ type: "ipv7" }),
    ).toThrow();
  });

  it("rejects a non-positive server id", () => {
    expect(() =>
      createFloatingIp.inputSchema.parse({ type: "ipv4", server: -1 }),
    ).toThrow();
  });
});

describe("createFloatingIp — handler (not confirm-gated)", () => {
  it("forwards only the provided fields (type only)", async () => {
    const client = makeClient();
    await createFloatingIp.handler(
      createFloatingIp.inputSchema.parse({ type: "ipv6" }),
      ctx(client),
    );
    expect(client.createFloatingIp).toHaveBeenCalledTimes(1);
    expect(client.createFloatingIp).toHaveBeenCalledWith({ type: "ipv6" });
  });

  it("forwards the full body when all fields provided", async () => {
    const client = makeClient();
    await createFloatingIp.handler(
      createFloatingIp.inputSchema.parse({
        type: "ipv4",
        home_location: "fsn1",
        server: 42,
        name: "web-frontend",
        description: "edge",
        labels: { env: "prod" },
      }),
      ctx(client),
    );
    expect(client.createFloatingIp).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ipv4",
        home_location: "fsn1",
        server: 42,
        name: "web-frontend",
        description: "edge",
        labels: { env: "prod" },
      }),
    );
    // wait must not leak into the upstream body.
    const body = client.createFloatingIp.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("wait");
  });

  it("returns the slim floating_ip and a settled action", async () => {
    const client = makeClient();
    const result = (await createFloatingIp.handler(
      createFloatingIp.inputSchema.parse({ type: "ipv4" }),
      ctx(client),
    )) as { floating_ip: Record<string, unknown>; action: Record<string, unknown> };

    expect(Object.keys(result).sort()).toEqual(["action", "floating_ip"]);
    expect(Object.keys(result.floating_ip).sort()).toEqual(SLIM_KEYS);
    expect(Object.keys(result.action).sort()).toEqual(ACTION_KEYS);
    expect(result.action).toEqual({
      id: 13,
      command: "assign_floating_ip",
      status: "success",
      progress: 100,
      finished: "2026-05-01T00:00:05+00:00",
    });
    // status was "success" so no polling occurred.
    expect(client.waitForAction).not.toHaveBeenCalled();
  });

  it("returns action null when upstream carries no action", async () => {
    const client = makeClient({
      createFloatingIp: vi
        .fn()
        .mockResolvedValue({ floating_ip: sampleFloatingIp }),
    });
    const result = (await createFloatingIp.handler(
      createFloatingIp.inputSchema.parse({ type: "ipv4" }),
      ctx(client),
    )) as { floating_ip: unknown; action: unknown };
    expect(result.action).toBeNull();
  });
});

// =============================================================================
// delete_floating_ip
// =============================================================================

describe("deleteFloatingIp — metadata + schema", () => {
  it("has the expected name and non-empty description", () => {
    expect(deleteFloatingIp.name).toBe("delete_floating_ip");
    expect(deleteFloatingIp.description.length).toBeGreaterThan(0);
    expect(deleteFloatingIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteFloatingIp.inputSchema.parse({
      floating_ip_id: 4711,
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive id", () => {
    expect(() =>
      deleteFloatingIp.inputSchema.parse({ floating_ip_id: -1 }),
    ).toThrow();
  });

  it("rejects a non-integer id", () => {
    expect(() =>
      deleteFloatingIp.inputSchema.parse({ floating_ip_id: 1.5 }),
    ).toThrow();
  });
});

describe("deleteFloatingIp — confirm gate", () => {
  it("throws ConfirmRequiredError and does not mutate when confirm is false", async () => {
    const client = makeClient();
    await expect(
      deleteFloatingIp.handler(
        deleteFloatingIp.inputSchema.parse({ floating_ip_id: 4711 }),
        ctx(client),
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteFloatingIp).not.toHaveBeenCalled();
  });

  it("preview names the delete action and the id", async () => {
    const client = makeClient();
    try {
      await deleteFloatingIp.handler(
        deleteFloatingIp.inputSchema.parse({ floating_ip_id: 4711 }),
        ctx(client),
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

describe("deleteFloatingIp — past confirm gate", () => {
  it("with confirm true deletes and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deleteFloatingIp.handler(
      deleteFloatingIp.inputSchema.parse({
        floating_ip_id: 4711,
        confirm: true,
      }),
      ctx(client),
    )) as { floating_ip_id: number; deleted: boolean };
    expect(client.deleteFloatingIp).toHaveBeenCalledWith(4711);
    expect(Object.keys(result).sort()).toEqual(["deleted", "floating_ip_id"]);
    expect(result).toEqual({ floating_ip_id: 4711, deleted: true });
  });
});

// =============================================================================
// assign_floating_ip
// =============================================================================

describe("assignFloatingIp — metadata + schema", () => {
  it("has the expected name and non-empty description", () => {
    expect(assignFloatingIp.name).toBe("assign_floating_ip");
    expect(assignFloatingIp.description.length).toBeGreaterThan(0);
    expect(assignFloatingIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = assignFloatingIp.inputSchema.parse({
      floating_ip_id: 4711,
      server_id: 42,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("requires server_id", () => {
    expect(() =>
      assignFloatingIp.inputSchema.parse({ floating_ip_id: 4711 }),
    ).toThrow();
  });
});

describe("assignFloatingIp — handler", () => {
  it("calls floatingIpAction with assign and the server body", async () => {
    const client = makeClient();
    await assignFloatingIp.handler(
      assignFloatingIp.inputSchema.parse({
        floating_ip_id: 4711,
        server_id: 42,
      }),
      ctx(client),
    );
    expect(client.floatingIpAction).toHaveBeenCalledWith(4711, "assign", {
      server: 42,
    });
  });

  it("returns floating_ip_id and a settled action", async () => {
    const client = makeClient();
    const result = (await assignFloatingIp.handler(
      assignFloatingIp.inputSchema.parse({
        floating_ip_id: 4711,
        server_id: 42,
      }),
      ctx(client),
    )) as { floating_ip_id: number; action: Record<string, unknown> };
    expect(Object.keys(result).sort()).toEqual(["action", "floating_ip_id"]);
    expect(result.floating_ip_id).toBe(4711);
    expect(Object.keys(result.action).sort()).toEqual(ACTION_KEYS);
  });
});

// =============================================================================
// unassign_floating_ip
// =============================================================================

describe("unassignFloatingIp — metadata + schema", () => {
  it("has the expected name and non-empty description", () => {
    expect(unassignFloatingIp.name).toBe("unassign_floating_ip");
    expect(unassignFloatingIp.description.length).toBeGreaterThan(0);
    expect(unassignFloatingIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = unassignFloatingIp.inputSchema.parse({
      floating_ip_id: 4711,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive id", () => {
    expect(() =>
      unassignFloatingIp.inputSchema.parse({ floating_ip_id: 0 }),
    ).toThrow();
  });
});

describe("unassignFloatingIp — handler", () => {
  it("calls floatingIpAction with unassign and no body", async () => {
    const client = makeClient();
    await unassignFloatingIp.handler(
      unassignFloatingIp.inputSchema.parse({ floating_ip_id: 4711 }),
      ctx(client),
    );
    expect(client.floatingIpAction).toHaveBeenCalledWith(4711, "unassign");
  });

  it("returns floating_ip_id and a settled action", async () => {
    const client = makeClient();
    const result = (await unassignFloatingIp.handler(
      unassignFloatingIp.inputSchema.parse({ floating_ip_id: 4711 }),
      ctx(client),
    )) as { floating_ip_id: number; action: Record<string, unknown> };
    expect(Object.keys(result).sort()).toEqual(["action", "floating_ip_id"]);
    expect(result.floating_ip_id).toBe(4711);
    expect(Object.keys(result.action).sort()).toEqual(ACTION_KEYS);
  });

  it("polls when the action is still running and wait is true", async () => {
    const running = { ...sampleAction, status: "running", progress: 40 };
    const settled = { ...sampleAction, status: "success" };
    const client = makeClient({
      floatingIpAction: vi.fn().mockResolvedValue({ action: running }),
      waitForAction: vi.fn().mockResolvedValue(settled),
    });
    const result = (await unassignFloatingIp.handler(
      unassignFloatingIp.inputSchema.parse({ floating_ip_id: 4711, wait: true }),
      ctx(client),
    )) as { action: Record<string, unknown> };
    expect(client.waitForAction).toHaveBeenCalledWith(13);
    expect(result.action.status).toBe("success");
  });

  it("does not poll when wait is false", async () => {
    const running = { ...sampleAction, status: "running", progress: 40 };
    const client = makeClient({
      floatingIpAction: vi.fn().mockResolvedValue({ action: running }),
    });
    const result = (await unassignFloatingIp.handler(
      unassignFloatingIp.inputSchema.parse({
        floating_ip_id: 4711,
        wait: false,
      }),
      ctx(client),
    )) as { action: Record<string, unknown> };
    expect(client.waitForAction).not.toHaveBeenCalled();
    expect(result.action.status).toBe("running");
  });
});
