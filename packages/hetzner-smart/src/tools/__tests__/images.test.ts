import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import { listImages, getImage, deleteImage } from "../images.js";

// A full upstream image with extra fields the slim mapper must strip.
const sampleImage = {
  id: 42,
  type: "snapshot",
  status: "available",
  name: "my-snapshot",
  description: "nightly backup",
  os_flavor: "ubuntu",
  os_version: "22.04",
  architecture: "x86",
  disk_size: 20,
  image_size: 2.3,
  created: "2026-05-01T00:00:00+00:00",
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  bound_to: null,
  created_from: { id: 1, name: "server1" },
  rapid_deploy: false,
  deprecated: null,
  protection: { delete: false },
};

const SLIM_KEYS = [
  "id",
  "type",
  "name",
  "description",
  "status",
  "os_flavor",
  "os_version",
  "architecture",
  "disk_size",
  "image_size",
  "created",
  "labels",
].sort();

type FakeImageClient = {
  listImages: ReturnType<typeof vi.fn>;
  getImage: ReturnType<typeof vi.fn>;
  deleteImage: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeImageClient> = {}): FakeImageClient {
  return {
    listImages: vi.fn().mockResolvedValue({ images: [sampleImage] }),
    getImage: vi.fn().mockResolvedValue(sampleImage),
    deleteImage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeImageClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

// =============================================================================
// list_images
// =============================================================================

describe("listImages — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listImages.name).toBe("list_images");
    expect(listImages.description).not.toBe("");
    expect(listImages.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listImages.inputSchema.parse({})).not.toThrow();
  });

  it("rejects an out-of-enum type", () => {
    expect(() => listImages.inputSchema.parse({ type: "bogus" })).toThrow();
  });
});

