import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import { list_files, file_info, upload_file, read_file } from "../files.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  listFiles: ReturnType<typeof vi.fn>;
  getFileInfo: ReturnType<typeof vi.fn>;
  getUploadUrl: ReturnType<typeof vi.fn>;
  uploadBytes: ReturnType<typeof vi.fn>;
  completeUpload: ReturnType<typeof vi.fn>;
  fetchRemoteFile: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    listFiles: vi.fn(),
    getFileInfo: vi.fn(),
    getUploadUrl: vi.fn(),
    uploadBytes: vi.fn(),
    completeUpload: vi.fn(),
    fetchRemoteFile: vi.fn(),
    downloadFile: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(
  tool: { inputSchema: { parse: (v: unknown) => T } },
  raw: unknown,
): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// list_files — schema defaults + slim mapping
// ---------------------------------------------------------------------------

describe("list_files — schema defaults", () => {
  it("defaults count to 100 and page to 1", () => {
    const parsed = parse(list_files, {}) as { count: number; page: number };
    expect(parsed.count).toBe(100);
    expect(parsed.page).toBe(1);
  });
});

describe("list_files — slim mapping", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns slimmed files and paging fields", async () => {
    client.listFiles.mockResolvedValue({
      ok: true,
      files: [
        {
          id: "F001",
          name: "report.pdf",
          title: "Q1 Report",
          mimetype: "application/pdf",
          filetype: "pdf",
          size: 20480,
          permalink: "https://slack.com/files/F001",
          permalink_public: "https://files.slack.com/files/F001",
          user: "U001",
          created: 1700000000,
          channels: ["C001", "C002"],
          extra_field: "should not appear",
        },
      ],
      paging: { count: 1, total: 1, page: 1, pages: 1 },
    });
    const input = parse(list_files, {});
    const result = (await list_files.handler(input, ctx(client))) as {
      files: Array<Record<string, unknown>>;
      count: number;
      page: number;
      pages: number;
      total: number;
    };
    expect(result.count).toBe(1);
    expect(result.page).toBe(1);
    expect(result.pages).toBe(1);
    expect(result.total).toBe(1);
    const f = result.files[0];
    expect(f).toBeDefined();
    expect(f?.["id"]).toBe("F001");
    expect(f?.["name"]).toBe("report.pdf");
    expect(f?.["mimetype"]).toBe("application/pdf");
    expect(f?.["channels"]).toEqual(["C001", "C002"]);
    expect(f).not.toHaveProperty("extra_field");
  });

  it("omits paging fields when paging is absent", async () => {
    client.listFiles.mockResolvedValue({
      ok: true,
      files: [],
    });
    const input = parse(list_files, {});
    const result = (await list_files.handler(input, ctx(client))) as Record<
      string,
      unknown
    >;
    expect(result["page"]).toBeUndefined();
    expect(result["pages"]).toBeUndefined();
    expect(result["total"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// file_info — slim mapping
// ---------------------------------------------------------------------------

describe("file_info — slim mapping", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns a slimmed file object", async () => {
    client.getFileInfo.mockResolvedValue({
      ok: true,
      file: {
        id: "F002",
        name: "notes.txt",
        size: 512,
        mimetype: "text/plain",
        url_private_download:
          "https://files.slack.com/files-pri/T1-F002/download/notes.txt",
        unwanted: "drop me",
      },
    });
    const input = parse(file_info, { file: "F002" });
    const result = (await file_info.handler(input, ctx(client))) as Record<
      string,
      unknown
    >;
    expect(result["id"]).toBe("F002");
    expect(result["name"]).toBe("notes.txt");
    expect(result["size"]).toBe(512);
    // url_private_download is surfaced so a caller can fetch the bytes itself.
    expect(result["url_private_download"]).toBe(
      "https://files.slack.com/files-pri/T1-F002/download/notes.txt",
    );
    expect(result).not.toHaveProperty("unwanted");
  });
});

// ---------------------------------------------------------------------------
// read_file — content decoding + schema defaults
// ---------------------------------------------------------------------------

describe("read_file — schema defaults", () => {
  it("defaults max_bytes to 1_000_000", () => {
    const parsed = parse(read_file, { file: "F1" }) as { max_bytes: number };
    expect(parsed.max_bytes).toBe(1_000_000);
  });
});

describe("read_file — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("returns UTF-8 text inline for a text mimetype and marks it untrusted", async () => {
    client.downloadFile.mockResolvedValue({
      file: { id: "F1", name: "notes.txt", mimetype: "text/plain", filetype: "text" },
      bytes: new TextEncoder().encode("hello world"),
    });
    const input = parse(read_file, { file: "F1" });
    const result = (await read_file.handler(input, ctx(client))) as {
      id: string;
      encoding: string;
      content: string;
      size: number;
      mimetype?: string;
      note: string;
    };
    expect(result.encoding).toBe("text");
    expect(result.content).toBe("hello world");
    expect(result.size).toBe(11);
    expect(result.id).toBe("F1");
    expect(result.mimetype).toBe("text/plain");
    expect(result.note.toLowerCase()).toContain("untrusted");
  });

  it("base64-encodes a binary mimetype", async () => {
    client.downloadFile.mockResolvedValue({
      file: { id: "F2", name: "pixel.png", mimetype: "image/png", filetype: "png" },
      bytes: new Uint8Array([1, 2, 3]),
    });
    const input = parse(read_file, { file: "F2" });
    const result = (await read_file.handler(input, ctx(client))) as {
      encoding: string;
      content: string;
      size: number;
    };
    expect(result.encoding).toBe("base64");
    expect(result.content).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(result.size).toBe(3);
  });

  it("treats a JSON application mimetype as text", async () => {
    client.downloadFile.mockResolvedValue({
      file: { id: "F3", name: "data.json", mimetype: "application/json" },
      bytes: new TextEncoder().encode('{"ok":true}'),
    });
    const input = parse(read_file, { file: "F3" });
    const result = (await read_file.handler(input, ctx(client))) as {
      encoding: string;
      content: string;
    };
    expect(result.encoding).toBe("text");
    expect(result.content).toBe('{"ok":true}');
  });

  it("passes the resolved max_bytes through to the client", async () => {
    client.downloadFile.mockResolvedValue({
      file: { id: "F4", mimetype: "text/plain" },
      bytes: new TextEncoder().encode("x"),
    });
    const input = parse(read_file, { file: "F4", max_bytes: 500 });
    await read_file.handler(input, ctx(client));
    const [args] = client.downloadFile.mock.calls[0] as [
      { file: string; maxBytes: number },
    ];
    expect(args.file).toBe("F4");
    expect(args.maxBytes).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// upload_file — validation guards
// ---------------------------------------------------------------------------

describe("upload_file — validation: source selection", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ValidationError when neither file_path nor content_base64 is provided", async () => {
    const input = parse(upload_file, { confirm: true });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });

  it("throws ValidationError when both file_path and content_base64 are provided", async () => {
    const input = parse(upload_file, {
      file_path: "/tmp/x.txt",
      content_base64: "aGVsbG8=",
      filename: "x.txt",
      confirm: true,
    });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });

  it("throws ValidationError when content_base64 is given without filename", async () => {
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      confirm: true,
    });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upload_file — confirm gate
// ---------------------------------------------------------------------------

describe("upload_file — confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and makes NO client calls", async () => {
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      filename: "hello.txt",
    });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.getUploadUrl).not.toHaveBeenCalled();
    expect(client.uploadBytes).not.toHaveBeenCalled();
    expect(client.completeUpload).not.toHaveBeenCalled();
  });

  it("preview contains filename, byte count and channel", async () => {
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      filename: "hello.txt",
      channel_id: "C001",
    });
    let preview = "";
    try {
      await upload_file.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("hello.txt");
    expect(preview).toContain("C001");
    // "aGVsbG8=" decodes to "hello" (5 bytes)
    expect(preview).toContain("5 bytes");
  });

  it("preview uses (no channel) when channel_id is omitted", async () => {
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      filename: "hello.txt",
    });
    let preview = "";
    try {
      await upload_file.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("(no channel)");
  });
});

