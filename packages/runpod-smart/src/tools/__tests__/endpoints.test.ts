import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listEndpoints,
  createEndpoint,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
} from "../endpoints.js";

type FakeClient = {
  listEndpoints: ReturnType<typeof vi.fn>;
};

const SLIM_ENDPOINT_KEYS = [
  "createdAt",
  "id",
  "idleTimeout",
  "name",
  "templateId",
  "workersMax",
  "workersMin",
].sort();

// A full upstream endpoint payload carrying camelCase slim fields plus a pile
// of upstream-only extras the mapper must strip.
const fullEndpoint = {
  id: "ep_abc",
  name: "llama-prod",
  templateId: "tpl_xyz",
  workersMin: 0,
  workersMax: 3,
  idleTimeout: 5,
  createdAt: "2026-04-01T12:00:00.000Z",
  env: { FOO: "bar" },
  gpuTypeIds: ["NVIDIA RTX A6000"],
  gpuCount: 1,
  scalerType: "QUEUE_DELAY",
  scalerValue: 4,
  computeType: "GPU",
  dataCenterIds: ["EU-RO-1"],
  executionTimeoutMs: 600000,
  workers: [],
  userId: "user_xyz",
  version: 1,
};

type FakeEndpointOpsClient = {
  createEndpoint: ReturnType<typeof vi.fn>;
  getEndpoint: ReturnType<typeof vi.fn>;
  updateEndpoint: ReturnType<typeof vi.fn>;
  deleteEndpoint: ReturnType<typeof vi.fn>;
};

function makeEndpointOpsClient(
  overrides: Partial<FakeEndpointOpsClient> = {},
): FakeEndpointOpsClient {
  return {
    createEndpoint: vi.fn().mockResolvedValue(fullEndpoint),
    getEndpoint: vi.fn().mockResolvedValue(fullEndpoint),
    updateEndpoint: vi.fn().mockResolvedValue(fullEndpoint),
    deleteEndpoint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const sampleEndpoint = {
  id: "ep_abc",
  name: "llama-prod",
  templateId: "tpl_xyz",
  workersMin: 0,
  workersMax: 3,
  idleTimeout: 5,
  createdAt: "2026-04-01T12:00:00.000Z",
  // Upstream-only fields the slim mapper must strip:
  env: { FOO: "bar" },
  gpuTypeIds: ["NVIDIA RTX A6000"],
  gpuCount: 1,
  scalerType: "QUEUE_DELAY",
  scalerValue: 4,
  computeType: "GPU",
  dataCenterIds: ["EU-RO-1"],
  executionTimeoutMs: 600000,
  workers: [],
  userId: "user_xyz",
  version: 1,
};

function makeClient(endpoints: Array<Record<string, unknown>>): FakeClient {
  return {
    listEndpoints: vi.fn().mockResolvedValue({ endpoints }),
  };
}

describe("listEndpoints — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listEndpoints.name).toBe("list_endpoints");
    expect(listEndpoints.description).toBe("List Runpod serverless endpoints.");
    expect(listEndpoints.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listEndpoints.inputSchema.parse({})).not.toThrow();
  });
});

