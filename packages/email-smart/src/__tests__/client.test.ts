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
import { AuthError, ValidationError } from "smart-mcp-core";
import { EmailClient } from "../client.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-client-test-"));
}

function writeTokenFile(home: string, account: string, payload: unknown): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

function fixtureFile(opts: {
  expiry: string;
  token?: string;
  refreshToken?: string;
  scopes?: string[];
}) {
  return {
    token: opts.token ?? "test-access-token",
    refresh_token: opts.refreshToken ?? "test-refresh-token",
    token_uri: TOKEN_URL,
    client_id: "test-client.apps.googleusercontent.com",
    client_secret: "test-secret",
    scopes: opts.scopes ?? ["https://www.googleapis.com/auth/gmail.modify"],
    expiry: opts.expiry,
  };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
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

describe("EmailClient.sendMessage — happy path", () => {
  it("POSTs raw to Gmail with bearer access token and returns slim shape", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-04-28T13:00:00.000Z" }),
    );
    let capturedAuth: string | null = null;
    let capturedBody: unknown;
    server.use(
      http.post(GMAIL_SEND_URL, async ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        capturedBody = await request.json();
        return HttpResponse.json({
          id: "msg_abc",
          threadId: "thr_xyz",
          labelIds: ["SENT"],
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.sendMessage("alice", "RAWBASE64URL");

    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedBody).toEqual({ raw: "RAWBASE64URL" });
    expect(result).toEqual({
      id: "msg_abc",
      threadId: "thr_xyz",
      labelIds: ["SENT"],
    });
  });
});

describe("EmailClient.sendMessage — error mapping", () => {
  it("maps Gmail 403 → AuthError with scope-insufficient guidance", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-04-28T13:00:00.000Z" }),
    );
    server.use(
      http.post(GMAIL_SEND_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(client.sendMessage("alice", "RAW")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining(
        "after expanding scope to gmail.modify",
      ),
    });
  });

  it("maps Gmail 401 → AuthError with re-auth guidance for the account", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-04-28T13:00:00.000Z" }),
    );
    server.use(
      http.post(GMAIL_SEND_URL, () =>
        HttpResponse.json(
          { error: { code: 401, message: "Invalid Credentials" } },
          { status: 401 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(client.sendMessage("alice", "RAW")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("alice"),
    });
  });

  it("maps Gmail 400 → ValidationError, NOT AuthError", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-04-28T13:00:00.000Z" }),
    );
    server.use(
      http.post(GMAIL_SEND_URL, () =>
        HttpResponse.json(
          { error: { code: 400, message: "Invalid raw" } },
          { status: 400 },
        ),
      ),
    );

    const client = new EmailClient(tmpHome);
    await expect(client.sendMessage("alice", "BAD")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("EmailClient.oauthFor — caching", () => {
  it("re-uses the same GoogleOAuthClient instance across calls for an account", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-04-28T13:00:00.000Z" }),
    );
    let sendCount = 0;
    server.use(
      http.post(GMAIL_SEND_URL, () => {
        sendCount++;
        return HttpResponse.json({
          id: `m_${sendCount}`,
          threadId: `t_${sendCount}`,
          labelIds: ["SENT"],
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const a = client.oauthFor("alice");
    const b = client.oauthFor("alice");
    expect(a).toBe(b);

    // Different account → different instance.
    writeTokenFile(
      tmpHome,
      "bob",
      fixtureFile({ expiry: "2026-04-28T13:00:00.000Z" }),
    );
    const c = client.oauthFor("bob");
    expect(c).not.toBe(a);
  });
});

describe("EmailClient.sendMessage — propagates OAuth errors", () => {
  it("throws AuthError when token file is missing for the account", async () => {
    const client = new EmailClient(tmpHome);
    await expect(client.sendMessage("ghost", "RAW")).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe("EmailClient — lazy HOME resolution", () => {
  it("constructor does not throw when HOME is unset; sendMessage throws ValidationError", async () => {
    const previousHome = process.env.HOME;
    delete process.env.HOME;
    try {
      // Constructor must NOT throw — HOME is resolved lazily.
      const client = new EmailClient();

      await expect(client.sendMessage("alice", "RAW")).rejects.toMatchObject({
        name: "ValidationError",
        message: expect.stringContaining(
          "HOME environment variable is not set",
        ),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe("EmailClient.sendMessage — refreshes expired token first", () => {
  it("triggers OAuth refresh when token is expired before sending", async () => {
    // Expiry just 10 seconds out → below 60s threshold → refresh.
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        expiry: "2026-04-28T12:00:10.000Z",
        token: "expired-token",
      }),
    );

    let refreshHit = false;
    let bearerSentToGmail: string | null = null;
    server.use(
      http.post(TOKEN_URL, () => {
        refreshHit = true;
        return HttpResponse.json({
          access_token: "fresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.modify",
        });
      }),
      http.post(GMAIL_SEND_URL, ({ request }) => {
        bearerSentToGmail = request.headers.get("authorization");
        return HttpResponse.json({
          id: "msg_x",
          threadId: "thr_x",
          labelIds: ["SENT"],
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    await client.sendMessage("alice", "RAW");
    expect(refreshHit).toBe(true);
    expect(bearerSentToGmail).toBe("Bearer fresh-token");
  });
});
