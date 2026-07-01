import { describe, it, expect, vi } from "vitest";
import { getTool, listTool, escapeQValue } from "../files-read.js";

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

  it("passes drive_id + corpora through for shared-drive listing (L5)", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
    });
    const parsed = listTool.inputSchema.parse({
      folder_id: "folder_x",
      drive_id: "drive_team",
      corpora: "drive",
    }) as Parameters<typeof listTool.handler>[0];

    await listTool.handler(parsed, { client: client as unknown as never });

    expect(client.listFiles).toHaveBeenCalledWith({
      q: "'folder_x' in parents and trashed = false",
      driveId: "drive_team",
      corpora: "drive",
    });
  });

  it("escapes a folder_id containing a single quote before building q (L1)", async () => {
    const client = makeClient({
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
    });
    const parsed = listTool.inputSchema.parse({
      folder_id: "abc' or trashed=false or '",
    }) as Parameters<typeof listTool.handler>[0];

    await listTool.handler(parsed, { client: client as unknown as never });

    // The quote is backslash-escaped so it can't break out of the literal.
    expect(client.listFiles).toHaveBeenCalledWith({
      q: "'abc\\' or trashed=false or \\'' in parents and trashed = false",
    });
  });
});

describe("escapeQValue (L1)", () => {
  it("escapes backslash first, then single quote", () => {
    expect(escapeQValue("a'b")).toBe("a\\'b");
    expect(escapeQValue("a\\b")).toBe("a\\\\b");
    // backslash-before-quote must not double-escape the wrong char.
    expect(escapeQValue("a\\'b")).toBe("a\\\\\\'b");
  });

  it("leaves an ordinary id unchanged", () => {
    expect(escapeQValue("folder_x")).toBe("folder_x");
  });
});
