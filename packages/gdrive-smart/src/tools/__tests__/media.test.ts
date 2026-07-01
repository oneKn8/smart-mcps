import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the raw media layer so the tool tests exercise wiring/validation only —
// no fetch, no network. The disk-level behavior is covered in
// `src/__tests__/media.test.ts`.
vi.mock("../../media.js", () => ({
  uploadMultipart: vi.fn(),
  updateContent: vi.fn(),
  downloadMedia: vi.fn(),
  exportDoc: vi.fn(),
}));

import {
  uploadMultipart,
  updateContent,
  downloadMedia,
  exportDoc,
} from "../../media.js";
import {
  uploadTool,
  updateContentTool,
  downloadTool,
  exportFileTool,
} from "../media.js";

const ACCOUNT = "your-account";

type FakeClient = {
  accessToken: ReturnType<typeof vi.fn>;
  getAccount: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    accessToken: vi.fn().mockResolvedValue("tok"),
    getAccount: vi.fn().mockReturnValue(ACCOUNT),
  };
}

function ctxOf(client: FakeClient): { client: never } {
  return { client: client as unknown as never };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gdrive-tool-media-"));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("uploadTool", () => {
  it("uploads an existing file and returns the slim shape", async () => {
    const localPath = join(dir, "photo.jpg");
    writeFileSync(localPath, "bytes");
    vi.mocked(uploadMultipart).mockResolvedValue({
      id: "file_up",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      webViewLink: "https://drive/view",
      size: "5",
      parents: ["folder_x"],
    });
    const client = makeClient();
    const parsed = uploadTool.inputSchema.parse({
      local_path: localPath,
      parent_id: "folder_x",
      mime_type: "image/jpeg",
    }) as Parameters<typeof uploadTool.handler>[0];

    const out = await uploadTool.handler(parsed, ctxOf(client));

    // token getter + shaped opts + account threaded through.
    expect(uploadMultipart).toHaveBeenCalledTimes(1);
    const call = vi.mocked(uploadMultipart).mock.calls[0]!;
    expect(typeof call[0]).toBe("function");
    expect(call[1]).toEqual({
      name: "photo.jpg",
      localPath,
      parents: ["folder_x"],
      mimeType: "image/jpeg",
    });
    expect(call[2]).toBe(ACCOUNT);
    // token getter resolves via the client.
    await expect((call[0] as () => Promise<string>)()).resolves.toBe("tok");

    expect(out).toEqual({
      file_id: "file_up",
      name: "photo.jpg",
      web_view_link: "https://drive/view",
      mime_type: "image/jpeg",
      size: "5",
    });
  });

  it("defaults name to the file basename when name omitted", async () => {
    const localPath = join(dir, "report.pdf");
    writeFileSync(localPath, "x");
    vi.mocked(uploadMultipart).mockResolvedValue({ id: "f", name: "report.pdf" });
    const parsed = uploadTool.inputSchema.parse({
      local_path: localPath,
    }) as Parameters<typeof uploadTool.handler>[0];

    await uploadTool.handler(parsed, ctxOf(makeClient()));

    const call = vi.mocked(uploadMultipart).mock.calls[0]!;
    expect((call[1] as { name: string }).name).toBe("report.pdf");
    // No parents/mimeType keys when not supplied.
    expect(call[1]).toEqual({ name: "report.pdf", localPath });
  });

  it("throws a ValidationError when local_path does not exist", async () => {
    const parsed = uploadTool.inputSchema.parse({
      local_path: join(dir, "nope.txt"),
    }) as Parameters<typeof uploadTool.handler>[0];

    await expect(
      uploadTool.handler(parsed, ctxOf(makeClient())),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(uploadMultipart).not.toHaveBeenCalled();
  });
});

describe("updateContentTool", () => {
  it("replaces bytes of an existing file and returns the slim shape", async () => {
    const localPath = join(dir, "new.txt");
    writeFileSync(localPath, "x");
    vi.mocked(updateContent).mockResolvedValue({
      id: "file_1",
      name: "new.txt",
      mimeType: "text/plain",
      webViewLink: null,
      size: "1",
    });
    const parsed = updateContentTool.inputSchema.parse({
      file_id: "file_1",
      local_path: localPath,
      mime_type: "text/plain",
    }) as Parameters<typeof updateContentTool.handler>[0];

    const out = await updateContentTool.handler(parsed, ctxOf(makeClient()));

    const call = vi.mocked(updateContent).mock.calls[0]!;
    expect(call[1]).toBe("file_1");
    expect(call[2]).toEqual({ localPath, mimeType: "text/plain" });
    expect(call[3]).toBe(ACCOUNT);
    expect(out).toEqual({
      file_id: "file_1",
      name: "new.txt",
      web_view_link: null,
      mime_type: "text/plain",
      size: "1",
    });
  });

  it("throws a ValidationError when local_path does not exist", async () => {
    const parsed = updateContentTool.inputSchema.parse({
      file_id: "file_1",
      local_path: join(dir, "gone.txt"),
    }) as Parameters<typeof updateContentTool.handler>[0];
    await expect(
      updateContentTool.handler(parsed, ctxOf(makeClient())),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect(updateContent).not.toHaveBeenCalled();
  });
});

describe("downloadTool", () => {
  it("passes file_id + dest_path + account and returns path/bytes", async () => {
    vi.mocked(downloadMedia).mockResolvedValue({
      path: "/tmp/out.bin",
      bytes: 42,
    });
    const parsed = downloadTool.inputSchema.parse({
      file_id: "file_dl",
      dest_path: "/tmp/out.bin",
    }) as Parameters<typeof downloadTool.handler>[0];

    const out = await downloadTool.handler(parsed, ctxOf(makeClient()));

    const call = vi.mocked(downloadMedia).mock.calls[0]!;
    expect(call[1]).toBe("file_dl");
    expect(call[2]).toBe("/tmp/out.bin");
    expect(call[3]).toBe(ACCOUNT);
    expect(out).toEqual({ path: "/tmp/out.bin", bytes: 42 });
  });
});

describe("exportFileTool", () => {
  it("passes file_id + mime + dest and returns path/bytes/mime_type", async () => {
    vi.mocked(exportDoc).mockResolvedValue({
      path: "/tmp/doc.pdf",
      bytes: 100,
      mime_type: "application/pdf",
    });
    const parsed = exportFileTool.inputSchema.parse({
      file_id: "doc_1",
      mime_type: "application/pdf",
      dest_path: "/tmp/doc.pdf",
    }) as Parameters<typeof exportFileTool.handler>[0];

    const out = await exportFileTool.handler(parsed, ctxOf(makeClient()));

    const call = vi.mocked(exportDoc).mock.calls[0]!;
    expect(call[1]).toBe("doc_1");
    expect(call[2]).toBe("application/pdf");
    expect(call[3]).toBe("/tmp/doc.pdf");
    expect(call[4]).toBe(ACCOUNT);
    expect(out).toEqual({
      path: "/tmp/doc.pdf",
      bytes: 100,
      mime_type: "application/pdf",
    });
  });
});
