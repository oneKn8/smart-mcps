import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listRegistryAuths,
  createRegistryAuth,
  getRegistryAuth,
  deleteRegistryAuth,
} from "../registry.js";

// A distinctive dummy secret. No output or preview may contain this value or
// any substring of it — that assertion is the whole point of secret discipline.
const DUMMY_PASSWORD = "sup3r-s3cret-xyz";

type FakeRegistryClient = {
  listRegistryAuths: ReturnType<typeof vi.fn>;
  createRegistryAuth: ReturnType<typeof vi.fn>;
  getRegistryAuth: ReturnType<typeof vi.fn>;
  deleteRegistryAuth: ReturnType<typeof vi.fn>;
};

function makeClient(
  overrides: Partial<FakeRegistryClient> = {},
): FakeRegistryClient {
  const sampleAuth = { id: "auth_abc", name: "dockerhub" };
  return {
    listRegistryAuths: vi
      .fn()
      .mockResolvedValue({ registryAuths: [sampleAuth] }),
    createRegistryAuth: vi.fn().mockResolvedValue(sampleAuth),
    getRegistryAuth: vi.fn().mockResolvedValue(sampleAuth),
    deleteRegistryAuth: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// =============================================================================
// list_registry_auths
// =============================================================================

describe("listRegistryAuths — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listRegistryAuths.name).toBe("list_registry_auths");
    expect(listRegistryAuths.description).toBe(
      "List container registry credentials.",
    );
    expect(listRegistryAuths.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listRegistryAuths.inputSchema.parse({})).not.toThrow();
  });
});