describe("listEndpoints — handler", () => {
  it("calls client.listEndpoints() exactly once", async () => {
    const client = makeClient([sampleEndpoint]);
    await listEndpoints.handler(
      listEndpoints.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(client.listEndpoints).toHaveBeenCalledTimes(1);
    expect(client.listEndpoints).toHaveBeenCalledWith();
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient([sampleEndpoint]);
    const result = await listEndpoints.handler(
      listEndpoints.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.endpoints).toHaveLength(1);
    const slim = result.endpoints[0]!;
    expect(Object.keys(slim).sort()).toEqual(
      [
        "createdAt",
        "id",
        "idleTimeout",
        "name",
        "templateId",
        "workersMax",
        "workersMin",
      ].sort(),
    );
    expect(slim.id).toBe("ep_abc");
    expect(slim.name).toBe("llama-prod");
    expect(slim.templateId).toBe("tpl_xyz");
    expect(slim.workersMin).toBe(0);
    expect(slim.workersMax).toBe(3);
    expect(slim.idleTimeout).toBe(5);
    expect(slim.createdAt).toBe("2026-04-01T12:00:00.000Z");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient([{ id: "ep_minimal" }]);
    const result = await listEndpoints.handler(
      listEndpoints.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    const slim = result.endpoints[0]!;
    expect(slim.id).toBe("ep_minimal");
    expect(slim.name).toBeNull();
    expect(slim.templateId).toBeNull();
    expect(slim.workersMin).toBeNull();
    expect(slim.workersMax).toBeNull();
    expect(slim.idleTimeout).toBeNull();
    expect(slim.createdAt).toBeNull();
  });

  it("count matches array length", async () => {
    const client = makeClient([
      { id: "a" },
      { id: "b" },
      { id: "c" },
      { id: "d" },
    ]);
    const result = await listEndpoints.handler(
      listEndpoints.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.count).toBe(4);
    expect(result.endpoints).toHaveLength(4);
  });

  it("returns empty list with count 0 when upstream is empty", async () => {
    const client = makeClient([]);
    const result = await listEndpoints.handler(
      listEndpoints.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.endpoints).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// create_endpoint
// =============================================================================

describe("createEndpoint — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createEndpoint.name).toBe("create_endpoint");
    expect(createEndpoint.description).toBe(
      "Create a serverless endpoint from a template.",
    );
    expect(createEndpoint.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("requires template_id (rejects empty)", () => {
    expect(() =>
      createEndpoint.inputSchema.parse({ template_id: "", confirm: true }),
    ).toThrow();
    expect(() => createEndpoint.inputSchema.parse({ confirm: true })).toThrow();
  });

  it("rejects compute_type outside the enum", () => {
    expect(() =>
      createEndpoint.inputSchema.parse({
        template_id: "tpl_xyz",
        compute_type: "TPU",
      }),
    ).toThrow();
  });

  it("rejects scaler_type outside the enum", () => {
    expect(() =>
      createEndpoint.inputSchema.parse({
        template_id: "tpl_xyz",
        scaler_type: "CPU_LOAD",
      }),
    ).toThrow();
  });

  it("enforces upstream bounds on idle_timeout (1..3600) and scaler_value (>=1)", () => {
    // Mirrors EndpointCreateInput: idleTimeout 1..3600, scalerValue min 1.
    const base = { template_id: "tpl_xyz" };
    expect(() => createEndpoint.inputSchema.parse({ ...base, idle_timeout: 0 })).toThrow();
    expect(() => createEndpoint.inputSchema.parse({ ...base, idle_timeout: 3601 })).toThrow();
    expect(() => createEndpoint.inputSchema.parse({ ...base, scaler_value: 0 })).toThrow();
    expect(() =>
      createEndpoint.inputSchema.parse({ ...base, idle_timeout: 5, scaler_value: 1 }),
    ).not.toThrow();
    // update_endpoint shares the same bounds.
    expect(() =>
      updateEndpoint.inputSchema.parse({ endpoint_id: "ep_1", idle_timeout: 0 }),
    ).toThrow();
    expect(() =>
      updateEndpoint.inputSchema.parse({ endpoint_id: "ep_1", scaler_value: 0 }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = createEndpoint.inputSchema.parse({
      template_id: "tpl_xyz",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("createEndpoint — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeEndpointOpsClient();
    await expect(
      createEndpoint.handler(
        createEndpoint.inputSchema.parse({ template_id: "tpl_xyz" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createEndpoint).not.toHaveBeenCalled();
  });

  it("preview uses the endpoint name when provided", async () => {
    const client = makeEndpointOpsClient();
    try {
      await createEndpoint.handler(
        createEndpoint.inputSchema.parse({
          template_id: "tpl_xyz",
          name: "llama-prod",
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will create endpoint llama-prod",
      );
    }
  });

  it("preview falls back to template id when name is omitted", async () => {
    const client = makeEndpointOpsClient();
    try {
      await createEndpoint.handler(
        createEndpoint.inputSchema.parse({ template_id: "tpl_xyz" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will create endpoint from template tpl_xyz",
      );
    }
  });
});

describe("createEndpoint — body mapping (snake → camel)", () => {
  it("maps all provided fields to the camelCase wire shape", async () => {
    const client = makeEndpointOpsClient();
    await createEndpoint.handler(
      createEndpoint.inputSchema.parse({
        template_id: "tpl_xyz",
        name: "llama-prod",
        compute_type: "GPU",
        gpu_type_ids: ["NVIDIA RTX A6000"],
        gpu_count: 2,
        workers_min: 0,
        workers_max: 3,
        idle_timeout: 5,
        scaler_type: "QUEUE_DELAY",
        scaler_value: 4,
        execution_timeout_ms: 600000,
        flashboot: true,
        network_volume_id: "vol_123",
        data_center_ids: ["EU-RO-1"],
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createEndpoint.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      templateId: "tpl_xyz",
      name: "llama-prod",
      computeType: "GPU",
      gpuTypeIds: ["NVIDIA RTX A6000"],
      gpuCount: 2,
      workersMin: 0,
      workersMax: 3,
      idleTimeout: 5,
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
      executionTimeoutMs: 600000,
      flashboot: true,
      networkVolumeId: "vol_123",
      dataCenterIds: ["EU-RO-1"],
    });
  });

  it("omits undefined fields but always sends templateId", async () => {
    const client = makeEndpointOpsClient();
    await createEndpoint.handler(
      createEndpoint.inputSchema.parse({
        template_id: "tpl_only",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createEndpoint.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ templateId: "tpl_only" });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("computeType");
    expect(body).not.toHaveProperty("gpuTypeIds");
    expect(body).not.toHaveProperty("networkVolumeId");
  });

  it("preserves workers_min: 0 (falsy but defined) in the body", async () => {
    const client = makeEndpointOpsClient();
    await createEndpoint.handler(
      createEndpoint.inputSchema.parse({
        template_id: "tpl_xyz",
        workers_min: 0,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createEndpoint.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body.workersMin).toBe(0);
  });
});

describe("createEndpoint — output shape", () => {
  it("returns the slim endpoint shape only (strips upstream extras)", async () => {
    const client = makeEndpointOpsClient();
    const result = (await createEndpoint.handler(
      createEndpoint.inputSchema.parse({
        template_id: "tpl_xyz",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_ENDPOINT_KEYS);
    expect(result.id).toBe("ep_abc");
    expect(result).not.toHaveProperty("env");
    expect(result).not.toHaveProperty("scalerType");
  });
});

// =============================================================================
// get_endpoint
// =============================================================================

describe("getEndpoint — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getEndpoint.name).toBe("get_endpoint");
    expect(getEndpoint.description).toBe("Get a serverless endpoint by ID.");
    expect(getEndpoint.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty endpoint_id", () => {
    expect(() => getEndpoint.inputSchema.parse({ endpoint_id: "" })).toThrow();
  });
});

describe("getEndpoint — handler", () => {
  it("passes include flags through to client.getEndpoint", async () => {
    const client = makeEndpointOpsClient();
    await getEndpoint.handler(
      getEndpoint.inputSchema.parse({
        endpoint_id: "ep_abc",
        include_template: true,
        include_workers: false,
      }),
      { client: client as unknown as never },
    );
    expect(client.getEndpoint).toHaveBeenCalledTimes(1);
    expect(client.getEndpoint).toHaveBeenCalledWith("ep_abc", {
      includeTemplate: true,
      includeWorkers: false,
    });
  });

  it("passes undefined include flags when omitted", async () => {
    const client = makeEndpointOpsClient();
    await getEndpoint.handler(
      getEndpoint.inputSchema.parse({ endpoint_id: "ep_abc" }),
      { client: client as unknown as never },
    );
    expect(client.getEndpoint).toHaveBeenCalledWith("ep_abc", {
      includeTemplate: undefined,
      includeWorkers: undefined,
    });
  });

  it("returns the slim endpoint shape (strips upstream extras)", async () => {
    const client = makeEndpointOpsClient();
    const result = (await getEndpoint.handler(
      getEndpoint.inputSchema.parse({ endpoint_id: "ep_abc" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_ENDPOINT_KEYS);
    expect(result).not.toHaveProperty("gpuCount");
    expect(result).not.toHaveProperty("workers");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeEndpointOpsClient({
      getEndpoint: vi.fn().mockResolvedValue({ id: "ep_min" }),
    });
    const result = (await getEndpoint.handler(
      getEndpoint.inputSchema.parse({ endpoint_id: "ep_min" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result.id).toBe("ep_min");
    expect(result.name).toBeNull();
    expect(result.templateId).toBeNull();
    expect(result.workersMin).toBeNull();
    expect(result.workersMax).toBeNull();
    expect(result.idleTimeout).toBeNull();
    expect(result.createdAt).toBeNull();
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeEndpointOpsClient({
      getEndpoint: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Endpoint not found: ep_x")),
    });
    await expect(
      getEndpoint.handler(
        getEndpoint.inputSchema.parse({ endpoint_id: "ep_x" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// update_endpoint
// =============================================================================

describe("updateEndpoint — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(updateEndpoint.name).toBe("update_endpoint");
    expect(updateEndpoint.description).toBe(
      "Update endpoint scaling and config.",
    );
    expect(updateEndpoint.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty endpoint_id", () => {
    expect(() =>
      updateEndpoint.inputSchema.parse({ endpoint_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = updateEndpoint.inputSchema.parse({
      endpoint_id: "ep_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("updateEndpoint — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeEndpointOpsClient();
    await expect(
      updateEndpoint.handler(
        updateEndpoint.inputSchema.parse({
          endpoint_id: "ep_abc",
          workers_max: 5,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.updateEndpoint).not.toHaveBeenCalled();
  });

  it("preview contains the endpoint id and the changed fields", async () => {
    const client = makeEndpointOpsClient();
    try {
      await updateEndpoint.handler(
        updateEndpoint.inputSchema.parse({
          endpoint_id: "ep_abc",
          workers_max: 5,
          idle_timeout: 10,
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("ep_abc");
      expect(preview).toContain("workersMax");
      expect(preview).toContain("idleTimeout");
      expect(preview).toMatch(/update/i);
    }
  });
});

describe("updateEndpoint — body mapping + output", () => {
  it("sends only the changed fields (snake → camel), never id or confirm", async () => {
    const client = makeEndpointOpsClient();
    await updateEndpoint.handler(
      updateEndpoint.inputSchema.parse({
        endpoint_id: "ep_abc",
        name: "renamed",
        gpu_type_ids: ["NVIDIA H100 80GB HBM3"],
        gpu_count: 2,
        workers_min: 1,
        workers_max: 4,
        idle_timeout: 30,
        scaler_type: "REQUEST_COUNT",
        scaler_value: 8,
        execution_timeout_ms: 300000,
        flashboot: false,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.updateEndpoint).toHaveBeenCalledTimes(1);
    const [id, body] = client.updateEndpoint.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("ep_abc");
    expect(body).toEqual({
      name: "renamed",
      gpuTypeIds: ["NVIDIA H100 80GB HBM3"],
      gpuCount: 2,
      workersMin: 1,
      workersMax: 4,
      idleTimeout: 30,
      scalerType: "REQUEST_COUNT",
      scalerValue: 8,
      executionTimeoutMs: 300000,
      flashboot: false,
    });
    expect(body).not.toHaveProperty("endpoint_id");
    expect(body).not.toHaveProperty("endpointId");
    expect(body).not.toHaveProperty("confirm");
  });

  it("sends an empty body when no updatable fields are provided", async () => {
    const client = makeEndpointOpsClient();
    await updateEndpoint.handler(
      updateEndpoint.inputSchema.parse({
        endpoint_id: "ep_abc",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.updateEndpoint.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({});
  });

  it("returns the slim endpoint shape (strips upstream extras)", async () => {
    const client = makeEndpointOpsClient();
    const result = (await updateEndpoint.handler(
      updateEndpoint.inputSchema.parse({
        endpoint_id: "ep_abc",
        workers_max: 5,
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_ENDPOINT_KEYS);
    expect(result).not.toHaveProperty("scalerValue");
  });

  it("propagates NotFoundError from updateEndpoint", async () => {
    const client = makeEndpointOpsClient({
      updateEndpoint: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Endpoint not found: gone")),
    });
    await expect(
      updateEndpoint.handler(
        updateEndpoint.inputSchema.parse({
          endpoint_id: "gone",
          workers_max: 5,
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// delete_endpoint
// =============================================================================

describe("deleteEndpoint — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteEndpoint.name).toBe("delete_endpoint");
    expect(deleteEndpoint.description).toBe("Delete a serverless endpoint.");
    expect(deleteEndpoint.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty endpoint_id", () => {
    expect(() =>
      deleteEndpoint.inputSchema.parse({ endpoint_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteEndpoint.inputSchema.parse({
      endpoint_id: "ep_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("deleteEndpoint — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeEndpointOpsClient();
    await expect(
      deleteEndpoint.handler(
        deleteEndpoint.inputSchema.parse({ endpoint_id: "ep_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteEndpoint).not.toHaveBeenCalled();
  });

  it("preview contains literal 'PERMANENTLY DELETE' and the endpoint id", async () => {
    const client = makeEndpointOpsClient();
    try {
      await deleteEndpoint.handler(
        deleteEndpoint.inputSchema.parse({ endpoint_id: "ep_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("ep_abc");
    }
  });
});

describe("deleteEndpoint — past confirm gate", () => {
  it("with confirm: true calls client.deleteEndpoint and returns confirmation", async () => {
    const client = makeEndpointOpsClient();
    const result = (await deleteEndpoint.handler(
      deleteEndpoint.inputSchema.parse({ endpoint_id: "ep_abc", confirm: true }),
      { client: client as unknown as never },
    )) as { endpoint_id: string; deleted: boolean };
    expect(client.deleteEndpoint).toHaveBeenCalledWith("ep_abc");
    expect(result).toEqual({ endpoint_id: "ep_abc", deleted: true });
  });

  it("propagates NotFoundError from deleteEndpoint", async () => {
    const client = makeEndpointOpsClient({
      deleteEndpoint: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Endpoint not found: ep_abc")),
    });
    await expect(
      deleteEndpoint.handler(
        deleteEndpoint.inputSchema.parse({
          endpoint_id: "ep_abc",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
