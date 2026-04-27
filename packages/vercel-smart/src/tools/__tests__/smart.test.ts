import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { AmbiguousMatchError, NotFoundError } from "smart-mcp-core";
import { smartProject, dailyStatus } from "../smart.js";

type FakeClient = {
  listProjects: ReturnType<typeof vi.fn>;
};

function makeClient(projects: Array<Record<string, unknown>>): FakeClient {
  return {
    listProjects: vi.fn().mockResolvedValue({
      projects,
      pagination: { count: projects.length, next: null },
    }),
  };
}

describe("smartProject — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(smartProject.name).toBe("smart_project");
    expect(smartProject.description).toBe(
      "Resolve a partial project name to a single Vercel project.",
    );
    const parsed = smartProject.inputSchema.parse({ query: "alpha" }) as {
      query: string;
    };
    expect(parsed.query).toBe("alpha");
    expect(smartProject.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects empty query string", () => {
    expect(() => smartProject.inputSchema.parse({ query: "" })).toThrow();
  });

  it("rejects missing query field", () => {
    expect(() => smartProject.inputSchema.parse({})).toThrow();
  });
});

describe("smartProject — resolution", () => {
  it("returns single project on exact name match", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: "nextjs" },
      { id: "prj_b", name: "beta-site", framework: "vite" },
      { id: "prj_g", name: "gamma-site", framework: "remix" },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as { id: string; name: string; framework: string | null };
    expect(result).toEqual({
      id: "prj_a",
      name: "alpha-site",
      framework: "nextjs",
    });
  });

  it("returns single project on fuzzy match above threshold (0.9)", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: "nextjs" },
      { id: "prj_b", name: "beta-site", framework: "vite" },
      { id: "prj_g", name: "gamma-site", framework: "remix" },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-sit" }) as { query: string },
      { client: client as unknown as never },
    )) as { id: string; name: string; framework: string | null };
    expect(result.id).toBe("prj_a");
    expect(result.name).toBe("alpha-site");
  });

  it("strips extra fields from the project shape (only id, name, framework)", async () => {
    const client = makeClient([
      {
        id: "prj_a",
        name: "alpha-site",
        framework: "nextjs",
        accountId: "acc_should_be_stripped",
        env: [{ key: "FOO", value: "bar" }],
        link: { type: "github", repo: "x/y" },
        latestDeployments: [{ url: "alpha.vercel.app" }],
        updatedAt: 1700000000000,
        createdAt: 1699999999999,
      },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["framework", "id", "name"]);
    expect(result).not.toHaveProperty("accountId");
    expect(result).not.toHaveProperty("env");
    expect(result).not.toHaveProperty("link");
    expect(result).not.toHaveProperty("latestDeployments");
    expect(result).not.toHaveProperty("updatedAt");
    expect(result).not.toHaveProperty("createdAt");
  });

  it("returns framework: null when upstream framework is null", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: null },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as { framework: string | null };
    expect(result.framework).toBeNull();
  });

  it("returns framework: null when upstream framework is missing", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site" },
    ]);
    const result = (await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    )) as { framework: string | null };
    expect(result.framework).toBeNull();
  });

  it("throws AmbiguousMatchError when no candidate exceeds threshold", async () => {
    const client = makeClient([
      { id: "prj_1", name: "alpha-staging", framework: "nextjs" },
      { id: "prj_2", name: "alpha-marketing", framework: "nextjs" },
      { id: "prj_3", name: "alpha-prod", framework: "nextjs" },
    ]);
    let caught: unknown;
    try {
      await smartProject.handler(
        smartProject.inputSchema.parse({ query: "alpha" }) as { query: string },
        { client: client as unknown as never },
      );
      expect.fail("should have thrown AmbiguousMatchError");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousMatchError);
    const ambiguous = caught as AmbiguousMatchError;
    expect(ambiguous.candidates.length).toBeLessThanOrEqual(3);
    const labels = ambiguous.candidates.map((c) => c.label);
    expect(labels).toContain("alpha-staging");
    expect(labels).toContain("alpha-marketing");
    expect(labels).toContain("alpha-prod");
  });

  it("throws NotFoundError when project list is empty", async () => {
    const client = makeClient([]);
    let caught: unknown;
    try {
      await smartProject.handler(
        smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
        { client: client as unknown as never },
      );
      expect.fail("should have thrown NotFoundError");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  it("calls client.listProjects with { limit: 100 }", async () => {
    const client = makeClient([
      { id: "prj_a", name: "alpha-site", framework: "nextjs" },
    ]);
    await smartProject.handler(
      smartProject.inputSchema.parse({ query: "alpha-site" }) as { query: string },
      { client: client as unknown as never },
    );
    expect(client.listProjects).toHaveBeenCalledWith({ limit: 100 });
  });
});

type FakeStatusClient = {
  listProjects: ReturnType<typeof vi.fn>;
  listDeployments: ReturnType<typeof vi.fn>;
};

function makeStatusClient(
  projects: Array<Record<string, unknown>>,
  deploymentsByProjectId: Record<string, Array<Record<string, unknown>>>,
): FakeStatusClient {
  return {
    listProjects: vi.fn().mockResolvedValue({
      projects,
      pagination: { count: projects.length, next: null },
    }),
    listDeployments: vi.fn().mockImplementation(
      async ({ projectId }: { projectId: string; limit?: number }) => ({
        deployments: deploymentsByProjectId[projectId] ?? [],
      }),
    ),
  };
}

const NOW = 1_700_000_000_000;

describe("dailyStatus — metadata & schema", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has correct name, description, and zod input schema with default hours=24", () => {
    expect(dailyStatus.name).toBe("daily_status");
    expect(dailyStatus.description).toBe(
      "24h deploy + project health snapshot across all Vercel projects.",
    );
    const parsed = dailyStatus.inputSchema.parse({}) as { hours: number };
    expect(parsed.hours).toBe(24);
    expect(dailyStatus.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("rejects hours below 1 and above 720; accepts 24 and 720", () => {
    expect(() => dailyStatus.inputSchema.parse({ hours: 0 })).toThrow();
    expect(() => dailyStatus.inputSchema.parse({ hours: 721 })).toThrow();
    expect(() => dailyStatus.inputSchema.parse({ hours: 24 })).not.toThrow();
    expect(() => dailyStatus.inputSchema.parse({ hours: 720 })).not.toThrow();
  });
});

describe("dailyStatus — handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls listProjects with { limit: 100 }", async () => {
    const client = makeStatusClient([], {});
    await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    );
    expect(client.listProjects).toHaveBeenCalledWith({ limit: 100 });
  });

  it("calls listDeployments per project with { projectId, limit: 20 }", async () => {
    const client = makeStatusClient(
      [
        { id: "prj_a", name: "alpha-site", updatedAt: NOW },
        { id: "prj_b", name: "beta-site", updatedAt: NOW },
      ],
      { prj_a: [], prj_b: [] },
    );
    await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    );
    expect(client.listDeployments).toHaveBeenCalledTimes(2);
    expect(client.listDeployments).toHaveBeenNthCalledWith(1, {
      projectId: "prj_a",
      limit: 20,
    });
    expect(client.listDeployments).toHaveBeenNthCalledWith(2, {
      projectId: "prj_b",
      limit: 20,
    });
  });

  it("echoes hours; defaults to 24 when omitted", async () => {
    const client = makeStatusClient([], {});
    const out48 = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 48 }) as { hours: number },
      { client: client as unknown as never },
    )) as { window_hours: number };
    expect(out48.window_hours).toBe(48);

    const outDef = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { window_hours: number };
    expect(outDef.window_hours).toBe(24);
  });

  it("project_count matches projects length", async () => {
    const client = makeStatusClient(
      [
        { id: "prj_a", name: "alpha-site", updatedAt: NOW },
        { id: "prj_b", name: "beta-site", updatedAt: NOW },
        { id: "prj_g", name: "gamma-site", updatedAt: NOW },
      ],
      { prj_a: [], prj_b: [], prj_g: [] },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { project_count: number };
    expect(out.project_count).toBe(3);
  });

  it("buckets by state correctly (READY/ERROR/BUILDING/QUEUED/CANCELED)", async () => {
    const t = NOW - 1 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: NOW }],
      {
        prj_a: [
          { uid: "d1", name: "alpha-site", url: "alpha-site-1.vercel.app", state: "READY", createdAt: t, target: "production" },
          { uid: "d2", name: "alpha-site", url: "alpha-site-2.vercel.app", state: "ERROR", createdAt: t, target: "production" },
          { uid: "d3", name: "alpha-site", url: "alpha-site-3.vercel.app", state: "BUILDING", createdAt: t, target: "production" },
          { uid: "d4", name: "alpha-site", url: "alpha-site-4.vercel.app", state: "QUEUED", createdAt: t, target: "production" },
          { uid: "d5", name: "alpha-site", url: "alpha-site-5.vercel.app", state: "CANCELED", createdAt: t, target: "production" },
        ],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as {
      by_project: Array<{ ready: number; error: number; building: number; canceled: number }>;
    };
    expect(out.by_project[0].ready).toBe(1);
    expect(out.by_project[0].error).toBe(1);
    expect(out.by_project[0].building).toBe(2);
    expect(out.by_project[0].canceled).toBe(1);
  });

  it("ignores out-of-window deployments and picks latest in-window for `latest`", async () => {
    const inWindow = NOW - 1 * 3600 * 1000;
    const outOfWindow = NOW - 100 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: NOW }],
      {
        prj_a: [
          { uid: "old", name: "alpha-site", url: "alpha-site-old.vercel.app", state: "READY", createdAt: outOfWindow, target: "production" },
          { uid: "new", name: "alpha-site", url: "alpha-site-new.vercel.app", state: "READY", createdAt: inWindow, target: "production" },
        ],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({ hours: 24 }) as { hours: number },
      { client: client as unknown as never },
    )) as {
      by_project: Array<{ ready: number; latest: { state: string; createdAt: number; url: string; target: string | null } | null }>;
      deployments: { total: number; ready: number };
    };
    expect(out.by_project[0].ready).toBe(1);
    expect(out.deployments.total).toBe(1);
    expect(out.by_project[0].latest).not.toBeNull();
    expect(out.by_project[0].latest!.url).toBe("alpha-site-new.vercel.app");
    expect(out.by_project[0].latest!.createdAt).toBe(inWindow);
  });

  it("latest is highest createdAt deploy in window", async () => {
    const t1 = NOW - 5 * 3600 * 1000;
    const t2 = NOW - 3 * 3600 * 1000;
    const t3 = NOW - 1 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: NOW }],
      {
        prj_a: [
          { uid: "d1", name: "alpha-site", url: "alpha-site-1.vercel.app", state: "READY", createdAt: t1, target: "production" },
          { uid: "d3", name: "alpha-site", url: "alpha-site-3.vercel.app", state: "ERROR", createdAt: t3, target: "production" },
          { uid: "d2", name: "alpha-site", url: "alpha-site-2.vercel.app", state: "BUILDING", createdAt: t2, target: "production" },
        ],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as {
      by_project: Array<{ latest: { state: string; createdAt: number; url: string; target: string | null } | null }>;
    };
    expect(out.by_project[0].latest!.createdAt).toBe(t3);
    expect(out.by_project[0].latest!.url).toBe("alpha-site-3.vercel.app");
    expect(out.by_project[0].latest!.state).toBe("ERROR");
  });

  it("latest is null when no in-window deploys; project still appears with zero counts", async () => {
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: NOW }],
      { prj_a: [] },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as {
      by_project: Array<{
        project: string;
        ready: number;
        error: number;
        latest: unknown;
      }>;
    };
    expect(out.by_project).toHaveLength(1);
    expect(out.by_project[0].project).toBe("alpha-site");
    expect(out.by_project[0].ready).toBe(0);
    expect(out.by_project[0].error).toBe(0);
    expect(out.by_project[0].latest).toBeNull();
  });

  it("aggregated `deployments` totals match sum of per-project", async () => {
    const t = NOW - 1 * 3600 * 1000;
    const mk = (state: string, uid: string) => ({
      uid,
      name: "x",
      url: `${uid}.vercel.app`,
      state,
      createdAt: t,
      target: "production",
    });
    const client = makeStatusClient(
      [
        { id: "prj_a", name: "alpha-site", updatedAt: NOW },
        { id: "prj_b", name: "beta-site", updatedAt: NOW },
      ],
      {
        prj_a: [mk("READY", "a1"), mk("READY", "a2"), mk("ERROR", "a3")],
        prj_b: [mk("READY", "b1"), mk("READY", "b2"), mk("ERROR", "b3")],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as {
      deployments: { total: number; ready: number; error: number; building: number; canceled: number };
    };
    expect(out.deployments.ready).toBe(4);
    expect(out.deployments.error).toBe(2);
    expect(out.deployments.total).toBe(6);
  });

  it("flags errored project with correct count in reason", async () => {
    const t = NOW - 1 * 3600 * 1000;
    const mkErr = (uid: string) => ({
      uid,
      name: "alpha-site",
      url: `${uid}.vercel.app`,
      state: "ERROR",
      createdAt: t,
      target: "production",
    });
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: NOW }],
      { prj_a: [mkErr("e1"), mkErr("e2"), mkErr("e3")] },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { flagged: Array<{ project: string; reason: string }> };
    expect(out.flagged).toContainEqual({
      project: "alpha-site",
      reason: "had 3 errored deploys in window",
    });
  });

  it("flags stale project (no activity in 7 days)", async () => {
    const eightDaysAgo = NOW - 8 * 24 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: eightDaysAgo }],
      { prj_a: [] },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { flagged: Array<{ project: string; reason: string }> };
    expect(out.flagged).toContainEqual({
      project: "alpha-site",
      reason: "no deploy activity in 7 days",
    });
  });

  it("errored takes precedence over stale (one flag entry, error reason)", async () => {
    const t = NOW - 1 * 3600 * 1000;
    const eightDaysAgo = NOW - 8 * 24 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: eightDaysAgo }],
      {
        prj_a: [
          { uid: "e1", name: "alpha-site", url: "e1.vercel.app", state: "ERROR", createdAt: t, target: "production" },
        ],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { flagged: Array<{ project: string; reason: string }> };
    const forAlpha = out.flagged.filter((f) => f.project === "alpha-site");
    expect(forAlpha).toHaveLength(1);
    expect(forAlpha[0].reason).toContain("errored deploys");
  });

  it("recently-updated project with no in-window deploys is NOT flagged", async () => {
    const oneDayAgo = NOW - 1 * 24 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: oneDayAgo }],
      { prj_a: [] },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { flagged: Array<{ project: string }> };
    expect(out.flagged.find((f) => f.project === "alpha-site")).toBeUndefined();
  });

  it("by_project contains every project even without in-window deploys", async () => {
    const t = NOW - 1 * 3600 * 1000;
    const client = makeStatusClient(
      [
        { id: "prj_a", name: "alpha-site", updatedAt: NOW },
        { id: "prj_b", name: "beta-site", updatedAt: NOW },
        { id: "prj_g", name: "gamma-site", updatedAt: NOW },
      ],
      {
        prj_a: [
          { uid: "d1", name: "alpha-site", url: "alpha-site-1.vercel.app", state: "READY", createdAt: t, target: "production" },
        ],
        prj_b: [],
        prj_g: [],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as { by_project: Array<{ project: string }> };
    expect(out.by_project).toHaveLength(3);
    const names = out.by_project.map((p) => p.project).sort();
    expect(names).toEqual(["alpha-site", "beta-site", "gamma-site"]);
  });

  it("latest slim shape strips extra fields (only state, createdAt, url, target)", async () => {
    const t = NOW - 1 * 3600 * 1000;
    const client = makeStatusClient(
      [{ id: "prj_a", name: "alpha-site", updatedAt: NOW }],
      {
        prj_a: [
          {
            uid: "d_should_strip",
            name: "alpha-site",
            url: "alpha-site-abc.vercel.app",
            state: "READY",
            createdAt: t,
            target: "production",
            meta: { foo: "bar" },
            buildingAt: 12345,
          },
        ],
      },
    );
    const out = (await dailyStatus.handler(
      dailyStatus.inputSchema.parse({}) as { hours: number },
      { client: client as unknown as never },
    )) as {
      by_project: Array<{ latest: Record<string, unknown> | null }>;
    };
    const latest = out.by_project[0].latest!;
    expect(Object.keys(latest).sort()).toEqual(["createdAt", "state", "target", "url"]);
  });
});
