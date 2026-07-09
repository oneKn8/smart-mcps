import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listFirewalls,
  getFirewall,
  createFirewall,
  deleteFirewall,
  setFirewallRules,
  applyFirewall,
} from "../firewalls.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

// A full upstream firewall with extra fields the slim mapper must strip.
const sampleFirewall = {
  id: 55,
  name: "web-fw",
  rules: [
    {
      direction: "in",
      protocol: "tcp",
      port: "80",
      source_ips: ["0.0.0.0/0", "::/0"],
      destination_ips: [],
      description: "http", // extra dropped by slim rule
    },
    {
      direction: "in",
      protocol: "tcp",
      port: "443",
      source_ips: ["0.0.0.0/0"],
      destination_ips: [],
    },
  ],
  applied_to: [{ type: "server", server: { id: 42 } }],
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  created: "2026-05-01T00:00:00Z",
};

const successAction = {
  id: 10,
  command: "set_firewall_rules",
  status: "success",
  progress: 100,
  started: "2026-05-01T00:00:00Z",
  finished: "2026-05-01T00:00:05Z",
  resources: [{ id: 55, type: "firewall" }],
  error: null,
};

const runningAction = {
  id: 11,
  command: "apply_firewall",
  status: "running",
  progress: 40,
  started: "2026-05-01T00:00:00Z",
  finished: null,
  resources: [{ id: 55, type: "firewall" }],
  error: null,
};

type FakeClient = {
  listFirewalls: ReturnType<typeof vi.fn>;
  getFirewall: ReturnType<typeof vi.fn>;
  createFirewall: ReturnType<typeof vi.fn>;
  deleteFirewall: ReturnType<typeof vi.fn>;
  firewallAction: ReturnType<typeof vi.fn>;
  extractAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listFirewalls: vi
      .fn()
      .mockResolvedValue({ firewalls: [sampleFirewall], meta: {} }),
    getFirewall: vi.fn().mockResolvedValue(sampleFirewall),
    createFirewall: vi
      .fn()
      .mockResolvedValue({ firewall: sampleFirewall, actions: [successAction] }),
    deleteFirewall: vi.fn().mockResolvedValue(undefined),
    firewallAction: vi.fn().mockResolvedValue({ actions: [successAction] }),
    // Mirror the real client's extractAction: single `{ action }` or `{ actions:[...] }`.
    extractAction: vi.fn((b: Record<string, unknown> | undefined) => {
      if (!b) return undefined;
      if (b.action) return b.action;
      if (Array.isArray(b.actions)) return b.actions[0];
      return undefined;
    }),
    waitForAction: vi.fn().mockResolvedValue({ ...runningAction, status: "success", progress: 100, finished: "2026-05-01T00:01:00Z" }),
    ...overrides,
  };
}

const FW_SLIM_KEYS = [
  "id",
  "name",
  "rules_count",
  "applied_to_count",
  "labels",
].sort();
const GET_KEYS = [...FW_SLIM_KEYS, "rules"].sort();

// =============================================================================
// list_firewalls
// =============================================================================

describe("listFirewalls — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listFirewalls.name).toBe("list_firewalls");
    expect(listFirewalls.description).toBeTruthy();
    expect(listFirewalls.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listFirewalls.inputSchema.parse({})).not.toThrow();
  });
});

