import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import {
  shareTool,
  listPermissionsTool,
  updatePermissionTool,
  unshareTool,
} from "../permissions.js";

type FakeClient = {
  createPermission: ReturnType<typeof vi.fn>;
  listPermissions: ReturnType<typeof vi.fn>;
  updatePermission: ReturnType<typeof vi.fn>;
  deletePermission: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    createPermission: vi.fn(),
    listPermissions: vi.fn(),
    updatePermission: vi.fn(),
    deletePermission: vi.fn(),
    ...over,
  };
}

const userPerm = {
  id: "perm_new",
  type: "user",
  role: "writer",
  emailAddress: "bob@example.test",
};

// =============================================================================
// share
// =============================================================================

describe("shareTool — metadata + schema", () => {
  it("name + <=15-token description", () => {
    expect(shareTool.name).toBe("share");
    expect(shareTool.description.split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  it("confirm defaults false, transfer_ownership defaults false", () => {
    const parsed = shareTool.inputSchema.parse({
      file_id: "f",
      role: "reader",
      type: "user",
      email_address: "a@example.test",
    }) as { confirm: boolean; transfer_ownership: boolean };
    expect(parsed.confirm).toBe(false);
    expect(parsed.transfer_ownership).toBe(false);
  });
});

describe("shareTool — scope-shape validation", () => {
  it("requires email_address for type user", async () => {
    const client = makeClient();
    const parsed = shareTool.inputSchema.parse({
      file_id: "f",
      role: "reader",
      type: "user",
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];
    await expect(
      shareTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires domain for type domain", async () => {
    const client = makeClient();
    const parsed = shareTool.inputSchema.parse({
      file_id: "f",
      role: "reader",
      type: "domain",
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];
    await expect(
      shareTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects email/domain for type anyone", async () => {
    const client = makeClient();
    const parsed = shareTool.inputSchema.parse({
      file_id: "f",
      role: "reader",
      type: "anyone",
      email_address: "a@example.test",
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];
    await expect(
      shareTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("shareTool — confirm gate + exposure preview", () => {
  it("requires confirm and previews the exact grant", async () => {
    const client = makeClient();
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "writer",
      type: "user",
      email_address: "bob@example.test",
    }) as Parameters<typeof shareTool.handler>[0];

    await expect(
      shareTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toMatchObject({
      name: "ConfirmRequiredError",
      preview: expect.stringContaining("writer"),
    });
    expect(client.createPermission).not.toHaveBeenCalled();
  });

  it("HARD-warns in the preview for type anyone (public)", async () => {
    const client = makeClient();
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "reader",
      type: "anyone",
    }) as Parameters<typeof shareTool.handler>[0];

    await expect(
      shareTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toMatchObject({
      preview: expect.stringMatching(/public|world/i),
    });
  });

  it("HARD-warns in the preview for role owner (ownership transfer)", async () => {
    const client = makeClient();
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "owner",
      type: "user",
      email_address: "bob@example.test",
    }) as Parameters<typeof shareTool.handler>[0];

    await expect(
      shareTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toMatchObject({
      preview: expect.stringMatching(/ownership/i),
    });
  });
});

describe("shareTool — confirmed handler", () => {
  it("user share: notifications default ON, no transferOwnership", async () => {
    const client = makeClient({
      createPermission: vi.fn().mockResolvedValue(userPerm),
    });
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "writer",
      type: "user",
      email_address: "bob@example.test",
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];

    const out = await shareTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.createPermission).toHaveBeenCalledWith("file_alpha", {
      role: "writer",
      type: "user",
      emailAddress: "bob@example.test",
      sendNotificationEmail: true,
    });
    expect(out.permission).toEqual({
      id: "perm_new",
      type: "user",
      role: "writer",
      email_address: "bob@example.test",
      domain: null,
    });
  });

  it("anyone share: notifications default OFF (non-user type)", async () => {
    const client = makeClient({
      createPermission: vi
        .fn()
        .mockResolvedValue({ id: "anyoneWithLink", type: "anyone", role: "reader" }),
    });
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "reader",
      type: "anyone",
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];

    await shareTool.handler(parsed, { client: client as unknown as never });

    expect(client.createPermission).toHaveBeenCalledWith("file_alpha", {
      role: "reader",
      type: "anyone",
      sendNotificationEmail: false,
    });
  });

  it("owner share: forces transferOwnership true", async () => {
    const client = makeClient({
      createPermission: vi
        .fn()
        .mockResolvedValue({ id: "perm_o", type: "user", role: "owner" }),
    });
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "owner",
      type: "user",
      email_address: "bob@example.test",
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];

    await shareTool.handler(parsed, { client: client as unknown as never });

    expect(client.createPermission).toHaveBeenCalledWith(
      "file_alpha",
      expect.objectContaining({ transferOwnership: true }),
    );
  });

  it("honors an explicit send_notification_email override", async () => {
    const client = makeClient({
      createPermission: vi.fn().mockResolvedValue(userPerm),
    });
    const parsed = shareTool.inputSchema.parse({
      file_id: "file_alpha",
      role: "reader",
      type: "user",
      email_address: "bob@example.test",
      send_notification_email: false,
      confirm: true,
    }) as Parameters<typeof shareTool.handler>[0];

    await shareTool.handler(parsed, { client: client as unknown as never });

    expect(client.createPermission).toHaveBeenCalledWith(
      "file_alpha",
      expect.objectContaining({ sendNotificationEmail: false }),
    );
  });
});

// =============================================================================
// list_permissions
// =============================================================================

describe("listPermissionsTool", () => {
  it("maps each permission to the slim shape", async () => {
    const client = makeClient({
      listPermissions: vi.fn().mockResolvedValue([
        userPerm,
        { id: "anyoneWithLink", type: "anyone", role: "reader" },
      ]),
    });
    const parsed = listPermissionsTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof listPermissionsTool.handler>[0];

    const out = await listPermissionsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listPermissions).toHaveBeenCalledWith("file_alpha");
    expect(out.permissions).toHaveLength(2);
    expect(out.permissions[1]).toEqual({
      id: "anyoneWithLink",
      type: "anyone",
      role: "reader",
      email_address: null,
      domain: null,
    });
  });
});

// =============================================================================
// update_permission
// =============================================================================

describe("updatePermissionTool", () => {
  it("plain role downgrade is NOT gated", async () => {
    const client = makeClient({
      updatePermission: vi
        .fn()
        .mockResolvedValue({ id: "perm_a", type: "user", role: "reader" }),
    });
    const parsed = updatePermissionTool.inputSchema.parse({
      file_id: "file_alpha",
      permission_id: "perm_a",
      role: "reader",
    }) as Parameters<typeof updatePermissionTool.handler>[0];

    const out = await updatePermissionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.updatePermission).toHaveBeenCalledWith(
      "file_alpha",
      "perm_a",
      { role: "reader" },
    );
    expect(out.permission.role).toBe("reader");
  });

  it("elevating to owner is confirm-gated with an ownership warning", async () => {
    const client = makeClient();
    const parsed = updatePermissionTool.inputSchema.parse({
      file_id: "file_alpha",
      permission_id: "perm_a",
      role: "owner",
    }) as Parameters<typeof updatePermissionTool.handler>[0];

    await expect(
      updatePermissionTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toMatchObject({
      name: "ConfirmRequiredError",
      preview: expect.stringMatching(/ownership/i),
    });
    expect(client.updatePermission).not.toHaveBeenCalled();
  });

  it("owner change with confirm forces transferOwnership true", async () => {
    const client = makeClient({
      updatePermission: vi
        .fn()
        .mockResolvedValue({ id: "perm_a", type: "user", role: "owner" }),
    });
    const parsed = updatePermissionTool.inputSchema.parse({
      file_id: "file_alpha",
      permission_id: "perm_a",
      role: "owner",
      confirm: true,
    }) as Parameters<typeof updatePermissionTool.handler>[0];

    await updatePermissionTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.updatePermission).toHaveBeenCalledWith(
      "file_alpha",
      "perm_a",
      { role: "owner", transferOwnership: true },
    );
  });

  it("transfer_ownership flag alone gates even for a non-owner role", async () => {
    const client = makeClient();
    const parsed = updatePermissionTool.inputSchema.parse({
      file_id: "file_alpha",
      permission_id: "perm_a",
      role: "writer",
      transfer_ownership: true,
    }) as Parameters<typeof updatePermissionTool.handler>[0];

    await expect(
      updatePermissionTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toMatchObject({ name: "ConfirmRequiredError" });
  });
});

// =============================================================================
// unshare
// =============================================================================

describe("unshareTool", () => {
  it("deletes the permission (not gated)", async () => {
    const client = makeClient({
      deletePermission: vi.fn().mockResolvedValue(undefined),
    });
    const parsed = unshareTool.inputSchema.parse({
      file_id: "file_alpha",
      permission_id: "perm_a",
    }) as Parameters<typeof unshareTool.handler>[0];

    const out = await unshareTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.deletePermission).toHaveBeenCalledWith("file_alpha", "perm_a");
    expect(out).toEqual({ unshared: true });
  });
});
