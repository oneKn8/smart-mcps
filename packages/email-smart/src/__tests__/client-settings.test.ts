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

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-settingsclient-test-"));
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
      scopes: ["https://www.googleapis.com/auth/gmail.settings.basic"],
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

describe("EmailClient.createFilter", () => {
  it("POSTs /settings/filters with criteria + action and bearer", async () => {
    let capturedBody: unknown;
    let capturedAuth: string | null = null;
    server.use(
      http.post(`${SETTINGS}/filters`, async ({ request }) => {
        capturedBody = await request.json();
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          id: "F_1",
          criteria: { from: "news@x.com" },
          action: { addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] },
        });
      }),
    );

    const client = new EmailClient(tmpHome);
    const result = await client.createFilter("alice", {
      criteria: { from: "news@x.com" },
      action: { addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] },
    });

    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedBody).toEqual({
      criteria: { from: "news@x.com" },
      action: { addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] },
    });
    expect(result).toEqual({
      id: "F_1",
      criteria: { from: "news@x.com" },
      action: { addLabelIds: ["Label_9"], removeLabelIds: ["INBOX"] },
    });
  });

  it("maps 403 to AuthError mentioning gmail.settings.basic", async () => {
    server.use(
      http.post(`${SETTINGS}/filters`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const client = new EmailClient(tmpHome);
    await expect(
      client.createFilter("alice", {
        criteria: { from: "a@b.com" },
        action: { addLabelIds: ["INBOX"] },
      }),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("gmail.settings.basic"),
    });
  });
});

