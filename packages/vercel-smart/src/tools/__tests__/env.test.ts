import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, PermissionError, NotFoundError } from "smart-mcp-core";
import { listEnv, revealEnv, setEnv, editEnv, deleteEnv } from "../env.js";

type FakeClient = {
  listProjectEnv: ReturnType<typeof vi.fn>;
  revealProjectEnv: ReturnType<typeof vi.fn>;
  upsertProjectEnv: ReturnType<typeof vi.fn>;
  updateProjectEnv: ReturnType<typeof vi.fn>;
  deleteProjectEnv: ReturnType<typeof vi.fn>;
};

function makeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listProjectEnv: vi.fn().mockResolvedValue({ envs: [] }),
    revealProjectEnv: vi.fn().mockResolvedValue({}),
    upsertProjectEnv: vi.fn().mockResolvedValue({}),
    updateProjectEnv: vi.fn().mockResolvedValue({}),
    deleteProjectEnv: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function ctx(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

type EnvOverrides = Partial<{
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[] | string;
  gitBranch: string | null;
  comment: string;
  createdAt: number;
  updatedAt: number;
}>;

function makeEnv(overrides: EnvOverrides): Record<string, unknown> {
  return {
    id: "env_1",
    key: "DATABASE_URL",
    value: "postgres://secret",
    type: "encrypted",
    target: ["production", "preview"],
    gitBranch: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ list_env

describe("listEnv — metadata & validation", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listEnv.name).toBe("list_env");
    expect(listEnv.description).toContain("environment variable");
    expect(listEnv.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults decrypt to false", () => {
    const parsed = listEnv.inputSchema.parse({ project: "alpha" }) as {
      decrypt: boolean;
    };
    expect(parsed.decrypt).toBe(false);
  });

  it("rejects empty project string", () => {
    expect(() => listEnv.inputSchema.parse({ project: "" })).toThrow();
  });
});

describe("listEnv — M4 slim projection (never leaks value)", () => {
  it("decrypt=false output entries NEVER contain a 'value' field", async () => {
    const client = makeClient({
      listProjectEnv: vi.fn().mockResolvedValue({
        envs: [
          makeEnv({ id: "env_a", key: "A", value: "plaintext-A", type: "plain" }),
          makeEnv({ id: "env_b", key: "B", value: "cipher-B", type: "encrypted" }),
        ],
      }),
    });
    const input = listEnv.inputSchema.parse({ project: "alpha" });
    const result = (await listEnv.handler(input as never, ctx(client))) as {
      decrypted: boolean;
      count: number;
      envs: Array<Record<string, unknown>>;
    };

    expect(result.decrypted).toBe(false);
    expect(result.count).toBe(2);
    for (const e of result.envs) {
      expect(e).not.toHaveProperty("value");
      expect(Object.keys(e).sort()).toEqual(
        ["gitBranch", "id", "key", "target", "type", "updatedAt"].sort(),
      );
    }
    // decrypt=false must NOT reach the reveal-gated API arg
    expect(client.listProjectEnv).toHaveBeenCalledWith("alpha", {
      decrypt: false,
      gitBranch: undefined,
    });
  });

  it("even when upstream includes a value, decrypt=false strips it", async () => {
    const client = makeClient({
      listProjectEnv: vi
        .fn()
        .mockResolvedValue({ envs: [makeEnv({ value: "leaky-secret" })] }),
    });
    const input = listEnv.inputSchema.parse({ project: "alpha" });
    const result = (await listEnv.handler(input as never, ctx(client))) as {
      envs: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(result)).not.toContain("leaky-secret");
  });
});