// ---------------------------------------------------------------------------
// upload_file — happy path (content_base64)
// ---------------------------------------------------------------------------

describe("upload_file — happy path with content_base64", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
    client.getUploadUrl.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/XYZ",
      file_id: "F999",
    });
    client.uploadBytes.mockResolvedValue(undefined);
    client.completeUpload.mockResolvedValue({
      ok: true,
      files: [{ id: "F999", name: "hello.txt" }],
    });
  });

  it("calls getUploadUrl, uploadBytes, completeUpload in order with correct args", async () => {
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      filename: "hello.txt",
      title: "Hello File",
      channel_id: "C001",
      initial_comment: "see attachment",
      confirm: true,
    });
    const result = (await upload_file.handler(input, ctx(client))) as {
      ok: boolean;
      file_id: string;
      files?: Array<Record<string, unknown>>;
    };

    // step 1: getUploadUrl
    expect(client.getUploadUrl).toHaveBeenCalledTimes(1);
    const [urlArgs] = client.getUploadUrl.mock.calls[0] as [
      { filename: string; length: number },
    ];
    expect(urlArgs.filename).toBe("hello.txt");
    expect(urlArgs.length).toBe(5); // "hello" is 5 bytes

    // step 2: uploadBytes
    expect(client.uploadBytes).toHaveBeenCalledTimes(1);
    const [uploadUrl, bytes, uploadFilename] = client.uploadBytes.mock
      .calls[0] as [string, Uint8Array, string];
    expect(uploadUrl).toBe("https://files.slack.com/upload/v1/XYZ");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(5);
    expect(uploadFilename).toBe("hello.txt");

    // step 3: completeUpload
    expect(client.completeUpload).toHaveBeenCalledTimes(1);
    const [completeArgs] = client.completeUpload.mock.calls[0] as [
      {
        files: Array<{ id: string; title?: string }>;
        channel_id?: string;
        initial_comment?: string;
      },
    ];
    expect(completeArgs.files).toEqual([
      { id: "F999", title: "Hello File" },
    ]);
    expect(completeArgs.channel_id).toBe("C001");
    expect(completeArgs.initial_comment).toBe("see attachment");

    // output
    expect(result.ok).toBe(true);
    expect(result.file_id).toBe("F999");
    expect(result.files).toHaveLength(1);
    expect(result.files?.[0]?.["id"]).toBe("F999");
  });

  it("omits title from completeUpload files entry when not provided", async () => {
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      filename: "hello.txt",
      confirm: true,
    });
    await upload_file.handler(input, ctx(client));
    const [completeArgs] = client.completeUpload.mock.calls[0] as [
      { files: Array<{ id: string; title?: string }> },
    ];
    expect(completeArgs.files[0]).toEqual({ id: "F999" });
    expect(completeArgs.files[0]).not.toHaveProperty("title");
  });

  it("omits files field from output when completeUpload returns empty files", async () => {
    client.completeUpload.mockResolvedValueOnce({ ok: true, files: [] });
    const input = parse(upload_file, {
      content_base64: "aGVsbG8=",
      filename: "hello.txt",
      confirm: true,
    });
    const result = (await upload_file.handler(input, ctx(client))) as Record<
      string,
      unknown
    >;
    expect(result).not.toHaveProperty("files");
  });
});

