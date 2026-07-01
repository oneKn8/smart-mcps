import { describe, it, expect, vi } from "vitest";
import { getTool, listTool } from "../files-read.js";

type FakeClient = {
  getFile: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
};

function makeClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    getFile: vi.fn(),
    listFiles: vi.fn(),
    ...over,
  };
}

const rawFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "file_alpha",
  name: "doc.txt",
  mimeType: "text/plain",
  parents: ["folder_x"],
  ...over,
});

describe("getTool", () => {
  it("calls getFile and returns a slim file", async () => {
    const client = makeClient({
      getFile: vi.fn().mockResolvedValue(rawFile()),
    });
    const parsed = getTool.inputSchema.parse({
      file_id: "file_alpha",
    }) as Parameters<typeof getTool.handler>[0];

    const out = await getTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.getFile).toHaveBeenCalledWith("file_alpha");
    expect(out.file.id).toBe("file_alpha");
    expect(out.file.parents).toEqual(["folder_x"]);
  });
});

describe("listTool", () => {
  it("builds a folder-children q from folder_id", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({ files: [rawFile()] }),
    });
    const parsed = listTool.inputSchema.parse({
      folder_id: "folder_x",
    }) as Parameters<typeof listTool.handler>[0];

    await listTool.handler(parsed, { client: client as unknown as never });

    expect(client.listFiles).toHaveBeenCalledWith({
      q: "'folder_x' in parents and trashed = false",
    });
  });

  it("free-form q takes precedence over folder_id", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
    });
    const parsed = listTool.inputSchema.parse({
      folder_id: "folder_x",
      q: "name contains 'invoice'",
    }) as Parameters<typeof listTool.handler>[0];

    await listTool.handler(parsed, { client: client as unknown as never });

    expect(client.listFiles).toHaveBeenCalledWith({
      q: "name contains 'invoice'",
    });
  });

  it("forwards page_size/page_token and surfaces next_page_token", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({
        files: [rawFile()],
        nextPageToken: "tok_next",
      }),
    });
    const parsed = listTool.inputSchema.parse({
      page_size: 50,
      page_token: "tok_in",
    }) as Parameters<typeof listTool.handler>[0];

    const out = await listTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(client.listFiles).toHaveBeenCalledWith({
      pageSize: 50,
      pageToken: "tok_in",
    });
    expect(out.files).toHaveLength(1);
    expect(out.next_page_token).toBe("tok_next");
  });

  it("omits next_page_token when absent and maps rows to slim files", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({ files: [rawFile()] }),
    });
    const parsed = listTool.inputSchema.parse({}) as Parameters<
      typeof listTool.handler
    >[0];

    const out = await listTool.handler(parsed, {
      client: client as unknown as never,
    });

    expect(out.next_page_token).toBeUndefined();
    expect(out.files[0]).toMatchObject({ id: "file_alpha", mime_type: "text/plain" });
  });

  it("rejects a page_size above 100 at the schema", () => {
    expect(() => listTool.inputSchema.parse({ page_size: 500 })).toThrow();
  });
});
