import { describe, it, expect, vi } from "vitest";
import { ValidationError } from "smart-mcp-core";
import {
  renameTool,
  moveTool,
  starTool,
  updateMetadataTool,
  copyTool,
} from "../files-organize.js";

type FakeClient = {
  updateFile: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
  copyFile: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    updateFile: vi.fn(),
    getFile: vi.fn(),
    copyFile: vi.fn(),
    ...over,
  };
}

const rawFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "file_alpha",
  name: "doc.txt",
  mimeType: "text/plain",
  parents: ["folder_old"],
  ...over,
});

describe("renameTool", () => {
  it("calls updateFile with the new name", async () => {
    const client = makeClient({
      updateFile: vi.fn().mockResolvedValue(rawFile({ name: "new.txt" })),
    });
    const parsed = renameTool.inputSchema.parse({
      file_id: "file_alpha",
      name: "new.txt",
    }) as Parameters<typeof renameTool.handler>[0];

    const out = await renameTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.updateFile).toHaveBeenCalledWith("file_alpha", {
      name: "new.txt",
    });
    expect(out.file.name).toBe("new.txt");
  });
});

describe("moveTool", () => {
  it("auto-detects current parents via getFile and removes them", async () => {
    const client = makeClient({
      getFile: vi.fn().mockResolvedValue(rawFile({ parents: ["folder_old"] })),
      updateFile: vi
        .fn()
        .mockResolvedValue(rawFile({ parents: ["folder_new"] })),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
    }) as Parameters<typeof moveTool.handler>[0];

    const out = await moveTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.getFile).toHaveBeenCalledWith("file_alpha");
    expect(client.updateFile).toHaveBeenCalledWith(
      "file_alpha",
      {},
      { addParents: "folder_new", removeParents: "folder_old" },
    );
    expect(out.file.parents).toEqual(["folder_new"]);
  });

  it("validates an explicit remove_parent IS a current parent, then moves (M5)", async () => {
    const client = makeClient({
      getFile: vi
        .fn()
        .mockResolvedValue(
          rawFile({ parents: ["folder_specific", "folder_other"] }),
        ),
      updateFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
      remove_parent: "folder_specific",
    }) as Parameters<typeof moveTool.handler>[0];

    await moveTool.handler(parsed, { client: client as unknown as never });

    expect(client.getFile).toHaveBeenCalledWith("file_alpha");
    expect(client.updateFile).toHaveBeenCalledWith(
      "file_alpha",
      {},
      { addParents: "folder_new", removeParents: "folder_specific" },
    );
  });

  it("rejects an explicit remove_parent that is NOT a current parent (M5)", async () => {
    const client = makeClient({
      getFile: vi
        .fn()
        .mockResolvedValue(rawFile({ parents: ["folder_old"] })),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
      remove_parent: "folder_ghost",
    }) as Parameters<typeof moveTool.handler>[0];

    await expect(
      moveTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.updateFile).not.toHaveBeenCalled();
  });

  it("rejects moving a file the caller cannot edit (shared, not owned)", async () => {
    const client = makeClient({
      getFile: vi
        .fn()
        .mockResolvedValue(rawFile({ capabilities: { canEdit: false } })),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
    }) as Parameters<typeof moveTool.handler>[0];

    await expect(
      moveTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.updateFile).not.toHaveBeenCalled();
  });

  it("auto-detect DROPS new_parent from removeParents when already a parent (M5)", async () => {
    const client = makeClient({
      getFile: vi
        .fn()
        .mockResolvedValue(rawFile({ parents: ["folder_new", "folder_old"] })),
      updateFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
    }) as Parameters<typeof moveTool.handler>[0];

    await moveTool.handler(parsed, { client: client as unknown as never });

    // never add==remove: only the OTHER parent is removed.
    expect(client.updateFile).toHaveBeenCalledWith(
      "file_alpha",
      {},
      { addParents: "folder_new", removeParents: "folder_old" },
    );
  });

  it("auto-detect omits removeParents when new_parent is the only parent (M5)", async () => {
    const client = makeClient({
      getFile: vi
        .fn()
        .mockResolvedValue(rawFile({ parents: ["folder_new"] })),
      updateFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
    }) as Parameters<typeof moveTool.handler>[0];

    await moveTool.handler(parsed, { client: client as unknown as never });

    expect(client.updateFile).toHaveBeenCalledWith(
      "file_alpha",
      {},
      { addParents: "folder_new" },
    );
  });

  it("omits removeParents when the file has no current parents", async () => {
    const client = makeClient({
      getFile: vi.fn().mockResolvedValue(rawFile({ parents: [] })),
      updateFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = moveTool.inputSchema.parse({
      file_id: "file_alpha",
      new_parent: "folder_new",
    }) as Parameters<typeof moveTool.handler>[0];

    await moveTool.handler(parsed, { client: client as unknown as never });

    expect(client.updateFile).toHaveBeenCalledWith(
      "file_alpha",
      {},
      { addParents: "folder_new" },
    );
  });
});

describe("starTool", () => {
  it("starred defaults to true", () => {
    const parsed = starTool.inputSchema.parse({ file_id: "x" }) as {
      starred: boolean;
    };
    expect(parsed.starred).toBe(true);
  });

  it("stars a file by default", async () => {
    const client = makeClient({
      updateFile: vi.fn().mockResolvedValue(rawFile({ starred: true })),
    });
    const parsed = starTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof starTool.handler>[0];

    await starTool.handler(parsed, { client: client as unknown as never });
    expect(client.updateFile).toHaveBeenCalledWith("file_alpha", {
      starred: true,
    });
  });

  it("unstars when starred=false", async () => {
    const client = makeClient({
      updateFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = starTool.inputSchema.parse({
      file_id: "file_alpha",
      starred: false,
    }) as Parameters<typeof starTool.handler>[0];

    await starTool.handler(parsed, { client: client as unknown as never });
    expect(client.updateFile).toHaveBeenCalledWith("file_alpha", {
      starred: false,
    });
  });
});

describe("updateMetadataTool", () => {
  it("builds a body with only the supplied fields", async () => {
    const client = makeClient({
      updateFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = updateMetadataTool.inputSchema.parse({
      file_id: "file_alpha",
      name: "new",
      description: "final",
    }) as Parameters<typeof updateMetadataTool.handler>[0];

    await updateMetadataTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.updateFile).toHaveBeenCalledWith("file_alpha", {
      name: "new",
      description: "final",
    });
  });

  it("rejects an empty update (no fields)", async () => {
    const client = makeClient();
    const parsed = updateMetadataTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof updateMetadataTool.handler>[0];

    await expect(
      updateMetadataTool.handler(parsed, {
        client: client as unknown as never,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.updateFile).not.toHaveBeenCalled();
  });
});

describe("copyTool", () => {
  it("copies a plain file (name + parent forwarded)", async () => {
    const client = makeClient({
      getFile: vi.fn().mockResolvedValue(rawFile({ mimeType: "text/plain" })),
      copyFile: vi.fn().mockResolvedValue(rawFile({ id: "file_copy" })),
    });
    const parsed = copyTool.inputSchema.parse({
      file_id: "file_alpha",
      name: "Copy",
      parent_id: "folder_dest",
    }) as Parameters<typeof copyTool.handler>[0];

    const out = await copyTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.copyFile).toHaveBeenCalledWith("file_alpha", {
      name: "Copy",
      parentId: "folder_dest",
    });
    expect(out.file.id).toBe("file_copy");
  });

  it("rejects copying a folder with a clear message", async () => {
    const client = makeClient({
      getFile: vi
        .fn()
        .mockResolvedValue(
          rawFile({ mimeType: "application/vnd.google-apps.folder" }),
        ),
    });
    const parsed = copyTool.inputSchema.parse({
      file_id: "folder_alpha",
    }) as Parameters<typeof copyTool.handler>[0];

    await expect(
      copyTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.copyFile).not.toHaveBeenCalled();
  });
});
