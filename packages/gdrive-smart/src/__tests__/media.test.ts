import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "smart-mcp-core";
import {
  uploadMultipart,
  updateContent,
  downloadMedia,
  exportDoc,
} from "../media.js";

// The media layer does RAW fetch (binary / multipart), so these tests stub the
// global `fetch` and use REAL temp files under os.tmpdir() for the disk I/O.
// No msw here — msw is for the JSON `fetchJson` path only.

const ACCOUNT = "your-account";
const TOKEN = "tok_media_test";
const getToken = async (): Promise<string> => TOKEN;

/** Minimal Response-like stub with only the surface the media layer touches. */
function okJson(value: unknown): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

function okBytes(bytes: Uint8Array): {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
} {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => ab,
    text: async () => "",
  };
}

function errResponse(
  status: number,
  bodyText: string,
): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: false, status, text: async () => bodyText };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gdrive-media-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("uploadMultipart", () => {
  it("POSTs a multipart/related body with metadata + file bytes", async () => {
    const localPath = join(dir, "upload.txt");
    const content = "hello drive upload";
    writeFileSync(localPath, content);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okJson({
          id: "file_new",
          name: "upload.txt",
          mimeType: "text/plain",
          webViewLink: "https://drive/view",
          size: String(content.length),
          parents: ["folder_x"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await uploadMultipart(
      getToken,
      {
        name: "upload.txt",
        parents: ["folder_x"],
        mimeType: "text/plain",
        localPath,
      },
      ACCOUNT,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    // Endpoint + uploadType + fields.
    expect(url).toContain(
      "https://www.googleapis.com/upload/drive/v3/files",
    );
    expect(url).toContain("uploadType=multipart");
    expect(url).toContain(
      "fields=id,name,mimeType,webViewLink,size,parents",
    );
    expect(init.method).toBe("POST");

    // Content-Type carries a boundary.
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    const ct = headers["content-type"];
    expect(ct).toMatch(/^multipart\/related; boundary=.+/);
    const boundary = ct.split("boundary=")[1] as string;

    // Body is a Buffer; verify both parts are present, metadata first.
    expect(Buffer.isBuffer(init.body)).toBe(true);
    const bodyStr = (init.body as Buffer).toString("utf8");
    expect(bodyStr).toContain(`--${boundary}\r\n`);
    expect(bodyStr.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
    // Metadata part (application/json) comes FIRST and carries name+parents+mimeType.
    expect(bodyStr).toContain("Content-Type: application/json; charset=UTF-8");
    expect(bodyStr).toContain(
      '{"name":"upload.txt","parents":["folder_x"],"mimeType":"text/plain"}',
    );
    // Media part uses the real MIME, then the raw bytes.
    expect(bodyStr).toContain("Content-Type: text/plain");
    expect(bodyStr).toContain(content);
    // Metadata part precedes media bytes.
    expect(bodyStr.indexOf('"name":"upload.txt"')).toBeLessThan(
      bodyStr.indexOf(content),
    );

    // Returns the parsed File metadata.
    expect(out.id).toBe("file_new");
    expect(out.name).toBe("upload.txt");
  });

  it("omits parents/mimeType from metadata when not provided", async () => {
    const localPath = join(dir, "bare.bin");
    writeFileSync(localPath, "xyz");
    const fetchMock = vi.fn().mockResolvedValue(okJson({ id: "f" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadMultipart(getToken, { name: "bare.bin", localPath }, ACCOUNT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const bodyStr = (init.body as Buffer).toString("utf8");
    expect(bodyStr).toContain('{"name":"bare.bin"}');
    // Default media MIME when none given.
    expect(bodyStr).toContain("Content-Type: application/octet-stream");
  });

  it("maps a 401 to an AuthError", async () => {
    const localPath = join(dir, "u.txt");
    writeFileSync(localPath, "a");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(401, "Invalid Credentials")),
    );
    await expect(
      uploadMultipart(getToken, { name: "u.txt", localPath }, ACCOUNT),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("uses a crypto.randomUUID-based multipart boundary (L2)", async () => {
    const localPath = join(dir, "boundary.txt");
    writeFileSync(localPath, "x");
    const fetchMock = vi.fn().mockResolvedValue(okJson({ id: "f" }));
    vi.stubGlobal("fetch", fetchMock);
    await uploadMultipart(getToken, { name: "boundary.txt", localPath }, ACCOUNT);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const ct = (init.headers as Record<string, string>)["content-type"];
    expect(ct).toMatch(
      /boundary=gdrive_smart_boundary_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// =============================================================================
// C1 — mime_type header-injection defense
// =============================================================================

describe("mime_type validation (C1 header injection)", () => {
  const INJECTION = "text/plain\r\nX-Injected: pwned\r\n\r\nEVIL";

  it("rejects a CRLF-injecting mime_type in uploadMultipart and builds NO body", async () => {
    const localPath = join(dir, "evil.txt");
    writeFileSync(localPath, "data");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadMultipart(
        getToken,
        { name: "evil.txt", localPath, mimeType: INJECTION },
        ACCOUNT,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    // No request was ever assembled or sent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the same injection in updateContent and builds NO body", async () => {
    const localPath = join(dir, "evil2.txt");
    writeFileSync(localPath, "data");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateContent(getToken, "file_1", { localPath, mimeType: INJECTION }, ACCOUNT),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a bare control char and a non type/subtype value", async () => {
    const localPath = join(dir, "c.txt");
    writeFileSync(localPath, "data");
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      uploadMultipart(
        getToken,
        { name: "c.txt", localPath, mimeType: "text/plain\x00" },
        ACCOUNT,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      uploadMultipart(
        getToken,
        { name: "c.txt", localPath, mimeType: "not-a-mime" },
        ACCOUNT,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a clean RFC 6838 mime_type", async () => {
    const localPath = join(dir, "ok.txt");
    writeFileSync(localPath, "data");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ id: "f" })));
    await expect(
      uploadMultipart(
        getToken,
        { name: "ok.txt", localPath, mimeType: "image/jpeg" },
        ACCOUNT,
      ),
    ).resolves.toBeDefined();
  });
});

// =============================================================================
// M4 — path safety (traversal + overwrite)
// =============================================================================

describe("path safety (M4)", () => {
  it("downloadMedia rejects a dest_path with a .. traversal segment (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadMedia(getToken, "f", "/home/user/../etc/passwd", ACCOUNT),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploadMultipart rejects a local_path with a .. traversal segment (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      uploadMultipart(getToken, { name: "x", localPath: "/a/../secret" }, ACCOUNT),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloadMedia refuses to overwrite an existing file unless overwrite=true", async () => {
    const dest = join(dir, "exists.bin");
    writeFileSync(dest, "old");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okBytes(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    // Without the flag: refuse, and never hit the network.
    await expect(
      downloadMedia(getToken, "f", dest, ACCOUNT),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining(dest),
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // With overwrite=true: writes the new bytes.
    const res = await downloadMedia(getToken, "f", dest, ACCOUNT, true);
    expect(res.bytes).toBe(3);
    expect(Array.from(readFileSync(dest))).toEqual([1, 2, 3]);
  });

  it("exportDoc refuses to overwrite an existing file unless overwrite=true", async () => {
    const dest = join(dir, "doc.pdf");
    writeFileSync(dest, "old");
    const fetchMock = vi.fn().mockResolvedValue(okBytes(new Uint8Array([80])));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      exportDoc(getToken, "d", "application/pdf", dest, ACCOUNT),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();

    const res = await exportDoc(
      getToken,
      "d",
      "application/pdf",
      dest,
      ACCOUNT,
      true,
    );
    expect(res.bytes).toBe(1);
  });
});

describe("updateContent", () => {
  it("PATCHes raw bytes to the upload host with uploadType=media", async () => {
    const localPath = join(dir, "replace.txt");
    const content = "new bytes here";
    writeFileSync(localPath, content);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okJson({ id: "file_1", name: "replace.txt", mimeType: "text/plain" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await updateContent(
      getToken,
      "file_1",
      { localPath, mimeType: "text/plain" },
      ACCOUNT,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "https://www.googleapis.com/upload/drive/v3/files/file_1",
    );
    expect(url).toContain("uploadType=media");
    expect(url).toContain("fields=id,name,mimeType,webViewLink,size,parents");
    expect(init.method).toBe("PATCH");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("text/plain");
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect((init.body as Buffer).toString("utf8")).toBe(content);
    expect(out.id).toBe("file_1");
  });

  it("maps a 404 to a NotFoundError naming the file id", async () => {
    const localPath = join(dir, "x.txt");
    writeFileSync(localPath, "a");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(404, "File not found")),
    );
    await expect(
      updateContent(getToken, "missing_id", { localPath }, ACCOUNT),
    ).rejects.toMatchObject({ name: "NotFoundError" });
  });
});

describe("downloadMedia", () => {
  it("GETs alt=media, writes bytes to destPath, reports byte count", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okBytes(bytes)));
    const destPath = join(dir, "out.bin");

    const res = await downloadMedia(getToken, "file_dl", destPath, ACCOUNT);

    expect(res).toEqual({ path: destPath, bytes: bytes.byteLength });
    // Never inline bytes — only path + count in the result.
    expect(Object.keys(res).sort()).toEqual(["bytes", "path"]);
    // The bytes actually landed on disk.
    const written = readFileSync(destPath);
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });

  it("hits files.get?alt=media with a bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okBytes(new Uint8Array([9])));
    vi.stubGlobal("fetch", fetchMock);
    await downloadMedia(getToken, "file_dl", join(dir, "o"), ACCOUNT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/file_dl?alt=media",
    );
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("maps a 500 to an UpstreamError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(500, "backend error")),
    );
    await expect(
      downloadMedia(getToken, "file_dl", join(dir, "o"), ACCOUNT),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("maps a 403 fileNotDownloadable to a ValidationError pointing at export_file, NOT re-auth (M3)", async () => {
    const body = JSON.stringify({
      error: {
        errors: [{ reason: "fileNotDownloadable" }],
        code: 403,
        message:
          "Only files with binary content can be downloaded. Use Export with Docs Editors files.",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(403, body)),
    );
    const err = await downloadMedia(
      getToken,
      "doc_native",
      join(dir, "o"),
      ACCOUNT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as Error).message).toMatch(/export_file/);
  });

  it("still maps a genuine 403 insufficient-scope download to AuthError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(403, "Insufficient Permission")),
    );
    await expect(
      downloadMedia(getToken, "file_dl", join(dir, "o"), ACCOUNT),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("exportDoc", () => {
  it("GETs files.export, writes bytes, returns path/bytes/mime_type", async () => {
    const bytes = new Uint8Array([80, 68, 70]); // "PDF"
    const fetchMock = vi.fn().mockResolvedValue(okBytes(bytes));
    vi.stubGlobal("fetch", fetchMock);
    const destPath = join(dir, "doc.pdf");

    const res = await exportDoc(
      getToken,
      "doc_1",
      "application/pdf",
      destPath,
      ACCOUNT,
    );

    expect(res).toEqual({
      path: destPath,
      bytes: bytes.byteLength,
      mime_type: "application/pdf",
    });
    expect(Object.keys(res).sort()).toEqual(["bytes", "mime_type", "path"]);
    expect(Array.from(readFileSync(destPath))).toEqual(Array.from(bytes));

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/doc_1/export?mimeType=application%2Fpdf",
    );
  });

  it("maps a 403 to an AuthError (scope)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(403, "Insufficient Permission")),
    );
    await expect(
      exportDoc(getToken, "doc_1", "application/pdf", join(dir, "o"), ACCOUNT),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
