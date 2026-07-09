import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  listPrimaryIps,
  createPrimaryIp,
  deletePrimaryIp,
  assignPrimaryIp,
  unassignPrimaryIp,
} from "../primary-ips.js";

// A full upstream Primary IP with extras the slim mapper must strip. Datacenter
// is nested; assignee_type/blocked/created/dns_ptr/protection are dropped.
const samplePrimaryIp = {
  id: 42,
  name: "web-primary",
  ip: "203.0.113.7",
  type: "ipv4",
  assignee_id: 17,
  auto_delete: true,
  datacenter: {
    id: 4,
    name: "fsn1-dc14",
    location: { name: "fsn1", city: "Falkenstein" },
  },
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  assignee_type: "server",
  blocked: false,
  created: "2026-05-01T00:00:00Z",
  dns_ptr: [{ ip: "203.0.113.7", dns_ptr: "host.example.com" }],
  protection: { delete: false },
};

// A settled action; settleAction summarizes it down to the 5 public fields.
const sampleAction = {
  id: 555,
  command: "assign_primary_ip",
  status: "success",
  progress: 100,
  started: "2026-05-01T00:00:00Z",
  finished: "2026-05-01T00:01:00Z",
  resources: [],
  error: null,
};

const SLIM_KEYS = [
  "id",
  "name",
  "ip",
  "type",
  "assignee_id",
  "datacenter",
  "auto_delete",
  "labels",
].sort();

const ACTION_KEYS = ["id", "command", "status", "progress", "finished"].sort();

type FakeClient = {
  listPrimaryIps: ReturnType<typeof vi.fn>;
  createPrimaryIp: ReturnType<typeof vi.fn>;
  deletePrimaryIp: ReturnType<typeof vi.fn>;
  primaryIpAction: ReturnType<typeof vi.fn>;
  extractAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listPrimaryIps: vi
      .fn()
      .mockResolvedValue({ primary_ips: [samplePrimaryIp] }),
    createPrimaryIp: vi
      .fn()
      .mockResolvedValue({ primary_ip: samplePrimaryIp, action: sampleAction }),
    deletePrimaryIp: vi.fn().mockResolvedValue(undefined),
    primaryIpAction: vi.fn().mockResolvedValue({ action: sampleAction }),
    // Mirrors the real client: pull `action` off the raw mutation body. Status
    // is "success", so settleAction never reaches waitForAction.
    extractAction: vi.fn((body: unknown) =>
      body && typeof body === "object"
        ? (body as { action?: unknown }).action
        : undefined,
    ),
    waitForAction: vi.fn().mockResolvedValue(sampleAction),
    ...overrides,
  };
}

function makeCtx(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

// =============================================================================
// list_primary_ips
// =============================================================================

describe("listPrimaryIps — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listPrimaryIps.name).toBe("list_primary_ips");
    expect(listPrimaryIps.description).toBeTruthy();
    expect(listPrimaryIps.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listPrimaryIps.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() => listPrimaryIps.inputSchema.parse({ name: 123 })).toThrow();
  });
});