// ---------------------------------------------------------------------------
// upload_file — content_url source (SSRF-guarded fetch is tested in safe-fetch)
// ---------------------------------------------------------------------------

describe("upload_file — content_url validation", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ValidationError when content_url is given without filename", async () => {
    const input = parse(upload_file, {
      content_url: "http://files.test/a.png",
      confirm: true,
    });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.fetchRemoteFile).not.toHaveBeenCalled();
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });

  it.each([
    { file_path: "/tmp/x.png", content_url: "http://files.test/a.png" },
    { content_base64: "aGVsbG8=", content_url: "http://files.test/a.png" },
    {
      file_path: "/tmp/x.png",
      content_base64: "aGVsbG8=",
      content_url: "http://files.test/a.png",
    },
  ])(
    "throws ValidationError when content_url is combined with another source (%o)",
    async (extra) => {
      const input = parse(upload_file, {
        ...extra,
        filename: "a.png",
        confirm: true,
      });
      await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
        ValidationError,
      );
      expect(client.fetchRemoteFile).not.toHaveBeenCalled();
    },
  );
});

describe("upload_file — content_url confirm gate", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("throws ConfirmRequiredError without confirm and does NOT fetch the URL", async () => {
    const input = parse(upload_file, {
      content_url: "http://files.test/a.png",
      filename: "a.png",
    });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ConfirmRequiredError,
    );
    expect(client.fetchRemoteFile).not.toHaveBeenCalled();
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });

  it("preview shows filename and the source host (size unknown before fetch)", async () => {
    const input = parse(upload_file, {
      content_url: "http://files.test/a.png",
      filename: "a.png",
      channel_id: "C010",
    });
    let preview = "";
    try {
      await upload_file.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ConfirmRequiredError) preview = err.preview;
    }
    expect(preview).toContain("a.png");
    expect(preview).toContain("from files.test");
    expect(preview).toContain("C010");
  });
});