describe("listEnv — M4 decrypt gate", () => {
  it("decrypt=true is BLOCKED without VERCEL_SMART_ALLOW_REVEAL and never hits the API", async () => {
    const client = makeClient();
    const input = listEnv.inputSchema.parse({ project: "alpha", decrypt: true });
    await expect(listEnv.handler(input as never, ctx(client))).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(client.listProjectEnv).not.toHaveBeenCalled();
  });

  it("decrypt=true surfaces values (with decrypted flag) once the gate is open", async () => {
    vi.stubEnv("VERCEL_SMART_ALLOW_REVEAL", "1");
    const client = makeClient({
      listProjectEnv: vi.fn().mockResolvedValue({
        envs: [
          makeEnv({ id: "e1", key: "PLAIN", value: "shown", type: "encrypted" }),
          // sensitive vars return no plaintext -> decrypted:false, value:null
          makeEnv({ id: "e2", key: "SENS", value: undefined, type: "sensitive" }),
        ],
      }),
    });
    const input = listEnv.inputSchema.parse({ project: "alpha", decrypt: true });
    const result = (await listEnv.handler(input as never, ctx(client))) as {
      decrypted: boolean;
      envs: Array<{ key: string; value: string | null; decrypted: boolean }>;
    };
    expect(result.decrypted).toBe(true);
    const plain = result.envs.find((e) => e.key === "PLAIN")!;
    expect(plain.value).toBe("shown");
    expect(plain.decrypted).toBe(true);
    const sens = result.envs.find((e) => e.key === "SENS")!;
    expect(sens.value).toBeNull();
    expect(sens.decrypted).toBe(false);
  });
});

// ---------------------------------------------------------------- reveal_env

