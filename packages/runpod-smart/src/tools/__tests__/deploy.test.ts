import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import { deployServerless } from "../deploy.js";

type FakeClient = {
  createTemplate: ReturnType<typeof vi.fn>;
  createEndpoint: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    createTemplate: vi.fn().mockResolvedValue({ id: "tpl_new" }),
    createEndpoint: vi.fn().mockResolvedValue({ id: "ep_new" }),
    ...overrides,
  };
}

describe("deployServerless — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(deployServerless.name).toBe("deploy_serverless");
    expect(deployServerless.description).toBe(
      "Create a template and serverless endpoint together.",
    );
    expect(deployServerless.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty name", () => {
    expect(() =>
      deployServerless.inputSchema.parse({ name: "", image: "x" }),
    ).toThrow();
  });

  it("rejects empty image", () => {
    expect(() =>
      deployServerless.inputSchema.parse({ name: "x", image: "" }),
    ).toThrow();
  });

  it("rejects gpu_count below 1", () => {
    expect(() =>
      deployServerless.inputSchema.parse({ name: "x", image: "y", gpu_count: 0 }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deployServerless.inputSchema.parse({
      name: "x",
      image: "y",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("deployServerless — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deployServerless.handler(
        deployServerless.inputSchema.parse({ name: "svc", image: "img" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.createTemplate).not.toHaveBeenCalled();
    expect(client.createEndpoint).not.toHaveBeenCalled();
  });

  it("preview names the action, endpoint name, and image", async () => {
    const client = makeClient();
    try {
      await deployServerless.handler(
        deployServerless.inputSchema.parse({
          name: "svc",
          image: "runpod/worker:1.0",
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("svc");
      expect(preview).toContain("runpod/worker:1.0");
      expect(preview).toMatch(/template \+ endpoint/i);
    }
  });
});

describe("deployServerless — template body (step 1)", () => {
  it("sends name, imageName, and isServerless:true with omitted optionals", async () => {
    const client = makeClient();
    await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createTemplate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      name: "svc",
      imageName: "img",
      isServerless: true,
    });
  });

  it("forwards container_disk_gb, volume_gb, env, and registry auth id", async () => {
    const client = makeClient();
    await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        container_disk_gb: 40,
        volume_gb: 100,
        env: { HF_TOKEN: "secret" },
        container_registry_auth_id: "auth_123",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createTemplate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      name: "svc",
      imageName: "img",
      isServerless: true,
      containerDiskInGb: 40,
      volumeInGb: 100,
      env: { HF_TOKEN: "secret" },
      containerRegistryAuthId: "auth_123",
    });
  });

  it("includes volumeInGb when volume_gb is 0 (explicitly provided)", async () => {
    const client = makeClient();
    await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        volume_gb: 0,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createTemplate.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toHaveProperty("volumeInGb", 0);
  });
});

describe("deployServerless — endpoint body (step 2)", () => {
  it("binds the created template id and forwards worker/gpu config", async () => {
    const client = makeClient({
      createTemplate: vi.fn().mockResolvedValue({ id: "tpl_created" }),
    });
    await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        gpu_type_ids: ["NVIDIA A100 80GB"],
        gpu_count: 2,
        workers_min: 0,
        workers_max: 4,
        idle_timeout: 30,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createEndpoint.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      templateId: "tpl_created",
      name: "svc",
      gpuTypeIds: ["NVIDIA A100 80GB"],
      gpuCount: 2,
      workersMin: 0,
      workersMax: 4,
      idleTimeout: 30,
    });
  });

  it("sends only templateId + name when no optionals are provided", async () => {
    const client = makeClient({
      createTemplate: vi.fn().mockResolvedValue({ id: "tpl_bare" }),
    });
    await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    const body = client.createEndpoint.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ templateId: "tpl_bare", name: "svc" });
  });

  it("creates the template before the endpoint", async () => {
    const order: string[] = [];
    const client = makeClient({
      createTemplate: vi.fn().mockImplementation(async () => {
        order.push("template");
        return { id: "tpl_new" };
      }),
      createEndpoint: vi.fn().mockImplementation(async () => {
        order.push("endpoint");
        return { id: "ep_new" };
      }),
    });
    await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(order).toEqual(["template", "endpoint"]);
  });
});

describe("deployServerless — output", () => {
  it("returns template_id, endpoint_id, name, and run_url", async () => {
    const client = makeClient({
      createTemplate: vi.fn().mockResolvedValue({ id: "tpl_out" }),
      createEndpoint: vi.fn().mockResolvedValue({ id: "ep_out" }),
    });
    const result = (await deployServerless.handler(
      deployServerless.inputSchema.parse({
        name: "svc",
        image: "img",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ["endpoint_id", "name", "run_url", "template_id"].sort(),
    );
    expect(result).toEqual({
      template_id: "tpl_out",
      endpoint_id: "ep_out",
      name: "svc",
      run_url: "https://api.runpod.ai/v2/ep_out/run",
    });
  });
});

describe("deployServerless — orphan safety", () => {
  it("surfaces the created template_id when endpoint creation fails", async () => {
    const client = makeClient({
      createTemplate: vi.fn().mockResolvedValue({ id: "tpl_orphan" }),
      createEndpoint: vi
        .fn()
        .mockRejectedValue(new Error("upstream 400 bad worker config")),
    });
    await expect(
      deployServerless.handler(
        deployServerless.inputSchema.parse({
          name: "svc",
          image: "img",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toThrow(/tpl_orphan/);
  });

  it("preserves the underlying endpoint error detail in the message", async () => {
    const client = makeClient({
      createTemplate: vi.fn().mockResolvedValue({ id: "tpl_orphan" }),
      createEndpoint: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Endpoint not found: ep")),
    });
    await expect(
      deployServerless.handler(
        deployServerless.inputSchema.parse({
          name: "svc",
          image: "img",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toThrow(/Endpoint not found: ep/);
  });

  it("propagates a template creation failure directly (no endpoint attempted)", async () => {
    const client = makeClient({
      createTemplate: vi
        .fn()
        .mockRejectedValue(new Error("template create failed")),
    });
    await expect(
      deployServerless.handler(
        deployServerless.inputSchema.parse({
          name: "svc",
          image: "img",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toThrow(/template create failed/);
    expect(client.createEndpoint).not.toHaveBeenCalled();
  });
});
