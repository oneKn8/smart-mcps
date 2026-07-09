import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listVolumes,
  getVolume,
  createVolume,
  deleteVolume,
  attachVolume,
  detachVolume,
  resizeVolume,
} from "../volumes.js";

// A settled action envelope (status "success" so settleAction never polls).
const sampleAction = {
  id: 42,
  command: "attach_volume",
  status: "success",
  progress: 100,
  started: "2026-01-01T00:00:00Z",
  finished: "2026-01-01T00:01:00Z",
  resources: [{ id: 101, type: "volume" }],
  error: null,
};

// A full upstream Volume with extra fields the slim mapper must strip.
const sampleVolume = {
  id: 101,
  name: "backup-vol",
  size: 50,
  server: 555,
  location: { id: 1, name: "fsn1", city: "Falkenstein", country: "DE" },
  format: "ext4",
  status: "available",
  protection: { delete: false },
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  linux_device: "/dev/disk/by-id/scsi-0HC_Volume_101",
  created: "2026-01-01T00:00:00Z",
};

const ACTION_KEYS = ["id", "command", "status", "progress", "finished"].sort();
const SLIM_KEYS = [
  "id",
  "name",
  "size",
  "server",
  "location",
  "format",
  "status",
  "protection_delete",
  "labels",
].sort();

type FakeVolumeClient = {
  listVolumes: ReturnType<typeof vi.fn>;
  getVolume: ReturnType<typeof vi.fn>;
  createVolume: ReturnType<typeof vi.fn>;
  deleteVolume: ReturnType<typeof vi.fn>;
  volumeAction: ReturnType<typeof vi.fn>;
  extractAction: ReturnType<typeof vi.fn>;
  waitForAction: ReturnType<typeof vi.fn>;
};

function makeClient(
  overrides: Partial<FakeVolumeClient> = {},
): FakeVolumeClient {
  return {
    listVolumes: vi
      .fn()
      .mockResolvedValue({ volumes: [sampleVolume], meta: {} }),
    getVolume: vi.fn().mockResolvedValue(sampleVolume),
    createVolume: vi
      .fn()
      .mockResolvedValue({ volume: sampleVolume, action: sampleAction }),
    deleteVolume: vi.fn().mockResolvedValue(undefined),
    volumeAction: vi.fn().mockResolvedValue({ action: sampleAction }),
    // Mirror the real client's extractAction just enough for settleAction.
    extractAction: vi.fn(
      (body?: { action?: unknown } | null) =>
        (body && typeof body === "object" ? body.action : undefined) ??
        undefined,
    ),
    waitForAction: vi.fn().mockResolvedValue(sampleAction),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeVolumeClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

// Helper: reach into ctx to grab the stubbed client for assertions.
function ctxWith(overrides: Partial<FakeVolumeClient> = {}) {
  const client = makeClient(overrides);
  return { client, ctx: { client: client as unknown as never } };
}

// =============================================================================
// list_volumes
// =============================================================================

describe("listVolumes — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listVolumes.name).toBe("list_volumes");
    expect(listVolumes.description.length).toBeGreaterThan(0);
    expect(listVolumes.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listVolumes.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-integer page", () => {
    expect(() => listVolumes.inputSchema.parse({ page: 1.5 })).toThrow();
  });
});

