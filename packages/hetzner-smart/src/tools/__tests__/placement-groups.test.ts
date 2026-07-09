import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listPlacementGroups,
  createPlacementGroup,
  deletePlacementGroup,
} from "../placement-groups.js";

// A full upstream placement group carrying extras the slim mapper must strip.
const samplePg = {
  id: 897,
  name: "spread-group",
  type: "spread",
  servers: [4711, 4712, 4713],
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  created: "2026-05-01T00:00:00+00:00",
};

type FakePgClient = {
  listPlacementGroups: ReturnType<typeof vi.fn>;
  createPlacementGroup: ReturnType<typeof vi.fn>;
  deletePlacementGroup: ReturnType<typeof vi.fn>;
};

function makeCtx(overrides: Partial<FakePgClient> = {}): { client: never } {
  const client: FakePgClient = {
    listPlacementGroups: vi
      .fn()
      .mockResolvedValue({ placement_groups: [samplePg], meta: {} }),
    createPlacementGroup: vi
      .fn()
      .mockResolvedValue({ placement_group: samplePg, action: null }),
    deletePlacementGroup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { client: client as unknown as never };
}

const SLIM_KEYS = ["id", "name", "type", "servers_count", "labels"].sort();

type SlimShape = {
  id: number;
  name: string;
  type: string;
  servers_count: number;
  labels: Record<string, string>;
};

// =============================================================================
// list_placement_groups
// =============================================================================

describe("listPlacementGroups — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listPlacementGroups.name).toBe("list_placement_groups");
    expect(listPlacementGroups.description).toBeTruthy();
    expect(listPlacementGroups.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object (all filters optional)", () => {
    expect(() => listPlacementGroups.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() =>
      listPlacementGroups.inputSchema.parse({ name: 123 }),
    ).toThrow();
  });
});

