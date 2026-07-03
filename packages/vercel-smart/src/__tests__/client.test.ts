import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  AmbiguousMatchError,
} from "smart-mcp-core";
import { VercelClient } from "../client.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let savedToken: string | undefined;
let savedTeamId: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedToken = process.env.VERCEL_TOKEN;
  savedTeamId = process.env.VERCEL_TEAM_ID;
  savedHome = process.env.HOME;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  // Point HOME at a non-existent directory so the shared ~/.config/smart-mcps/.env
  // fallback in loadCreds does not leak real-machine credentials into tests.
  process.env.HOME = "/tmp/vercel-smart-test-no-home";
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = savedToken;
  if (savedTeamId === undefined) delete process.env.VERCEL_TEAM_ID;
  else process.env.VERCEL_TEAM_ID = savedTeamId;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// Helper: stub /v2/teams to return zero teams (personal-only mode).
function stubNoTeams() {
  server.use(
    http.get("https://api.vercel.com/v2/teams", () =>
      HttpResponse.json({ teams: [] }),
    ),
  );
}

// Helper: stub /v2/teams with the given teams.
function stubTeams(teams: Array<{ id: string; slug: string; name: string }>) {
  server.use(
    http.get("https://api.vercel.com/v2/teams", () =>
      HttpResponse.json({ teams }),
    ),
  );
}

describe("VercelClient — constructor", () => {
  it("reads creds via loadCreds when VERCEL_TOKEN is set", () => {
    process.env.VERCEL_TOKEN = "test_token";
    expect(() => new VercelClient()).not.toThrow();
  });

  it("throws AuthError when VERCEL_TOKEN is missing", () => {
    expect(() => new VercelClient()).toThrowError(AuthError);
  });
});

describe("VercelClient.listTeams", () => {
  it("calls GET /v2/teams with bearer header and returns parsed body", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenAuth: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v2/teams", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({
          teams: [
            { id: "team_a", slug: "alpha-team", name: "Alpha Team" },
            { id: "team_b", slug: "oneknight", name: "OneKnight" },
          ],
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listTeams();
    expect(seenAuth).toBe("Bearer test_token");
    expect(result.teams).toHaveLength(2);
    expect(result.teams[0]).toEqual({
      id: "team_a",
      slug: "alpha-team",
      name: "Alpha Team",
    });
  });

  it("maps 401 to AuthError mentioning VERCEL_TOKEN", async () => {
    process.env.VERCEL_TOKEN = "bad_token";
    server.use(
      http.get("https://api.vercel.com/v2/teams", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = new VercelClient();
    try {
      await client.listTeams();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("VERCEL_TOKEN");
    }
  });
});

describe("VercelClient.discoverScopes", () => {
  it("with no VERCEL_TEAM_ID returns [personal, ...teams]", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([
      { id: "team_a", slug: "alpha-team", name: "Alpha Team" },
      { id: "team_b", slug: "oneknight", name: "OneKnight" },
    ]);
    const client = new VercelClient();
    const scopes = await client.discoverScopes();
    expect(scopes).toHaveLength(3);
    expect(scopes[0]).toEqual({ kind: "personal" });
    expect(scopes[1]).toEqual({ kind: "team", id: "team_a", slug: "alpha-team" });
    expect(scopes[2]).toEqual({ kind: "team", id: "team_b", slug: "oneknight" });
  });

  it("with VERCEL_TEAM_ID returns only that team, slug resolved from listTeams", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_a";
    stubTeams([
      { id: "team_a", slug: "alpha-team", name: "Alpha Team" },
      { id: "team_b", slug: "oneknight", name: "OneKnight" },
    ]);
    const client = new VercelClient();
    const scopes = await client.discoverScopes();
    expect(scopes).toEqual([
      { kind: "team", id: "team_a", slug: "alpha-team" },
    ]);
  });

  it("with VERCEL_TEAM_ID falls back to id-as-slug when listTeams omits it", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_foreign";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    const client = new VercelClient();
    const scopes = await client.discoverScopes();
    expect(scopes).toEqual([
      { kind: "team", id: "team_foreign", slug: "team_foreign" },
    ]);
  });

  it("caches teams across calls (only one /v2/teams hit)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let teamsCalls = 0;
    server.use(
      http.get("https://api.vercel.com/v2/teams", () => {
        teamsCalls++;
        return HttpResponse.json({
          teams: [{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }],
        });
      }),
    );
    const client = new VercelClient();
    await client.discoverScopes();
    await client.discoverScopes();
    expect(teamsCalls).toBe(1);
  });
});

