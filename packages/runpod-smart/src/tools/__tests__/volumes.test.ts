import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listNetworkVolumes,
  createNetworkVolume,
  getNetworkVolume,
  updateNetworkVolume,
  deleteNetworkVolume,
} from "../volumes.js";

// A full upstream NetworkVolume with extra fields the slim mapper must strip.
const sampleVolume = {
  id: "vol_abc",
  name: "training-data",
  size: 200,
  dataCenterId: "EU-RO-1",
  // Upstream-only fields the slim mapper must strip:
  createdAt: "2026-05-01T00:00:00.000Z",
  mountPath: "/workspace",
  gpuTypeIds: ["NVIDIA GeForce RTX 4090"],
  status: "READY",
};

type FakeVolumeClient = {
  listNetworkVolumes: ReturnType<typeof vi.fn>;
  createNetworkVolume: ReturnType<typeof vi.fn>;
  getNetworkVolume: ReturnType<typeof vi.fn>;
  updateNetworkVolume: ReturnType<typeof vi.fn>;
  deleteNetworkVolume: ReturnType<typeof vi.fn>;
};

function makeClient(
  overrides: Partial<FakeVolumeClient> = {},
): FakeVolumeClient {
  return {
    listNetworkVolumes: vi
      .fn()
      .mockResolvedValue({ networkVolumes: [sampleVolume] }),
    createNetworkVolume: vi.fn().mockResolvedValue(sampleVolume),
    getNetworkVolume: vi.fn().mockResolvedValue(sampleVolume),
    updateNetworkVolume: vi.fn().mockResolvedValue(sampleVolume),
    deleteNetworkVolume: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SLIM_KEYS = ["id", "name", "size", "dataCenterId"].sort();

// =============================================================================
// list_network_volumes
// =============================================================================

describe("listNetworkVolumes — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listNetworkVolumes.name).toBe("list_network_volumes");
    expect(listNetworkVolumes.description).toBe("List network volumes.");
    expect(listNetworkVolumes.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listNetworkVolumes.inputSchema.parse({})).not.toThrow();
  });
});

describe("listNetworkVolumes — handler", () => {
  it("calls client.listNetworkVolumes() exactly once with no args", async () => {
    const client = makeClient();
    await listNetworkVolumes.handler(
      listNetworkVolumes.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(client.listNetworkVolumes).toHaveBeenCalledTimes(1);
    expect(client.listNetworkVolumes).toHaveBeenCalledWith();
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient();
    const result = (await listNetworkVolumes.handler(
      listNetworkVolumes.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    )) as { volumes: Array<Record<string, unknown>>; count: number };

    expect(result.volumes).toHaveLength(1);
    const slim = result.volumes[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: "vol_abc",
      name: "training-data",
      size: 200,
      dataCenterId: "EU-RO-1",
    });
    expect(slim).not.toHaveProperty("createdAt");
    expect(slim).not.toHaveProperty("mountPath");
    expect(slim).not.toHaveProperty("gpuTypeIds");
    expect(slim).not.toHaveProperty("status");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient({
      listNetworkVolumes: vi
        .fn()
        .mockResolvedValue({ networkVolumes: [{ id: "vol_minimal" }] }),
    });
    const result = (await listNetworkVolumes.handler(
      listNetworkVolumes.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    )) as { volumes: SlimVolumeShape[] };
    const slim = result.volumes[0]!;
    expect(slim.id).toBe("vol_minimal");
    expect(slim.name).toBeNull();
    expect(slim.size).toBeNull();
    expect(slim.dataCenterId).toBeNull();
  });

  it("count matches array length", async () => {
    const client = makeClient({
      listNetworkVolumes: vi.fn().mockResolvedValue({
        networkVolumes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      }),
    });
    const result = (await listNetworkVolumes.handler(
      listNetworkVolumes.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    )) as { volumes: unknown[]; count: number };
    expect(result.count).toBe(3);
    expect(result.volumes).toHaveLength(3);
  });

  it("returns empty list with count 0 when upstream is empty", async () => {
    const client = makeClient({
      listNetworkVolumes: vi.fn().mockResolvedValue({ networkVolumes: [] }),
    });
    const result = (await listNetworkVolumes.handler(
      listNetworkVolumes.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    )) as { volumes: unknown[]; count: number };
    expect(result.volumes).toEqual([]);
    expect(result.count).toBe(0);
  });
});

type SlimVolumeShape = {
  id: string;
  name: string | null;
  size: number | null;
  dataCenterId: string | null;
};

// =============================================================================
// create_network_volume
// =============================================================================

