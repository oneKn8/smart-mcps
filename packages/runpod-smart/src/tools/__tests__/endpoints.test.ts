import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listEndpoints } from "../endpoints.js";

type FakeClient = {
  listEndpoints: ReturnType<typeof vi.fn>;
};

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
