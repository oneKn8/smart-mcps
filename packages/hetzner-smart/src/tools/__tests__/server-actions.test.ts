import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  rebuildServer,
  changeServerType,
  createSnapshot,
  changeServerProtection,
} from "../server-actions.js";

// A settled action envelope. summarizeAction (real, via settleAction) slims this
// to { id, command, status, progress, finished }.
const successAction = {
  id: 42,
  command: "rebuild_server",
  status: "success",
  progress: 100,
  started: "2026-07-08T00:00:00Z",
  finished: "2026-07-08T00:01:00Z",
  resources: [{ id: 1, type: "server" }],
  error: null,
};

const runningAction = {
  ...successAction,
  status: "running",
  progress: 40,
  finished: null,
};

// Mirrors the real HetznerClient.extractAction so the real settleAction, which
// tools call, can find the action inside a stubbed serverAction body.
function fakeExtractAction(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  if (rec.action && typeof rec.action === "object" && !Array.isArray(rec.action)) {
    return rec.action;
  }
  if (Array.isArray(rec.actions)) return rec.actions[0];
  return undefined;
}

type FakeClient = {
  serverAction: ReturnType<typeof vi.fn>;
  extractAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    serverAction: vi.fn().mockResolvedValue({ action: successAction }),
    extractAction: vi.fn(fakeExtractAction),
    waitForAction: vi.fn().mockResolvedValue(successAction),
    ...overrides,
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

const ACTION_SUMMARY_KEYS = ["id", "command", "status", "progress", "finished"];

// =============================================================================
// rebuild_server
// =============================================================================

describe("rebuildServer — metadata + schema", () => {
  it("has snake_case name and a non-empty description", () => {
    expect(rebuildServer.name).toBe("rebuild_server");
    expect(rebuildServer.description).toBe("Rebuild a server from an image.");
    expect(rebuildServer.description.length).toBeGreaterThan(0);
    expect(rebuildServer.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false and wait to true", () => {
    const parsed = rebuildServer.inputSchema.parse({
      server_id: 5,
      image: "ubuntu-24.04",
    }) as { confirm: boolean; wait: boolean };
    expect(parsed.confirm).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() =>
      rebuildServer.inputSchema.parse({ server_id: 0, image: "ubuntu-24.04" }),
    ).toThrow();
  });

  it("rejects an empty image", () => {
    expect(() =>
      rebuildServer.inputSchema.parse({ server_id: 5, image: "" }),
    ).toThrow();
  });
});

describe("rebuildServer — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false and does not mutate", async () => {
    const client = makeClient();
    await expect(
      rebuildServer.handler(
        rebuildServer.inputSchema.parse({ server_id: 5, image: "ubuntu-24.04" }),
        ctx(client),
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.serverAction).not.toHaveBeenCalled();
  });

  it("preview names the server id and warns of the disk wipe", async () => {
    const client = makeClient();
    try {
      await rebuildServer.handler(
        rebuildServer.inputSchema.parse({ server_id: 5, image: "ubuntu-24.04" }),
        ctx(client),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("5");
      expect(preview).toContain("ubuntu-24.04");
      expect(preview).toContain("WIPES");
    }
  });
});

describe("rebuildServer — past confirm gate", () => {
  it("calls serverAction(id, 'rebuild', { image })", async () => {
    const client = makeClient({
      serverAction: vi
        .fn()
        .mockResolvedValue({ action: successAction, root_password: "s3cret" }),
    });
    await rebuildServer.handler(
      rebuildServer.inputSchema.parse({
        server_id: 5,
        image: "ubuntu-24.04",
        confirm: true,
      }),
      ctx(client),
    );
    expect(client.serverAction).toHaveBeenCalledWith(5, "rebuild", {
      image: "ubuntu-24.04",
    });
  });

  it("returns exactly { server_id, action, root_password }", async () => {
    const client = makeClient({
      serverAction: vi
        .fn()
        .mockResolvedValue({ action: successAction, root_password: "s3cret" }),
    });
    const result = (await rebuildServer.handler(
      rebuildServer.inputSchema.parse({
        server_id: 5,
        image: "ubuntu-24.04",
        confirm: true,
      }),
      ctx(client),
    )) as { server_id: number; action: Record<string, unknown>; root_password: string };
    expect(Object.keys(result).sort()).toEqual(
      ["server_id", "action", "root_password"].sort(),
    );
    expect(result.server_id).toBe(5);
    expect(result.root_password).toBe("s3cret");
    expect(Object.keys(result.action).sort()).toEqual(
      ACTION_SUMMARY_KEYS.sort(),
    );
    expect(result.action.status).toBe("success");
  });

  it("nulls root_password when upstream omits it", async () => {
    const client = makeClient();
    const result = (await rebuildServer.handler(
      rebuildServer.inputSchema.parse({
        server_id: 5,
        image: "ubuntu-24.04",
        confirm: true,
      }),
      ctx(client),
    )) as { root_password: string | null };
    expect(result.root_password).toBeNull();
  });

  it("polls waitForAction when the action is still running and wait is true", async () => {
    const client = makeClient({
      serverAction: vi
        .fn()
        .mockResolvedValue({ action: runningAction, root_password: "pw" }),
    });
    const result = (await rebuildServer.handler(
      rebuildServer.inputSchema.parse({
        server_id: 5,
        image: "ubuntu-24.04",
        confirm: true,
      }),
      ctx(client),
    )) as { action: Record<string, unknown> };
    expect(client.waitForAction).toHaveBeenCalledWith(42);
    expect(result.action.status).toBe("success");
  });
});

// =============================================================================
// change_server_type
// =============================================================================

describe("changeServerType — metadata + schema", () => {
  it("has snake_case name and a non-empty description", () => {
    expect(changeServerType.name).toBe("change_server_type");
    expect(changeServerType.description.length).toBeGreaterThan(0);
    expect(changeServerType.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults upgrade_disk false, confirm false, wait true", () => {
    const parsed = changeServerType.inputSchema.parse({
      server_id: 7,
      server_type: "cpx31",
    }) as { upgrade_disk: boolean; confirm: boolean; wait: boolean };
    expect(parsed.upgrade_disk).toBe(false);
    expect(parsed.confirm).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects an empty server_type", () => {
    expect(() =>
      changeServerType.inputSchema.parse({ server_id: 7, server_type: "" }),
    ).toThrow();
  });
});

describe("changeServerType — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false and does not mutate", async () => {
    const client = makeClient();
    await expect(
      changeServerType.handler(
        changeServerType.inputSchema.parse({
          server_id: 7,
          server_type: "cpx31",
        }),
        ctx(client),
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.serverAction).not.toHaveBeenCalled();
  });

  it("preview names the server id and the target type", async () => {
    const client = makeClient();
    try {
      await changeServerType.handler(
        changeServerType.inputSchema.parse({
          server_id: 7,
          server_type: "cpx31",
        }),
        ctx(client),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("7");
      expect(preview).toContain("cpx31");
    }
  });
});

describe("changeServerType — past confirm gate", () => {
  it("calls serverAction(id, 'change_type', { server_type, upgrade_disk })", async () => {
    const client = makeClient();
    await changeServerType.handler(
      changeServerType.inputSchema.parse({
        server_id: 7,
        server_type: "cpx31",
        upgrade_disk: true,
        confirm: true,
      }),
      ctx(client),
    );
    expect(client.serverAction).toHaveBeenCalledWith(7, "change_type", {
      server_type: "cpx31",
      upgrade_disk: true,
    });
  });

  it("returns exactly { server_id, action }", async () => {
    const client = makeClient();
    const result = (await changeServerType.handler(
      changeServerType.inputSchema.parse({
        server_id: 7,
        server_type: "cpx31",
        confirm: true,
      }),
      ctx(client),
    )) as { server_id: number; action: Record<string, unknown> };
    expect(Object.keys(result).sort()).toEqual(["server_id", "action"].sort());
    expect(result.server_id).toBe(7);
    expect(result.action.status).toBe("success");
  });

  it("returns the running summary without polling when wait is false", async () => {
    const client = makeClient({
      serverAction: vi.fn().mockResolvedValue({ action: runningAction }),
    });
    const result = (await changeServerType.handler(
      changeServerType.inputSchema.parse({
        server_id: 7,
        server_type: "cpx31",
        confirm: true,
        wait: false,
      }),
      ctx(client),
    )) as { action: Record<string, unknown> };
    expect(client.waitForAction).not.toHaveBeenCalled();
    expect(result.action.status).toBe("running");
  });
});

// =============================================================================
// create_snapshot
// =============================================================================

describe("createSnapshot — metadata + schema", () => {
  it("has snake_case name and a non-empty description", () => {
    expect(createSnapshot.name).toBe("create_snapshot");
    expect(createSnapshot.description.length).toBeGreaterThan(0);
    expect(createSnapshot.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true", () => {
    const parsed = createSnapshot.inputSchema.parse({ server_id: 9 }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() => createSnapshot.inputSchema.parse({ server_id: -1 })).toThrow();
  });
});

describe("createSnapshot — handler", () => {
  it("calls serverAction(id, 'create_image', { type, description, labels })", async () => {
    const client = makeClient({
      serverAction: vi.fn().mockResolvedValue({
        action: successAction,
        image: { id: 999, type: "snapshot", name: "snap", extra: "drop" },
      }),
    });
    await createSnapshot.handler(
      createSnapshot.inputSchema.parse({
        server_id: 9,
        description: "nightly",
        labels: { env: "prod" },
      }),
      ctx(client),
    );
    expect(client.serverAction).toHaveBeenCalledWith(9, "create_image", {
      type: "snapshot",
      description: "nightly",
      labels: { env: "prod" },
    });
  });

  it("omits description and labels when not supplied", async () => {
    const client = makeClient();
    await createSnapshot.handler(
      createSnapshot.inputSchema.parse({ server_id: 9 }),
      ctx(client),
    );
    expect(client.serverAction).toHaveBeenCalledWith(9, "create_image", {
      type: "snapshot",
    });
  });

  it("returns exactly { server_id, image_id, action } with image_id from body.image.id", async () => {
    const client = makeClient({
      serverAction: vi.fn().mockResolvedValue({
        action: successAction,
        image: { id: 999, type: "snapshot", name: "snap" },
      }),
    });
    const result = (await createSnapshot.handler(
      createSnapshot.inputSchema.parse({ server_id: 9 }),
      ctx(client),
    )) as { server_id: number; image_id: number | null; action: Record<string, unknown> };
    expect(Object.keys(result).sort()).toEqual(
      ["server_id", "image_id", "action"].sort(),
    );
    expect(result.server_id).toBe(9);
    expect(result.image_id).toBe(999);
    expect(result.action.status).toBe("success");
  });

  it("nulls image_id when upstream omits the image", async () => {
    const client = makeClient();
    const result = (await createSnapshot.handler(
      createSnapshot.inputSchema.parse({ server_id: 9 }),
      ctx(client),
    )) as { image_id: number | null };
    expect(result.image_id).toBeNull();
  });
});

// =============================================================================
// change_server_protection
// =============================================================================

describe("changeServerProtection — metadata + schema", () => {
  it("has snake_case name and a non-empty description", () => {
    expect(changeServerProtection.name).toBe("change_server_protection");
    expect(changeServerProtection.description.length).toBeGreaterThan(0);
    expect(changeServerProtection.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true", () => {
    const parsed = changeServerProtection.inputSchema.parse({
      server_id: 3,
      delete: true,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive server_id", () => {
    expect(() =>
      changeServerProtection.inputSchema.parse({ server_id: 0, delete: true }),
    ).toThrow();
  });
});

describe("changeServerProtection — handler", () => {
  it("throws and does not mutate when neither delete nor rebuild is set", async () => {
    const client = makeClient();
    await expect(
      changeServerProtection.handler(
        changeServerProtection.inputSchema.parse({ server_id: 3 }),
        ctx(client),
      ),
    ).rejects.toThrow(/at least one/i);
    expect(client.serverAction).not.toHaveBeenCalled();
  });

  it("forwards only the flags provided", async () => {
    const client = makeClient();
    await changeServerProtection.handler(
      changeServerProtection.inputSchema.parse({ server_id: 3, delete: true }),
      ctx(client),
    );
    expect(client.serverAction).toHaveBeenCalledWith(3, "change_protection", {
      delete: true,
    });
  });

  it("forwards both flags when both provided", async () => {
    const client = makeClient();
    await changeServerProtection.handler(
      changeServerProtection.inputSchema.parse({
        server_id: 3,
        delete: true,
        rebuild: false,
      }),
      ctx(client),
    );
    expect(client.serverAction).toHaveBeenCalledWith(3, "change_protection", {
      delete: true,
      rebuild: false,
    });
  });

  it("returns exactly { server_id, action }", async () => {
    const client = makeClient();
    const result = (await changeServerProtection.handler(
      changeServerProtection.inputSchema.parse({ server_id: 3, rebuild: true }),
      ctx(client),
    )) as { server_id: number; action: Record<string, unknown> };
    expect(Object.keys(result).sort()).toEqual(["server_id", "action"].sort());
    expect(result.server_id).toBe(3);
    expect(result.action.status).toBe("success");
  });
});
