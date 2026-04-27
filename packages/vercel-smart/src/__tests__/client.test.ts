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

  it("calls correct URL with bearer header", async () => {
    process.env.VERCEL_TOKEN = "test_token";
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
  });

  it("includes teamId when VERCEL_TEAM_ID is set", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
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

  it("maps 404 to NotFoundError mentioning the project name", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    server.use(
      http.get(
        "https://api.vercel.com/v9/projects/missing-project/domains",
        () =>
          HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );
    const client = new VercelClient();
    try {
      await client.listProjectDomains("missing-project");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as Error).message).toContain("Project not found: missing-project");
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

  it("calls correct PATCH URL with bearer header, JSON content-type, and JSON body", async () => {
    process.env.VERCEL_TOKEN = "test_token";
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
  });

  it("includes teamId when VERCEL_TEAM_ID is set", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
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

  it("maps 404 to NotFoundError", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    server.use(
      http.patch(
        "https://api.vercel.com/v9/projects/missing/domains/www.alpha-site.com",
        () => HttpResponse.json({ error: "not found" }, { status: 404 }),
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

  it("calls correct URL with bearer header (no projectId filter when not given)", async () => {
    process.env.VERCEL_TOKEN = "test_token";
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
  });

  it("filters by projectId when given", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listDeployments({ projectId: "prj_alpha" });
    expect(seenUrl).toContain("projectId=prj_alpha");
  });

  it("honors limit", async () => {
    process.env.VERCEL_TOKEN = "test_token";
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

  it("includes teamId when VERCEL_TEAM_ID is set", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    let seenUrl: string | null = null;
    server.use(
      http.get("https://api.vercel.com/v6/deployments", ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(mockResponse);
      }),
    );
    const client = new VercelClient();
    await client.listDeployments({ projectId: "prj_alpha", limit: 20 });
    expect(seenUrl).toContain("teamId=team_xyz");
  });

  it("returns parsed body unchanged", async () => {
    process.env.VERCEL_TOKEN = "test_token";
    server.use(
      http.get("https://api.vercel.com/v6/deployments", () =>
        HttpResponse.json(mockResponse),
      ),
    );
    const client = new VercelClient();
    const result = await client.listDeployments({ projectId: "prj_alpha", limit: 20 });
    expect(result).toEqual(mockResponse);
  });
});
