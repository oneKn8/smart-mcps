import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { SlackClient } from "../client.js";
import {
  AuthError,
  NotFoundError,
  UpstreamError,
  ValidationError,
} from "smart-mcp-core";

const USER_TOKEN = "xoxp-test-user-token";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedUserToken: string | undefined;
let savedBotToken: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedUserToken = process.env.SLACK_USER_TOKEN;
  savedBotToken = process.env.SLACK_BOT_TOKEN;
  savedHome = process.env.HOME;
  process.env.SLACK_USER_TOKEN = USER_TOKEN;
  process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
  process.env.HOME = "/tmp/slack-smart-test-no-home";
});

afterEach(() => {
  if (savedUserToken === undefined) delete process.env.SLACK_USER_TOKEN;
  else process.env.SLACK_USER_TOKEN = savedUserToken;
  if (savedBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = savedBotToken;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe("SlackClient.listFiles", () => {
  it("sends GET with bearer user token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/files.list", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          ok: true,
          files: [{ id: "F001", name: "report.pdf" }],
          paging: { count: 1, total: 1, page: 1, pages: 1 },
        });
      }),
    );
    const client = new SlackClient();
    const result = await client.listFiles({});
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(result.files).toHaveLength(1);
  });

  it("passes page and count as query params", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/files.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          files: [],
          paging: { count: 50, total: 0, page: 2, pages: 0 },
        });
      }),
    );
    const client = new SlackClient();
    await client.listFiles({ count: 50, page: 2 });
    expect(seenUrl).toContain("count=50");
    expect(seenUrl).toContain("page=2");
  });

  it("passes channel and user when provided", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get("https://slack.com/api/files.list", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          ok: true,
          files: [],
          paging: { count: 100, total: 0, page: 1, pages: 0 },
        });
      }),
    );
    const client = new SlackClient();
    await client.listFiles({ channel: "C001", user: "U001" });
    expect(seenUrl).toContain("channel=C001");
    expect(seenUrl).toContain("user=U001");
  });
});

// ---------------------------------------------------------------------------
// getFileInfo
// ---------------------------------------------------------------------------

describe("SlackClient.getFileInfo", () => {
  it("sends GET with file param and user token", async () => {
    let seenUrl: string | null = null;
    let seenAuth: string | null = null;
    const fileData = { id: "F001", name: "doc.txt", size: 1024 };
    server.use(
      http.get("https://slack.com/api/files.info", ({ request }) => {
        seenUrl = request.url;
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ ok: true, file: fileData });
      }),
    );
    const client = new SlackClient();
    const result = await client.getFileInfo({ file: "F001" });
    expect(seenUrl).toContain("file=F001");
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(result.file).toEqual(fileData);
  });
});

// ---------------------------------------------------------------------------
// getUploadUrl
// ---------------------------------------------------------------------------

describe("SlackClient.getUploadUrl", () => {
  it("sends GET with filename and length, returns upload_url and file_id", async () => {
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://slack.com/api/files.getUploadURLExternal",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json({
            ok: true,
            upload_url: "https://files.slack.com/upload/v1/ABC123",
            file_id: "F999",
          });
        },
      ),
    );
    const client = new SlackClient();
    const result = await client.getUploadUrl({
      filename: "photo.png",
      length: 4096,
    });
    expect(seenUrl).toContain("filename=photo.png");
    expect(seenUrl).toContain("length=4096");
    expect(result.upload_url).toBe(
      "https://files.slack.com/upload/v1/ABC123",
    );
    expect(result.file_id).toBe("F999");
  });
});

// ---------------------------------------------------------------------------
// completeUpload — asserts `files` is a JSON array in the POST body
// ---------------------------------------------------------------------------

describe("SlackClient.completeUpload", () => {
  it("POSTs to files.completeUploadExternal with files as a JSON array", async () => {
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post(
        "https://slack.com/api/files.completeUploadExternal",
        async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            files: [{ id: "F999", name: "photo.png" }],
          });
        },
      ),
    );
    const client = new SlackClient();
    const result = await client.completeUpload({
      files: [{ id: "F999", title: "My photo" }],
      channel_id: "C001",
      initial_comment: "here you go",
    });
    // files must be an actual array, not a serialised string
    expect(Array.isArray(seenBody?.["files"])).toBe(true);
    const filesArr = seenBody?.["files"] as Array<Record<string, unknown>>;
    expect(filesArr[0]?.["id"]).toBe("F999");
    expect(filesArr[0]?.["title"]).toBe("My photo");
    expect(seenBody?.["channel_id"]).toBe("C001");
    expect(seenBody?.["initial_comment"]).toBe("here you go");
    expect(result.ok).toBe(true);
  });

  it("omits optional fields when not provided", async () => {
    let seenBody: Record<string, unknown> | null = null;
    server.use(
      http.post(
        "https://slack.com/api/files.completeUploadExternal",
        async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ok: true, files: [] });
        },
      ),
    );
    const client = new SlackClient();
    await client.completeUpload({ files: [{ id: "F001" }] });
    expect(seenBody).not.toHaveProperty("channel_id");
    expect(seenBody).not.toHaveProperty("initial_comment");
    expect(seenBody).not.toHaveProperty("thread_ts");
  });
});

// ---------------------------------------------------------------------------
// uploadBytes — stubs the pre-signed URL and asserts POST + UpstreamError
// ---------------------------------------------------------------------------

