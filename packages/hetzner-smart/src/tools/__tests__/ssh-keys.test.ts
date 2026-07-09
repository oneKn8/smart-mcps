import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, NotFoundError } from "smart-mcp-core";
import {
  listSshKeys,
  getSshKey,
  createSshKey,
  deleteSshKey,
} from "../ssh-keys.js";

// A full upstream SSH key carrying extras the slim mapper must strip.
const sampleKey = {
  id: 2323,
  name: "laptop-key",
  fingerprint: "b7:2f:0e:11:aa:cc:dd:ee:01:23:45:67:89:ab:cd:ef",
  labels: { env: "prod" },
  // Upstream-only fields the slim mapper must strip:
  public_key: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB laptop-key",
  created: "2026-05-01T00:00:00.000Z",
};

type FakeSshClient = {
  listSshKeys: ReturnType<typeof vi.fn>;
  getSshKey: ReturnType<typeof vi.fn>;
  createSshKey: ReturnType<typeof vi.fn>;
  deleteSshKey: ReturnType<typeof vi.fn>;
};

function makeCtx(
  overrides: Partial<FakeSshClient> = {},
): { client: never } {
  const client: FakeSshClient = {
    listSshKeys: vi.fn().mockResolvedValue({ ssh_keys: [sampleKey], meta: {} }),
    getSshKey: vi.fn().mockResolvedValue(sampleKey),
    createSshKey: vi.fn().mockResolvedValue({ ssh_key: sampleKey }),
    deleteSshKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { client: client as unknown as never };
}

const SLIM_KEYS = ["id", "name", "fingerprint", "labels"].sort();

// =============================================================================
// list_ssh_keys
// =============================================================================

describe("listSshKeys — metadata + schema", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listSshKeys.name).toBe("list_ssh_keys");
    expect(listSshKeys.description).toBeTruthy();
    expect(listSshKeys.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listSshKeys.inputSchema.parse({})).not.toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() => listSshKeys.inputSchema.parse({ name: 123 })).toThrow();
  });
});

describe("listSshKeys — handler", () => {
  it("forwards only provided filters to the client", async () => {
    const ctx = makeCtx();
    await listSshKeys.handler(
      listSshKeys.inputSchema.parse({ name: "laptop-key" }),
      ctx,
    );
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.listSshKeys).toHaveBeenCalledTimes(1);
    expect(client.listSshKeys).toHaveBeenCalledWith({ name: "laptop-key" });
  });

  it("passes label_selector through and omits absent name", async () => {
    const ctx = makeCtx();
    await listSshKeys.handler(
      listSshKeys.inputSchema.parse({ label_selector: "env=prod" }),
      ctx,
    );
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.listSshKeys).toHaveBeenCalledWith({
      label_selector: "env=prod",
    });
  });

  it("maps over body.ssh_keys and strips upstream extras", async () => {
    const ctx = makeCtx();
    const result = (await listSshKeys.handler(
      listSshKeys.inputSchema.parse({}),
      ctx,
    )) as { ssh_keys: Array<Record<string, unknown>>; count: number };

    expect(result.ssh_keys).toHaveLength(1);
    expect(result.count).toBe(1);
    const slim = result.ssh_keys[0]!;
    expect(Object.keys(slim).sort()).toEqual(SLIM_KEYS);
    expect(slim).toEqual({
      id: 2323,
      name: "laptop-key",
      fingerprint: "b7:2f:0e:11:aa:cc:dd:ee:01:23:45:67:89:ab:cd:ef",
      labels: { env: "prod" },
    });
    expect(slim).not.toHaveProperty("public_key");
    expect(slim).not.toHaveProperty("created");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const ctx = makeCtx({
      listSshKeys: vi.fn().mockResolvedValue({ ssh_keys: [{ id: 7 }] }),
    });
    const result = (await listSshKeys.handler(
      listSshKeys.inputSchema.parse({}),
      ctx,
    )) as { ssh_keys: SlimShape[] };
    const slim = result.ssh_keys[0]!;
    expect(slim.id).toBe(7);
    expect(slim.name).toBe("");
    expect(slim.fingerprint).toBeNull();
    expect(slim.labels).toEqual({});
  });

  it("returns an empty list with count 0 when body.ssh_keys is not an array", async () => {
    const ctx = makeCtx({
      listSshKeys: vi.fn().mockResolvedValue({ meta: {} }),
    });
    const result = (await listSshKeys.handler(
      listSshKeys.inputSchema.parse({}),
      ctx,
    )) as { ssh_keys: unknown[]; count: number };
    expect(result.ssh_keys).toEqual([]);
    expect(result.count).toBe(0);
  });
});

type SlimShape = {
  id: number;
  name: string;
  fingerprint: string | null;
  labels: Record<string, string>;
};

// =============================================================================
// get_ssh_key
// =============================================================================

describe("getSshKey — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(getSshKey.name).toBe("get_ssh_key");
    expect(getSshKey.description).toBeTruthy();
    expect(getSshKey.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects a non-integer id", () => {
    expect(() => getSshKey.inputSchema.parse({ ssh_key_id: 1.5 })).toThrow();
  });

  it("rejects a non-positive id", () => {
    expect(() => getSshKey.inputSchema.parse({ ssh_key_id: 0 })).toThrow();
  });

  it("rejects a string id", () => {
    expect(() => getSshKey.inputSchema.parse({ ssh_key_id: "2323" })).toThrow();
  });
});