describe("createNetworkVolume — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createNetworkVolume.name).toBe("create_network_volume");
    expect(createNetworkVolume.description).toBe("Create a network volume.");
    expect(createNetworkVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = createNetworkVolume.inputSchema.parse({
      name: "vol",
      size_gb: 100,
      data_center_id: "EU-RO-1",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty name", () => {
    expect(() =>
      createNetworkVolume.inputSchema.parse({
        name: "",
        size_gb: 100,
        data_center_id: "EU-RO-1",
      }),
    ).toThrow();
  });

  it("rejects empty data_center_id", () => {
    expect(() =>
      createNetworkVolume.inputSchema.parse({
        name: "vol",
        size_gb: 100,
        data_center_id: "",
      }),
    ).toThrow();
  });

  it("rejects size_gb: 0 (min 1)", () => {
    expect(() =>
      createNetworkVolume.inputSchema.parse({
        name: "vol",
        size_gb: 0,
        data_center_id: "EU-RO-1",
      }),
    ).toThrow();
  });

  it("rejects size_gb: 4001 (max 4000)", () => {
    expect(() =>
      createNetworkVolume.inputSchema.parse({
        name: "vol",
        size_gb: 4001,
        data_center_id: "EU-RO-1",
      }),
    ).toThrow();
  });

  it("rejects non-integer size_gb", () => {
    expect(() =>
      createNetworkVolume.inputSchema.parse({
        name: "vol",
        size_gb: 100.5,
        data_center_id: "EU-RO-1",
      }),
    ).toThrow();
  });
});

