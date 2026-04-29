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
import { NotFoundError } from "smart-mcp-core";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-readclient-test-"));
}

function writeTokenFile(home: string, account: string): string {
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
  return file;
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

describe("EmailClient.listMessages", () => {
  it("GETs /users/me/messages with bearer and query params", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${GMAIL_BASE}/users/me/messages`, ({ request }) => {
        capturedUrl = request.url;
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          messages: [
            { id: "m1", threadId: "t1" },
            { id: "m2", threadId: "t2" },
          ],
          nextPageToken: "tok_2",
          resultSizeEstimate: 2,
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.listMessages("alice", {
      q: "from:newsletter",
      maxResults: 10,
      labelIds: "INBOX",
    });

    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedUrl).toContain("q=from%3Anewsletter");
    expect(capturedUrl).toContain("maxResults=10");
    expect(capturedUrl).toContain("labelIds=INBOX");
    expect(result).toEqual({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      nextPageToken: "tok_2",
      resultSizeEstimate: 2,
    });
  });

  it("normalizes missing messages field to empty array", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/users/me/messages`, () =>
        HttpResponse.json({ resultSizeEstimate: 0 }),
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.listMessages("alice", { maxResults: 5 });
    expect(result.messages).toEqual([]);
    expect(result.resultSizeEstimate).toBe(0);
  });

  it("forwards pageToken when provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${GMAIL_BASE}/users/me/messages`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ messages: [], resultSizeEstimate: 0 });
      }),
    );

    const client = new EmailClient(tmpHome);
    await client.listMessages("alice", { pageToken: "tok_abc" });
    expect(capturedUrl).toContain("pageToken=tok_abc");
  });
});

describe("EmailClient.getMessage", () => {
  it("GETs /users/me/messages/{id} with format param and returns body", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${GMAIL_BASE}/users/me/messages/msg_xyz`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          id: "msg_xyz",
          threadId: "thr_xyz",
          labelIds: ["INBOX"],
          snippet: "preview",
          sizeEstimate: 100,
          payload: { headers: [{ name: "Subject", value: "Hi" }] },
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.getMessage("alice", "msg_xyz", "metadata");
    expect(capturedUrl).toContain("format=metadata");
    expect(result).toMatchObject({ id: "msg_xyz", snippet: "preview" });
  });

  it("defaults format to metadata when not provided", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${GMAIL_BASE}/users/me/messages/msg_a`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ id: "msg_a", threadId: "t" });
      }),
    );

    const client = new EmailClient(tmpHome);
    await client.getMessage("alice", "msg_a");
    expect(capturedUrl).toContain("format=metadata");
  });

  it("maps Gmail 404 → NotFoundError", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/users/me/messages/missing`, () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(
      client.getMessage("alice", "missing", "metadata"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("EmailClient.getThread", () => {
  it("GETs /users/me/threads/{id} with format param", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${GMAIL_BASE}/users/me/threads/thr_1`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({
          id: "thr_1",
          messages: [
            { id: "m1", threadId: "thr_1", payload: { headers: [] } },
            { id: "m2", threadId: "thr_1", payload: { headers: [] } },
          ],
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.getThread("alice", "thr_1", "metadata");
    expect(capturedUrl).toContain("format=metadata");
    expect(result.id).toBe("thr_1");
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages).toHaveLength(2);
  });

  it("maps Gmail 404 → NotFoundError on threads endpoint", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/users/me/threads/missing`, () =>
        HttpResponse.json(
          { error: { code: 404, message: "Not Found" } },
          { status: 404 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(
      client.getThread("alice", "missing", "metadata"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