describe("VercelClient.listProjectsRaw", () => {
  it("personal scope: omits teamId from /v9/projects", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listProjectsRaw({ kind: "personal" }, { limit: 20 });
    expect(seenUrl).not.toContain("teamId=");
    expect(result.projects).toHaveLength(1);
  });

  it("team scope: includes teamId from scope (not constructor creds)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          projects: [{ id: "prj_t1", name: "team-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    await client.listProjectsRaw(
      { kind: "team", id: "team_a", slug: "alpha-team" },
      { limit: 20 },
    );
    expect(seenUrl).toContain("teamId=team_a");
  });
});

describe("VercelClient.listAllProjects", () => {
  it("aggregates across personal + teams and tags each with team slug", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [
              { id: "prj_t1", name: "team-site" },
              { id: "prj_t2", name: "team-other" },
            ],
            pagination: { count: 2, next: null },
          });
        }
        // personal
        return HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listAllProjects({ limit: 20 });
    expect(result.count).toBe(3);
    expect(result.projects).toHaveLength(3);
    const personal = result.projects.find((p) => p.id === "prj_p1");
    expect(personal?.team).toBe("personal");
    const teamSite = result.projects.find((p) => p.id === "prj_t1");
    expect(teamSite?.team).toBe("alpha-team");
  });

  it("deduplicates if same project id appears under multiple scopes (first wins)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_dup", name: "dup-site" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [{ id: "prj_dup", name: "dup-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listAllProjects({ limit: 20 });
    expect(result.count).toBe(1);
    expect(result.projects[0]?.team).toBe("personal"); // personal scope first
  });

  it("VERCEL_TEAM_ID override: only that team is queried", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_a";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    const seenUrls: string[] = [];
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenUrls.push(request.url);
        return HttpResponse.json({
          projects: [{ id: "prj_t1", name: "team-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listAllProjects({ limit: 20 });
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain("teamId=team_a");
    expect(result.projects[0]?.team).toBe("alpha-team");
  });
});

describe("VercelClient.resolveProject", () => {
  it("populates cache on first call and looks up by name", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_t1", name: "team-site" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const found = await client.resolveProject("team-site");
    expect(found.scope).toEqual({ kind: "team", id: "team_a", slug: "alpha-team" });
    expect((found.project as { id: string }).id).toBe("prj_t1");
  });

  it("looks up by project id as well as name", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    const client = new VercelClient();
    const byId = await client.resolveProject("prj_p1");
    expect(byId.scope).toEqual({ kind: "personal" });
  });

  it("personal-account project resolves with kind=personal scope", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_t1", name: "team-site" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.resolveProject("personal-site");
    expect(result.scope).toEqual({ kind: "personal" });
  });

  it("refreshes cache once on miss, then throws NotFoundError if still missing", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    let projectCalls = 0;
    server.use(
      http.get("https://api.vercel.com/v9/projects", () => {
        projectCalls++;
        return HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    await expect(client.resolveProject("nonexistent")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Initial population (1) + one refresh (1) = 2 total calls to /v9/projects.
    expect(projectCalls).toBe(2);
  });

  it("does not refresh on cache hit (subsequent calls reuse cache)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    let projectCalls = 0;
    server.use(
      http.get("https://api.vercel.com/v9/projects", () => {
        projectCalls++;
        return HttpResponse.json({
          projects: [{ id: "prj_p1", name: "personal-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    await client.resolveProject("personal-site");
    await client.resolveProject("personal-site");
    await client.resolveProject("prj_p1");
    expect(projectCalls).toBe(1);
  });
});

describe("VercelClient.listProjects (back-compat aggregator)", () => {
  it("personal-only mode: returns single page tagged with team='personal'", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json({
          projects: [{ id: "prj_1", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listProjects({ limit: 20 });
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("limit=20");
    expect(seenUrl).not.toContain("teamId=");
    expect(result.projects[0]).toMatchObject({
      id: "prj_1",
      name: "alpha-site",
      team: "personal",
    });
  });

  it("VERCEL_TEAM_ID set: routes to that team only and tags with team slug", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    stubTeams([{ id: "team_xyz", slug: "xyzteam", name: "XYZ" }]);
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json({
          projects: [{ id: "prj_1", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const result = await client.listProjects({ limit: 5 });
    expect(seenUrl).toContain("teamId=team_xyz");
    expect(result.projects[0]?.team).toBe("xyzteam");
  });

  it("maps 401 from project listing to AuthError mentioning VERCEL_TOKEN", async () => {
    process.env.VERCEL_TOKEN = "bad_token";
    stubNoTeams();
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
    stubNoTeams();
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

describe("VercelClient.listProjectDomains", () => {
  const mockResponse = {
    domains: [
      {
        name: "alpha-site.com",
        apexName: "alpha-site.com",
        projectId: "prj_alpha",
        redirect: null as string | null,
        redirectStatusCode: null as number | null,
        verified: true,
        gitBranch: null as string | null,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
    ],
  };

  it("personal scope: calls /v9/projects/{name}/domains with bearer header, no teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_alpha", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v9/projects/alpha-site/domains",
        ({ request }) => {
          seenAuth = request.headers.get("authorization");
          seenUrl = request.url;
          return HttpResponse.json(mockResponse);
        },
      ),
    );
    const client = new VercelClient();
    await client.listProjectDomains("alpha-site");
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("/v9/projects/alpha-site/domains");
    expect(seenUrl).not.toContain("teamId=");
  });

  it("resolves to team scope and uses that team's id (not constructor creds)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_t1", name: "team-site" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [],
          pagination: { count: 0, next: null },
        });
      }),
    );
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v9/projects/team-site/domains",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(mockResponse);
        },
      ),
    );
    const client = new VercelClient();
    await client.listProjectDomains("team-site");
    expect(seenUrl).toContain("teamId=team_a");
  });

  it("legacy: with VERCEL_TEAM_ID env override, uses that single team", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    stubTeams([{ id: "team_xyz", slug: "xyzteam", name: "XYZ" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_alpha", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v9/projects/alpha-site/domains",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(mockResponse);
        },
      ),
    );
    const client = new VercelClient();
    await client.listProjectDomains("alpha-site");
    expect(seenUrl).toContain("teamId=team_xyz");
  });

  it("returns parsed body unchanged", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_alpha", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    server.use(
      http.get(
        "https://api.vercel.com/v9/projects/alpha-site/domains",
        () => HttpResponse.json(mockResponse),
      ),
    );
    const client = new VercelClient();
    const result = await client.listProjectDomains("alpha-site");
    expect(result).toEqual(mockResponse);
  });

  it("throws NotFoundError when project cannot be resolved across any scope", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [],
          pagination: { count: 0, next: null },
        }),
      ),
    );
    const client = new VercelClient();
    try {
      await client.listProjectDomains("missing-project");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toContain("missing-project");
    }
  });
});