describe("listImages — handler", () => {
  it("forwards only the supplied filter params", async () => {
    const client = makeClient();
    await listImages.handler(
      listImages.inputSchema.parse({
        type: "snapshot",
        architecture: "x86",
        label_selector: "env=prod",
      }),
      { client: client as unknown as never },
    );
    expect(client.listImages).toHaveBeenCalledTimes(1);
    expect(client.listImages).toHaveBeenCalledWith({
      type: "snapshot",
      architecture: "x86",
      label_selector: "env=prod",
    });
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient();
    const result = (await listImages.handler(
      listImages.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { images: Array<Record<string, unknown>>; count: number };

    expect(result.images).toHaveLength(1);
    const slim = result.images[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 42,
      type: "snapshot",
      name: "my-snapshot",
      description: "nightly backup",
      status: "available",
      os_flavor: "ubuntu",
      os_version: "22.04",
      architecture: "x86",
      disk_size: 20,
      image_size: 2.3,
      created: "2026-05-01T00:00:00+00:00",
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("bound_to");
    expect(slim).not.toHaveProperty("created_from");
    expect(slim).not.toHaveProperty("protection");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient({
      listImages: vi.fn().mockResolvedValue({
        images: [{ id: 7, type: "backup", status: "creating" }],
      }),
    });
    const result = (await listImages.handler(
      listImages.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { images: SlimImageShape[] };
    const slim = result.images[0]!;
    expect(slim.id).toBe(7);
    expect(slim.type).toBe("backup");
    expect(slim.status).toBe("creating");
    expect(slim.name).toBeNull();
    expect(slim.description).toBeNull();
    expect(slim.os_flavor).toBeNull();
    expect(slim.os_version).toBeNull();
    expect(slim.architecture).toBeNull();
    expect(slim.disk_size).toBeNull();
    expect(slim.image_size).toBeNull();
    expect(slim.created).toBeNull();
    expect(slim.labels).toEqual({});
  });

  it("count matches array length", async () => {
    const client = makeClient({
      listImages: vi.fn().mockResolvedValue({
        images: [{ id: 1 }, { id: 2 }, { id: 3 }],
      }),
    });
    const result = (await listImages.handler(
      listImages.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { images: unknown[]; count: number };
    expect(result.count).toBe(3);
    expect(result.images).toHaveLength(3);
  });

  it("guards a non-array / missing images key with empty count 0", async () => {
    const client = makeClient({
      listImages: vi.fn().mockResolvedValue({ meta: {} }),
    });
    const result = (await listImages.handler(
      listImages.inputSchema.parse({}),
      { client: client as unknown as never },
    )) as { images: unknown[]; count: number };
    expect(result.images).toEqual([]);
    expect(result.count).toBe(0);
  });
});

type SlimImageShape = {
  id: number;
  type: string;
  name: string | null;
  description: string | null;
  status: string;
  os_flavor: string | null;
  os_version: string | null;
  architecture: string | null;
  disk_size: number | null;
  image_size: number | null;
  created: string | null;
  labels: Record<string, string>;
};

// =============================================================================
// get_image
// =============================================================================

describe("getImage — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getImage.name).toBe("get_image");
    expect(getImage.description).not.toBe("");
    expect(getImage.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-positive image_id", () => {
    expect(() => getImage.inputSchema.parse({ image_id: 0 })).toThrow();
  });

  it("rejects a missing image_id", () => {
    expect(() => getImage.inputSchema.parse({})).toThrow();
  });

  it("rejects a non-integer image_id", () => {
    expect(() => getImage.inputSchema.parse({ image_id: 1.5 })).toThrow();
  });
});

describe("getImage — handler", () => {
  it("calls client.getImage with the numeric id", async () => {
    const client = makeClient();
    await getImage.handler(getImage.inputSchema.parse({ image_id: 42 }), {
      client: client as unknown as never,
    });
    expect(client.getImage).toHaveBeenCalledTimes(1);
    expect(client.getImage).toHaveBeenCalledWith(42);
  });

  it("returns the slim shape (only listed keys)", async () => {
    const client = makeClient();
    const result = (await getImage.handler(
      getImage.inputSchema.parse({ image_id: 42 }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).not.toHaveProperty("created_from");
    expect(result).not.toHaveProperty("protection");
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getImage: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Image not found: 99")),
    });
    await expect(
      getImage.handler(getImage.inputSchema.parse({ image_id: 99 }), {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// delete_image
// =============================================================================

describe("deleteImage — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteImage.name).toBe("delete_image");
    expect(deleteImage.description).not.toBe("");
    expect(deleteImage.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteImage.inputSchema.parse({ image_id: 42 }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive image_id", () => {
    expect(() =>
      deleteImage.inputSchema.parse({ image_id: 0, confirm: true }),
    ).toThrow();
  });
});

describe("deleteImage — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteImage.handler(deleteImage.inputSchema.parse({ image_id: 42 }), {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteImage).not.toHaveBeenCalled();
  });

  it("preview contains 'PERMANENTLY DELETE' and the image id", async () => {
    const client = makeClient();
    try {
      await deleteImage.handler(deleteImage.inputSchema.parse({ image_id: 42 }), {
        client: client as unknown as never,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("42");
    }
  });
});

describe("deleteImage — past confirm gate", () => {
  it("with confirm: true calls client.deleteImage and returns confirmation", async () => {
    const client = makeClient();
    const result = (await deleteImage.handler(
      deleteImage.inputSchema.parse({ image_id: 42, confirm: true }),
      { client: client as unknown as never },
    )) as { image_id: number; deleted: boolean };
    expect(client.deleteImage).toHaveBeenCalledWith(42);
    expect(result).toEqual({ image_id: 42, deleted: true });
  });

  it("returns only the confirmation keys", async () => {
    const client = makeClient();
    const result = (await deleteImage.handler(
      deleteImage.inputSchema.parse({ image_id: 42, confirm: true }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["deleted", "image_id"].sort());
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      deleteImage: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Image not found: 99")),
    });
    await expect(
      deleteImage.handler(
        deleteImage.inputSchema.parse({ image_id: 99, confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// Reference makeCtx so the shared helper is exercised even though most tests
// inline the context for clarity.
describe("makeCtx helper", () => {
  it("produces a context whose client stub is callable", async () => {
    const ctx = makeCtx();
    const result = (await listImages.handler(
      listImages.inputSchema.parse({}),
      ctx,
    )) as { count: number };
    expect(result.count).toBe(1);
  });
});