describe("listFirewalls — handler", () => {
  it("forwards name + label_selector filters", async () => {
    const client = makeClient();
    await listFirewalls.handler(
      listFirewalls.inputSchema.parse({
        name: "web-fw",
        label_selector: "env=prod",
      }),
      { client: client as unknown as never },
    );
    expect(client.listFirewalls).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web-fw", label_selector: "env=prod" }),
    );
  });

  it("strips upstream extras and returns the slim shape + count", async () => {
    const client = makeClient();
    const result = (await listFirewalls.handler(
      listFirewalls.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { firewalls: Array<Record<string, unknown>>; count: number };

    expect(Object.keys(result).sort()).toEqual(["firewalls", "count"].sort());
    expect(result.count).toBe(1);
    const slim = result.firewalls[0]!;
    expect(Object.keys(slim).sort()).toEqual(FW_SLIM_KEYS);
    expect(slim).toEqual({
      id: 55,
      name: "web-fw",
      rules_count: 2,
      applied_to_count: 1,
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("created");
    expect(slim).not.toHaveProperty("rules");
  });

  it("returns empty list with count 0 when upstream is empty", async () => {
    const client = makeClient({
      listFirewalls: vi.fn().mockResolvedValue({ firewalls: [] }),
    });
    const result = (await listFirewalls.handler(
      listFirewalls.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { firewalls: unknown[]; count: number };
    expect(result.firewalls).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("null-safes missing name/labels", async () => {
    const client = makeClient({
      listFirewalls: vi.fn().mockResolvedValue({ firewalls: [{ id: 7 }] }),
    });
    const result = (await listFirewalls.handler(
      listFirewalls.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { firewalls: Array<Record<string, unknown>> };
    const slim = result.firewalls[0]!;
    expect(slim.id).toBe(7);
    expect(slim.name).toBeNull();
    expect(slim.rules_count).toBe(0);
    expect(slim.applied_to_count).toBe(0);
    expect(slim.labels).toEqual({});
  });
});

// =============================================================================
// get_firewall
// =============================================================================

describe("getFirewall — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getFirewall.name).toBe("get_firewall");
    expect(getFirewall.description).toBeTruthy();
    expect(getFirewall.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-positive firewall_id", () => {
    expect(() => getFirewall.inputSchema.parse({ firewall_id: 0 })).toThrow();
    expect(() => getFirewall.inputSchema.parse({ firewall_id: -1 })).toThrow();
  });

  it("rejects a non-integer firewall_id", () => {
    expect(() =>
      getFirewall.inputSchema.parse({ firewall_id: 1.5 }),
    ).toThrow();
  });
});

describe("getFirewall — handler", () => {
  it("calls client.getFirewall with the numeric id", async () => {
    const client = makeClient();
    await getFirewall.handler(
      getFirewall.inputSchema.parse({ firewall_id: 55 }),
      { client: client as unknown as never },
    );
    expect(client.getFirewall).toHaveBeenCalledTimes(1);
    expect(client.getFirewall).toHaveBeenCalledWith(55);
  });

  it("returns the slim shape plus a slim rules passthrough", async () => {
    const client = makeClient();
    const result = (await getFirewall.handler(
      getFirewall.inputSchema.parse({ firewall_id: 55 }),
      { client: client as unknown as never },
    )) as GetFirewallShape;

    expect(Object.keys(result).sort()).toEqual(GET_KEYS);
    expect(result.rules).toHaveLength(2);
    const rule = result.rules[0]!;
    expect(Object.keys(rule).sort()).toEqual(
      ["direction", "protocol", "port", "source_ips", "destination_ips"].sort(),
    );
    expect(rule).toEqual({
      direction: "in",
      protocol: "tcp",
      port: "80",
      source_ips: ["0.0.0.0/0", "::/0"],
      destination_ips: [],
    });
    expect(rule).not.toHaveProperty("description");
  });

  it("tolerates a firewall with no rules array", async () => {
    const client = makeClient({
      getFirewall: vi
        .fn()
        .mockResolvedValue({ id: 9, name: "empty", applied_to: [], labels: {} }),
    });
    const result = (await getFirewall.handler(
      getFirewall.inputSchema.parse({ firewall_id: 9 }),
      { client: client as unknown as never },
    )) as GetFirewallShape;
    expect(result.rules).toEqual([]);
    expect(result.rules_count).toBe(0);
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getFirewall: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Firewall not found: 999")),
    });
    await expect(
      getFirewall.handler(
        getFirewall.inputSchema.parse({ firewall_id: 999 }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

type GetFirewallShape = {
  id: number;
  name: string | null;
  rules_count: number;
  applied_to_count: number;
  labels: Record<string, string>;
  rules: Array<Record<string, unknown>>;
};

// =============================================================================
// create_firewall
// =============================================================================

describe("createFirewall — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(createFirewall.name).toBe("create_firewall");
    expect(createFirewall.description).toBeTruthy();
    expect(createFirewall.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects an empty name", () => {
    expect(() => createFirewall.inputSchema.parse({ name: "" })).toThrow();
  });

  it("rejects an invalid rule direction", () => {
    expect(() =>
      createFirewall.inputSchema.parse({
        name: "fw",
        rules: [{ direction: "sideways", protocol: "tcp" }],
      }),
    ).toThrow();
  });

  it("rejects an invalid rule protocol", () => {
    expect(() =>
      createFirewall.inputSchema.parse({
        name: "fw",
        rules: [{ direction: "in", protocol: "sctp" }],
      }),
    ).toThrow();
  });

  it("accepts a minimal name-only firewall", () => {
    expect(() => createFirewall.inputSchema.parse({ name: "fw" })).not.toThrow();
  });
});

describe("createFirewall — handler", () => {
  it("builds rules + apply_to (server ids and label selector) + labels", async () => {
    const client = makeClient();
    await createFirewall.handler(
      createFirewall.inputSchema.parse({
        name: "web-fw",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "80",
            source_ips: ["0.0.0.0/0"],
          },
        ],
        apply_to_server_ids: [42, 43],
        apply_to_label_selector: "env=prod",
        labels: { env: "prod" },
      }),
      { client: client as unknown as never },
    );
    expect(client.createFirewall).toHaveBeenCalledTimes(1);
    const body = client.createFirewall.mock.calls[0]?.[0];
    expect(body).toEqual({
      name: "web-fw",
      rules: [
        {
          direction: "in",
          protocol: "tcp",
          port: "80",
          source_ips: ["0.0.0.0/0"],
        },
      ],
      apply_to: [
        { type: "server", server: { id: 42 } },
        { type: "server", server: { id: 43 } },
        { type: "label_selector", label_selector: { selector: "env=prod" } },
      ],
      labels: { env: "prod" },
    });
  });

  it("omits apply_to when no targets are given", async () => {
    const client = makeClient();
    await createFirewall.handler(
      createFirewall.inputSchema.parse({ name: "bare" }),
      { client: client as unknown as never },
    );
    const body = client.createFirewall.mock.calls[0]?.[0];
    expect(body).toEqual({ name: "bare" });
    expect(body).not.toHaveProperty("apply_to");
    expect(body).not.toHaveProperty("rules");
    expect(body).not.toHaveProperty("labels");
  });

  it("returns firewall_id, name, and action summaries only", async () => {
    const client = makeClient();
    const result = (await createFirewall.handler(
      createFirewall.inputSchema.parse({ name: "web-fw" }),
      { client: client as unknown as never },
    )) as {
      firewall_id: number;
      name: string;
      actions: Array<Record<string, unknown>>;
    };
    expect(Object.keys(result).sort()).toEqual(
      ["firewall_id", "name", "actions"].sort(),
    );
    expect(result.firewall_id).toBe(55);
    expect(result.name).toBe("web-fw");
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0]!;
    expect(Object.keys(action).sort()).toEqual(
      ["id", "command", "status", "progress", "finished"].sort(),
    );
    expect(action.status).toBe("success");
  });

  it("tolerates a synchronous response with no actions", async () => {
    const client = makeClient({
      createFirewall: vi
        .fn()
        .mockResolvedValue({ firewall: { id: 3, name: "sync-fw" } }),
    });
    const result = (await createFirewall.handler(
      createFirewall.inputSchema.parse({ name: "sync-fw" }),
      { client: client as unknown as never },
    )) as { firewall_id: number; name: string; actions: unknown[] };
    expect(result.firewall_id).toBe(3);
    expect(result.actions).toEqual([]);
  });
});

// =============================================================================
// delete_firewall
// =============================================================================

describe("deleteFirewall — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteFirewall.name).toBe("delete_firewall");
    expect(deleteFirewall.description).toBeTruthy();
    expect(deleteFirewall.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteFirewall.inputSchema.parse({ firewall_id: 55 }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive firewall_id", () => {
    expect(() =>
      deleteFirewall.inputSchema.parse({ firewall_id: 0, confirm: true }),
    ).toThrow();
  });
});

describe("deleteFirewall — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteFirewall.handler(
        deleteFirewall.inputSchema.parse({ firewall_id: 55 }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteFirewall).not.toHaveBeenCalled();
  });

  it("preview names the deletion and the firewall id", async () => {
    const client = makeClient();
    try {
      await deleteFirewall.handler(
        deleteFirewall.inputSchema.parse({ firewall_id: 55 }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("55");
      expect(preview).toMatch(/delete/i);
    }
  });
});

describe("deleteFirewall — past confirm gate", () => {
  it("with confirm: true deletes and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deleteFirewall.handler(
      deleteFirewall.inputSchema.parse({ firewall_id: 55, confirm: true }),
      { client: client as unknown as never },
    )) as { firewall_id: number; deleted: boolean };
    expect(client.deleteFirewall).toHaveBeenCalledWith(55);
    expect(Object.keys(result).sort()).toEqual(
      ["firewall_id", "deleted"].sort(),
    );
    expect(result).toEqual({ firewall_id: 55, deleted: true });
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      deleteFirewall: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Firewall not found: 999")),
    });
    await expect(
      deleteFirewall.handler(
        deleteFirewall.inputSchema.parse({ firewall_id: 999, confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// set_firewall_rules
// =============================================================================

describe("setFirewallRules — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(setFirewallRules.name).toBe("set_firewall_rules");
    expect(setFirewallRules.description).toBeTruthy();
    expect(setFirewallRules.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = setFirewallRules.inputSchema.parse({
      firewall_id: 55,
      rules: [{ direction: "in", protocol: "tcp", port: "22" }],
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("requires the rules array", () => {
    expect(() =>
      setFirewallRules.inputSchema.parse({ firewall_id: 55 }),
    ).toThrow();
  });

  it("rejects a non-positive firewall_id", () => {
    expect(() =>
      setFirewallRules.inputSchema.parse({
        firewall_id: 0,
        rules: [{ direction: "in", protocol: "tcp" }],
      }),
    ).toThrow();
  });
});

describe("setFirewallRules — handler", () => {
  it("calls firewallAction set_rules with the forwarded rules", async () => {
    const client = makeClient();
    await setFirewallRules.handler(
      setFirewallRules.inputSchema.parse({
        firewall_id: 55,
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "22",
            source_ips: ["10.0.0.0/8"],
          },
        ],
      }),
      { client: client as unknown as never },
    );
    expect(client.firewallAction).toHaveBeenCalledWith(55, "set_rules", {
      rules: [
        {
          direction: "in",
          protocol: "tcp",
          port: "22",
          source_ips: ["10.0.0.0/8"],
        },
      ],
    });
  });

  it("returns firewall_id + settled action summaries only", async () => {
    const client = makeClient();
    const result = (await setFirewallRules.handler(
      setFirewallRules.inputSchema.parse({
        firewall_id: 55,
        rules: [{ direction: "in", protocol: "tcp", port: "22" }],
      }),
      { client: client as unknown as never },
    )) as { firewall_id: number; actions: Array<Record<string, unknown>> };
    expect(Object.keys(result).sort()).toEqual(
      ["firewall_id", "actions"].sort(),
    );
    expect(result.firewall_id).toBe(55);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.status).toBe("success");
  });

  it("polls a running action to completion when wait is true", async () => {
    const client = makeClient({
      firewallAction: vi.fn().mockResolvedValue({ actions: [runningAction] }),
    });
    const result = (await setFirewallRules.handler(
      setFirewallRules.inputSchema.parse({
        firewall_id: 55,
        rules: [{ direction: "in", protocol: "tcp", port: "22" }],
        wait: true,
      }),
      { client: client as unknown as never },
    )) as { actions: Array<Record<string, unknown>> };
    expect(client.waitForAction).toHaveBeenCalledWith(runningAction.id);
    expect(result.actions[0]!.status).toBe("success");
  });

  it("does not poll when wait is false", async () => {
    const client = makeClient({
      firewallAction: vi.fn().mockResolvedValue({ actions: [runningAction] }),
    });
    const result = (await setFirewallRules.handler(
      setFirewallRules.inputSchema.parse({
        firewall_id: 55,
        rules: [{ direction: "in", protocol: "tcp", port: "22" }],
        wait: false,
      }),
      { client: client as unknown as never },
    )) as { actions: Array<Record<string, unknown>> };
    expect(client.waitForAction).not.toHaveBeenCalled();
    expect(result.actions[0]!.status).toBe("running");
  });
});

// =============================================================================
// apply_firewall
// =============================================================================

describe("applyFirewall — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(applyFirewall.name).toBe("apply_firewall");
    expect(applyFirewall.description).toBeTruthy();
    expect(applyFirewall.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = applyFirewall.inputSchema.parse({ firewall_id: 55 }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive firewall_id", () => {
    expect(() =>
      applyFirewall.inputSchema.parse({ firewall_id: -1 }),
    ).toThrow();
  });
});

describe("applyFirewall — handler", () => {
  it("builds apply_to from server_ids and label_selector", async () => {
    const client = makeClient();
    await applyFirewall.handler(
      applyFirewall.inputSchema.parse({
        firewall_id: 55,
        server_ids: [42, 43],
        label_selector: "env=prod",
      }),
      { client: client as unknown as never },
    );
    expect(client.firewallAction).toHaveBeenCalledWith(
      55,
      "apply_to_resources",
      {
        apply_to: [
          { type: "server", server: { id: 42 } },
          { type: "server", server: { id: 43 } },
          { type: "label_selector", label_selector: { selector: "env=prod" } },
        ],
      },
    );
  });

  it("returns firewall_id + action summaries only", async () => {
    const client = makeClient();
    const result = (await applyFirewall.handler(
      applyFirewall.inputSchema.parse({ firewall_id: 55, server_ids: [42] }),
      { client: client as unknown as never },
    )) as { firewall_id: number; actions: Array<Record<string, unknown>> };
    expect(Object.keys(result).sort()).toEqual(
      ["firewall_id", "actions"].sort(),
    );
    expect(result.firewall_id).toBe(55);
    expect(result.actions).toHaveLength(1);
  });

  it("passes an empty apply_to when no targets are given", async () => {
    const client = makeClient();
    await applyFirewall.handler(
      applyFirewall.inputSchema.parse({ firewall_id: 55 }),
      { client: client as unknown as never },
    );
    expect(client.firewallAction).toHaveBeenCalledWith(
      55,
      "apply_to_resources",
      { apply_to: [] },
    );
  });
});