describe("VercelClient.updateProjectDomain", () => {
  const updatedDomain = {
    name: "www.alpha-site.com",
    apexName: "alpha-site.com",
    projectId: "prj_alpha",
    redirect: "alpha-site.com",
    redirectStatusCode: 308 as number | null,
    verified: true,
    gitBranch: null as string | null,
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
  };

  it("calls correct PATCH URL with bearer header, JSON content-type, and JSON body (personal)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_alpha", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    let seenAuth: string | null = null;
    let seenContentType: string | null = null;
    let seenMethod: string | null = null;
    let seenBody: unknown = null;
    let seenUrl: string | null = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/alpha-site/domains/www.alpha-site.com",
        async ({ request }) => {
          seenAuth = request.headers.get("authorization");
          seenContentType = request.headers.get("content-type");
          seenMethod = request.method;
          seenUrl = request.url;
          seenBody = await request.json();
          return HttpResponse.json(updatedDomain);
        },
      ),
    );
    const client = new VercelClient();
    await client.updateProjectDomain("alpha-site", "www.alpha-site.com", {
      redirect: "alpha-site.com",
      redirectStatusCode: 308,
    });
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenMethod).toBe("PATCH");
    expect(seenContentType).toContain("application/json");
    expect(seenBody).toEqual({
      redirect: "alpha-site.com",
      redirectStatusCode: 308,
    });
    expect(seenUrl).toContain("/v9/projects/alpha-site/domains/www.alpha-site.com");
    expect(seenUrl).not.toContain("teamId=");
  });

  it("uses the resolved scope's teamId (resolved via cache, not constructor creds)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_t1", name: "team-site" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [],
          pagination: { count: 0, next: null },
        });
      }),
    );
    let seenUrl: string | null = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/team-site/domains/www.team-site.com",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(updatedDomain);
        },
      ),
    );
    const client = new VercelClient();
    await client.updateProjectDomain("team-site", "www.team-site.com", {
      redirect: "team-site.com",
      redirectStatusCode: 308,
    });
    expect(seenUrl).toContain("teamId=team_a");
  });

  it("legacy: VERCEL_TEAM_ID override forces single team scope", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    stubTeams([{ id: "team_xyz", slug: "xyzteam", name: "XYZ" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_alpha", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    let seenUrl: string | null = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/alpha-site/domains/www.alpha-site.com",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(updatedDomain);
        },
      ),
    );
    const client = new VercelClient();
    await client.updateProjectDomain("alpha-site", "www.alpha-site.com", {
      redirect: "alpha-site.com",
      redirectStatusCode: 308,
    });
    expect(seenUrl).toContain("teamId=team_xyz");
  });

  it("returns parsed updated domain object", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_alpha", name: "alpha-site" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/alpha-site/domains/www.alpha-site.com",
        () => HttpResponse.json(updatedDomain),
      ),
    );
    const client = new VercelClient();
    const result = await client.updateProjectDomain("alpha-site", "www.alpha-site.com", {
      redirect: "alpha-site.com",
      redirectStatusCode: 308,
    });
    expect(result).toEqual(updatedDomain);
  });

  it("URL-encodes idOrName and domain in the path", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [{ id: "prj_weird", name: "weird name" }],
          pagination: { count: 1, next: null },
        }),
      ),
    );
    let seenUrl: string | null = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/weird%20name/domains/www.alpha-site.com",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(updatedDomain);
        },
      ),
    );
    const client = new VercelClient();
    await client.updateProjectDomain("weird name", "www.alpha-site.com", {
      redirect: "alpha-site.com",
      redirectStatusCode: 308,
    });
    expect(seenUrl).toContain("weird%20name");
    expect(seenUrl).toContain("www.alpha-site.com");
  });

  it("throws NotFoundError when project cannot be resolved", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [],
          pagination: { count: 0, next: null },
        }),
      ),
    );
    const client = new VercelClient();
    await expect(
      client.updateProjectDomain("missing", "www.alpha-site.com", {
        redirect: "missing.com",
        redirectStatusCode: 308,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("VercelClient.listDeployments", () => {
  const mockResponse = {
    deployments: [
      {
        uid: "dpl_1",
        name: "alpha-site",
        url: "alpha-site-abc.vercel.app",
        state: "READY",
        createdAt: 1700000000000,
        target: "production",
      },
    ],
    pagination: { count: 1, next: null as string | null },
  };

  it("calls correct URL with bearer header (no projectId, no teamId in personal mode)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v7/deployments", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listDeployments({});
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).not.toContain("projectId=");
    expect(seenUrl).not.toContain("teamId=");
  });

  it("filters by projectId and routes to that project's resolved scope", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_t1", name: "team-site" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [],
          pagination: { count: 0, next: null },
        });
      }),
    );
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v7/deployments", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listDeployments({ projectId: "prj_t1" });
    expect(seenUrl).toContain("projectId=prj_t1");
    expect(seenUrl).toContain("teamId=team_a");
  });

  it("honors limit", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v7/deployments", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listDeployments({ limit: 50 });
    expect(seenUrl).toContain("limit=50");
  });

  it("legacy: VERCEL_TEAM_ID override applied when no projectId given", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    stubTeams([{ id: "team_xyz", slug: "xyzteam", name: "XYZ" }]);
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v7/deployments", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listDeployments({ limit: 20 });
    expect(seenUrl).toContain("teamId=team_xyz");
  });

  it("returns parsed body unchanged", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v7/deployments", () =>
        HttpResponse.json(mockResponse),
      ),
    );
    const client = new VercelClient();
    const result = await client.listDeployments({ limit: 20 });
    expect(result).toEqual(mockResponse);
  });
});