describe("SlackClient.uploadBytes", () => {
  it("POSTs to the provided upload_url", async () => {
    let seenMethod: string | null = null;
    server.use(
      http.post(
        "https://files.slack.com/upload/v1/TEST",
        ({ request }) => {
          seenMethod = request.method;
          return new HttpResponse(null, { status: 200 });
        },
      ),
    );
    const client = new SlackClient();
    await client.uploadBytes(
      "https://files.slack.com/upload/v1/TEST",
      new Uint8Array([1, 2, 3]),
      "test.bin",
    );
    expect(seenMethod).toBe("POST");
  });

  it("throws UpstreamError when the upload POST returns non-ok status", async () => {
    server.use(
      http.post(
        "https://files.slack.com/upload/v1/FAIL",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    const client = new SlackClient();
    await expect(
      client.uploadBytes(
        "https://files.slack.com/upload/v1/FAIL",
        new Uint8Array([1]),
        "fail.bin",
      ),
    ).rejects.toThrow(UpstreamError);
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteFile — delegates to the SSRF-hardened fetcher (safe-fetch)
// ---------------------------------------------------------------------------

describe("SlackClient.fetchRemoteFile", () => {
  it("fetches bytes from a public IP-literal URL (no DNS, real safe-fetch path)", async () => {
    server.use(
      http.get("http://93.184.216.34/logo.png", () =>
        HttpResponse.arrayBuffer(new Uint8Array([5, 6, 7]).buffer),
      ),
    );
    const client = new SlackClient();
    const { bytes } = await client.fetchRemoteFile(
      "http://93.184.216.34/logo.png",
    );
    expect(Array.from(bytes)).toEqual([5, 6, 7]);
  });

  it("rejects a loopback URL before any request is made", async () => {
    const client = new SlackClient();
    await expect(
      client.fetchRemoteFile("http://127.0.0.1/x"),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// downloadFile — files.info -> authed GET of url_private_download
// ---------------------------------------------------------------------------

describe("SlackClient.downloadFile", () => {
  it("fetches bytes from url_private_download with the user bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get("https://slack.com/api/files.info", () =>
        HttpResponse.json({
          ok: true,
          file: {
            id: "F1",
            name: "notes.txt",
            mimetype: "text/plain",
            url_private_download:
              "https://files.slack.com/files-pri/T1-F1/download/notes.txt",
          },
        }),
      ),
      http.get(
        "https://files.slack.com/files-pri/T1-F1/download/notes.txt",
        ({ request }) => {
          seenAuth = request.headers.get("authorization");
          return HttpResponse.text("hello");
        },
      ),
    );
    const client = new SlackClient();
    const { file, bytes } = await client.downloadFile({
      file: "F1",
      maxBytes: 1000,
    });
    expect(seenAuth).toBe(`Bearer ${USER_TOKEN}`);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect((file as Record<string, unknown>)["id"]).toBe("F1");
  });

  it("throws NotFoundError when the file has no downloadable URL", async () => {
    server.use(
      http.get("https://slack.com/api/files.info", () =>
        HttpResponse.json({
          ok: true,
          file: { id: "F2", name: "x", mimetype: "text/plain" },
        }),
      ),
    );
    const client = new SlackClient();
    await expect(
      client.downloadFile({ file: "F2", maxBytes: 1000 }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses to send the token to a non-Slack host", async () => {
    server.use(
      http.get("https://slack.com/api/files.info", () =>
        HttpResponse.json({
          ok: true,
          file: {
            id: "F3",
            mimetype: "text/plain",
            url_private_download: "https://evil.example.com/steal",
          },
        }),
      ),
    );
    const client = new SlackClient();
    // Rejects BEFORE any GET is made — onUnhandledRequest:"error" would fire if
    // we ever hit the evil host.
    await expect(
      client.downloadFile({ file: "F3", maxBytes: 1000 }),
    ).rejects.toThrow(ValidationError);
  });

  it("throws AuthError when Slack returns an HTML sign-in page instead of bytes", async () => {
    server.use(
      http.get("https://slack.com/api/files.info", () =>
        HttpResponse.json({
          ok: true,
          file: {
            id: "F4",
            mimetype: "text/plain",
            url_private_download:
              "https://files.slack.com/files-pri/T1-F4/download/x",
          },
        }),
      ),
      http.get(
        "https://files.slack.com/files-pri/T1-F4/download/x",
        () =>
          new HttpResponse("<html>sign in</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    );
    const client = new SlackClient();
    await expect(
      client.downloadFile({ file: "F4", maxBytes: 1000 }),
    ).rejects.toThrow(AuthError);
  });

  it("rejects a file whose body exceeds max_bytes", async () => {
    server.use(
      http.get("https://slack.com/api/files.info", () =>
        HttpResponse.json({
          ok: true,
          file: {
            id: "F5",
            mimetype: "application/octet-stream",
            url_private_download:
              "https://files.slack.com/files-pri/T1-F5/download/big.bin",
          },
        }),
      ),
      http.get(
        "https://files.slack.com/files-pri/T1-F5/download/big.bin",
        () => HttpResponse.arrayBuffer(new Uint8Array(20).buffer),
      ),
    );
    const client = new SlackClient();
    await expect(
      client.downloadFile({ file: "F5", maxBytes: 10 }),
    ).rejects.toThrow(ValidationError);
  });
});
