import { describe, it, expect, vi } from "vitest";
import {
  createFolderTool,
  createShortcutTool,
  generateIdsTool,
} from "../files-create.js";

type FakeClient = {
  createFolder: ReturnType<typeof vi.fn>;
  createShortcut: ReturnType<typeof vi.fn>;
  generateIds: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    createFolder: vi.fn(),
    createShortcut: vi.fn(),
    generateIds: vi.fn(),
    ...over,
  };
}

const rawFolder = {
  id: "folder_new",
  name: "Invoices",
  mimeType: "application/vnd.google-apps.folder",
  parents: ["root"],
};

describe("createFolderTool", () => {
  it("metadata: name + <=15-token description", () => {
    expect(createFolderTool.name).toBe("create_folder");
    expect(
      createFolderTool.description.split(/\s+/).length,
    ).toBeLessThanOrEqual(15);
  });

  it("calls createFolder and returns a slim file", async () => {
    const client = makeClient({
      createFolder: vi.fn().mockResolvedValue(rawFolder),
    });
    const parsed = createFolderTool.inputSchema.parse({
      name: "Invoices",
    }) as Parameters<typeof createFolderTool.handler>[0];

    const out = await createFolderTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.createFolder).toHaveBeenCalledWith({ name: "Invoices" });
    expect(out.file).toEqual({
      id: "folder_new",
      name: "Invoices",
      mime_type: "application/vnd.google-apps.folder",
      parents: ["root"],
      web_view_link: null,
      trashed: false,
      starred: false,
      size: null,
      modified_time: null,
    });
  });

  it("forwards parent_id as parentId", async () => {
    const client = makeClient({
      createFolder: vi.fn().mockResolvedValue(rawFolder),
    });
    const parsed = createFolderTool.inputSchema.parse({
      name: "Sub",
      parent_id: "folder_parent",
    }) as Parameters<typeof createFolderTool.handler>[0];

    await createFolderTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.createFolder).toHaveBeenCalledWith({
      name: "Sub",
      parentId: "folder_parent",
    });
  });

  it("requires name", () => {
    expect(() => createFolderTool.inputSchema.parse({})).toThrow();
  });
});

describe("createShortcutTool", () => {
  it("calls createShortcut with targetId + parentId", async () => {
    const client = makeClient({
      createShortcut: vi.fn().mockResolvedValue({ id: "shortcut_new" }),
    });
    const parsed = createShortcutTool.inputSchema.parse({
      name: "link",
      target_id: "file_target",
      parent_id: "folder_parent",
    }) as Parameters<typeof createShortcutTool.handler>[0];

    const out = await createShortcutTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.createShortcut).toHaveBeenCalledWith({
      name: "link",
      targetId: "file_target",
      parentId: "folder_parent",
    });
    expect(out.file.id).toBe("shortcut_new");
  });

  it("requires name and target_id", () => {
    expect(() => createShortcutTool.inputSchema.parse({ name: "x" })).toThrow();
  });
});

describe("generateIdsTool", () => {
  it("count defaults to 10", () => {
    const parsed = generateIdsTool.inputSchema.parse({}) as { count: number };
    expect(parsed.count).toBe(10);
  });

  it("calls generateIds with the parsed count and returns ids", async () => {
    const client = makeClient({
      generateIds: vi.fn().mockResolvedValue({ ids: ["id1", "id2"] }),
    });
    const parsed = generateIdsTool.inputSchema.parse({
      count: 2,
    }) as Parameters<typeof generateIdsTool.handler>[0];

    const out = await generateIdsTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.generateIds).toHaveBeenCalledWith({ count: 2 });
    expect(out).toEqual({ ids: ["id1", "id2"] });
  });
});