describe("listPrimaryIps — handler", () => {
  it("forwards label_selector and name as query params", async () => {
    const client = makeClient();
    await listPrimaryIps.handler(
      listPrimaryIps.inputSchema.parse({
        label_selector: "env=prod",
        name: "web-primary",
      }),
      makeCtx(client),
    );
    expect(client.listPrimaryIps).toHaveBeenCalledTimes(1);
    expect(client.listPrimaryIps).toHaveBeenCalledWith(
      expect.objectContaining({ label_selector: "env=prod", name: "web-primary" }),
    );
  });

  it("omits params the caller did not provide", async () => {
    const client = makeClient();
    await listPrimaryIps.handler(
      listPrimaryIps.inputSchema.parse({}),
      makeCtx(client),
    );
    expect(client.listPrimaryIps).toHaveBeenCalledWith({});
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient();
    const result = (await listPrimaryIps.handler(
      listPrimaryIps.inputSchema.parse({}),
      makeCtx(client),
    )) as { primary_ips: Array<Record<string, unknown>>; count: number };

    expect(result.count).toBe(1);
    expect(result.primary_ips).toHaveLength(1);
    const slim = result.primary_ips[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 42,
      name: "web-primary",
      ip: "203.0.113.7",
      type: "ipv4",
      assignee_id: 17,
      datacenter: "fsn1-dc14",
      auto_delete: true,
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("dns_ptr");
    expect(slim).not.toHaveProperty("protection");
    expect(slim).not.toHaveProperty("assignee_type");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient({
      listPrimaryIps: vi
        .fn()
        .mockResolvedValue({ primary_ips: [{ id: 99 }] }),
    });
    const result = (await listPrimaryIps.handler(
      listPrimaryIps.inputSchema.parse({}),
      makeCtx(client),
    )) as { primary_ips: Array<Record<string, unknown>> };
    const slim = result.primary_ips[0]!;
    expect(slim.id).toBe(99);
    expect(slim.name).toBe("");
    expect(slim.ip).toBe("");
    expect(slim.type).toBe("");
    expect(slim.assignee_id).toBeNull();
    expect(slim.datacenter).toBeNull();
    expect(slim.auto_delete).toBe(false);
    expect(slim.labels).toEqual({});
  });

  it("returns empty list with count 0 and guards non-array upstream", async () => {
    const client = makeClient({
      listPrimaryIps: vi.fn().mockResolvedValue({ primary_ips: undefined }),
    });
    const result = (await listPrimaryIps.handler(
      listPrimaryIps.inputSchema.parse({}),
      makeCtx(client),
    )) as { primary_ips: unknown[]; count: number };
    expect(result.primary_ips).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// create_primary_ip
// =============================================================================

describe("createPrimaryIp — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createPrimaryIp.name).toBe("create_primary_ip");
    expect(createPrimaryIp.description).toBeTruthy();
    expect(createPrimaryIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = createPrimaryIp.inputSchema.parse({
      type: "ipv4",
      name: "web-primary",
      datacenter: "fsn1-dc14",
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects an invalid type enum value", () => {
    expect(() =>
      createPrimaryIp.inputSchema.parse({
        type: "ipv7",
        name: "web-primary",
        datacenter: "fsn1-dc14",
      }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      createPrimaryIp.inputSchema.parse({
        type: "ipv4",
        name: "",
        datacenter: "fsn1-dc14",
      }),
    ).toThrow();
  });

  it("rejects an empty datacenter", () => {
    expect(() =>
      createPrimaryIp.inputSchema.parse({
        type: "ipv4",
        name: "web-primary",
        datacenter: "",
      }),
    ).toThrow();
  });
});

describe("createPrimaryIp — handler", () => {
  it("forwards the request body with assignee_type server", async () => {
    const client = makeClient();
    await createPrimaryIp.handler(
      createPrimaryIp.inputSchema.parse({
        type: "ipv4",
        name: "web-primary",
        datacenter: "fsn1-dc14",
        assignee_id: 17,
        auto_delete: true,
        labels: { env: "prod" },
      }),
      makeCtx(client),
    );
    expect(client.createPrimaryIp).toHaveBeenCalledTimes(1);
    expect(client.createPrimaryIp).toHaveBeenCalledWith({
      type: "ipv4",
      name: "web-primary",
      datacenter: "fsn1-dc14",
      assignee_type: "server",
      assignee_id: 17,
      auto_delete: true,
      labels: { env: "prod" },
    });
  });

  it("omits optional fields the caller did not provide", async () => {
    const client = makeClient();
    await createPrimaryIp.handler(
      createPrimaryIp.inputSchema.parse({
        type: "ipv6",
        name: "v6-primary",
        datacenter: "fsn1-dc14",
      }),
      makeCtx(client),
    );
    expect(client.createPrimaryIp).toHaveBeenCalledWith({
      type: "ipv6",
      name: "v6-primary",
      datacenter: "fsn1-dc14",
      assignee_type: "server",
    });
  });

  it("returns slim primary_ip plus a summarized action", async () => {
    const client = makeClient();
    const result = (await createPrimaryIp.handler(
      createPrimaryIp.inputSchema.parse({
        type: "ipv4",
        name: "web-primary",
        datacenter: "fsn1-dc14",
      }),
      makeCtx(client),
    )) as {
      primary_ip: Record<string, unknown> | null;
      action: Record<string, unknown> | null;
    };
    expect(Object.keys(result).sort()).toEqual(["action", "primary_ip"].sort());
    expect(Object.keys(result.primary_ip!).sort()).toEqual(SLIM_KEYS);
    expect(Object.keys(result.action!).sort()).toEqual(ACTION_KEYS);
    expect(result.action).toEqual({
      id: 555,
      command: "assign_primary_ip",
      status: "success",
      progress: 100,
      finished: "2026-05-01T00:01:00Z",
    });
  });

  it("returns null primary_ip when upstream omits it", async () => {
    const client = makeClient({
      createPrimaryIp: vi.fn().mockResolvedValue({ action: sampleAction }),
    });
    const result = (await createPrimaryIp.handler(
      createPrimaryIp.inputSchema.parse({
        type: "ipv4",
        name: "web-primary",
        datacenter: "fsn1-dc14",
      }),
      makeCtx(client),
    )) as { primary_ip: unknown; action: unknown };
    expect(result.primary_ip).toBeNull();
    expect(result.action).not.toBeNull();
  });
});

// =============================================================================
// delete_primary_ip
// =============================================================================

describe("deletePrimaryIp — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(deletePrimaryIp.name).toBe("delete_primary_ip");
    expect(deletePrimaryIp.description).toBeTruthy();
    expect(deletePrimaryIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deletePrimaryIp.inputSchema.parse({
      primary_ip_id: 42,
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive primary_ip_id", () => {
    expect(() =>
      deletePrimaryIp.inputSchema.parse({ primary_ip_id: -1 }),
    ).toThrow();
  });

  it("rejects a non-integer primary_ip_id", () => {
    expect(() =>
      deletePrimaryIp.inputSchema.parse({ primary_ip_id: 1.5 }),
    ).toThrow();
  });
});

describe("deletePrimaryIp — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deletePrimaryIp.handler(
        deletePrimaryIp.inputSchema.parse({ primary_ip_id: 42 }),
        makeCtx(client),
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deletePrimaryIp).not.toHaveBeenCalled();
  });

  it("preview names the id and warns about permanence", async () => {
    const client = makeClient();
    try {
      await deletePrimaryIp.handler(
        deletePrimaryIp.inputSchema.parse({ primary_ip_id: 42 }),
        makeCtx(client),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("42");
      expect(preview).toContain("PERMANENTLY DELETE");
    }
  });
});

describe("deletePrimaryIp — past confirm gate", () => {
  it("with confirm true deletes and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deletePrimaryIp.handler(
      deletePrimaryIp.inputSchema.parse({ primary_ip_id: 42, confirm: true }),
      makeCtx(client),
    )) as { primary_ip_id: number; deleted: boolean };
    expect(client.deletePrimaryIp).toHaveBeenCalledWith(42);
    expect(Object.keys(result).sort()).toEqual(
      ["primary_ip_id", "deleted"].sort(),
    );
    expect(result).toEqual({ primary_ip_id: 42, deleted: true });
  });
});