describe("getSshKey — handler", () => {
  it("calls client.getSshKey with the numeric id", async () => {
    const ctx = makeCtx();
    await getSshKey.handler(getSshKey.inputSchema.parse({ ssh_key_id: 2323 }), ctx);
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.getSshKey).toHaveBeenCalledTimes(1);
    expect(client.getSshKey).toHaveBeenCalledWith(2323);
  });

  it("maps the unwrapped key to the slim shape only", async () => {
    const ctx = makeCtx();
    const result = (await getSshKey.handler(
      getSshKey.inputSchema.parse({ ssh_key_id: 2323 }),
      ctx,
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).not.toHaveProperty("public_key");
    expect(result).not.toHaveProperty("created");
  });

  it("propagates NotFoundError from the client", async () => {
    const ctx = makeCtx({
      getSshKey: vi
        .fn()
        .mockRejectedValue(new NotFoundError("SSH key not found: 9")),
    });
    await expect(
      getSshKey.handler(getSshKey.inputSchema.parse({ ssh_key_id: 9 }), ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// =============================================================================
// create_ssh_key
// =============================================================================

describe("createSshKey — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(createSshKey.name).toBe("create_ssh_key");
    expect(createSshKey.description).toBeTruthy();
    expect(createSshKey.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects an empty name", () => {
    expect(() =>
      createSshKey.inputSchema.parse({ name: "", public_key: "ssh-rsa AAA" }),
    ).toThrow();
  });

  it("rejects an empty public_key", () => {
    expect(() =>
      createSshKey.inputSchema.parse({ name: "k", public_key: "" }),
    ).toThrow();
  });
});

describe("createSshKey — handler", () => {
  it("forwards name and public_key, omitting labels when absent", async () => {
    const ctx = makeCtx();
    await createSshKey.handler(
      createSshKey.inputSchema.parse({
        name: "laptop-key",
        public_key: "ssh-rsa AAAAB3 laptop-key",
      }),
      ctx,
    );
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.createSshKey).toHaveBeenCalledTimes(1);
    expect(client.createSshKey).toHaveBeenCalledWith({
      name: "laptop-key",
      public_key: "ssh-rsa AAAAB3 laptop-key",
    });
  });

  it("forwards labels when provided", async () => {
    const ctx = makeCtx();
    await createSshKey.handler(
      createSshKey.inputSchema.parse({
        name: "laptop-key",
        public_key: "ssh-rsa AAAAB3 laptop-key",
        labels: { env: "prod" },
      }),
      ctx,
    );
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.createSshKey).toHaveBeenCalledWith({
      name: "laptop-key",
      public_key: "ssh-rsa AAAAB3 laptop-key",
      labels: { env: "prod" },
    });
  });

  it("pulls body.ssh_key and returns the slim shape only", async () => {
    const ctx = makeCtx();
    const result = (await createSshKey.handler(
      createSshKey.inputSchema.parse({
        name: "laptop-key",
        public_key: "ssh-rsa AAAAB3 laptop-key",
      }),
      ctx,
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(SLIM_KEYS);
    expect(result).toEqual({
      id: 2323,
      name: "laptop-key",
      fingerprint: "b7:2f:0e:11:aa:cc:dd:ee:01:23:45:67:89:ab:cd:ef",
      labels: { env: "prod" },
    });
  });
});

// =============================================================================
// delete_ssh_key
// =============================================================================

describe("deleteSshKey — metadata + schema", () => {
  it("has correct name and description", () => {
    expect(deleteSshKey.name).toBe("delete_ssh_key");
    expect(deleteSshKey.description).toBeTruthy();
    expect(deleteSshKey.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("defaults confirm to false when omitted", () => {
    const parsed = deleteSshKey.inputSchema.parse({ ssh_key_id: 2323 }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects a non-positive id", () => {
    expect(() =>
      deleteSshKey.inputSchema.parse({ ssh_key_id: 0, confirm: true }),
    ).toThrow();
  });
});

describe("deleteSshKey — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is false (default)", async () => {
    const ctx = makeCtx();
    await expect(
      deleteSshKey.handler(deleteSshKey.inputSchema.parse({ ssh_key_id: 2323 }), ctx),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.deleteSshKey).not.toHaveBeenCalled();
  });

  it("preview names the fetched key and its id", async () => {
    const ctx = makeCtx();
    try {
      await deleteSshKey.handler(
        deleteSshKey.inputSchema.parse({ ssh_key_id: 2323 }),
        ctx,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("laptop-key");
      expect(preview).toContain("2323");
      expect(preview).toMatch(/delete/i);
    }
  });
});

describe("deleteSshKey — past confirm gate", () => {
  it("with confirm: true deletes and returns the slim confirmation", async () => {
    const ctx = makeCtx();
    const result = (await deleteSshKey.handler(
      deleteSshKey.inputSchema.parse({ ssh_key_id: 2323, confirm: true }),
      ctx,
    )) as { ssh_key_id: number; deleted: boolean };
    const client = ctx.client as unknown as FakeSshClient;
    expect(client.deleteSshKey).toHaveBeenCalledWith(2323);
    expect(Object.keys(result).sort()).toEqual(
      ["ssh_key_id", "deleted"].sort(),
    );
    expect(result).toEqual({ ssh_key_id: 2323, deleted: true });
  });

  it("propagates NotFoundError from the client", async () => {
    const ctx = makeCtx({
      getSshKey: vi
        .fn()
        .mockRejectedValue(new NotFoundError("SSH key not found: 9")),
    });
    await expect(
      deleteSshKey.handler(
        deleteSshKey.inputSchema.parse({ ssh_key_id: 9, confirm: true }),
        ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