// --- Helpers for the write/mutation surface (resolveProjectStrict-based) -----

// Resolve a single project under team_a (teamId=team_a asserted downstream).
function stubResolveTeam(project: { id: string; name: string }) {
  stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
  server.use(
    http.get("https://api.vercel.com/v9/projects", ({ request }) => {
      const teamId = new URL(request.url).searchParams.get("teamId");
      if (teamId === "team_a") {
        return HttpResponse.json({
          projects: [project],
          pagination: { count: 1, next: null },
        });
      }
      return HttpResponse.json({
        projects: [],
        pagination: { count: 0, next: null },
      });
    }),
  );
}

describe("VercelClient.resolveProjectStrict", () => {
  it("resolves a unique name and derives the team scope", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    const client = new VercelClient();
    const found = await client.resolveProjectStrict("team-site");
    expect(found.scope).toEqual({ kind: "team", id: "team_a", slug: "alpha-team" });
    expect((found.project as { id: string }).id).toBe("prj_t1");
  });

  it("throws AmbiguousMatchError when the same NAME exists in >1 scope", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        // Same name "dup" under both personal and team_a, distinct ids.
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_team_dup", name: "dup" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [{ id: "prj_personal_dup", name: "dup" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    await expect(client.resolveProjectStrict("dup")).rejects.toBeInstanceOf(
      AmbiguousMatchError,
    );
  });

  it("resolves by unique id even when the name is ambiguous", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubTeams([{ id: "team_a", slug: "alpha-team", name: "Alpha Team" }]);
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const teamId = new URL(request.url).searchParams.get("teamId");
        if (teamId === "team_a") {
          return HttpResponse.json({
            projects: [{ id: "prj_team_dup", name: "dup" }],
            pagination: { count: 1, next: null },
          });
        }
        return HttpResponse.json({
          projects: [{ id: "prj_personal_dup", name: "dup" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const found = await client.resolveProjectStrict("prj_team_dup");
    expect(found.scope).toEqual({ kind: "team", id: "team_a", slug: "alpha-team" });
  });

  it("throws NotFoundError when the project cannot be resolved", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    server.use(
      http.get("https://api.vercel.com/v9/projects", () =>
        HttpResponse.json({
          projects: [],
          pagination: { count: 0, next: null },
        }),
      ),
    );
    const client = new VercelClient();
    await expect(
      client.resolveProjectStrict("missing"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("paginates a scope (follows pagination.next as until)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubNoTeams();
    const seenUntil: Array<string | null> = [];
    server.use(
      http.get("https://api.vercel.com/v9/projects", ({ request }) => {
        const until = new URL(request.url).searchParams.get("until");
        seenUntil.push(until);
        if (until === null) {
          return HttpResponse.json({
            projects: [{ id: "prj_1", name: "page1" }],
            pagination: { count: 1, next: 1699999999999 },
          });
        }
        return HttpResponse.json({
          projects: [{ id: "prj_2", name: "page2" }],
          pagination: { count: 1, next: null },
        });
      }),
    );
    const client = new VercelClient();
    const found = await client.resolveProjectStrict("page2");
    expect((found.project as { id: string }).id).toBe("prj_2");
    // First page has no `until`; second page passes the next cursor.
    expect(seenUntil).toEqual([null, "1699999999999"]);
  });
});

describe("VercelClient.listProjectEnv", () => {
  const envResponse = {
    envs: [
      {
        id: "env_1",
        key: "API_KEY",
        type: "encrypted",
        target: ["production"],
        gitBranch: null,
        updatedAt: 1700000000000,
      },
    ],
  };

  it("GET /v10/.../env with bearer + teamId; no decrypt by default", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v10/projects/team-site/env",
        ({ request }) => {
          seenAuth = request.headers.get("authorization");
          seenUrl = request.url;
          return HttpResponse.json(envResponse);
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.listProjectEnv("team-site");
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("teamId=team_a");
    expect(seenUrl).not.toContain("decrypt=");
    expect(result).toEqual(envResponse);
  });

  it("passes decrypt=true and gitBranch when requested", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v10/projects/team-site/env",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json(envResponse);
        },
      ),
    );
    const client = new VercelClient();
    await client.listProjectEnv("team-site", { decrypt: true, gitBranch: "main" });
    expect(seenUrl).toContain("decrypt=true");
    expect(seenUrl).toContain("gitBranch=main");
  });
});

