import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { AuthError, RateLimitError } from "smart-mcp-core";
import { VercelClient } from "../client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedToken: string | undefined;
let savedTeamId: string | undefined;

beforeEach(() => {
  savedToken = process.env.VERCEL_TOKEN;
  savedTeamId = process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = savedToken;
  if (savedTeamId === undefined) delete process.env.VERCEL_TEAM_ID;
  else process.env.VERCEL_TEAM_ID = savedTeamId;
});

describe("VercelClient — constructor", () => {
  it("reads creds via loadCreds when VERCEL_TOKEN is set", () => {
    process.env.VERCEL_TOKEN = "test_token";
    expect(() => new VercelClient()).not.toThrow();
  });

  it("throws AuthError when VERCEL_TOKEN is missing", () => {
    expect(() => new VercelClient()).toThrowError(AuthError);
  });
});

describe("VercelClient.listProjects", () => {
  const mockResponse = {
    projects: [{ id: "prj_1", name: "alpha-site" }],
    pagination: { count: 1, next: null as string | null },
  };

  it("calls correct URL with bearer header and limit param", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listProjects({ limit: 20 });
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("limit=20");
  });

  it("injects teamId when VERCEL_TEAM_ID is set", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listProjects({ limit: 5 });
    expect(seenUrl).toContain("teamId=team_xyz");
  });

  it("returns parsed body unchanged", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json(mockResponse),
      ),
    );
    const client = new VercelClient();
    const result = await client.listProjects({ limit: 20 });
    expect(result).toEqual(mockResponse);
  });

  it("maps 401 to AuthError with helpful message mentioning VERCEL_TOKEN", async () => {
    process.env.VERCEL_TOKEN = "bad_token";
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = new VercelClient();
    try {
      await client.listProjects({ limit: 20 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("VERCEL_TOKEN");
    }
  });

  it("retries 429 then throws RateLimitError after retries exhausted", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let calls = 0;
    server.use(
      http.get("https://api.vercel.com/v9/projects", () => {
        calls++;
        return HttpResponse.json({ error: "slow down" }, { status: 429 });
      }),
    );
    const client = new VercelClient();
    await expect(client.listProjects({ limit: 20 })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    // fetchJson default: initial + 3 retries = 4 calls on persistent 429
    expect(calls).toBe(4);
  });
});
