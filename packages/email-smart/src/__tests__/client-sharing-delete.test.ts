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
const SETTINGS = `${GMAIL_BASE}/users/me/settings`;
const USER = `${GMAIL_BASE}/users/me`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-sharingclient-test-"));
}

function writeTokenFile(home: string, account: string): void {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${account}.json`),
    JSON.stringify({
      token: "test-access-token",
      refresh_token: "test-refresh-token",
      token_uri: TOKEN_URL,
      client_id: "test-client.apps.googleusercontent.com",
      client_secret: "test-secret",
      scopes: ["https://mail.google.com/"],
      expiry: "2026-07-01T13:00:00.000Z",
    }),
  );
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
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

// ============================ Auto-forwarding ================================

describe("EmailClient.getAutoForwarding / updateAutoForwarding", () => {
  it("GETs /settings/autoForwarding with bearer", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.get(`${SETTINGS}/autoForwarding`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({ enabled: false });
      }),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.getAutoForwarding("alice")).toEqual({
      enabled: false,
    });
    expect(capturedAuth).toBe("Bearer test-access-token");
  });

  it("PUTs /settings/autoForwarding with the settings body", async () => {
    let capturedBody: unknown;
    server.use(
      http.put(`${SETTINGS}/autoForwarding`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          emailAddress: "dest@x.com",
          disposition: "archive",
        });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.updateAutoForwarding("alice", {
      enabled: true,
      emailAddress: "dest@x.com",
      disposition: "archive",
    });
    expect(capturedBody).toEqual({
      enabled: true,
      emailAddress: "dest@x.com",
      disposition: "archive",
    });
    expect(result).toEqual({
      enabled: true,
      emailAddress: "dest@x.com",
      disposition: "archive",
    });
  });

  it("maps 403 to AuthError mentioning gmail.settings.sharing", async () => {
    server.use(
      http.put(`${SETTINGS}/autoForwarding`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const client = new EmailClient(tmpHome);
    await expect(
      client.updateAutoForwarding("alice", { enabled: false }),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("gmail.settings.sharing"),
    });
  });
});

// ========================= Forwarding addresses =============================

describe("EmailClient forwardingAddresses", () => {
  it("GETs /settings/forwardingAddresses and unwraps the array", async () => {
    server.use(
      http.get(`${SETTINGS}/forwardingAddresses`, () =>
        HttpResponse.json({
          forwardingAddresses: [
            { forwardingEmail: "a@x.com", verificationStatus: "accepted" },
            { forwardingEmail: "b@x.com", verificationStatus: "pending" },
          ],
        }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.listForwardingAddresses("alice")).toEqual([
      { forwardingEmail: "a@x.com", verificationStatus: "accepted" },
      { forwardingEmail: "b@x.com", verificationStatus: "pending" },
    ]);
  });

  it("normalizes a missing forwardingAddresses field to an empty array", async () => {
    server.use(
      http.get(`${SETTINGS}/forwardingAddresses`, () =>
        HttpResponse.json({}),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.listForwardingAddresses("alice")).toEqual([]);
  });

  it("POSTs /settings/forwardingAddresses with { forwardingEmail }", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${SETTINGS}/forwardingAddresses`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          forwardingEmail: "dest@x.com",
          verificationStatus: "pending",
        });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.createForwardingAddress("alice", "dest@x.com");
    expect(capturedBody).toEqual({ forwardingEmail: "dest@x.com" });
    expect(result).toEqual({
      forwardingEmail: "dest@x.com",
      verificationStatus: "pending",
    });
  });

  it("DELETEs /settings/forwardingAddresses/{email} and returns void", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.delete(
        `${SETTINGS}/forwardingAddresses/dest%40x.com`,
        ({ request }) => {
          capturedAuth = request.headers.get("authorization");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.deleteForwardingAddress("alice", "dest@x.com");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toBeUndefined();
  });

  it("maps 403 on delete to AuthError mentioning gmail.settings.sharing", async () => {
    server.use(
      http.delete(`${SETTINGS}/forwardingAddresses/dest%40x.com`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const client = new EmailClient(tmpHome);
    await expect(
      client.deleteForwardingAddress("alice", "dest@x.com"),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("gmail.settings.sharing"),
    });
  });
});

// ================================ Delegates =================================

describe("EmailClient delegates", () => {
  it("GETs /settings/delegates and unwraps the array", async () => {
    server.use(
      http.get(`${SETTINGS}/delegates`, () =>
        HttpResponse.json({
          delegates: [
            { delegateEmail: "a@x.com", verificationStatus: "accepted" },
          ],
        }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.listDelegates("alice")).toEqual([
      { delegateEmail: "a@x.com", verificationStatus: "accepted" },
    ]);
  });

  it("normalizes a missing delegates field to an empty array", async () => {
    server.use(
      http.get(`${SETTINGS}/delegates`, () => HttpResponse.json({})),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.listDelegates("alice")).toEqual([]);
  });

  it("POSTs /settings/delegates with { delegateEmail }", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${SETTINGS}/delegates`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          delegateEmail: "assistant@x.com",
          verificationStatus: "accepted",
        });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.createDelegate("alice", "assistant@x.com");
    expect(capturedBody).toEqual({ delegateEmail: "assistant@x.com" });
    expect(result).toEqual({
      delegateEmail: "assistant@x.com",
      verificationStatus: "accepted",
    });
  });

  it("DELETEs /settings/delegates/{email} and returns void", async () => {
    server.use(
      http.delete(`${SETTINGS}/delegates/assistant%40x.com`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(
      await client.deleteDelegate("alice", "assistant@x.com"),
    ).toBeUndefined();
  });
});

// ============================ Permanent delete ==============================

describe("EmailClient permanent delete", () => {
  it("DELETEs /messages/{id} with bearer and returns void", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.delete(`${USER}/messages/msg_1`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.deleteMessage("alice", "msg_1");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toBeUndefined();
  });

  it("maps 403 on message delete to AuthError mentioning mail.google.com", async () => {
    server.use(
      http.delete(`${USER}/messages/msg_1`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const client = new EmailClient(tmpHome);
    await expect(
      client.deleteMessage("alice", "msg_1"),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("https://mail.google.com/"),
    });
  });

  it("POSTs /messages/batchDelete with { ids } and returns void", async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${USER}/messages/batchDelete`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.batchDeleteMessages("alice", ["m1", "m2"]);
    expect(capturedBody).toEqual({ ids: ["m1", "m2"] });
    expect(result).toBeUndefined();
  });

  it("DELETEs /threads/{id} and returns void", async () => {
    server.use(
      http.delete(`${USER}/threads/thr_1`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.deleteThread("alice", "thr_1")).toBeUndefined();
  });

  it("maps 403 on batchDelete to AuthError (mail.google.com)", async () => {
    server.use(
      http.post(`${USER}/messages/batchDelete`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const client = new EmailClient(tmpHome);
    await expect(
      client.batchDeleteMessages("alice", ["m1"]),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