describe("revealEnv — metadata & gate", () => {
  it("has correct name and input schema", () => {
    expect(revealEnv.name).toBe("reveal_env");
    expect(revealEnv.inputSchema).toBeInstanceOf(z.ZodType);
    expect(() => revealEnv.inputSchema.parse({ project: "alpha" })).toThrow();
    expect(() => revealEnv.inputSchema.parse({ project: "", id: "env_1" })).toThrow();
  });

  it("is BLOCKED without VERCEL_SMART_ALLOW_REVEAL and never hits the API", async () => {
    const client = makeClient();
    const input = revealEnv.inputSchema.parse({ project: "alpha", id: "env_1" });
    await expect(revealEnv.handler(input as never, ctx(client))).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(client.revealProjectEnv).not.toHaveBeenCalled();
  });

  it("returns decrypted value and marks output sensitive when gate is open", async () => {
    vi.stubEnv("VERCEL_SMART_ALLOW_REVEAL", "1");
    const client = makeClient({
      revealProjectEnv: vi.fn().mockResolvedValue(
        makeEnv({ id: "env_1", key: "DATABASE_URL", value: "postgres://real", type: "encrypted" }),
      ),
    });
    const input = revealEnv.inputSchema.parse({ project: "alpha", id: "env_1" });
    const result = (await revealEnv.handler(input as never, ctx(client))) as {
      value: string | null;
      decrypted: boolean;
      sensitive: boolean;
      note?: string;
    };
    expect(result.value).toBe("postgres://real");
    expect(result.decrypted).toBe(true);
    expect(result.sensitive).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it("surfaces decrypted:false with a note for type:'sensitive'", async () => {
    vi.stubEnv("VERCEL_SMART_ALLOW_REVEAL", "1");
    const client = makeClient({
      revealProjectEnv: vi
        .fn()
        .mockResolvedValue(makeEnv({ id: "env_9", key: "S", value: undefined, type: "sensitive" })),
    });
    const input = revealEnv.inputSchema.parse({ project: "alpha", id: "env_9" });
    const result = (await revealEnv.handler(input as never, ctx(client))) as {
      value: string | null;
      decrypted: boolean;
      note?: string;
    };
    expect(result.value).toBeNull();
    expect(result.decrypted).toBe(false);
    expect(result.note).toContain("sensitive");
  });
});

// ------------------------------------------------------------------- set_env

const SECRET = "super-secret-value-9000";

describe("setEnv — metadata & validation", () => {
  it("has correct name and description", () => {
    expect(setEnv.name).toBe("set_env");
    expect(setEnv.description).toContain("confirm");
  });

  it("applies defaults (type=encrypted, confirm=false)", () => {
    const parsed = setEnv.inputSchema.parse({
      project: "alpha",
      key: "K",
      value: "v",
      target: ["production"],
    }) as { type: string; confirm: boolean };
    expect(parsed.type).toBe("encrypted");
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty target array", () => {
    expect(() =>
      setEnv.inputSchema.parse({ project: "alpha", key: "K", value: "v", target: [] }),
    ).toThrow();
  });

  it("rejects invalid target value", () => {
    expect(() =>
      setEnv.inputSchema.parse({
        project: "alpha",
        key: "K",
        value: "v",
        target: ["staging"],
      }),
    ).toThrow();
  });

  it("rejects invalid type value", () => {
    expect(() =>
      setEnv.inputSchema.parse({
        project: "alpha",
        key: "K",
        value: "v",
        target: ["production"],
        type: "bogus",
      }),
    ).toThrow();
  });
});

describe("setEnv — confirm gate & value redaction (M4)", () => {
  it("confirm omitted throws ConfirmRequiredError and does NOT call upsertProjectEnv", async () => {
    const client = makeClient();
    const input = setEnv.inputSchema.parse({
      project: "alpha",
      key: "DATABASE_URL",
      value: SECRET,
      target: ["production"],
    });
    let caught: unknown = null;
    try {
      await setEnv.handler(input as never, ctx(client));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    expect(client.upsertProjectEnv).not.toHaveBeenCalled();
  });

  it("preview REDACTS the value (shows key/target/type, never the secret)", async () => {
    const client = makeClient();
    const input = setEnv.inputSchema.parse({
      project: "alpha",
      key: "DATABASE_URL",
      value: SECRET,
      target: ["production", "preview"],
      type: "encrypted",
    });
    let caught: ConfirmRequiredError | null = null;
    try {
      await setEnv.handler(input as never, ctx(client));
    } catch (err) {
      caught = err as ConfirmRequiredError;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const preview = caught!.preview;
    expect(preview).not.toContain(SECRET);
    expect(preview).toContain("<redacted>");
    expect(preview).toContain("DATABASE_URL");
    expect(preview).toContain("production");
    expect(preview).toContain("encrypted");
  });

  it("confirm:true calls upsertProjectEnv and never returns the value", async () => {
    const client = makeClient();
    const input = setEnv.inputSchema.parse({
      project: "alpha",
      key: "DATABASE_URL",
      value: SECRET,
      target: ["production"],
      confirm: true,
    });
    const result = (await setEnv.handler(input as never, ctx(client))) as {
      action: string;
      changed: boolean;
    };
    expect(client.upsertProjectEnv).toHaveBeenCalledTimes(1);
    // upsert body carries the value, but the tool's OUTPUT must not
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.changed).toBe(true);
    expect(result.action).toBe("create");
  });
});

describe("setEnv — no-op short-circuit", () => {
  it("plain var with identical value/target/type short-circuits without a write", async () => {
    const client = makeClient({
      listProjectEnv: vi.fn().mockResolvedValue({
        envs: [
          makeEnv({
            id: "env_p",
            key: "FLAG",
            value: "on",
            type: "plain",
            target: ["production"],
            gitBranch: null,
          }),
        ],
      }),
    });
    const input = setEnv.inputSchema.parse({
      project: "alpha",
      key: "FLAG",
      value: "on",
      target: ["production"],
      type: "plain",
      confirm: false,
    });
    const result = (await setEnv.handler(input as never, ctx(client))) as {
      action: string;
      changed: boolean;
    };
    expect(result.action).toBe("noop");
    expect(result.changed).toBe(false);
    expect(client.upsertProjectEnv).not.toHaveBeenCalled();
  });

  it("existing var with a DIFFERENT plain value still requires confirm (not a no-op)", async () => {
    const client = makeClient({
      listProjectEnv: vi.fn().mockResolvedValue({
        envs: [
          makeEnv({
            id: "env_p",
            key: "FLAG",
            value: "off",
            type: "plain",
            target: ["production"],
          }),
        ],
      }),
    });
    const input = setEnv.inputSchema.parse({
      project: "alpha",
      key: "FLAG",
      value: "on",
      target: ["production"],
      type: "plain",
    });
    await expect(setEnv.handler(input as never, ctx(client))).rejects.toBeInstanceOf(
      ConfirmRequiredError,
    );
    expect(client.upsertProjectEnv).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ edit_env

describe("editEnv — metadata & validation", () => {
  it("has correct name", () => {
    expect(editEnv.name).toBe("edit_env");
    expect(editEnv.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects an edit with no mutable field (refine)", () => {
    expect(() => editEnv.inputSchema.parse({ project: "alpha", id: "env_1" })).toThrow();
  });

  it("accepts an edit that changes value", () => {
    const parsed = editEnv.inputSchema.parse({
      project: "alpha",
      id: "env_1",
      value: "new",
    }) as { confirm: boolean };
    expect(parsed.confirm).toBe(false);
  });
});

describe("editEnv — confirm gate, redaction, existence", () => {
  it("throws NotFoundError when the env id does not exist (before confirm)", async () => {
    const client = makeClient({
      listProjectEnv: vi.fn().mockResolvedValue({ envs: [makeEnv({ id: "env_1" })] }),
    });
    const input = editEnv.inputSchema.parse({
      project: "alpha",
      id: "does_not_exist",
      value: "x",
      confirm: true,
    });
    await expect(editEnv.handler(input as never, ctx(client))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(client.updateProjectEnv).not.toHaveBeenCalled();
  });

  it("confirm omitted throws ConfirmRequiredError with value redacted, no write", async () => {
    const client = makeClient({
      listProjectEnv: vi
        .fn()
        .mockResolvedValue({ envs: [makeEnv({ id: "env_1", key: "API_KEY" })] }),
    });
    const input = editEnv.inputSchema.parse({
      project: "alpha",
      id: "env_1",
      value: SECRET,
    });
    let caught: ConfirmRequiredError | null = null;
    try {
      await editEnv.handler(input as never, ctx(client));
    } catch (err) {
      caught = err as ConfirmRequiredError;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    expect(caught!.preview).not.toContain(SECRET);
    expect(caught!.preview).toContain("<redacted>");
    expect(caught!.preview).toContain("API_KEY");
    expect(client.updateProjectEnv).not.toHaveBeenCalled();
  });

  it("confirm:true applies the change and reports changed fields, never the value", async () => {
    const client = makeClient({
      listProjectEnv: vi
        .fn()
        .mockResolvedValue({ envs: [makeEnv({ id: "env_1", key: "API_KEY" })] }),
      updateProjectEnv: vi
        .fn()
        .mockResolvedValue(makeEnv({ id: "env_1", key: "API_KEY", type: "plain" })),
    });
    const input = editEnv.inputSchema.parse({
      project: "alpha",
      id: "env_1",
      value: SECRET,
      type: "plain",
      confirm: true,
    });
    const result = (await editEnv.handler(input as never, ctx(client))) as {
      changed: string[];
      key: string;
    };
    expect(client.updateProjectEnv).toHaveBeenCalledTimes(1);
    const body = client.updateProjectEnv.mock.calls[0][2];
    expect(body).toMatchObject({ value: SECRET, type: "plain" });
    expect(result.changed.sort()).toEqual(["type", "value"].sort());
    expect(result.key).toBe("API_KEY");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------- delete_env

describe("deleteEnv — metadata, gate, existence", () => {
  it("has correct name and validation", () => {
    expect(deleteEnv.name).toBe("delete_env");
    expect(() => deleteEnv.inputSchema.parse({ project: "alpha" })).toThrow();
    const parsed = deleteEnv.inputSchema.parse({ project: "alpha", id: "env_1" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("throws NotFoundError when the env id does not exist", async () => {
    const client = makeClient({
      listProjectEnv: vi.fn().mockResolvedValue({ envs: [makeEnv({ id: "env_1" })] }),
    });
    const input = deleteEnv.inputSchema.parse({
      project: "alpha",
      id: "missing",
      confirm: true,
    });
    await expect(deleteEnv.handler(input as never, ctx(client))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(client.deleteProjectEnv).not.toHaveBeenCalled();
  });

  it("confirm omitted throws ConfirmRequiredError and does NOT delete", async () => {
    const client = makeClient({
      listProjectEnv: vi
        .fn()
        .mockResolvedValue({ envs: [makeEnv({ id: "env_1", key: "OLD_KEY" })] }),
    });
    const input = deleteEnv.inputSchema.parse({ project: "alpha", id: "env_1" });
    let caught: ConfirmRequiredError | null = null;
    try {
      await deleteEnv.handler(input as never, ctx(client));
    } catch (err) {
      caught = err as ConfirmRequiredError;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    expect(caught!.preview).toContain("OLD_KEY");
    expect(client.deleteProjectEnv).not.toHaveBeenCalled();
  });

  it("confirm:true deletes by id and echoes the key", async () => {
    const client = makeClient({
      listProjectEnv: vi
        .fn()
        .mockResolvedValue({ envs: [makeEnv({ id: "env_1", key: "OLD_KEY" })] }),
    });
    const input = deleteEnv.inputSchema.parse({
      project: "alpha",
      id: "env_1",
      confirm: true,
    });
    const result = (await deleteEnv.handler(input as never, ctx(client))) as {
      deleted: boolean;
      key: string;
    };
    expect(client.deleteProjectEnv).toHaveBeenCalledWith("alpha", "env_1");
    expect(result.deleted).toBe(true);
    expect(result.key).toBe("OLD_KEY");
  });
});
