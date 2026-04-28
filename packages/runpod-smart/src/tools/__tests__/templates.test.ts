import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listTemplates } from "../templates.js";

type FakeClient = {
  listTemplates: ReturnType<typeof vi.fn>;
};

const sampleTemplate = {
  id: "30zmvf89kd",
  name: "PyTorch 2.1",
  imageName: "runpod/pytorch:2.1.0",
  containerDiskInGb: 50,
  volumeInGb: 0,
  isServerless: false,
  isPublic: true,
  category: "NVIDIA",
  // Upstream-only fields the slim mapper must strip:
  env: { FOO: "bar" },
  dockerEntrypoint: [],
  dockerStartCmd: [],
  readme: "# Hello",
  earned: 12.5,
  isRunpod: true,
  ports: ["8888/http"],
};

function makeClient(templates: Array<Record<string, unknown>>): FakeClient {
  return {
    listTemplates: vi.fn().mockResolvedValue({ templates }),
  };
}

describe("listTemplates — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listTemplates.name).toBe("list_templates");
    expect(listTemplates.description).toBe("List Runpod pod templates.");
    expect(listTemplates.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listTemplates.inputSchema.parse({})).not.toThrow();
  });
});

describe("listTemplates — handler", () => {
  it("calls client.listTemplates() exactly once", async () => {
    const client = makeClient([sampleTemplate]);
    await listTemplates.handler(
      listTemplates.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(client.listTemplates).toHaveBeenCalledTimes(1);
    expect(client.listTemplates).toHaveBeenCalledWith();
  });

  it("strips upstream extras and returns the slim shape only", async () => {
    const client = makeClient([sampleTemplate]);
    const result = await listTemplates.handler(
      listTemplates.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.templates).toHaveLength(1);
    const slim = result.templates[0]!;
    expect(Object.keys(slim).sort()).toEqual(
      [
        "category",
        "containerDiskInGb",
        "id",
        "imageName",
        "isPublic",
        "isServerless",
        "name",
        "volumeInGb",
      ].sort(),
    );
    expect(slim.id).toBe("30zmvf89kd");
    expect(slim.name).toBe("PyTorch 2.1");
    expect(slim.imageName).toBe("runpod/pytorch:2.1.0");
    expect(slim.containerDiskInGb).toBe(50);
    expect(slim.volumeInGb).toBe(0);
    expect(slim.isServerless).toBe(false);
    expect(slim.isPublic).toBe(true);
    expect(slim.category).toBe("NVIDIA");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeClient([{ id: "tpl_minimal" }]);
    const result = await listTemplates.handler(
      listTemplates.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    const slim = result.templates[0]!;
    expect(slim.id).toBe("tpl_minimal");
    expect(slim.name).toBeNull();
    expect(slim.imageName).toBeNull();
    expect(slim.containerDiskInGb).toBeNull();
    expect(slim.volumeInGb).toBeNull();
    expect(slim.isServerless).toBeNull();
    expect(slim.isPublic).toBeNull();
    expect(slim.category).toBeNull();
  });

  it("count matches array length", async () => {
    const client = makeClient([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
    const result = await listTemplates.handler(
      listTemplates.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.count).toBe(3);
    expect(result.templates).toHaveLength(3);
  });

  it("returns empty list with count 0 when upstream is empty", async () => {
    const client = makeClient([]);
    const result = await listTemplates.handler(
      listTemplates.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.templates).toEqual([]);
    expect(result.count).toBe(0);
  });
});