describe("upload_file — content_url happy path", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
    client.fetchRemoteFile.mockResolvedValue({
      bytes: new Uint8Array([10, 20, 30, 40]),
    });
    client.getUploadUrl.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/URL",
      file_id: "F777",
    });
    client.uploadBytes.mockResolvedValue(undefined);
    client.completeUpload.mockResolvedValue({
      ok: true,
      files: [{ id: "F777", name: "remote.png" }],
    });
  });

  it("fetches the URL after confirm, then uploads the fetched bytes with the given filename", async () => {
    const input = parse(upload_file, {
      content_url: "http://files.test/remote.png",
      filename: "remote.png",
      channel_id: "C010",
      confirm: true,
    });
    const result = (await upload_file.handler(input, ctx(client))) as {
      ok: boolean;
      file_id: string;
    };

    expect(client.fetchRemoteFile).toHaveBeenCalledTimes(1);
    expect(client.fetchRemoteFile).toHaveBeenCalledWith(
      "http://files.test/remote.png",
    );

    const [urlArgs] = client.getUploadUrl.mock.calls[0] as [
      { filename: string; length: number },
    ];
    expect(urlArgs.filename).toBe("remote.png");
    expect(urlArgs.length).toBe(4); // fetched 4 bytes

    const [uploadUrl, bytes, fname] = client.uploadBytes.mock.calls[0] as [
      string,
      Uint8Array,
      string,
    ];
    expect(uploadUrl).toBe("https://files.slack.com/upload/v1/URL");
    expect(Array.from(bytes)).toEqual([10, 20, 30, 40]);
    expect(fname).toBe("remote.png");

    expect(result.ok).toBe(true);
    expect(result.file_id).toBe("F777");
  });

  it("propagates a fetch rejection (SSRF-blocked URL) and does NOT upload", async () => {
    client.fetchRemoteFile.mockRejectedValueOnce(
      new ValidationError(
        "content_url points at a blocked address (127.0.0.1)",
      ),
    );
    const input = parse(upload_file, {
      content_url: "http://127.0.0.1/x.png",
      filename: "x.png",
      confirm: true,
    });
    await expect(upload_file.handler(input, ctx(client))).rejects.toThrow(
      ValidationError,
    );
    expect(client.getUploadUrl).not.toHaveBeenCalled();
    expect(client.uploadBytes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upload_file — file_path branch (vi.mock for node:fs)
// ---------------------------------------------------------------------------

describe("upload_file — file_path read error", () => {
  it("throws a clear ValidationError pointing at content_url/content_base64 when the path is unreadable", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    });
    const client = makeClient();
    const input = parse(upload_file, {
      file_path: "/not/on/this/host.png",
      confirm: true,
    });
    let msg = "";
    try {
      await upload_file.handler(input, ctx(client));
    } catch (err) {
      if (err instanceof ValidationError) msg = err.message;
    }
    expect(msg).toContain("content_url");
    expect(msg).toContain("content_base64");
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });
});

describe("upload_file — file_path branch", () => {
  it("reads bytes from file_path and derives filename from basename", async () => {
    // Mock node:fs to avoid real filesystem access
    vi.mock("node:fs", () => ({
      readFileSync: vi.fn(() => Buffer.from("file content")),
    }));
    const { readFileSync } = await import("node:fs");

    const client = makeClient();
    client.getUploadUrl.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/FSPATH",
      file_id: "F888",
    });
    client.uploadBytes.mockResolvedValue(undefined);
    client.completeUpload.mockResolvedValue({ ok: true, files: [] });

    const input = parse(upload_file, {
      file_path: "/some/dir/document.pdf",
      confirm: true,
    });
    await upload_file.handler(input, ctx(client));

    expect(readFileSync).toHaveBeenCalledWith("/some/dir/document.pdf");

    const [urlArgs] = client.getUploadUrl.mock.calls[0] as [
      { filename: string; length: number },
    ];
    // basename derived: "document.pdf"
    expect(urlArgs.filename).toBe("document.pdf");
    // "file content" is 12 bytes
    expect(urlArgs.length).toBe(12);

    vi.restoreAllMocks();
  });
});