describe("createNetworkVolume — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      createNetworkVolume.handler(
        createNetworkVolume.inputSchema.parse({
          name: "training-data",
          size_gb: 200,
          data_center_id: "EU-RO-1",
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createNetworkVolume).not.toHaveBeenCalled();
  });

  it("preview contains size, name, and data center", async () => {
    const client = makeClient();
    try {
      await createNetworkVolume.handler(
        createNetworkVolume.inputSchema.parse({
          name: "training-data",
          size_gb: 200,
          data_center_id: "EU-RO-1",
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("200GB");
      expect(preview).toContain("training-data");
      expect(preview).toContain("EU-RO-1");
      expect(preview).toMatch(/create/i);
    }
  });
});

describe("createNetworkVolume — past confirm gate", () => {
  it("with confirm: true forwards the camelCase body", async () => {
    const client = makeClient();
    await createNetworkVolume.handler(
      createNetworkVolume.inputSchema.parse({
        name: "training-data",
        size_gb: 200,
        data_center_id: "EU-RO-1",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.createNetworkVolume).toHaveBeenCalledTimes(1);
    const body = client.createNetworkVolume.mock.calls[0]?.[0];
    expect(body).toEqual({
      name: "training-data",
      size: 200,
      dataCenterId: "EU-RO-1",
    });
  });

  it("returns the slim shape (only listed keys)", async () => {
    const client = makeClient();
    const result = (await createNetworkVolume.handler(
      createNetworkVolume.inputSchema.parse({
        name: "training-data",
        size_gb: 200,
        data_center_id: "EU-RO-1",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).toEqual({
      id: "vol_abc",
      name: "training-data",
      size: 200,
      dataCenterId: "EU-RO-1",
    });
  });
});

// =============================================================================
// get_network_volume
// =============================================================================

describe("getNetworkVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getNetworkVolume.name).toBe("get_network_volume");
    expect(getNetworkVolume.description).toBe("Get a network volume by ID.");
    expect(getNetworkVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty volume_id", () => {
    expect(() =>
      getNetworkVolume.inputSchema.parse({ volume_id: "" }),
    ).toThrow();
  });
});

describe("getNetworkVolume — handler", () => {
  it("calls client.getNetworkVolume with the input id", async () => {
    const client = makeClient();
    await getNetworkVolume.handler(
      getNetworkVolume.inputSchema.parse({ volume_id: "vol_abc" }),
      { client: client as unknown as never },
    );
    expect(client.getNetworkVolume).toHaveBeenCalledTimes(1);
    expect(client.getNetworkVolume).toHaveBeenCalledWith("vol_abc");
  });

  it("returns the slim shape (only listed keys)", async () => {
    const client = makeClient();
    const result = (await getNetworkVolume.handler(
      getNetworkVolume.inputSchema.parse({ volume_id: "vol_abc" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("status");
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getNetworkVolume: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Network volume not found: vol_x")),
    });
    await expect(
      getNetworkVolume.handler(
        getNetworkVolume.inputSchema.parse({ volume_id: "vol_x" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// update_network_volume
// =============================================================================

describe("updateNetworkVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(updateNetworkVolume.name).toBe("update_network_volume");
    expect(updateNetworkVolume.description).toBe(
      "Rename or grow a network volume.",
    );
    expect(updateNetworkVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = updateNetworkVolume.inputSchema.parse({
      volume_id: "vol_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty volume_id", () => {
    expect(() =>
      updateNetworkVolume.inputSchema.parse({ volume_id: "", confirm: true }),
    ).toThrow();
  });

  it("rejects size_gb: 4001 (max 4000)", () => {
    expect(() =>
      updateNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        size_gb: 4001,
      }),
    ).toThrow();
  });
});

describe("updateNetworkVolume — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      updateNetworkVolume.handler(
        updateNetworkVolume.inputSchema.parse({
          volume_id: "vol_abc",
          size_gb: 500,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.updateNetworkVolume).not.toHaveBeenCalled();
  });

  it("preview names the volume and the grow-only constraint", async () => {
    const client = makeClient();
    try {
      await updateNetworkVolume.handler(
        updateNetworkVolume.inputSchema.parse({
          volume_id: "vol_abc",
          size_gb: 500,
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("vol_abc");
      expect(preview).toContain("size can only increase");
    }
  });
});

describe("updateNetworkVolume — past confirm gate (body omit-undefined)", () => {
  it("forwards only name when only name is provided", async () => {
    const client = makeClient();
    await updateNetworkVolume.handler(
      updateNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        name: "renamed",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.updateNetworkVolume).toHaveBeenCalledWith("vol_abc", {
      name: "renamed",
    });
  });

  it("forwards only size when only size_gb is provided", async () => {
    const client = makeClient();
    await updateNetworkVolume.handler(
      updateNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        size_gb: 500,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.updateNetworkVolume).toHaveBeenCalledWith("vol_abc", {
      size: 500,
    });
  });

  it("forwards both name and size when both provided", async () => {
    const client = makeClient();
    await updateNetworkVolume.handler(
      updateNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        name: "renamed",
        size_gb: 500,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.updateNetworkVolume).toHaveBeenCalledWith("vol_abc", {
      name: "renamed",
      size: 500,
    });
  });

  it("forwards an empty body when neither name nor size provided", async () => {
    const client = makeClient();
    await updateNetworkVolume.handler(
      updateNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.updateNetworkVolume).toHaveBeenCalledWith("vol_abc", {});
  });

  it("returns the slim shape (only listed keys)", async () => {
    const client = makeClient();
    const result = (await updateNetworkVolume.handler(
      updateNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        size_gb: 500,
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      updateNetworkVolume: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Network volume not found: vol_x")),
    });
    await expect(
      updateNetworkVolume.handler(
        updateNetworkVolume.inputSchema.parse({
          volume_id: "vol_x",
          size_gb: 500,
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// delete_network_volume
// =============================================================================

describe("deleteNetworkVolume — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteNetworkVolume.name).toBe("delete_network_volume");
    expect(deleteNetworkVolume.description).toBe("Delete a network volume.");
    expect(deleteNetworkVolume.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteNetworkVolume.inputSchema.parse({
      volume_id: "vol_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty volume_id", () => {
    expect(() =>
      deleteNetworkVolume.inputSchema.parse({ volume_id: "", confirm: true }),
    ).toThrow();
  });
});

describe("deleteNetworkVolume — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteNetworkVolume.handler(
        deleteNetworkVolume.inputSchema.parse({ volume_id: "vol_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteNetworkVolume).not.toHaveBeenCalled();
  });

  it("preview contains literal 'PERMANENTLY DELETE', the id, and 'data lost'", async () => {
    const client = makeClient();
    try {
      await deleteNetworkVolume.handler(
        deleteNetworkVolume.inputSchema.parse({ volume_id: "vol_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("vol_abc");
      expect(preview).toContain("data lost");
    }
  });
});

describe("deleteNetworkVolume — past confirm gate", () => {
  it("with confirm: true calls client.deleteNetworkVolume and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deleteNetworkVolume.handler(
      deleteNetworkVolume.inputSchema.parse({
        volume_id: "vol_abc",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as { volume_id: string; deleted: boolean };
    expect(client.deleteNetworkVolume).toHaveBeenCalledWith("vol_abc");
    expect(result).toEqual({ volume_id: "vol_abc", deleted: true });
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      deleteNetworkVolume: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Network volume not found: vol_x")),
    });
    await expect(
      deleteNetworkVolume.handler(
        deleteNetworkVolume.inputSchema.parse({
          volume_id: "vol_x",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
