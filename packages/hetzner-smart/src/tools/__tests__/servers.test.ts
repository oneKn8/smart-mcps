import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  getServerMetrics,
} from "../servers.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

// A full upstream server payload with nested public_net / server_type plus extra
// fields the slim mapper must strip.
const rawServer = {
  id: 42,
  name: "web-1",
  status: "running",
  public_net: {
    ipv4: { ip: "1.2.3.4" },
    ipv6: { ip: "2001:db8::/64" },
  },
  server_type: {
    name: "cx22",
    cores: 2,
    memory: 4,
    disk: 40,
    architecture: "x86",
  },
  datacenter: { location: { name: "nbg1" } },
  image: { name: "ubuntu-24.04" },
  created: "2026-05-01T00:00:00+00:00",
  labels: { env: "prod" },
  protection: { delete: false, rebuild: false },
  // Upstream-only fields the slim mapper must strip:
  outgoing_traffic: 123456,
  primary_disk_size: 40,
  rescue_enabled: false,
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

const createBody = {
  server: rawServer,
  action: successAction,
  root_password: "s3cr3t",
  next_actions: [],
};

const metricsBody = {
  metrics: {
    start: "2026-05-01T00:00:00Z",
    end: "2026-05-01T01:00:00Z",
    step: 60,
    time_series: {
      "cpu": { values: [] },
    },
  },
};

const SLIM_SERVER_KEYS = [
  "id",
  "name",
  "status",
  "ipv4",
  "ipv6",
  "server_type",
  "cores",
  "memory",
  "disk",
  "architecture",
  "location",
  "image",
  "created",
  "labels",
  "protection_delete",
  "protection_rebuild",
].sort();

type FakeClient = Record<string, ReturnType<typeof vi.fn>>;

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listServers: vi.fn().mockResolvedValue({ servers: [rawServer], meta: {} }),
    getServer: vi.fn().mockResolvedValue(rawServer),
    createServer: vi.fn().mockResolvedValue(createBody),
    updateServer: vi.fn().mockResolvedValue({ server: rawServer }),
    deleteServer: vi.fn().mockResolvedValue({ action: successAction }),
    getServerMetrics: vi.fn().mockResolvedValue(metricsBody),
    // settleAction calls these on the client.
    extractAction: vi.fn(
      (body: unknown) =>
        (body as { action?: unknown; actions?: unknown[] })?.action ??
        (body as { actions?: unknown[] })?.actions?.[0],
    ),
    waitForAction: vi.fn().mockResolvedValue(successAction),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// list_servers
// =============================================================================

describe("listServers — metadata + schema", () => {
  it("has correct name, description, and zod schema", () => {
    expect(listServers.name).toBe("list_servers");
    expect(listServers.description).toBeTruthy();
    expect(listServers.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listServers.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-positive per_page", () => {
    expect(() => listServers.inputSchema.parse({ per_page: -1 })).toThrow();
  });
});

describe("listServers — handler", () => {
  it("forwards only provided filter params", async () => {
    const ctx = makeCtx();
    await listServers.handler(
      listServers.inputSchema.parse({ status: "running", per_page: 10 }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.listServers).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", per_page: 10 }),
    );
    const params = client.listServers.mock.calls[0]?.[0];
    expect(params).not.toHaveProperty("name");
  });

  it("strips upstream extras and returns the slim shape + count", async () => {
    const ctx = makeCtx();
    const result = (await listServers.handler(
      listServers.inputSchema.parse({}),
      ctx,
    )) as { servers: Array<Record<string, unknown>>; count: number };

    expect(Object.keys(result).sort()).toEqual(["count", "servers"]);
    expect(result.count).toBe(1);
    const slim = result.servers[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_SERVER_KEYS);
    expect(slim.ipv4).toBe("1.2.3.4");
    expect(slim.location).toBe("nbg1");
    expect(slim).not.toHaveProperty("outgoing_traffic");
  });

  it("guards a non-array servers body", async () => {
    const ctx = makeCtx({
      listServers: vi.fn().mockResolvedValue({ meta: {} }),
    });
    const result = (await listServers.handler(
      listServers.inputSchema.parse({}),
      ctx,
    )) as { servers: unknown[]; count: number };
    expect(result.servers).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// get_server
// =============================================================================

describe("getServer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getServer.name).toBe("get_server");
    expect(getServer.description).toBeTruthy();
    expect(getServer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => getServer.inputSchema.parse({ server_id: 0 })).toThrow();
  });
});

describe("getServer — handler", () => {
  it("calls client.getServer with the id and returns the slim shape", async () => {
    const ctx = makeCtx();
    const result = (await getServer.handler(
      getServer.inputSchema.parse({ server_id: 42 }),
      ctx,
    )) as Record<string, unknown>;
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServer).toHaveBeenCalledWith(42);
    expect(Object.keys(result).sort()).toEqual(SLIM_SERVER_KEYS);
    expect(result).not.toHaveProperty("outgoing_traffic");
  });

  it("propagates NotFoundError from the client", async () => {
    const ctx = makeCtx({
      getServer: vi.fn().mockRejectedValue(new NotFoundError("Server not found: 99")),
    });
    await expect(
      getServer.handler(getServer.inputSchema.parse({ server_id: 99 }), ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// create_server
// =============================================================================

describe("createServer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(createServer.name).toBe("create_server");
    expect(createServer.description).toBeTruthy();
    expect(createServer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults start_after_create, public_ipv4/ipv6, and wait", () => {
    const parsed = createServer.inputSchema.parse({
      name: "web-1",
      server_type: "cx22",
      image: "ubuntu-24.04",
    }) as {
      start_after_create: boolean;
      public_ipv4: boolean;
      public_ipv6: boolean;
      wait: boolean;
    };
    expect(parsed.start_after_create).toBe(true);
    expect(parsed.public_ipv4).toBe(true);
    expect(parsed.public_ipv6).toBe(true);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a missing name", () => {
    expect(() =>
      createServer.inputSchema.parse({ server_type: "cx22", image: "ubuntu-24.04" }),
    ).toThrow();
  });
});

describe("createServer — handler (NOT confirm-gated)", () => {
  it("maps firewalls and public_net into the request body", async () => {
    const ctx = makeCtx();
    await createServer.handler(
      createServer.inputSchema.parse({
        name: "web-1",
        server_type: "cx22",
        image: "ubuntu-24.04",
        firewalls: [7],
        location: "nbg1",
        wait: false,
      }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "web-1",
        server_type: "cx22",
        image: "ubuntu-24.04",
        start_after_create: true,
        public_net: { enable_ipv4: true, enable_ipv6: true },
        firewalls: [{ firewall: 7 }],
        location: "nbg1",
      }),
    );
  });

  it("returns { server, action, root_password } and re-fetches on wait", async () => {
    const ctx = makeCtx();
    const result = (await createServer.handler(
      createServer.inputSchema.parse({
        name: "web-1",
        server_type: "cx22",
        image: "ubuntu-24.04",
        wait: true,
      }),
      ctx,
    )) as {
      server: Record<string, unknown> | null;
      action: Record<string, unknown> | null;
      root_password: string | null;
    };
    expect(Object.keys(result).sort()).toEqual(
      ["action", "root_password", "server"].sort(),
    );
    expect(result.root_password).toBe("s3cr3t");
    expect(result.action?.status).toBe("success");
    expect(Object.keys(result.server!).sort()).toEqual(SLIM_SERVER_KEYS);
    // wait:true re-fetches the settled server for its assigned IP.
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServer).toHaveBeenCalledWith(42);
  });

  it("does NOT re-fetch when wait is false", async () => {
    const ctx = makeCtx();
    await createServer.handler(
      createServer.inputSchema.parse({
        name: "web-1",
        server_type: "cx22",
        image: "ubuntu-24.04",
        wait: false,
      }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServer).not.toHaveBeenCalled();
  });
});

// =============================================================================
// update_server
// =============================================================================

describe("updateServer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(updateServer.name).toBe("update_server");
    expect(updateServer.description).toBeTruthy();
    expect(updateServer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => updateServer.inputSchema.parse({ server_id: -1 })).toThrow();
  });
});

describe("updateServer — handler", () => {
  it("forwards only provided fields and unwraps body.server", async () => {
    const ctx = makeCtx();
    const result = (await updateServer.handler(
      updateServer.inputSchema.parse({ server_id: 42, name: "renamed" }),
      ctx,
    )) as Record<string, unknown>;
    const client = ctx.client as unknown as FakeClient;
    expect(client.updateServer).toHaveBeenCalledWith(42, { name: "renamed" });
    expect(Object.keys(result).sort()).toEqual(SLIM_SERVER_KEYS);
  });

  it("forwards an empty patch when neither name nor labels provided", async () => {
    const ctx = makeCtx();
    await updateServer.handler(
      updateServer.inputSchema.parse({ server_id: 42 }),
      ctx,
    );
    const client = ctx.client as unknown as FakeClient;
    expect(client.updateServer).toHaveBeenCalledWith(42, {});
  });
});

// =============================================================================
// delete_server
// =============================================================================

describe("deleteServer — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteServer.name).toBe("delete_server");
    expect(deleteServer.description).toBeTruthy();
    expect(deleteServer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false and wait to true", () => {
    const parsed = deleteServer.inputSchema.parse({ server_id: 42 }) as {
      confirm: boolean;
      wait: boolean;
    };
    expect(parsed.confirm).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => deleteServer.inputSchema.parse({ server_id: 0 })).toThrow();
  });
});

