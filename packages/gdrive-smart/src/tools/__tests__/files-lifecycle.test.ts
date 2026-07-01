import { describe, it, expect, vi } from "vitest";
import {
  trashTool,
  restoreTool,
  deleteTool,
  emptyTrashTool,
} from "../files-lifecycle.js";

type FakeClient = {
  updateFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  emptyTrash: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    updateFile: vi.fn(),
    deleteFile: vi.fn(),
    emptyTrash: vi.fn(),
    listFiles: vi.fn(),
    ...over,
  };
}

const rawFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "file_alpha",
  name: "doc.txt",
  mimeType: "text/plain",
  ...over,
});

describe("trashTool", () => {
  it("description marks it recoverable", () => {
    expect(trashTool.description).toContain("recoverable");
  });

  it("is NOT confirm-gated — trashes immediately (reversible)", async () => {
    const client = makeClient({
      updateFile: vi.fn().mockResolvedValue(rawFile({ trashed: true })),
    });
    const parsed = trashTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof trashTool.handler>[0];

    const out = await trashTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.updateFile).toHaveBeenCalledWith("file_alpha", {
      trashed: true,
    });
    expect(out.file.trashed).toBe(true);
  });
});

describe("restoreTool", () => {
  it("sets trashed:false", async () => {
    const client = makeClient({
      updateFile: vi.fn().mockResolvedValue(rawFile({ trashed: false })),
    });
    const parsed = restoreTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof restoreTool.handler>[0];

    await restoreTool.handler(parsed, { client: client as unknown as never });
    expect(client.updateFile).toHaveBeenCalledWith("file_alpha", {
      trashed: false,
    });
  });
});

describe("deleteTool — hard confirm gate", () => {
  it("confirm defaults to false", () => {
    const parsed = deleteTool.inputSchema.parse({ file_id: "x" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("throws ConfirmRequiredError naming the file id + irreversibility", async () => {
    const client = makeClient();
    const parsed = deleteTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof deleteTool.handler>[0];

    await expect(
      deleteTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toMatchObject({
      name: "ConfirmRequiredError",
      preview: expect.stringContaining("file_alpha"),
    });
    await expect(
      deleteTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toMatchObject({
      preview: expect.stringMatching(/cannot be undone/i),
    });
    expect(client.deleteFile).not.toHaveBeenCalled();
  });

  it("deletes when confirm=true", async () => {
    const client = makeClient({
      deleteFile: vi.fn().mockResolvedValue(undefined),
    });
    const parsed = deleteTool.inputSchema.parse({
      file_id: "file_alpha",
      confirm: true,
    }) as Parameters<typeof deleteTool.handler>[0];

    const out = await deleteTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.deleteFile).toHaveBeenCalledWith("file_alpha");
    expect(out).toEqual({ deleted: true });
  });
});

describe("emptyTrashTool — dry_run default true", () => {
  it("dry_run defaults to true, confirm to false", () => {
    const parsed = emptyTrashTool.inputSchema.parse({}) as {
      dry_run: boolean;
      confirm: boolean;
    };
    expect(parsed.dry_run).toBe(true);
    expect(parsed.confirm).toBe(false);
  });

  it("dry_run lists trashed files and returns them WITHOUT deleting", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({
        files: [rawFile({ id: "t1" }), rawFile({ id: "t2" })],
      }),
    });
    const parsed = emptyTrashTool.inputSchema.parse({}) as Parameters<
      typeof emptyTrashTool.handler
    >[0];

    const out = await emptyTrashTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listFiles).toHaveBeenCalledWith({
      q: "trashed=true",
      pageSize: 100,
    });
    expect(client.emptyTrash).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dry_run: true, count: 2 });
    if ("would_delete" in out) {
      expect(out.would_delete).toHaveLength(2);
    }
  });

  it("dry_run=false but no confirm -> ConfirmRequiredError with a count preview", async () => {
    const client = makeClient({
      listFiles: vi
        .fn()
        .mockResolvedValue({ files: [rawFile({ id: "t1" })] }),
    });
    const parsed = emptyTrashTool.inputSchema.parse({
      dry_run: false,
    }) as Parameters<typeof emptyTrashTool.handler>[0];

    await expect(
      emptyTrashTool.handler(parsed, { client: client as unknown as never }),
    ).rejects.toMatchObject({
      name: "ConfirmRequiredError",
      preview: expect.stringContaining("1 trashed file"),
    });
    expect(client.emptyTrash).not.toHaveBeenCalled();
  });

  it("dry_run=false AND confirm=true empties the trash", async () => {
    const client = makeClient({
      listFiles: vi
        .fn()
        .mockResolvedValue({ files: [rawFile({ id: "t1" })] }),
      emptyTrash: vi.fn().mockResolvedValue(undefined),
    });
    const parsed = emptyTrashTool.inputSchema.parse({
      dry_run: false,
      confirm: true,
    }) as Parameters<typeof emptyTrashTool.handler>[0];

    const out = await emptyTrashTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.emptyTrash).toHaveBeenCalled();
    expect(out).toEqual({ emptied: true, deleted_count: 1 });
  });

  it("dry_run wins over confirm (confirm ignored while dry_run true)", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
    });
    const parsed = emptyTrashTool.inputSchema.parse({
      confirm: true,
    }) as Parameters<typeof emptyTrashTool.handler>[0];

    const out = await emptyTrashTool.handler(parsed, {
      client: client as unknown as never,
    });
    expect(client.emptyTrash).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dry_run: true });
  });
});