describe("listPlacementGroups — handler", () => {
  it("forwards name and label_selector filters to the client", async () => {
    const ctx = makeCtx();
    await listPlacementGroups.handler(
      listPlacementGroups.inputSchema.parse({
        name: "spread-group",
        label_selector: "env=prod",
      }),
      ctx,
    );
    const client = ctx.client as unknown as FakePgClient;
    expect(client.listPlacementGroups).toHaveBeenCalledTimes(1);
    expect(client.listPlacementGroups).toHaveBeenCalledWith({
      name: "spread-group",
      label_selector: "env=prod",
    });
  });

  it("omits undefined filters (empty params when none given)", async () => {
    const ctx = makeCtx();
    await listPlacementGroups.handler(
      listPlacementGroups.inputSchema.parse({}),
      ctx,
    );
    const client = ctx.client as unknown as FakePgClient;
    expect(client.listPlacementGroups).toHaveBeenCalledWith({});
  });

  it("maps body.placement_groups to the slim shape and strips extras", async () => {
    const ctx = makeCtx();
    const result = (await listPlacementGroups.handler(
      listPlacementGroups.inputSchema.parse({}),
      ctx,
    )) as { placement_groups: Array<Record<string, unknown>>; count: number };

    expect(result.placement_groups).toHaveLength(1);
    expect(result.count).toBe(1);
    const slim = result.placement_groups[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 897,
      name: "spread-group",
      type: "spread",
      servers_count: 3,
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("servers");
    expect(slim).not.toHaveProperty("created");
  });

  it("null-safes optional fields and defaults servers_count to 0", async () => {
    const ctx = makeCtx({
      listPlacementGroups: vi
        .fn()
        .mockResolvedValue({ placement_groups: [{ id: 9 }] }),
    });
    const result = (await listPlacementGroups.handler(
      listPlacementGroups.inputSchema.parse({}),
      ctx,
    )) as { placement_groups: SlimShape[] };
    const slim = result.placement_groups[0]!;
    expect(slim.id).toBe(9);
    expect(slim.name).toBe("");
    expect(slim.type).toBe("");
    expect(slim.servers_count).toBe(0);
    expect(slim.labels).toEqual({});
  });

  it("returns an empty list with count 0 when upstream lacks the array", async () => {
    const ctx = makeCtx({
      listPlacementGroups: vi.fn().mockResolvedValue({ meta: {} }),
    });
    const result = (await listPlacementGroups.handler(
      listPlacementGroups.inputSchema.parse({}),
      ctx,
    )) as { placement_groups: unknown[]; count: number };
    expect(result.placement_groups).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// create_placement_group
// =============================================================================

describe("createPlacementGroup — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createPlacementGroup.name).toBe("create_placement_group");
    expect(createPlacementGroup.description).toBeTruthy();
    expect(createPlacementGroup.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects an empty name", () => {
    expect(() => createPlacementGroup.inputSchema.parse({ name: "" })).toThrow();
  });

  it("defaults type to spread when omitted", () => {
    const parsed = createPlacementGroup.inputSchema.parse({
      name: "spread-group",
    }) as { type: string };
    expect(parsed.type).toBe("spread");
  });

  it("rejects an unsupported type value", () => {
    expect(() =>
      createPlacementGroup.inputSchema.parse({
        name: "spread-group",
        type: "cluster",
      }),
    ).toThrow();
  });
});

describe("createPlacementGroup — handler", () => {
  it("forwards name and the default type, omitting labels when absent", async () => {
    const ctx = makeCtx();
    await createPlacementGroup.handler(
      createPlacementGroup.inputSchema.parse({ name: "spread-group" }),
      ctx,
    );
    const client = ctx.client as unknown as FakePgClient;
    expect(client.createPlacementGroup).toHaveBeenCalledTimes(1);
    expect(client.createPlacementGroup).toHaveBeenCalledWith({
      name: "spread-group",
      type: "spread",
    });
  });

  it("forwards labels when provided", async () => {
    const ctx = makeCtx();
    await createPlacementGroup.handler(
      createPlacementGroup.inputSchema.parse({
        name: "spread-group",
        labels: { env: "prod" },
      }),
      ctx,
    );
    const client = ctx.client as unknown as FakePgClient;
    expect(client.createPlacementGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "spread-group",
        type: "spread",
        labels: { env: "prod" },
      }),
    );
  });

  it("pulls body.placement_group and returns the slim shape only", async () => {
    const ctx = makeCtx();
    const result = (await createPlacementGroup.handler(
      createPlacementGroup.inputSchema.parse({ name: "spread-group" }),
      ctx,
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).toEqual({
      id: 897,
      name: "spread-group",
      type: "spread",
      servers_count: 3,
      labels: { env: "prod" },
    });
  });

  it("null-safes when body.placement_group is absent", async () => {
    const ctx = makeCtx({
      createPlacementGroup: vi.fn().mockResolvedValue({}),
    });
    const result = (await createPlacementGroup.handler(
      createPlacementGroup.inputSchema.parse({ name: "spread-group" }),
      ctx,
    )) as SlimShape;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result.id).toBe(0);
    expect(result.servers_count).toBe(0);
  });
});

// =============================================================================
// delete_placement_group
// =============================================================================

describe("deletePlacementGroup — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(deletePlacementGroup.name).toBe("delete_placement_group");
    expect(deletePlacementGroup.description).toBeTruthy();
    expect(deletePlacementGroup.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deletePlacementGroup.inputSchema.parse({
      placement_group_id: 897,
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive placement_group_id", () => {
    expect(() =>
      deletePlacementGroup.inputSchema.parse({
        placement_group_id: 0,
        confirm: true,
      }),
    ).toThrow();
  });
});

describe("deletePlacementGroup — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const ctx = makeCtx();
    await expect(
      deletePlacementGroup.handler(
        deletePlacementGroup.inputSchema.parse({ placement_group_id: 897 }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    const client = ctx.client as unknown as FakePgClient;
    expect(client.deletePlacementGroup).not.toHaveBeenCalled();
  });

  it("preview names the id and warns of permanent deletion", async () => {
    const ctx = makeCtx();
    try {
      await deletePlacementGroup.handler(
        deletePlacementGroup.inputSchema.parse({ placement_group_id: 897 }),
        ctx,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("897");
      expect(preview).toContain("PERMANENTLY DELETE");
    }
  });
});

describe("deletePlacementGroup — past confirm gate", () => {
  it("with confirm: true deletes and returns the slim confirmation", async () => {
    const ctx = makeCtx();
    const result = (await deletePlacementGroup.handler(
      deletePlacementGroup.inputSchema.parse({
        placement_group_id: 897,
        confirm: true,
      }),
      ctx,
    )) as { placement_group_id: number; deleted: boolean };
    const client = ctx.client as unknown as FakePgClient;
    expect(client.deletePlacementGroup).toHaveBeenCalledWith(897);
    expect(Object.keys(result).sort()).toEqual(
      ["placement_group_id", "deleted"].sort(),
    );
    expect(result).toEqual({ placement_group_id: 897, deleted: true });
  });

  it("propagates NotFoundError from the client", async () => {
    const ctx = makeCtx({
      deletePlacementGroup: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Placement group not found: 9")),
    });
    await expect(
      deletePlacementGroup.handler(
        deletePlacementGroup.inputSchema.parse({
          placement_group_id: 9,
          confirm: true,
        }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