describe("deleteServer — confirm gate", () => {
  it("throws ConfirmRequiredError and never calls deleteServer when unconfirmed", async () => {
    const ctx = makeCtx();
    await expect(
      deleteServer.handler(
        deleteServer.inputSchema.parse({ server_id: 42 }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    const client = ctx.client as unknown as FakeClient;
    expect(client.deleteServer).not.toHaveBeenCalled();
  });

  it("preview names the fetched server and its ipv4", async () => {
    const ctx = makeCtx();
    try {
      await deleteServer.handler(
        deleteServer.inputSchema.parse({ server_id: 42 }),
        ctx,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("web-1");
      expect(preview).toContain("42");
      expect(preview).toContain("1.2.3.4");
      expect(preview).toMatch(/delete/i);
    }
  });
});

describe("deleteServer — past confirm gate", () => {
  it("deletes and returns { server_id, action, deleted }", async () => {
    const ctx = makeCtx();
    const result = (await deleteServer.handler(
      deleteServer.inputSchema.parse({ server_id: 42, confirm: true }),
      ctx,
    )) as { server_id: number; action: Record<string, unknown> | null; deleted: boolean };
    const client = ctx.client as unknown as FakeClient;
    expect(client.deleteServer).toHaveBeenCalledWith(42);
    expect(Object.keys(result).sort()).toEqual(
      ["action", "deleted", "server_id"].sort(),
    );
    expect(result.server_id).toBe(42);
    expect(result.deleted).toBe(true);
    expect(result.action?.status).toBe("success");
  });
});

// =============================================================================
// get_server_metrics
// =============================================================================

describe("getServerMetrics — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getServerMetrics.name).toBe("get_server_metrics");
    expect(getServerMetrics.description).toBeTruthy();
    expect(getServerMetrics.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults type to [cpu]", () => {
    const parsed = getServerMetrics.inputSchema.parse({ server_id: 42 }) as {
      type: string[];
    };
    expect(parsed.type).toEqual(["cpu"]);
  });

  it("rejects an unknown metric type", () => {
    expect(() =>
      getServerMetrics.inputSchema.parse({ server_id: 42, type: ["gpu"] }),
    ).toThrow();
  });
});

describe("getServerMetrics — handler", () => {
  it("joins type, forwards the window, and returns time_series keys", async () => {
    const ctx = makeCtx();
    const result = (await getServerMetrics.handler(
      getServerMetrics.inputSchema.parse({
        server_id: 42,
        type: ["cpu", "disk"],
        start: "2026-05-01T00:00:00Z",
        end: "2026-05-01T01:00:00Z",
        step: 120,
      }),
      ctx,
    )) as {
      server_id: number;
      start: string;
      end: string;
      step: number | null;
      series: string[];
    };
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServerMetrics).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "cpu,disk",
        start: "2026-05-01T00:00:00Z",
        end: "2026-05-01T01:00:00Z",
        step: 120,
      }),
    );
    expect(Object.keys(result).sort()).toEqual(
      ["end", "series", "server_id", "start", "step"].sort(),
    );
    expect(result.series).toEqual(["cpu"]);
    expect(result.step).toBe(60);
    expect(result.start).toBe("2026-05-01T00:00:00Z");
    expect(result.end).toBe("2026-05-01T01:00:00Z");
  });

  it("defaults the window to the last hour when start/end omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const ctx = makeCtx();
    const result = (await getServerMetrics.handler(
      getServerMetrics.inputSchema.parse({ server_id: 42 }),
      ctx,
    )) as { start: string; end: string };
    expect(result.end).toBe("2026-06-01T12:00:00.000Z");
    expect(result.start).toBe("2026-06-01T11:00:00.000Z");
    const client = ctx.client as unknown as FakeClient;
    expect(client.getServerMetrics).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: "cpu" }),
    );
  });
});
