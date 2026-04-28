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
import { vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthError } from "smart-mcp-core";
import { GoogleOAuthClient } from "../oauth.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "santo-test-home-"));
  return dir;
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

describe("GoogleOAuthClient.getTokenPath", () => {
  it("returns <HOME>/.santo-agent/oauth/<account>.json", () => {
    const client = new GoogleOAuthClient("alice", tmpHome);
    expect(client.getTokenPath()).toBe(
      path.join(tmpHome, ".santo-agent", "oauth", "alice.json"),
    );
  });

  it("defaults home to process.env.HOME", () => {
    const client = new GoogleOAuthClient("alice");
    expect(client.getTokenPath()).toBe(
      path.join(tmpHome, ".santo-agent", "oauth", "alice.json"),
    );
  });
});

describe("GoogleOAuthClient.getAccessToken — cache hit", () => {
  it("returns cached token without hitting the network when expiry > now + 60s", async () => {
    // Now is 12:00:00. Expiry is 12:05:00 (5 min ahead → way past 60s threshold).
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "cached-token-abc",
        expiry: "2026-04-28T12:05:00.000000Z",
      }),
    );
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls++;
        return HttpResponse.json({
          access_token: "fresh-token",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/gmail.modify",
          token_type: "Bearer",
        });
      }),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    const token = await client.getAccessToken();
    expect(token).toBe("cached-token-abc");
    expect(calls).toBe(0);
  });

  it("two consecutive calls inside cache window do NOT hit the network", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "cached-token-xyz",
        expiry: "2026-04-28T12:05:00.000000Z",
      }),
    );
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls++;
        return HttpResponse.json({
          access_token: "fresh-token",
          expires_in: 3599,
        });
      }),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    const a = await client.getAccessToken();
    const b = await client.getAccessToken();
    expect(a).toBe("cached-token-xyz");
    expect(b).toBe("cached-token-xyz");
    expect(calls).toBe(0);
  });
});

describe("GoogleOAuthClient.getAccessToken — refresh", () => {
  it("refreshes when expiry < now + 60s, posting form-encoded body", async () => {
    // Expiry is 12:00:30 — only 30s ahead, inside the 60s threshold.
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        refreshToken: "rt-123",
        expiry: "2026-04-28T12:00:30.000000Z",
      }),
    );
    let seenContentType: string | null = null;
    let seenBody: string | null = null;
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        seenContentType = request.headers.get("content-type");
        seenBody = await request.text();
        return HttpResponse.json({
          access_token: "fresh-token-1",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/gmail.modify",
          token_type: "Bearer",
        });
      }),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    const token = await client.getAccessToken();
    expect(token).toBe("fresh-token-1");
    expect(seenContentType).toContain("application/x-www-form-urlencoded");
    const params = new URLSearchParams(seenBody ?? "");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt-123");
    expect(params.get("client_id")).toBe("test-client.apps.googleusercontent.com");
    expect(params.get("client_secret")).toBe("test-secret");
  });

  it("writes the updated file back with new token, new expiry, refresh_token preserved", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        refreshToken: "rt-preserve",
        expiry: "2026-04-28T12:00:30.000000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({
          access_token: "fresh-token-2",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
          token_type: "Bearer",
        }),
      ),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    await client.getAccessToken();

    const filePath = client.getTokenPath();
    const written = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(written.token).toBe("fresh-token-2");
    expect(written.refresh_token).toBe("rt-preserve");
    expect(written.client_id).toBe("test-client.apps.googleusercontent.com");
    expect(written.client_secret).toBe("test-secret");
    expect(written.token_uri).toBe("https://oauth2.googleapis.com/token");
    expect(written.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
    // Now is 12:00:00, expires_in 3600 → expiry should be 13:00:00.
    expect(written.expiry).toBe("2026-04-28T13:00:00.000Z");
  });

  it("after write, file mode is 0600", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json({ access_token: "fresh", expires_in: 3600 }),
      ),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    await client.getAccessToken();
    const stat = fs.statSync(client.getTokenPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("two consecutive calls AFTER cache expires hit the network exactly once (in-flight dedup)", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000000Z",
      }),
    );
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, async () => {
        calls++;
        // Small delay simulates a real network roundtrip so both callers
        // arrive before the first finishes.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        return HttpResponse.json({
          access_token: "fresh-deduped",
          expires_in: 3600,
        });
      }),
    );
    // setImmediate cooperates with real timers; switch to real for this test only.
    vi.useRealTimers();
    const client = new GoogleOAuthClient("alice", tmpHome);
    const [a, b] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    expect(a).toBe("fresh-deduped");
    expect(b).toBe("fresh-deduped");
    expect(calls).toBe(1);
  });
});

describe("GoogleOAuthClient.getAccessToken — errors", () => {
  it("missing token file throws AuthError with run-auth.py recovery message", async () => {
    // Override HOME to a definitely-non-existent path so loadCreds-style
    // fallbacks cannot pick up real tokens.
    const ghostHome = path.join(
      os.tmpdir(),
      `santo-test-NONEXISTENT-${Date.now()}-${Math.random()}`,
    );
    process.env.HOME = ghostHome;
    const client = new GoogleOAuthClient("alice", ghostHome);
    const expectedPath = path.join(
      ghostHome,
      ".santo-agent",
      "oauth",
      "alice.json",
    );
    try {
      await client.getAccessToken();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toBe(
        `token at ${expectedPath} not found; run python3 ~/.santo-agent/bin/auth.py --account alice`,
      );
    }
  });

  it("400 invalid_grant from token endpoint throws AuthError with re-run hint", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        token: "stale-token",
        expiry: "2026-04-28T12:00:30.000000Z",
      }),
    );
    server.use(
      http.post(TOKEN_URL, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          { status: 400 },
        ),
      ),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    try {
      await client.getAccessToken();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toBe(
        "refresh token revoked; re-run bin/auth.py --account alice",
      );
    }
  });
});

describe("GoogleOAuthClient.hasGmailModifyScope", () => {
  it("returns true when scopes include gmail.modify", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        expiry: "2026-04-28T12:05:00.000000Z",
        scopes: [
          "https://www.googleapis.com/auth/gmail.modify",
          "openid",
        ],
      }),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    expect(await client.hasGmailModifyScope()).toBe(true);
  });

  it("returns false when scopes do not include gmail.modify", async () => {
    writeTokenFile(
      tmpHome,
      "alice",
      fixtureFile({
        expiry: "2026-04-28T12:05:00.000000Z",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }),
    );
    const client = new GoogleOAuthClient("alice", tmpHome);
    expect(await client.hasGmailModifyScope()).toBe(false);
  });
});