describe("VercelClient.revealProjectEnv", () => {
  it("GET /v1/.../env/{id} with bearer + teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v1/projects/team-site/env/env_1",
        ({ request }) => {
          seenAuth = request.headers.get("authorization");
          seenUrl = request.url;
          return HttpResponse.json({ id: "env_1", key: "API_KEY", value: "s3cret", type: "encrypted" });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.revealProjectEnv("team-site", "env_1");
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("teamId=team_a");
    expect((result as { value: string }).value).toBe("s3cret");
  });
});

describe("VercelClient.upsertProjectEnv", () => {
  it("POST /v10/.../env?upsert=true with body, teamId, bearer", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    let seenBody: unknown = null;
    server.use(
      http.post(
        "https://api.vercel.com/v10/projects/team-site/env",
        async ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          seenBody = await request.json();
          return HttpResponse.json({ created: { id: "env_new" } });
        },
      ),
    );
    const client = new VercelClient();
    await client.upsertProjectEnv("team-site", {
      key: "NEW_KEY",
      value: "v",
      type: "encrypted",
      target: ["production"],
    });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("upsert=true");
    expect(seenUrl).toContain("teamId=team_a");
    expect(seenBody).toEqual({
      key: "NEW_KEY",
      value: "v",
      type: "encrypted",
      target: ["production"],
    });
  });

  it("does NOT retry on 5xx (retries:0 -> single call, throws)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let calls = 0;
    server.use(
      http.post("https://api.vercel.com/v10/projects/team-site/env", () => {
        calls++;
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );
    const client = new VercelClient();
    await expect(
      client.upsertProjectEnv("team-site", { key: "K", value: "v" }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  });
});

describe("VercelClient.updateProjectEnv", () => {
  it("PATCH /v9/.../env/{id} with body, teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    let seenBody: unknown = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/team-site/env/env_1",
        async ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          seenBody = await request.json();
          return HttpResponse.json({ id: "env_1", key: "API_KEY", type: "encrypted" });
        },
      ),
    );
    const client = new VercelClient();
    await client.updateProjectEnv("team-site", "env_1", { value: "rotated" });
    expect(seenMethod).toBe("PATCH");
    expect(seenUrl).toContain("teamId=team_a");
    expect(seenBody).toEqual({ value: "rotated" });
  });
});

