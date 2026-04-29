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
import { AuthError } from "smart-mcp-core";
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-modifyclient-test-"));
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

describe("EmailClient.batchModify", () => {
  it("POSTs /users/me/messages/batchModify with ids + addLabelIds + removeLabelIds and bearer", async () => {
    let capturedBody: unknown;
    let capturedAuth: string | null = null;
    server.use(
      http.post(
        `${GMAIL_BASE}/users/me/messages/batchModify`,
        async ({ request }) => {
          capturedBody = await request.json();
          capturedAuth = request.headers.get("authorization");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    await client.batchModify("alice", {
      ids: ["m1", "m2"],
      addLabelIds: ["Label_42"],
      removeLabelIds: ["UNREAD"],
    });

    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedBody).toEqual({
      ids: ["m1", "m2"],
      addLabelIds: ["Label_42"],
      removeLabelIds: ["UNREAD"],
    });
  });

  it("omits addLabelIds and removeLabelIds when not provided", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(
        `${GMAIL_BASE}/users/me/messages/batchModify`,
        async ({ request }) => {
          capturedBody = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    await client.batchModify("alice", { ids: ["m1"] });

    expect(capturedBody).toEqual({ ids: ["m1"] });
  });

  it("treats 204 as success and returns void", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/users/me/messages/batchModify`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.batchModify("alice", {
      ids: ["m1"],
      removeLabelIds: ["UNREAD"],
    });
    expect(result).toBeUndefined();
  });

  it("maps Gmail 403 → AuthError with scope-insufficient hint", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/users/me/messages/batchModify`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(
      client.batchModify("alice", {
        ids: ["m1"],
        removeLabelIds: ["UNREAD"],
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe("EmailClient.batchTrash", () => {
  it("POSTs /users/me/messages/batchTrash with ids and bearer", async () => {
    let capturedBody: unknown;
    let capturedAuth: string | null = null;
    server.use(
      http.post(
        `${GMAIL_BASE}/users/me/messages/batchTrash`,
        async ({ request }) => {
          capturedBody = await request.json();
          capturedAuth = request.headers.get("authorization");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    const client = new EmailClient(tmpHome);
    await client.batchTrash("alice", ["m1", "m2", "m3"]);

    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedBody).toEqual({ ids: ["m1", "m2", "m3"] });
  });

  it("returns void on 204", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/users/me/messages/batchTrash`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.batchTrash("alice", ["m1"]);
    expect(result).toBeUndefined();
  });

  it("maps Gmail 403 → AuthError on batchTrash", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/users/me/messages/batchTrash`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(client.batchTrash("alice", ["m1"])).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe("EmailClient.listLabels", () => {
  it("GETs /users/me/labels and returns labels array", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${GMAIL_BASE}/users/me/labels`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "Label_42", name: "Newsletters", type: "user" },
          ],
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.listLabels("alice");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toEqual([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);
  });

  it("normalizes missing labels field to empty array", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/users/me/labels`, () => HttpResponse.json({})),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.listLabels("alice");
    expect(result).toEqual([]);
  });
});

describe("EmailClient.getLabel", () => {
  it("GETs /users/me/labels/{id} and returns label with counts", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${GMAIL_BASE}/users/me/labels/INBOX`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          id: "INBOX",
          name: "INBOX",
          type: "system",
          messagesTotal: 1234,
          messagesUnread: 12,
          threadsTotal: 999,
          threadsUnread: 7,
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.getLabel("alice", "INBOX");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toEqual({
      id: "INBOX",
      name: "INBOX",
      type: "system",
      messagesTotal: 1234,
      messagesUnread: 12,
      threadsUnread: 7,
    });
  });

  it("omits count fields when Gmail does not return them", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/users/me/labels/Label_5`, () =>
        HttpResponse.json({ id: "Label_5", name: "Custom", type: "user" }),
      ),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.getLabel("alice", "Label_5");
    expect(result).toEqual({
      id: "Label_5",
      name: "Custom",
      type: "user",
    });
  });
});