describe("listRegistryAuths — handler", () => {
  it("calls client.listRegistryAuths() exactly once with no args", async () => {
    const client = makeClient();
    await listRegistryAuths.handler(
      listRegistryAuths.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(client.listRegistryAuths).toHaveBeenCalledTimes(1);
    expect(client.listRegistryAuths).toHaveBeenCalledWith();
  });

  it("maps to the slim {id, name} shape only", async () => {
    const client = makeClient({
      listRegistryAuths: vi.fn().mockResolvedValue({
        registryAuths: [
          {
            id: "auth_abc",
            name: "dockerhub",
            // Upstream would never echo these, but assert we strip anything extra:
            username: "someone",
            registry: "docker.io",
          },
        ],
      }),
    });
    const result = await listRegistryAuths.handler(
      listRegistryAuths.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.registryAuths).toHaveLength(1);
    const slim = result.registryAuths[0]!;
    expect(Object.keys(slim).sort()).toEqual(["id", "name"].sort());
    expect(slim.id).toBe("auth_abc");
    expect(slim.name).toBe("dockerhub");
    expect(slim).not.toHaveProperty("username");
    expect(slim).not.toHaveProperty("registry");
  });

  it("null-safes name when upstream omits it", async () => {
    const client = makeClient({
      listRegistryAuths: vi
        .fn()
        .mockResolvedValue({ registryAuths: [{ id: "auth_min" }] }),
    });
    const result = await listRegistryAuths.handler(
      listRegistryAuths.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    const slim = result.registryAuths[0]!;
    expect(slim.id).toBe("auth_min");
    expect(slim.name).toBeNull();
  });

  it("count matches array length", async () => {
    const client = makeClient({
      listRegistryAuths: vi.fn().mockResolvedValue({
        registryAuths: [{ id: "a" }, { id: "b" }, { id: "c" }],
      }),
    });
    const result = await listRegistryAuths.handler(
      listRegistryAuths.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.count).toBe(3);
    expect(result.registryAuths).toHaveLength(3);
  });

  it("returns empty list with count 0 when upstream is empty", async () => {
    const client = makeClient({
      listRegistryAuths: vi.fn().mockResolvedValue({ registryAuths: [] }),
    });
    const result = await listRegistryAuths.handler(
      listRegistryAuths.inputSchema.parse({}) as Record<string, never>,
      { client: client as unknown as never },
    );
    expect(result.registryAuths).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// create_registry_auth
// =============================================================================

describe("createRegistryAuth — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(createRegistryAuth.name).toBe("create_registry_auth");
    expect(createRegistryAuth.description).toBe(
      "Store private container registry credentials.",
    );
    expect(createRegistryAuth.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = createRegistryAuth.inputSchema.parse({
      name: "dockerhub",
      username: "someone",
      password: DUMMY_PASSWORD,
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty name", () => {
    expect(() =>
      createRegistryAuth.inputSchema.parse({
        name: "",
        username: "someone",
        password: DUMMY_PASSWORD,
      }),
    ).toThrow();
  });

  it("rejects empty username", () => {
    expect(() =>
      createRegistryAuth.inputSchema.parse({
        name: "dockerhub",
        username: "",
        password: DUMMY_PASSWORD,
      }),
    ).toThrow();
  });

  it("rejects empty password", () => {
    expect(() =>
      createRegistryAuth.inputSchema.parse({
        name: "dockerhub",
        username: "someone",
        password: "",
      }),
    ).toThrow();
  });
});

describe("createRegistryAuth — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      createRegistryAuth.handler(
        createRegistryAuth.inputSchema.parse({
          name: "dockerhub",
          username: "someone",
          password: DUMMY_PASSWORD,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    // No credential must be stored when the confirm gate fails.
    expect(client.createRegistryAuth).not.toHaveBeenCalled();
  });

  it("preview names the credential label and username", async () => {
    const client = makeClient();
    try {
      await createRegistryAuth.handler(
        createRegistryAuth.inputSchema.parse({
          name: "dockerhub",
          username: "someone",
          password: DUMMY_PASSWORD,
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("dockerhub");
      expect(preview).toContain("someone");
      expect(preview).toMatch(/store/i);
    }
  });

  // SECRET DISCIPLINE: the password must never surface in the preview.
  it("preview does NOT contain the password value or any substring", async () => {
    const client = makeClient();
    try {
      await createRegistryAuth.handler(
        createRegistryAuth.inputSchema.parse({
          name: "dockerhub",
          username: "someone",
          password: DUMMY_PASSWORD,
        }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).not.toContain(DUMMY_PASSWORD);
      // Guard against partial leakage too — no meaningful chunk of the secret.
      expect(preview).not.toContain("sup3r");
      expect(preview).not.toContain("s3cret");
      expect(preview).not.toContain("xyz");
    }
  });
});

describe("createRegistryAuth — past confirm gate", () => {
  it("forwards name, username, password verbatim to the client", async () => {
    const client = makeClient();
    await createRegistryAuth.handler(
      createRegistryAuth.inputSchema.parse({
        name: "dockerhub",
        username: "someone",
        password: DUMMY_PASSWORD,
        confirm: true,
      }),
      { client: client as unknown as never },
    );
    expect(client.createRegistryAuth).toHaveBeenCalledTimes(1);
    expect(client.createRegistryAuth).toHaveBeenCalledWith({
      name: "dockerhub",
      username: "someone",
      password: DUMMY_PASSWORD,
    });
  });

  it("returns the slim {id, name} shape only", async () => {
    const client = makeClient({
      createRegistryAuth: vi
        .fn()
        .mockResolvedValue({ id: "auth_new", name: "dockerhub" }),
    });
    const result = (await createRegistryAuth.handler(
      createRegistryAuth.inputSchema.parse({
        name: "dockerhub",
        username: "someone",
        password: DUMMY_PASSWORD,
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["id", "name"].sort());
    expect(result.id).toBe("auth_new");
    expect(result.name).toBe("dockerhub");
  });

  // SECRET DISCIPLINE: even if upstream (wrongly) echoed the password back, the
  // slim mapper must not surface it. Return an id+name only.
  it("output does NOT contain the password value or any substring", async () => {
    const client = makeClient({
      createRegistryAuth: vi.fn().mockResolvedValue({
        id: "auth_new",
        name: "dockerhub",
        // A hostile / buggy upstream that echoes the secret back:
        password: DUMMY_PASSWORD,
        username: "someone",
      }),
    });
    const result = (await createRegistryAuth.handler(
      createRegistryAuth.inputSchema.parse({
        name: "dockerhub",
        username: "someone",
        password: DUMMY_PASSWORD,
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("username");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(DUMMY_PASSWORD);
    expect(serialized).not.toContain("sup3r");
    expect(serialized).not.toContain("s3cret");
    expect(serialized).not.toContain("xyz");
  });
});

// =============================================================================
// get_registry_auth
// =============================================================================

describe("getRegistryAuth — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getRegistryAuth.name).toBe("get_registry_auth");
    expect(getRegistryAuth.description).toBe(
      "Get a registry credential by ID.",
    );
    expect(getRegistryAuth.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty auth_id", () => {
    expect(() => getRegistryAuth.inputSchema.parse({ auth_id: "" })).toThrow();
  });
});

describe("getRegistryAuth — handler", () => {
  it("calls client.getRegistryAuth with the input id", async () => {
    const client = makeClient();
    await getRegistryAuth.handler(
      getRegistryAuth.inputSchema.parse({ auth_id: "auth_abc" }),
      { client: client as unknown as never },
    );
    expect(client.getRegistryAuth).toHaveBeenCalledTimes(1);
    expect(client.getRegistryAuth).toHaveBeenCalledWith("auth_abc");
  });

  it("returns the slim {id, name} shape only", async () => {
    const client = makeClient();
    const result = (await getRegistryAuth.handler(
      getRegistryAuth.inputSchema.parse({ auth_id: "auth_abc" }),
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["id", "name"].sort());
    expect(result.id).toBe("auth_abc");
    expect(result.name).toBe("dockerhub");
  });

  it("null-safes name when upstream omits it", async () => {
    const client = makeClient({
      getRegistryAuth: vi.fn().mockResolvedValue({ id: "auth_min" }),
    });
    const result = (await getRegistryAuth.handler(
      getRegistryAuth.inputSchema.parse({ auth_id: "auth_min" }),
      { client: client as unknown as never },
    )) as { id: string; name: string | null };
    expect(result.name).toBeNull();
  });

  it("propagates NotFoundError from the client", async () => {
    const client = makeClient({
      getRegistryAuth: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Registry auth not found: gone")),
    });
    await expect(
      getRegistryAuth.handler(
        getRegistryAuth.inputSchema.parse({ auth_id: "gone" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// delete_registry_auth
// =============================================================================

describe("deleteRegistryAuth — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(deleteRegistryAuth.name).toBe("delete_registry_auth");
    expect(deleteRegistryAuth.description).toBe(
      "Delete a registry credential.",
    );
    expect(deleteRegistryAuth.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty auth_id", () => {
    expect(() =>
      deleteRegistryAuth.inputSchema.parse({ auth_id: "", confirm: true }),
    ).toThrow();
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteRegistryAuth.inputSchema.parse({
      auth_id: "auth_abc",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("deleteRegistryAuth — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const client = makeClient();
    await expect(
      deleteRegistryAuth.handler(
        deleteRegistryAuth.inputSchema.parse({ auth_id: "auth_abc" }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    expect(client.deleteRegistryAuth).not.toHaveBeenCalled();
  });

  it("preview contains literal 'PERMANENTLY DELETE' and the auth_id", async () => {
    const client = makeClient();
    try {
      await deleteRegistryAuth.handler(
        deleteRegistryAuth.inputSchema.parse({ auth_id: "auth_abc" }),
        { client: client as unknown as never },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY DELETE");
      expect(preview).toContain("auth_abc");
    }
  });
});

describe("deleteRegistryAuth — past confirm gate", () => {
  it("with confirm: true calls client.deleteRegistryAuth and returns confirmation object", async () => {
    const client = makeClient();
    const result = (await deleteRegistryAuth.handler(
      deleteRegistryAuth.inputSchema.parse({
        auth_id: "auth_abc",
        confirm: true,
      }),
      { client: client as unknown as never },
    )) as { auth_id: string; deleted: boolean };
    expect(client.deleteRegistryAuth).toHaveBeenCalledWith("auth_abc");
    expect(result).toEqual({ auth_id: "auth_abc", deleted: true });
  });

  it("propagates NotFoundError from deleteRegistryAuth", async () => {
    const client = makeClient({
      deleteRegistryAuth: vi
        .fn()
        .mockRejectedValue(new NotFoundError("Registry auth not found: gone")),
    });
    await expect(
      deleteRegistryAuth.handler(
        deleteRegistryAuth.inputSchema.parse({
          auth_id: "gone",
          confirm: true,
        }),
        { client: client as unknown as never },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