describe("VercelClient.deleteProjectEnv", () => {
  it("DELETE /v9/.../env/{id} with teamId; 204 -> undefined", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.delete(
        "https://api.vercel.com/v9/projects/team-site/env/env_1",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.deleteProjectEnv("team-site", "env_1");
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toContain("teamId=team_a");
    expect(result).toBeUndefined();
  });
});

describe("VercelClient.addProjectDomain", () => {
  it("POST /v10/.../domains with body, teamId, bearer", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    let seenBody: unknown = null;
    server.use(
      http.post(
        "https://api.vercel.com/v10/projects/team-site/domains",
        async ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          seenBody = await request.json();
          return HttpResponse.json({ name: "team-site.com", verified: false });
        },
      ),
    );
    const client = new VercelClient();
    await client.addProjectDomain("team-site", { name: "team-site.com" });
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("teamId=team_a");
    expect(seenBody).toEqual({ name: "team-site.com" });
  });

  it("does NOT retry on 5xx (retries:0 -> single call)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let calls = 0;
    server.use(
      http.post("https://api.vercel.com/v10/projects/team-site/domains", () => {
        calls++;
        return HttpResponse.json({ error: "boom" }, { status: 502 });
      }),
    );
    const client = new VercelClient();
    await expect(
      client.addProjectDomain("team-site", { name: "team-site.com" }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  });
});