// =============================================================================
// assign_primary_ip
// =============================================================================

describe("assignPrimaryIp — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(assignPrimaryIp.name).toBe("assign_primary_ip");
    expect(assignPrimaryIp.description).toBeTruthy();
    expect(assignPrimaryIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = assignPrimaryIp.inputSchema.parse({
      primary_ip_id: 42,
      assignee_id: 17,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a missing assignee_id", () => {
    expect(() =>
      assignPrimaryIp.inputSchema.parse({ primary_ip_id: 42 }),
    ).toThrow();
  });
});

describe("assignPrimaryIp — handler", () => {
  it("calls primaryIpAction with assign command and server assignee", async () => {
    const client = makeClient();
    await assignPrimaryIp.handler(
      assignPrimaryIp.inputSchema.parse({
        primary_ip_id: 42,
        assignee_id: 17,
      }),
      makeCtx(client),
    );
    expect(client.primaryIpAction).toHaveBeenCalledWith(42, "assign", {
      assignee_id: 17,
      assignee_type: "server",
    });
  });

  it("returns the id plus a summarized action", async () => {
    const client = makeClient();
    const result = (await assignPrimaryIp.handler(
      assignPrimaryIp.inputSchema.parse({
        primary_ip_id: 42,
        assignee_id: 17,
      }),
      makeCtx(client),
    )) as { primary_ip_id: number; action: Record<string, unknown> | null };
    expect(Object.keys(result).sort()).toEqual(
      ["primary_ip_id", "action"].sort(),
    );
    expect(result.primary_ip_id).toBe(42);
    expect(Object.keys(result.action!).sort()).toEqual(ACTION_KEYS);
  });
});

// =============================================================================
// unassign_primary_ip
// =============================================================================

describe("unassignPrimaryIp — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(unassignPrimaryIp.name).toBe("unassign_primary_ip");
    expect(unassignPrimaryIp.description).toBeTruthy();
    expect(unassignPrimaryIp.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = unassignPrimaryIp.inputSchema.parse({
      primary_ip_id: 42,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive primary_ip_id", () => {
    expect(() =>
      unassignPrimaryIp.inputSchema.parse({ primary_ip_id: 0 }),
    ).toThrow();
  });
});

describe("unassignPrimaryIp — handler", () => {
  it("calls primaryIpAction with the unassign command", async () => {
    const client = makeClient();
    await unassignPrimaryIp.handler(
      unassignPrimaryIp.inputSchema.parse({ primary_ip_id: 42 }),
      makeCtx(client),
    );
    expect(client.primaryIpAction).toHaveBeenCalledWith(42, "unassign");
  });

  it("returns the id plus a summarized action", async () => {
    const client = makeClient();
    const result = (await unassignPrimaryIp.handler(
      unassignPrimaryIp.inputSchema.parse({ primary_ip_id: 42 }),
      makeCtx(client),
    )) as { primary_ip_id: number; action: Record<string, unknown> | null };
    expect(Object.keys(result).sort()).toEqual(
      ["primary_ip_id", "action"].sort(),
    );
    expect(result.primary_ip_id).toBe(42);
    expect(Object.keys(result.action!).sort()).toEqual(ACTION_KEYS);
  });
});
