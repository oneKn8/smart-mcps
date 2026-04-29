import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError, NotFoundError } from "smart-mcp-core";
import { EmailClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-draftsclient-test-"));
}

function writeTokenFile(home: string, account: string): void {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_uri: TOKEN_URL,
      client_id: "test-client.apps.googleusercontent.com",
      client_secret: "test-secret",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      expiry: "2026-04-28T13:00:00.000Z",
    }),
  );
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
  writeTokenFile(tmpHome, "alice");
});

afterEach(() => {
  vi.useRealTimers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("EmailClient.createDraft", () => {
  it("POSTs /users/me/drafts with {message:{raw}} and returns mapped GmailDraftRef", async () => {
    let capturedBody: unknown;
    let capturedAuth: string | null = null;
    server.use(
      http.post(`${GMAIL_BASE}/users/me/drafts`, async ({ request }) => {
        capturedBody = await request.json();
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          id: "draft_abc",
          message: { id: "msg_xyz", threadId: "thr_111" },
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.createDraft("alice", "RAW_MIME_BASE64URL");

    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedBody).toEqual({ message: { raw: "RAW_MIME_BASE64URL" } });
    expect(result).toEqual({
      id: "draft_abc",
      messageId: "msg_xyz",
      threadId: "thr_111",
    });
  });

  it("maps 401 → friendly AuthError (access token rejected)", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/users/me/drafts`, () =>
        HttpResponse.json(
          { error: { code: 401, message: "Invalid Credentials" } },
          { status: 401 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    const promise = client.createDraft("alice", "RAW");
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toThrow(/access token rejected/);
  });
});

describe("EmailClient.listDrafts", () => {
  it("passes q + maxResults query params and normalizes missing drafts to []", async () => {
    let capturedUrl: string | undefined;
    server.use(
      http.get(`${GMAIL_BASE}/users/me/drafts`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ resultSizeEstimate: 0 });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.listDrafts("alice", {
      q: "subject:test",
      maxResults: 10,
    });

    expect(capturedUrl).toContain("q=subject%3Atest");
    expect(capturedUrl).toContain("maxResults=10");
    expect(result).toEqual({ drafts: [], resultSizeEstimate: 0 });
  });

  it("honors pageToken and returns nextPageToken when present", async () => {
    let capturedUrl: string | undefined;
    server.use(
      http.get(`${GMAIL_BASE}/users/me/drafts`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          drafts: [
            { id: "d1", message: { id: "m1", threadId: "t1" } },
            { id: "d2", message: { id: "m2", threadId: "t2" } },
          ],
          nextPageToken: "next_cursor_xyz",
          resultSizeEstimate: 2,
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.listDrafts("alice", {
      pageToken: "cursor_abc",
    });

    expect(capturedUrl).toContain("pageToken=cursor_abc");
    expect(result).toEqual({
      drafts: [
        { id: "d1", messageId: "m1", threadId: "t1" },
        { id: "d2", messageId: "m2", threadId: "t2" },
      ],
      nextPageToken: "next_cursor_xyz",
      resultSizeEstimate: 2,
    });
  });
});

describe("EmailClient.getDraft", () => {
  it("defaults format to metadata and passes it as a query param", async () => {
    let capturedUrl: string | undefined;
    server.use(
      http.get(
        `${GMAIL_BASE}/users/me/drafts/draft_abc`,
        ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            id: "draft_abc",
            message: { id: "msg_xyz", threadId: "thr_111" },
          });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.getDraft("alice", "draft_abc");
    expect(capturedUrl).toContain("format=metadata");
    expect(result).toEqual({
      id: "draft_abc",
      message: { id: "msg_xyz", threadId: "thr_111" },
    });
  });

  it("passes explicit format override", async () => {
    let capturedUrl: string | undefined;
    server.use(
      http.get(
        `${GMAIL_BASE}/users/me/drafts/draft_abc`,
        ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            id: "draft_abc",
            message: { id: "msg_xyz", threadId: "thr_111", payload: {} },
          });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    await client.getDraft("alice", "draft_abc", "full");
    expect(capturedUrl).toContain("format=full");
  });

  it("maps 404 → NotFoundError with friendly draft id message", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/users/me/drafts/missing_draft`, () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    const promise = client.getDraft("alice", "missing_draft");
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await expect(promise).rejects.toThrow(/draft not found: missing_draft/);
  });
});

describe("EmailClient.updateDraft", () => {
  it("PUTs /users/me/drafts/{id} with {message:{raw}} and returns mapped GmailDraftRef", async () => {
    let capturedBody: unknown;
    let capturedMethod: string | undefined;
    server.use(
      http.put(
        `${GMAIL_BASE}/users/me/drafts/draft_abc`,
        async ({ request }) => {
          capturedBody = await request.json();
          capturedMethod = request.method;
          return HttpResponse.json({
            id: "draft_abc",
            message: { id: "msg_new", threadId: "thr_111" },
          });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.updateDraft(
      "alice",
      "draft_abc",
      "NEW_RAW_MIME",
    );

    expect(capturedMethod).toBe("PUT");
    expect(capturedBody).toEqual({ message: { raw: "NEW_RAW_MIME" } });
    expect(result).toEqual({
      id: "draft_abc",
      messageId: "msg_new",
      threadId: "thr_111",
    });
  });

  it("maps 403 → friendly AuthError pointing at gmail.modify scope", async () => {
    server.use(
      http.put(`${GMAIL_BASE}/users/me/drafts/draft_abc`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    const promise = client.updateDraft("alice", "draft_abc", "RAW");
    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toThrow(/scope insufficient/);
    await expect(promise).rejects.toThrow(/gmail\.modify/);
  });
});

describe("EmailClient.sendDraft", () => {
  it("POSTs /users/me/drafts/{id}/send and returns GmailSendResponse with labelIds", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.post(
        `${GMAIL_BASE}/users/me/drafts/draft_abc/send`,
        ({ request }) => {
          capturedAuth = request.headers.get("authorization");
          return HttpResponse.json({
            id: "msg_sent_999",
            threadId: "thr_111",
            labelIds: ["SENT"],
          });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.sendDraft("alice", "draft_abc");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toEqual({
      id: "msg_sent_999",
      threadId: "thr_111",
      labelIds: ["SENT"],
    });
  });

  it("maps 404 → NotFoundError with friendly draft id message", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/users/me/drafts/missing_draft/send`, () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    const promise = client.sendDraft("alice", "missing_draft");
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await expect(promise).rejects.toThrow(/draft not found: missing_draft/);
  });
});

describe("EmailClient.deleteDraft", () => {
  it("DELETEs /users/me/drafts/{id} and resolves to undefined on 204", async () => {
    let capturedMethod: string | undefined;
    let capturedAuth: string | null = null;
    server.use(
      http.delete(
        `${GMAIL_BASE}/users/me/drafts/draft_abc`,
        ({ request }) => {
          capturedMethod = request.method;
          capturedAuth = request.headers.get("authorization");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.deleteDraft("alice", "draft_abc");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toBeUndefined();
  });

  it("maps 404 → NotFoundError with friendly draft id message", async () => {
    server.use(
      http.delete(`${GMAIL_BASE}/users/me/drafts/missing_draft`, () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    const promise = client.deleteDraft("alice", "missing_draft");
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
    await expect(promise).rejects.toThrow(/draft not found: missing_draft/);
  });
});
