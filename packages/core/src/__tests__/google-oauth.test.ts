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
import { AuthError, UpstreamError, GoogleOAuthClient } from "../index.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "core-oauth-test-"));
}

function writeTokenFile(
  home: string,
  account: string,
  payload: unknown,
  suffix = ".json",
): string {
  const dir = path.join(home, ".santo-agent", "oauth");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${account}${suffix}`);
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
    token_uri: "https://oauth2.googleapis.com/token",
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

// ---------------------------------------------------------------------------
// Path resolution — preserves the legacy `<account>.json` shape by default
// and supports the new `<account>.calendar.json` shape for calendar-smart.
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient.getTokenPath — default suffix", () => {
  it("returns <HOME>/.santo-agent/oauth/<account>.json with no opts (preserves legacy)", () => {
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    expect(client.getTokenPath()).toBe(
      path.join(tmpHome, ".santo-agent", "oauth", "alice.json"),
    );
  });

  it("defaults home to process.env.HOME when opts.home is omitted", () => {
    const client = new GoogleOAuthClient("alice");
    expect(client.getTokenPath()).toBe(
      path.join(tmpHome, ".santo-agent", "oauth", "alice.json"),
    );
  });

  it("defaults home to process.env.HOME when opts is fully omitted", () => {
    // No opts arg at all — exercises the `opts = {}` default parameter.
    const client = new GoogleOAuthClient("alice");
    expect(client.getTokenPath()).toBe(
      path.join(tmpHome, ".santo-agent", "oauth", "alice.json"),
    );
  });
});

describe("GoogleOAuthClient.getTokenPath — custom suffix (calendar-smart shape)", () => {
  it("appends fileSuffix verbatim → <account>.calendar.json", () => {
    const client = new GoogleOAuthClient("alice", {
      home: tmpHome,
      fileSuffix: ".calendar.json",
    });
    expect(client.getTokenPath()).toBe(
      path.join(tmpHome, ".santo-agent", "oauth", "alice.calendar.json"),
    );
  });

  it("loads tokens from a .calendar.json file (independent of legacy .json)", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "calendar-cached",
        expiry: "2026-04-28T12:05:00.000Z",
      }),
      ".calendar.json",
    );
    const client = new GoogleOAuthClient("alice", {
      home: tmpHome,
      fileSuffix: ".calendar.json",
    });
    expect(await client.getAccessToken()).toBe("calendar-cached");
  });

  it("a .calendar.json client does NOT see a sibling .json token", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "2026-04-28T12:05:00.000Z" }),
      ".json",
    );
    const client = new GoogleOAuthClient("alice", {
      home: tmpHome,
      fileSuffix: ".calendar.json",
    });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(AuthError);
  });
});

// ---------------------------------------------------------------------------
// Caching + refresh — behavioral parity with the legacy email-smart oauth.ts.
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient.getAccessToken — cache hit", () => {
  it("returns cached token when expiry > now + 60s", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "cached-token-abc",
        expiry: "2026-04-28T12:05:00.000Z",
      }),
    );
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls++;
        return HttpResponse.json({
          access_token: "fresh",
          expires_in: 3599,
        });
      }),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    expect(await client.getAccessToken()).toBe("cached-token-abc");
    expect(calls).toBe(0);
  });
});

describe("GoogleOAuthClient.getAccessToken — refresh", () => {
  it("refreshes when expiry < now + 60s and writes back at mode 0600", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        refreshToken: "rt-xyz",
        expiry: "2026-04-28T12:00:30.000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: "fresh-token", expires_in: 3600 }),
      ),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    expect(await client.getAccessToken()).toBe("fresh-token");

    const written = JSON.parse(
      fs.readFileSync(client.getTokenPath(), "utf-8"),
    );
    expect(written.token).toBe("fresh-token");
    expect(written.refresh_token).toBe("rt-xyz");
    expect(written.expiry).toBe("2026-04-28T13:00:00.000Z");
    const stat = fs.statSync(client.getTokenPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("refreshes a .calendar.json token and writes back to the same path", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-cal",
        expiry: "2026-04-28T12:00:30.000Z",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      }),
      ".calendar.json",
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: "fresh-cal", expires_in: 3600 }),
      ),
    );
    const client = new GoogleOAuthClient("alice", {
      home: tmpHome,
      fileSuffix: ".calendar.json",
    });
    expect(await client.getAccessToken()).toBe("fresh-cal");
    const written = JSON.parse(
      fs.readFileSync(client.getTokenPath(), "utf-8"),
    );
    expect(written.token).toBe("fresh-cal");
    expect(written.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar",
    ]);
  });

  it("two concurrent calls AFTER cache expires hit the network exactly once (in-flight dedup)", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000Z",
      }),
    );
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, async () => {
        calls++;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        return HttpResponse.json({
          access_token: "fresh-deduped",
          expires_in: 3600,
        });
      }),
    );
    vi.useRealTimers();
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    const [a, b] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    expect(a).toBe("fresh-deduped");
    expect(b).toBe("fresh-deduped");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reauthHint templating — default mirrors the legacy python3 wording verbatim;
// custom hint feeds calendar-smart-auth (and any future Google-OAuth MCP).
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient — reauthHint default (legacy python3 wording)", () => {
  it("missing token → AuthError message ends with `python3 ~/.santo-agent/bin/auth.py --account <account>`", async () => {
    const ghostHome = path.join(
      os.tmpdir(),
      `oauth-NONEXISTENT-${Date.now()}`,
    );
    const client = new GoogleOAuthClient("alice", { home: ghostHome });
    const expectedPath = path.join(
      ghostHome,
      ".santo-agent",
      "oauth",
      "alice.json",
    );
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: `token at ${expectedPath} not found; run python3 ~/.santo-agent/bin/auth.py --account alice`,
    });
  });

  it("corrupt JSON → AuthError message ends with `re-run python3 ~/.santo-agent/bin/auth.py`", async () => {
    const dir = path.join(tmpHome, ".santo-agent", "oauth");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "alice.json");
    fs.writeFileSync(filePath, "{ not json");
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: `token file at ${filePath} is not valid JSON; re-run python3 ~/.santo-agent/bin/auth.py --account alice`,
    });
  });

  it("missing scopes field → AuthError message names the field and the python3 command", async () => {
    const payload = fixtureFile({ expiry: "2026-04-28T12:05:00.000Z" }) as Record<
      string,
      unknown
    >;
    delete payload.scopes;
    const filePath = writeTokenFile(tmpHome, "alice", payload);
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: `token file at ${filePath} missing or invalid field "scopes"; re-run python3 ~/.santo-agent/bin/auth.py --account alice`,
    });
  });

  it("unparseable expiry → AuthError quotes the bad value and the python3 command", async () => {
    const filePath = writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({ expiry: "not-a-date" }),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: `token file at ${filePath} has unparseable expiry "not-a-date"; re-run python3 ~/.santo-agent/bin/auth.py --account alice`,
    });
  });
});

describe("GoogleOAuthClient — reauthHint override (calendar-smart wording)", () => {
  it("missing token → AuthError message uses the custom hint instead of python3", async () => {
    const ghostHome = path.join(
      os.tmpdir(),
      `oauth-NONEXISTENT-cal-${Date.now()}`,
    );
    const client = new GoogleOAuthClient("alice", {
      home: ghostHome,
      fileSuffix: ".calendar.json",
      reauthHint: "node calendar-smart-auth.js alice",
    });
    const expectedPath = path.join(
      ghostHome,
      ".santo-agent",
      "oauth",
      "alice.calendar.json",
    );
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: `token at ${expectedPath} not found; run node calendar-smart-auth.js alice`,
    });
  });

  it("corrupt JSON → AuthError message uses the custom reauth hint", async () => {
    const dir = path.join(tmpHome, ".santo-agent", "oauth");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "alice.calendar.json");
    fs.writeFileSync(filePath, "{ not json");
    const client = new GoogleOAuthClient("alice", {
      home: tmpHome,
      fileSuffix: ".calendar.json",
      reauthHint: "calendar-smart-auth alice",
    });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: `token file at ${filePath} is not valid JSON; re-run calendar-smart-auth alice`,
    });
  });
});

// ---------------------------------------------------------------------------
// invalid_grant message stays literal (`bin/auth.py`) for backward compat
// with the existing email-smart oauth.ts behavior.
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient — invalid_grant message is preserved verbatim", () => {
  it("400 invalid_grant → AuthError 'refresh token revoked; re-run bin/auth.py --account <account>'", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          { error: "invalid_grant", error_description: "Token revoked." },
          { status: 400 },
        ),
      ),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "AuthError",
      message: "refresh token revoked; re-run bin/auth.py --account alice",
    });
  });
});

// ---------------------------------------------------------------------------
// Refresh-response validation parity.
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient — refresh response validation", () => {
  it("missing access_token → UpstreamError", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ expires_in: 3600 })),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      name: "UpstreamError",
      message:
        "OAuth refresh response invalid: missing or malformed access_token",
    });
  });

  it("non-positive expires_in → UpstreamError", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: "fresh", expires_in: 0 }),
      ),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(UpstreamError);
  });
});

// ---------------------------------------------------------------------------
// hasScope — replaces the legacy hasGmailModifyScope() with a generic check.
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient.hasScope", () => {
  it("returns true when the token file contains the requested scope", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        expiry: "2026-04-28T12:05:00.000Z",
        scopes: [
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/calendar",
        ],
      }),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    expect(
      await client.hasScope("https://www.googleapis.com/auth/calendar"),
    ).toBe(true);
    expect(
      await client.hasScope("https://www.googleapis.com/auth/gmail.modify"),
    ).toBe(true);
  });

  it("returns false when the token file does not contain the requested scope", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        expiry: "2026-04-28T12:05:00.000Z",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }),
    );
    const client = new GoogleOAuthClient("alice", { home: tmpHome });
    expect(
      await client.hasScope("https://www.googleapis.com/auth/gmail.modify"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requiredScope — present in the constructor signature but currently unused.
// Test asserts the constructor accepts it without throwing so future wiring
// (eager scope check) is non-breaking.
// ---------------------------------------------------------------------------

describe("GoogleOAuthClient — requiredScope option (forward-compat)", () => {
  it("constructor accepts requiredScope without side effect", () => {
    expect(
      () =>
        new GoogleOAuthClient("alice", {
          home: tmpHome,
          requiredScope: "https://www.googleapis.com/auth/calendar",
        }),
    ).not.toThrow();
  });
});
