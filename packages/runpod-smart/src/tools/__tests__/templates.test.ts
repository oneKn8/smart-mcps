import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
} from "../templates.js";

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

// =============================================================================
// Shared helpers for the CRUD tools
// =============================================================================

// The slim key set every tool returns via mapTemplate.
const SLIM_KEYS = [
  "category",
  "containerDiskInGb",
  "id",
  "imageName",
  "isPublic",
  "isServerless",
  "name",
  "volumeInGb",
].sort();

type FakeTemplateClient = {
  createTemplate: ReturnType<typeof vi.fn>;
  getTemplate: ReturnType<typeof vi.fn>;
  updateTemplate: ReturnType<typeof vi.fn>;
  deleteTemplate: ReturnType<typeof vi.fn>;
};

function makeTemplateClient(
  overrides: Partial<FakeTemplateClient> = {},
): FakeTemplateClient {
  return {
    createTemplate: vi.fn().mockResolvedValue(sampleTemplate),
    getTemplate: vi.fn().mockResolvedValue(sampleTemplate),
    updateTemplate: vi.fn().mockResolvedValue(sampleTemplate),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// =============================================================================
// create_template
// =============================================================================

describe("createTemplate — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createTemplate.name).toBe("create_template");
    expect(createTemplate.description).toBe(
      "Create a reusable pod or serverless template.",
    );
    expect(createTemplate.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = createTemplate.inputSchema.parse({
      name: "alpha-template",
      image: "runpod/pytorch:2.1.0",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty name", () => {
    expect(() =>
      createTemplate.inputSchema.parse({ name: "", image: "x" }),
    ).toThrow();
  });

  it("rejects empty image", () => {
    expect(() =>
      createTemplate.inputSchema.parse({ name: "x", image: "" }),
    ).toThrow();
  });

  it("rejects category outside the enum", () => {
    expect(() =>
      createTemplate.inputSchema.parse({
        name: "x",
        image: "y",
        category: "TPU",
      }),
    ).toThrow();
  });
});

describe("createTemplate — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeTemplateClient();
    await expect(
      createTemplate.handler(
        createTemplate.inputSchema.parse({
          name: "alpha-template",
          image: "runpod/pytorch:2.1.0",
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createTemplate).not.toHaveBeenCalled();
  });

  it("preview contains name, image, and 'create'", async () => {
    const client = makeTemplateClient();
    try {
      await createTemplate.handler(
        createTemplate.inputSchema.parse({
          name: "alpha-template",
          image: "runpod/pytorch:2.1.0",
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("alpha-template");
      expect(preview).toContain("runpod/pytorch:2.1.0");
      expect(preview).toMatch(/create/i);
    }
  });
});

describe("createTemplate — past confirm gate", () => {
  it("maps all provided fields snake -> camel into the wire body", async () => {
    const client = makeTemplateClient();
    await createTemplate.handler(
      createTemplate.inputSchema.parse({
        name: "alpha-template",
        image: "runpod/pytorch:2.1.0",
        container_disk_gb: 40,
        volume_gb: 100,
        volume_mount_path: "/workspace",
        ports: ["8888/http", "22/tcp"],
        env: { FOO: "bar" },
        is_serverless: true,
        is_public: false,
        category: "NVIDIA",
        readme: "# Readme",
        docker_start_cmd: ["python", "handler.py"],
        container_registry_auth_id: "cra_abc",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      name: "alpha-template",
      imageName: "runpod/pytorch:2.1.0",
      containerDiskInGb: 40,
      volumeInGb: 100,
      volumeMountPath: "/workspace",
      ports: ["8888/http", "22/tcp"],
      env: { FOO: "bar" },
      isServerless: true,
      isPublic: false,
      category: "NVIDIA",
      readme: "# Readme",
      dockerStartCmd: ["python", "handler.py"],
      containerRegistryAuthId: "cra_abc",
    });
    // confirm is a control flag, never forwarded to the API.
    expect(body).not.toHaveProperty("confirm");
  });

  it("omits every optional field the caller did not provide", async () => {
    const client = makeTemplateClient();
    await createTemplate.handler(
      createTemplate.inputSchema.parse({
        name: "alpha-template",
        image: "runpod/pytorch:2.1.0",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      name: "alpha-template",
      imageName: "runpod/pytorch:2.1.0",
    });
    expect(body).not.toHaveProperty("containerDiskInGb");
    expect(body).not.toHaveProperty("volumeInGb");
    expect(body).not.toHaveProperty("env");
    expect(body).not.toHaveProperty("dockerStartCmd");
    expect(body).not.toHaveProperty("containerRegistryAuthId");
  });

  it("returns the slim shape only (strips upstream extras)", async () => {
    const client = makeTemplateClient();
    const result = (await createTemplate.handler(
      createTemplate.inputSchema.parse({
        name: "alpha-template",
        image: "runpod/pytorch:2.1.0",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result.id).toBe("30zmvf89kd");
    expect(result).not.toHaveProperty("env");
    expect(result).not.toHaveProperty("readme");
  });

  it("propagates errors from client.createTemplate", async () => {
    const client = makeTemplateClient({
      createTemplate: vi.fn().mockRejectedValue(new Error("upstream 500")),
    });
    await expect(
      createTemplate.handler(
        createTemplate.inputSchema.parse({
          name: "alpha-template",
          image: "x",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toThrow(/upstream 500/);
  });
});

// =============================================================================
// get_template
// =============================================================================

describe("getTemplate — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(getTemplate.name).toBe("get_template");
    expect(getTemplate.description).toBe("Get a template by ID.");
    expect(getTemplate.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty template_id", () => {
    expect(() => getTemplate.inputSchema.parse({ template_id: "" })).toThrow();
  });
});

describe("getTemplate — handler", () => {
  it("calls client.getTemplate with id and empty opts when no flags set", async () => {
    const client = makeTemplateClient();
    await getTemplate.handler(
      getTemplate.inputSchema.parse({ template_id: "tpl_abc" }),
      { client: client as unknown as never },
    );
    expect(client.getTemplate).toHaveBeenCalledTimes(1);
    expect(client.getTemplate).toHaveBeenCalledWith("tpl_abc", {});
  });

  it("maps include flags snake -> camel opts (preserving explicit false)", async () => {
    const client = makeTemplateClient();
    await getTemplate.handler(
      getTemplate.inputSchema.parse({
        template_id: "tpl_abc",
        include_public: true,
        include_runpod: false,
        include_endpoint_bound: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.getTemplate).toHaveBeenCalledWith("tpl_abc", {
      includePublic: true,
      includeRunpod: false,
      includeEndpointBound: true,
    });
  });

  it("returns the slim shape only", async () => {
    const client = makeTemplateClient();
    const result = (await getTemplate.handler(
      getTemplate.inputSchema.parse({ template_id: "tpl_abc" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).not.toHaveProperty("env");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const client = makeTemplateClient({
      getTemplate: vi.fn().mockResolvedValue({ id: "tpl_minimal" }),
    });
    const result = (await getTemplate.handler(
      getTemplate.inputSchema.parse({ template_id: "tpl_minimal" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result.id).toBe("tpl_minimal");
    expect(result.name).toBeNull();
    expect(result.imageName).toBeNull();
    expect(result.containerDiskInGb).toBeNull();
    expect(result.isServerless).toBeNull();
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeTemplateClient({
      getTemplate: vi.fn().mockRejectedValue(
        new NotFoundError("Template not found: tpl_x"),
      ),
    });
    await expect(
      getTemplate.handler(
        getTemplate.inputSchema.parse({ template_id: "tpl_x" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// update_template
// =============================================================================

describe("updateTemplate — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(updateTemplate.name).toBe("update_template");
    expect(updateTemplate.description).toBe("Update a template.");
    expect(updateTemplate.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty template_id", () => {
    expect(() =>
      updateTemplate.inputSchema.parse({ template_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = updateTemplate.inputSchema.parse({
      template_id: "tpl_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("updateTemplate — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeTemplateClient();
    await expect(
      updateTemplate.handler(
        updateTemplate.inputSchema.parse({
          template_id: "tpl_abc",
          name: "renamed",
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.updateTemplate).not.toHaveBeenCalled();
  });

  it("preview contains template_id, 'update', and the changed field names", async () => {
    const client = makeTemplateClient();
    try {
      await updateTemplate.handler(
        updateTemplate.inputSchema.parse({
          template_id: "tpl_abc",
          name: "renamed",
          image: "new/image:1",
          container_disk_gb: 80,
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("tpl_abc");
      expect(preview).toMatch(/update/i);
      expect(preview).toContain("name");
      expect(preview).toContain("image");
      expect(preview).toContain("container_disk_gb");
    }
  });
});

describe("updateTemplate — past confirm gate", () => {
  it("sends only the provided fields mapped snake -> camel", async () => {
    const client = makeTemplateClient();
    await updateTemplate.handler(
      updateTemplate.inputSchema.parse({
        template_id: "tpl_abc",
        image: "new/image:1",
        container_disk_gb: 80,
        is_public: true,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.updateTemplate).toHaveBeenCalledTimes(1);
    const [id, body] = client.updateTemplate.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("tpl_abc");
    expect(body).toEqual({
      imageName: "new/image:1",
      containerDiskInGb: 80,
      isPublic: true,
    });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("confirm");
  });

  it("returns the slim shape only", async () => {
    const client = makeTemplateClient();
    const result = (await updateTemplate.handler(
      updateTemplate.inputSchema.parse({
        template_id: "tpl_abc",
        name: "renamed",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
  });

  it("propagates NotFoundError from client.updateTemplate", async () => {
    const client = makeTemplateClient({
      updateTemplate: vi.fn().mockRejectedValue(
        new NotFoundError("Template not found: tpl_abc"),
      ),
    });
    await expect(
      updateTemplate.handler(
        updateTemplate.inputSchema.parse({
          template_id: "tpl_abc",
          name: "renamed",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// delete_template
// =============================================================================

describe("deleteTemplate — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteTemplate.name).toBe("delete_template");
    expect(deleteTemplate.description).toBe("Delete a template.");
    expect(deleteTemplate.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty template_id", () => {
    expect(() =>
      deleteTemplate.inputSchema.parse({ template_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteTemplate.inputSchema.parse({
      template_id: "tpl_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("deleteTemplate — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false", async () => {
    const client = makeTemplateClient();
    await expect(
      deleteTemplate.handler(
        deleteTemplate.inputSchema.parse({ template_id: "tpl_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteTemplate).not.toHaveBeenCalled();
  });

  it("preview contains literal 'PERMANENTLY DELETE' and template_id", async () => {
    const client = makeTemplateClient();
    try {
      await deleteTemplate.handler(
        deleteTemplate.inputSchema.parse({ template_id: "tpl_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("tpl_abc");
    }
  });
});

describe("deleteTemplate — past confirm gate", () => {
  it("with confirm: true calls client.deleteTemplate and returns confirmation", async () => {
    const client = makeTemplateClient();
    const result = (await deleteTemplate.handler(
      deleteTemplate.inputSchema.parse({ template_id: "tpl_abc", confirm: true }),
      { client: client as unknown as never },
    )) as { template_id: string; deleted: boolean };
    expect(client.deleteTemplate).toHaveBeenCalledWith("tpl_abc");
    expect(result).toEqual({ template_id: "tpl_abc", deleted: true });
  });

  it("propagates NotFoundError from client.deleteTemplate", async () => {
    const client = makeTemplateClient({
      deleteTemplate: vi.fn().mockRejectedValue(
        new NotFoundError("Template not found: tpl_abc"),
      ),
    });
    await expect(
      deleteTemplate.handler(
        deleteTemplate.inputSchema.parse({ template_id: "tpl_abc", confirm: true }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
