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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runAuth,
  buildAuthorizationUrl,
  AUTHORIZATION_URL_BASE,
  EMAIL_SCOPES,
} from "../email-smart-auth.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAIL_SCOPE = "https://mail.google.com/";
const SETTINGS_BASIC_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.basic";
const SETTINGS_SHARING_SCOPE =
  "https://www.googleapis.com/auth/gmail.settings.sharing";
const SCOPE_STRING = `${MAIL_SCOPE} ${SETTINGS_BASIC_SCOPE} ${SETTINGS_SHARING_SCOPE}`;
const FAKE_REDIRECT = "http://127.0.0.1:54321";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "email-auth-"));
}

function writeClientJson(home: string, payload: unknown): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "client.json");
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

beforeEach(() => {
  tmpHome = makeTmpHome();
});

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runAuth — happy path", () => {
  it("exchanges the code, writes <account>.json with all three scopes, chmod 0600", async () => {
    writeClientJson(tmpHome, {
      installed: {
        client_id: "email-test-client.apps.googleusercontent.com",
        client_secret: "email-test-secret",
      },
    });

    let postedBody: string | null = null;
    let postedContentType: string | null = null;
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        postedContentType = request.headers.get("content-type");
        postedBody = await request.text();
        return HttpResponse.json({
          access_token: "fresh-email-access",
          refresh_token: "rt-email-123",
          expires_in: 3600,
          scope: SCOPE_STRING,
          token_type: "Bearer",
        });
      }),
    );

    const result = await runAuth({
      account: "alpha-account",
      home: tmpHome,
      redirectUri: FAKE_REDIRECT,
      codeReader: async () => "auth-code-from-google",
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });

    const expectedPath = path.join(
      tmpHome,
      ".santo-agent",
      "oauth",
      "alpha-account.json",
    );
    expect(result.tokenPath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
    expect(written).toEqual({
      token: "fresh-email-access",
      refresh_token: "rt-email-123",
      token_uri: TOKEN_URL,
      client_id: "email-test-client.apps.googleusercontent.com",
      client_secret: "email-test-secret",
      scopes: [MAIL_SCOPE, SETTINGS_BASIC_SCOPE, SETTINGS_SHARING_SCOPE],
      expiry: "2026-08-14T11:00:00.000Z",
    });

    const stat = fs.statSync(expectedPath);
    expect(stat.mode & 0o777).toBe(0o600);

    expect(postedContentType).toContain("application/x-www-form-urlencoded");
    const params = new URLSearchParams(postedBody ?? "");
    expect(params.get("code")).toBe("auth-code-from-google");
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe(
      "email-test-client.apps.googleusercontent.com",
    );
    expect(params.get("client_secret")).toBe("email-test-secret");
    expect(params.get("redirect_uri")).toBe(FAKE_REDIRECT);
  });

  it("accepts a top-level (non-installed-wrapper) client.json shape", async () => {
    writeClientJson(tmpHome, {
      client_id: "flat-client.apps.googleusercontent.com",
      client_secret: "flat-secret",
    });

    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "flat-token",
          refresh_token: "flat-rt",
          expires_in: 7200,
        }),
      ),
    );

    const result = await runAuth({
      account: "alice",
      home: tmpHome,
      redirectUri: FAKE_REDIRECT,
      codeReader: async () => "the-code",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const written = JSON.parse(fs.readFileSync(result.tokenPath, "utf-8"));
    expect(written.client_id).toBe("flat-client.apps.googleusercontent.com");
    expect(written.expiry).toBe("2026-01-01T02:00:00.000Z");
    // No scope field in the exchange response — falls back to EMAIL_SCOPES.
    expect(written.scopes).toEqual(EMAIL_SCOPES);
  });

  it("buildAuthorizationUrl carries all three scopes space-joined in one scope param", () => {
    const url = buildAuthorizationUrl("abc", FAKE_REDIRECT);
    expect(url).toContain(AUTHORIZATION_URL_BASE);
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    // URLSearchParams serializes the space between scopes as "+" (an
    // equivalent, Google-accepted query encoding of " ").
    const scopeParam = new URL(url).searchParams.get("scope");
    expect(scopeParam).toBe(SCOPE_STRING);
    expect(EMAIL_SCOPES).toEqual([
      MAIL_SCOPE,
      SETTINGS_BASIC_SCOPE,
      SETTINGS_SHARING_SCOPE,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("runAuth — error paths", () => {
  it("missing account argument throws a clear error", async () => {
    await expect(
      runAuth({
        account: "",
        home: tmpHome,
        redirectUri: FAKE_REDIRECT,
        codeReader: async () => "irrelevant",
      }),
    ).rejects.toThrow(/account/i);
  });

  it("missing client.json names ~/.santo-agent/oauth/client.json and the Console", async () => {
    try {
      await runAuth({
        account: "alice",
        home: tmpHome,
        redirectUri: FAKE_REDIRECT,
        codeReader: async () => "irrelevant",
      });
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(".santo-agent/oauth/client.json");
      expect(msg).toMatch(/Google Cloud Console|OAuth.*Client/i);
    }
  });

  it("client.json without client_secret throws a clear error", async () => {
    writeClientJson(tmpHome, { installed: { client_id: "only-id" } });
    await expect(
      runAuth({
        account: "alice",
        home: tmpHome,
        redirectUri: FAKE_REDIRECT,
        codeReader: async () => "x",
      }),
    ).rejects.toThrow(/client_secret/);
  });

  it("token endpoint 4xx propagates a clear error and writes no partial file", async () => {
    writeClientJson(tmpHome, {
      installed: { client_id: "good-client", client_secret: "good-secret" },
    });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Code expired or already redeemed.",
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      runAuth({
        account: "alice",
        home: tmpHome,
        redirectUri: FAKE_REDIRECT,
        codeReader: async () => "stale-code",
      }),
    ).rejects.toThrow(/invalid_grant|400/);

    const expectedPath = path.join(
      tmpHome,
      ".santo-agent",
      "oauth",
      "alice.json",
    );
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  it("token endpoint missing access_token propagates a clear error", async () => {
    writeClientJson(tmpHome, {
      installed: { client_id: "good-client", client_secret: "good-secret" },
    });
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ refresh_token: "rt", expires_in: 3600 }),
      ),
    );

    await expect(
      runAuth({
        account: "alice",
        home: tmpHome,
        redirectUri: FAKE_REDIRECT,
        codeReader: async () => "code",
      }),
    ).rejects.toThrow(/access_token/);
  });
});
