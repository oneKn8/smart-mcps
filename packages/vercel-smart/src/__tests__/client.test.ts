import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { AuthError, NotFoundError, RateLimitError } from "smart-mcp-core";
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
      http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
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
      http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
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
      http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
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
      http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
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
      http.get("https://api.vercel.com/v6/deployments", () =>
        HttpResponse.json(mockResponse),
      ),
    );
    const client = new VercelClient();
    const result = await client.listDeployments({ limit: 20 });
    expect(result).toEqual(mockResponse);
  });
});