describe("VercelClient.verifyProjectDomain", () => {
  it("POST /v9/.../domains/{domain}/verify with teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.post(
        "https://api.vercel.com/v9/projects/team-site/domains/team-site.com/verify",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return HttpResponse.json({ verified: true });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.verifyProjectDomain("team-site", "team-site.com");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("teamId=team_a");
    expect(result).toEqual({ verified: true });
  });
});

describe("VercelClient.removeProjectDomain", () => {
  it("DELETE /v9/.../domains/{domain} with teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.delete(
        "https://api.vercel.com/v9/projects/team-site/domains/team-site.com",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return HttpResponse.json({ uid: "dom_1" });
        },
      ),
    );
    const client = new VercelClient();
    await client.removeProjectDomain("team-site", "team-site.com");
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toContain("teamId=team_a");
  });
});

describe("VercelClient.getDeployment", () => {
  it("GET /v13/deployments/{id} with teamId derived from project", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v13/deployments/dpl_1",
        ({ request }) => {
          seenAuth = request.headers.get("authorization");
          seenUrl = request.url;
          return HttpResponse.json({ uid: "dpl_1", readyState: "READY" });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.getDeployment("dpl_1", { project: "team-site" });
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("teamId=team_a");
    expect(result).toEqual({ uid: "dpl_1", readyState: "READY" });
  });
});

describe("VercelClient.getDeploymentEvents", () => {
  it("GET /v3/deployments/{id}/events?follow=0 with teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenUrl: string | null = null;
    server.use(
      http.get(
        "https://api.vercel.com/v3/deployments/dpl_1/events",
        ({ request }) => {
          seenUrl = request.url;
          return HttpResponse.json([{ type: "stdout", text: "build ok" }]);
        },
      ),
    );
    const client = new VercelClient();
    await client.getDeploymentEvents("dpl_1", { project: "team-site" });
    expect(seenUrl).toContain("follow=0");
    expect(seenUrl).toContain("teamId=team_a");
  });
});

describe("VercelClient.createDeployment", () => {
  it("POST /v13/deployments with body + explicit teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    let seenBody: unknown = null;
    server.use(
      http.post("https://api.vercel.com/v13/deployments", async ({ request }) => {
        seenMethod = request.method;
        seenUrl = request.url;
        seenBody = await request.json();
        return HttpResponse.json({ id: "dpl_new", url: "x.vercel.app" });
      }),
    );
    const client = new VercelClient();
    await client.createDeployment(
      { name: "team-site", deploymentId: "dpl_old", target: "preview" },
      { teamId: "team_a" },
    );
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toContain("teamId=team_a");
    expect(seenBody).toEqual({
      name: "team-site",
      deploymentId: "dpl_old",
      target: "preview",
    });
  });

  it("does NOT retry on 5xx (retries:0 -> single call)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let calls = 0;
    server.use(
      http.post("https://api.vercel.com/v13/deployments", () => {
        calls++;
        return HttpResponse.json({ error: "boom" }, { status: 500 });
      }),
    );
    const client = new VercelClient();
    await expect(
      client.createDeployment({ name: "team-site" }, { teamId: "team_a" }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  });
});