describe("listVolumes — handler", () => {
  it("forwards only provided filters to client.listVolumes", async () => {
    const { client, ctx } = ctxWith();
    await listVolumes.handler(
      listVolumes.inputSchema.parse({ status: "available", name: "backup" }),
      ctx,
    );
    expect(client.listVolumes).toHaveBeenCalledTimes(1);
    expect(client.listVolumes).toHaveBeenCalledWith({
      status: "available",
      name: "backup",
    });
  });

  it("calls with an empty params object when no filters given", async () => {
    const { client, ctx } = ctxWith();
    await listVolumes.handler(listVolumes.inputSchema.parse({}), ctx);
    expect(client.listVolumes).toHaveBeenCalledWith({});
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const result = (await listVolumes.handler(
      listVolumes.inputSchema.parse({}),
      makeCtx(),
    )) as { volumes: Array<Record<string, unknown>>; count: number };

    expect(result.volumes).toHaveLength(1);
    const slim = result.volumes[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 101,
      name: "backup-vol",
      size: 50,
      server: 555,
      location: "fsn1",
      format: "ext4",
      status: "available",
      protection_delete: false,
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("linux_device");
    expect(slim).not.toHaveProperty("created");
    expect(result.count).toBe(1);
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const result = (await listVolumes.handler(
      listVolumes.inputSchema.parse({}),
      makeCtx({
        listVolumes: vi.fn().mockResolvedValue({ volumes: [{ id: 7 }] }),
      }),
    )) as { volumes: Array<Record<string, unknown>> };
    const slim = result.volumes[0]!;
    expect(slim.id).toBe(7);
    expect(slim.name).toBe("");
    expect(slim.size).toBeNull();
    expect(slim.server).toBeNull();
    expect(slim.location).toBeNull();
    expect(slim.format).toBeNull();
    expect(slim.protection_delete).toBe(false);
    expect(slim.labels).toEqual({});
  });

  it("returns empty list with count 0 when upstream is empty", async () => {
    const result = (await listVolumes.handler(
      listVolumes.inputSchema.parse({}),
      makeCtx({ listVolumes: vi.fn().mockResolvedValue({ volumes: [] }) }),
    )) as { volumes: unknown[]; count: number };
    expect(result.volumes).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// get_volume
// =============================================================================

describe("getVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getVolume.name).toBe("get_volume");
    expect(getVolume.description.length).toBeGreaterThan(0);
    expect(getVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-positive volume_id", () => {
    expect(() => getVolume.inputSchema.parse({ volume_id: 0 })).toThrow();
    expect(() => getVolume.inputSchema.parse({ volume_id: -1 })).toThrow();
  });

  it("rejects a string volume_id", () => {
    expect(() => getVolume.inputSchema.parse({ volume_id: "101" })).toThrow();
  });
});

describe("getVolume — handler", () => {
  it("calls client.getVolume with the input id", async () => {
    const { client, ctx } = ctxWith();
    await getVolume.handler(getVolume.inputSchema.parse({ volume_id: 101 }), ctx);
    expect(client.getVolume).toHaveBeenCalledTimes(1);
    expect(client.getVolume).toHaveBeenCalledWith(101);
  });

  it("returns the slim shape (only listed keys)", async () => {
    const result = (await getVolume.handler(
      getVolume.inputSchema.parse({ volume_id: 101 }),
      makeCtx(),
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).not.toHaveProperty("linux_device");
    expect(result).not.toHaveProperty("created");
  });

  it("propagates NotFoundError from the client", async () => {
    await expect(
      getVolume.handler(
        getVolume.inputSchema.parse({ volume_id: 999 }),
        makeCtx({
          getVolume: vi
            .fn()
            .mockRejectedValue(new NotFoundError("Volume not found: 999")),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// create_volume
// =============================================================================

describe("createVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(createVolume.name).toBe("create_volume");
    expect(createVolume.description.length).toBeGreaterThan(0);
    expect(createVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true when omitted", () => {
    const parsed = createVolume.inputSchema.parse({
      name: "vol",
      size: 50,
      location: "fsn1",
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects empty name", () => {
    expect(() =>
      createVolume.inputSchema.parse({ name: "", size: 50, location: "fsn1" }),
    ).toThrow();
  });

  it("rejects non-positive size", () => {
    expect(() =>
      createVolume.inputSchema.parse({ name: "vol", size: 0, location: "fsn1" }),
    ).toThrow();
  });
});

describe("createVolume — handler (NOT confirm-gated)", () => {
  it("forwards only provided fields as the create body", async () => {
    const { client, ctx } = ctxWith();
    await createVolume.handler(
      createVolume.inputSchema.parse({
        name: "backup-vol",
        size: 50,
        location: "fsn1",
        automount: true,
        labels: { env: "prod" },
      }),
      ctx,
    );
    expect(client.createVolume).toHaveBeenCalledTimes(1);
    expect(client.createVolume).toHaveBeenCalledWith({
      name: "backup-vol",
      size: 50,
      location: "fsn1",
      automount: true,
      labels: { env: "prod" },
    });
    // server/format omitted -> not present in body
    const body = client.createVolume.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("server");
    expect(body).not.toHaveProperty("format");
  });

  it("returns { volume, action } with slim volume and summarized action", async () => {
    const result = (await createVolume.handler(
      createVolume.inputSchema.parse({
        name: "backup-vol",
        size: 50,
        location: "fsn1",
      }),
      makeCtx(),
    )) as { volume: Record<string, unknown>; action: Record<string, unknown> };

    expect(Object.keys(result).sort()).toEqual(["action", "volume"].sort());
    expect(Object.keys(result.volume).sort()).toEqual(SLIM_KEYS);
    expect(Object.keys(result.action).sort()).toEqual(ACTION_KEYS);
    expect(result.action).toEqual({
      id: 42,
      command: "attach_volume",
      status: "success",
      progress: 100,
      finished: "2026-01-01T00:01:00Z",
    });
  });

  it("returns volume: null when upstream body carries no volume", async () => {
    const result = (await createVolume.handler(
      createVolume.inputSchema.parse({ name: "v", size: 10, location: "fsn1" }),
      makeCtx({
        createVolume: vi.fn().mockResolvedValue({ action: sampleAction }),
      }),
    )) as { volume: unknown; action: unknown };
    expect(result.volume).toBeNull();
    expect(result.action).not.toBeNull();
  });
});

// =============================================================================
// delete_volume (destructive)
// =============================================================================

describe("deleteVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteVolume.name).toBe("delete_volume");
    expect(deleteVolume.description.length).toBeGreaterThan(0);
    expect(deleteVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false and wait to true", () => {
    const parsed = deleteVolume.inputSchema.parse({ volume_id: 101 }) as {
      confirm: boolean;
      wait: boolean;
    };
    expect(parsed.confirm).toBe(false);
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive volume_id", () => {
    expect(() =>
      deleteVolume.inputSchema.parse({ volume_id: 0, confirm: true }),
    ).toThrow();
  });
});

describe("deleteVolume — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const { client, ctx } = ctxWith();
    await expect(
      deleteVolume.handler(
        deleteVolume.inputSchema.parse({ volume_id: 101 }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteVolume).not.toHaveBeenCalled();
  });

  it("preview names the real volume, id and size", async () => {
    const { ctx } = ctxWith();
    try {
      await deleteVolume.handler(
        deleteVolume.inputSchema.parse({ volume_id: 101 }),
        ctx,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("backup-vol");
      expect(preview).toContain("101");
      expect(preview).toContain("50GB");
    }
  });
});

describe("deleteVolume — past confirm gate", () => {
  it("with confirm: true deletes and returns { volume_id, action, deleted }", async () => {
    const { client, ctx } = ctxWith();
    const result = (await deleteVolume.handler(
      deleteVolume.inputSchema.parse({ volume_id: 101, confirm: true }),
      ctx,
    )) as { volume_id: number; action: unknown; deleted: boolean };
    expect(client.deleteVolume).toHaveBeenCalledWith(101);
    expect(Object.keys(result).sort()).toEqual(
      ["action", "deleted", "volume_id"].sort(),
    );
    expect(result.volume_id).toBe(101);
    expect(result.deleted).toBe(true);
    // Synchronous DELETE -> no action envelope.
    expect(result.action).toBeNull();
  });

  it("propagates NotFoundError from the client", async () => {
    await expect(
      deleteVolume.handler(
        deleteVolume.inputSchema.parse({ volume_id: 999, confirm: true }),
        makeCtx({
          getVolume: vi
            .fn()
            .mockRejectedValue(new NotFoundError("Volume not found: 999")),
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// attach_volume
// =============================================================================

describe("attachVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(attachVolume.name).toBe("attach_volume");
    expect(attachVolume.description.length).toBeGreaterThan(0);
    expect(attachVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true", () => {
    const parsed = attachVolume.inputSchema.parse({
      volume_id: 101,
      server_id: 555,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a missing server_id", () => {
    expect(() =>
      attachVolume.inputSchema.parse({ volume_id: 101 }),
    ).toThrow();
  });
});

describe("attachVolume — handler", () => {
  it("calls volumeAction with attach + server (and automount when set)", async () => {
    const { client, ctx } = ctxWith();
    await attachVolume.handler(
      attachVolume.inputSchema.parse({
        volume_id: 101,
        server_id: 555,
        automount: true,
      }),
      ctx,
    );
    expect(client.volumeAction).toHaveBeenCalledWith(101, "attach", {
      server: 555,
      automount: true,
    });
  });

  it("omits automount from the action body when not provided", async () => {
    const { client, ctx } = ctxWith();
    await attachVolume.handler(
      attachVolume.inputSchema.parse({ volume_id: 101, server_id: 555 }),
      ctx,
    );
    expect(client.volumeAction).toHaveBeenCalledWith(101, "attach", {
      server: 555,
    });
  });

  it("returns { volume_id, action } with summarized action", async () => {
    const result = (await attachVolume.handler(
      attachVolume.inputSchema.parse({ volume_id: 101, server_id: 555 }),
      makeCtx(),
    )) as { volume_id: number; action: Record<string, unknown> };
    expect(Object.keys(result).sort()).toEqual(["action", "volume_id"].sort());
    expect(result.volume_id).toBe(101);
    expect(Object.keys(result.action).sort()).toEqual(ACTION_KEYS);
  });
});

// =============================================================================
// detach_volume
// =============================================================================

describe("detachVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(detachVolume.name).toBe("detach_volume");
    expect(detachVolume.description.length).toBeGreaterThan(0);
    expect(detachVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true", () => {
    const parsed = detachVolume.inputSchema.parse({ volume_id: 101 }) as {
      wait: boolean;
    };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a non-positive volume_id", () => {
    expect(() => detachVolume.inputSchema.parse({ volume_id: 0 })).toThrow();
  });
});

describe("detachVolume — handler", () => {
  it("calls volumeAction with detach and no body", async () => {
    const { client, ctx } = ctxWith();
    await detachVolume.handler(
      detachVolume.inputSchema.parse({ volume_id: 101 }),
      ctx,
    );
    expect(client.volumeAction).toHaveBeenCalledWith(101, "detach");
  });

  it("returns { volume_id, action }", async () => {
    const result = (await detachVolume.handler(
      detachVolume.inputSchema.parse({ volume_id: 101 }),
      makeCtx(),
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["action", "volume_id"].sort());
  });
});

// =============================================================================
// resize_volume
// =============================================================================

describe("resizeVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(resizeVolume.name).toBe("resize_volume");
    expect(resizeVolume.description.length).toBeGreaterThan(0);
    expect(resizeVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults wait to true", () => {
    const parsed = resizeVolume.inputSchema.parse({
      volume_id: 101,
      size: 100,
    }) as { wait: boolean };
    expect(parsed.wait).toBe(true);
  });

  it("rejects a missing size", () => {
    expect(() => resizeVolume.inputSchema.parse({ volume_id: 101 })).toThrow();
  });

  it("rejects a non-integer size", () => {
    expect(() =>
      resizeVolume.inputSchema.parse({ volume_id: 101, size: 10.5 }),
    ).toThrow();
  });
});

describe("resizeVolume — handler", () => {
  it("calls volumeAction with resize + size body", async () => {
    const { client, ctx } = ctxWith();
    await resizeVolume.handler(
      resizeVolume.inputSchema.parse({ volume_id: 101, size: 100 }),
      ctx,
    );
    expect(client.volumeAction).toHaveBeenCalledWith(101, "resize", {
      size: 100,
    });
  });

  it("returns { volume_id, action }", async () => {
    const result = (await resizeVolume.handler(
      resizeVolume.inputSchema.parse({ volume_id: 101, size: 100 }),
      makeCtx(),
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["action", "volume_id"].sort());
  });
});