describe("EmailClient.listFilters", () => {
  it("GETs /settings/filters and unwraps the filter array", async () => {
    server.use(
      http.get(`${SETTINGS}/filters`, () =>
        HttpResponse.json({
          filter: [
            { id: "F_1", criteria: { from: "a@b.com" }, action: {} },
            { id: "F_2", criteria: {}, action: { addLabelIds: ["X"] } },
          ],
        }),
      ),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.listFilters("alice");
    expect(result).toEqual([
      { id: "F_1", criteria: { from: "a@b.com" }, action: {} },
      { id: "F_2", criteria: {}, action: { addLabelIds: ["X"] } },
    ]);
  });

  it("normalizes a missing filter field to an empty array", async () => {
    server.use(
      http.get(`${SETTINGS}/filters`, () => HttpResponse.json({})),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.listFilters("alice")).toEqual([]);
  });
});

describe("EmailClient.deleteFilter", () => {
  it("DELETEs /settings/filters/{id} with bearer and returns void", async () => {
    let capturedAuth: string | null = null;
    server.use(
      http.delete(`${SETTINGS}/filters/F_9`, ({ request }) => {
        capturedAuth = request.headers.get("authorization");
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.deleteFilter("alice", "F_9");
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(result).toBeUndefined();
  });

  it("maps 403 to AuthError", async () => {
    server.use(
      http.delete(`${SETTINGS}/filters/F_9`, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Insufficient Permission" } },
          { status: 403 },
        ),
      ),
    );
    const client = new EmailClient(tmpHome);
    await expect(client.deleteFilter("alice", "F_9")).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});

describe("EmailClient.getVacation / updateVacation", () => {
  it("GETs /settings/vacation", async () => {
    server.use(
      http.get(`${SETTINGS}/vacation`, () =>
        HttpResponse.json({ enableAutoReply: false }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.getVacation("alice")).toEqual({
      enableAutoReply: false,
    });
  });

  it("PUTs /settings/vacation with the settings body", async () => {
    let capturedBody: unknown;
    server.use(
      http.put(`${SETTINGS}/vacation`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enableAutoReply: true,
          responseSubject: "Away",
        });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.updateVacation("alice", {
      enableAutoReply: true,
      responseSubject: "Away",
    });
    expect(capturedBody).toEqual({
      enableAutoReply: true,
      responseSubject: "Away",
    });
    expect(result).toEqual({ enableAutoReply: true, responseSubject: "Away" });
  });
});

describe("EmailClient.getImap / updateImap", () => {
  it("GETs /settings/imap", async () => {
    server.use(
      http.get(`${SETTINGS}/imap`, () =>
        HttpResponse.json({ enabled: true, autoExpunge: true }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.getImap("alice")).toEqual({
      enabled: true,
      autoExpunge: true,
    });
  });

  it("PUTs /settings/imap with the settings body", async () => {
    let capturedBody: unknown;
    server.use(
      http.put(`${SETTINGS}/imap`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ enabled: false });
      }),
    );
    const client = new EmailClient(tmpHome);
    await client.updateImap("alice", { enabled: false });
    expect(capturedBody).toEqual({ enabled: false });
  });
});

describe("EmailClient.getPop / updatePop", () => {
  it("GETs /settings/pop", async () => {
    server.use(
      http.get(`${SETTINGS}/pop`, () =>
        HttpResponse.json({ accessWindow: "allMail" }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.getPop("alice")).toEqual({ accessWindow: "allMail" });
  });

  it("PUTs /settings/pop with the settings body", async () => {
    let capturedBody: unknown;
    server.use(
      http.put(`${SETTINGS}/pop`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ accessWindow: "disabled" });
      }),
    );
    const client = new EmailClient(tmpHome);
    await client.updatePop("alice", { accessWindow: "disabled" });
    expect(capturedBody).toEqual({ accessWindow: "disabled" });
  });
});

describe("EmailClient.updateLanguage", () => {
  it("PUTs /settings/language with { displayLanguage }", async () => {
    let capturedBody: unknown;
    server.use(
      http.put(`${SETTINGS}/language`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ displayLanguage: "en-GB" });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.updateLanguage("alice", "en-GB");
    expect(capturedBody).toEqual({ displayLanguage: "en-GB" });
    expect(result).toEqual({ displayLanguage: "en-GB" });
  });
});

describe("EmailClient.listSendAs / updateSendAs", () => {
  it("GETs /settings/sendAs and unwraps the sendAs array", async () => {
    server.use(
      http.get(`${SETTINGS}/sendAs`, () =>
        HttpResponse.json({
          sendAs: [
            { sendAsEmail: "alice@x.com", isPrimary: true },
            { sendAsEmail: "alias@x.com", signature: "<b>hi</b>" },
          ],
        }),
      ),
    );
    const client = new EmailClient(tmpHome);
    expect(await client.listSendAs("alice")).toEqual([
      { sendAsEmail: "alice@x.com", isPrimary: true },
      { sendAsEmail: "alias@x.com", signature: "<b>hi</b>" },
    ]);
  });

  it("normalizes a missing sendAs field to an empty array", async () => {
    server.use(http.get(`${SETTINGS}/sendAs`, () => HttpResponse.json({})));
    const client = new EmailClient(tmpHome);
    expect(await client.listSendAs("alice")).toEqual([]);
  });

  it("PATCHes /settings/sendAs/{email} with only signature + displayName", async () => {
    let capturedBody: unknown;
    let capturedAuth: string | null = null;
    let capturedEmail: string | undefined;
    server.use(
      http.patch(`${SETTINGS}/sendAs/:email`, async ({ request, params }) => {
        capturedAuth = request.headers.get("authorization");
        capturedEmail = params["email"] as string;
        capturedBody = await request.json();
        return HttpResponse.json({
          sendAsEmail: "alias@x.com",
          signature: "<b>new</b>",
          displayName: "Alias",
        });
      }),
    );
    const client = new EmailClient(tmpHome);
    const result = await client.updateSendAs("alice", "alias@x.com", {
      signature: "<b>new</b>",
      displayName: "Alias",
    });
    expect(capturedAuth).toBe("Bearer test-access-token");
    expect(capturedEmail).toBe("alias@x.com");
    expect(capturedBody).toEqual({
      signature: "<b>new</b>",
      displayName: "Alias",
    });
    expect(result).toEqual({
      sendAsEmail: "alias@x.com",
      signature: "<b>new</b>",
      displayName: "Alias",
    });
  });

  it("omits displayName from the PATCH body when not provided", async () => {
    let capturedBody: unknown;
    server.use(
      http.patch(`${SETTINGS}/sendAs/:email`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ sendAsEmail: "alias@x.com" });
      }),
    );
    const client = new EmailClient(tmpHome);
    await client.updateSendAs("alice", "alias@x.com", {
      signature: "<b>only</b>",
    });
    expect(capturedBody).toEqual({ signature: "<b>only</b>" });
  });
});