describe("VercelClient.promoteDeployment", () => {
  it("POST /v10/.../promote/{dpl} with teamId; empty 201 -> resolves", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.post(
        "https://api.vercel.com/v10/projects/team-site/promote/dpl_1",
        ({ request }) => {
          seenMethod = request.method;
          seenAuth = request.headers.get("authorization");
          seenUrl = request.url;
          return new HttpResponse(null, { status: 201 });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.promoteDeployment("team-site", "dpl_1");
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("teamId=team_a");
    expect(result).toBeUndefined();
  });

  it("does NOT retry on 5xx (single call, throws UpstreamError)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let calls = 0;
    server.use(
      http.post(
        "https://api.vercel.com/v10/projects/team-site/promote/dpl_1",
        () => {
          calls++;
          return HttpResponse.json({ error: "boom" }, { status: 500 });
        },
      ),
    );
    const client = new VercelClient();
    await expect(
      client.promoteDeployment("team-site", "dpl_1"),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  });
});

describe("VercelClient.cancelDeployment", () => {
  it("PATCH /v12/deployments/{id}/cancel with explicit teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v12/deployments/dpl_1/cancel",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return HttpResponse.json({ uid: "dpl_1", state: "CANCELED" });
        },
      ),
    );
    const client = new VercelClient();
    await client.cancelDeployment("dpl_1", { teamId: "team_a" });
    expect(seenMethod).toBe("PATCH");
    expect(seenUrl).toContain("teamId=team_a");
  });
});

describe("VercelClient.deleteDeployment", () => {
  it("DELETE /v13/deployments/{id} with explicit teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.delete(
        "https://api.vercel.com/v13/deployments/dpl_1",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return HttpResponse.json({ uid: "dpl_1", state: "DELETED" });
        },
      ),
    );
    const client = new VercelClient();
    await client.deleteDeployment("dpl_1", { teamId: "team_a" });
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toContain("teamId=team_a");
  });
});

describe("VercelClient.updateProject", () => {
  it("PATCH /v9/projects/{id} with body + teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    let seenBody: unknown = null;
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/team-site",
        async ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          seenBody = await request.json();
          return HttpResponse.json({ id: "prj_t1", name: "team-site" });
        },
      ),
    );
    const client = new VercelClient();
    await client.updateProject("team-site", { framework: "nextjs" });
    expect(seenMethod).toBe("PATCH");
    expect(seenUrl).toContain("teamId=team_a");
    expect(seenBody).toEqual({ framework: "nextjs" });
  });
});

describe("VercelClient.deleteProject", () => {
  it("DELETE /v9/projects/{id} with teamId; 204 -> undefined", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.delete(
        "https://api.vercel.com/v9/projects/team-site",
        ({ request }) => {
          seenMethod = request.method;
          seenUrl = request.url;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.deleteProject("team-site");
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toContain("teamId=team_a");
    expect(result).toBeUndefined();
  });
});

describe("VercelClient.pauseProject / unpauseProject", () => {
  it("pauseProject POSTs /v1/.../pause with teamId; empty 200 -> resolves", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenMethod: string | null = null;
    let seenAuth: string | null = null;
    let seenUrl: string | null = null;
    server.use(
      http.post(
        "https://api.vercel.com/v1/projects/team-site/pause",
        ({ request }) => {
          seenMethod = request.method;
          seenAuth = request.headers.get("authorization");
          seenUrl = request.url;
          return new HttpResponse(null, { status: 200 });
        },
      ),
    );
    const client = new VercelClient();
    const result = await client.pauseProject("team-site");
    expect(seenMethod).toBe("POST");
    expect(seenAuth).toBe("Bearer test_token");
    expect(seenUrl).toContain("teamId=team_a");
    expect(result).toBeUndefined();
  });

  it("unpauseProject POSTs /v1/.../unpause with teamId", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    let seenUrl: string | null = null;
    server.use(
      http.post(
        "https://api.vercel.com/v1/projects/team-site/unpause",
        ({ request }) => {
          seenUrl = request.url;
          return new HttpResponse(null, { status: 200 });
        },
      ),
    );
    const client = new VercelClient();
    await client.unpauseProject("team-site");
    expect(seenUrl).toContain("teamId=team_a");
  });

  it("pauseProject maps 401 to AuthError mentioning VERCEL_TOKEN", async () => {
    process.env.VERCEL_TOKEN = "bad_token";
    stubResolveTeam({ id: "prj_t1", name: "team-site" });
    server.use(
      http.post(
        "https://api.vercel.com/v1/projects/team-site/pause",
        () => HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    const client = new VercelClient();
    try {
      await client.pauseProject("team-site");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).toContain("VERCEL_TOKEN");
    }
  });
});
