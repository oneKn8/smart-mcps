import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { listProjects } from "../projects.js";

type FakeClient = {
  listProjects: ReturnType<typeof vi.fn>;
};

function makeClient(response: { projects: Array<Record<string, unknown>>; pagination?: unknown }): FakeClient {
  return {
    listProjects: vi.fn().mockResolvedValue({
      pagination: { count: response.projects.length, next: null },
      ...response,
    }),
  };
}

describe("listProjects — metadata", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listProjects.name).toBe("list_projects");
    expect(listProjects.description).toBe(
      "List Vercel projects across all accessible teams.",
    );
    // smoke check: parsing an empty object should succeed because limit has a default
    const parsed = listProjects.inputSchema.parse({}) as { limit: number };
    expect(parsed.limit).toBe(50);
    // schema should be a zod schema
    expect(listProjects.inputSchema).toBeInstanceOf(z.ZodType);
  });
});

describe("listProjects — limit handling", () => {
  it("passes default limit of 50 to client when omitted", async () => {
    const client = makeClient({ projects: [] });
    await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    );
    expect(client.listProjects).toHaveBeenCalledWith({ limit: 50 });
  });

  it("passes custom limit through to client", async () => {
    const client = makeClient({ projects: [] });
    await listProjects.handler(
      listProjects.inputSchema.parse({ limit: 10 }) as { limit: number },
      { client: client as unknown as never },
    );
    expect(client.listProjects).toHaveBeenCalledWith({ limit: 10 });
  });

  it("throws when limit is below the minimum (0)", () => {
    expect(() => listProjects.inputSchema.parse({ limit: 0 })).toThrow();
  });

  it("throws when limit exceeds the maximum (200)", () => {
    expect(() => listProjects.inputSchema.parse({ limit: 200 })).toThrow();
  });

  it("throws when limit is exactly 101 (upper bound enforced)", () => {
    expect(() => listProjects.inputSchema.parse({ limit: 101 })).toThrow();
  });
});

describe("listProjects — output mapping", () => {
  it("maps project fields to slim shape with all 5 fields populated", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_alpha",
          name: "alpha-site",
          framework: "nextjs",
          updatedAt: 1700000000000,
          latestDeployments: [
            { url: "alpha.vercel.app", state: "READY", createdAt: 1700000001000 },
          ],
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as {
      projects: Array<{
        id: string;
        name: string;
        framework: string | null;
        updatedAt: number;
        latestDeploymentUrl: string | null;
      }>;
      count: number;
    };
    expect(result.projects[0]).toEqual({
      id: "prj_alpha",
      name: "alpha-site",
      framework: "nextjs",
      updatedAt: 1700000000000,
      latestDeploymentUrl: "alpha.vercel.app",
      team: "personal",
    });
  });

  it("returns latestDeploymentUrl=null when latestDeployments is empty array", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_beta",
          name: "beta-site",
          framework: null,
          updatedAt: 1700000002000,
          latestDeployments: [],
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { projects: Array<{ latestDeploymentUrl: string | null }> };
    expect(result.projects[0]?.latestDeploymentUrl).toBeNull();
  });

  it("returns latestDeploymentUrl=null when latestDeployments is missing", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_gamma",
          name: "gamma-site",
          framework: "vite",
          updatedAt: 1700000003000,
          // latestDeployments intentionally omitted
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { projects: Array<{ latestDeploymentUrl: string | null }> };
    expect(result.projects[0]?.latestDeploymentUrl).toBeNull();
  });

  it("count matches projects.length", async () => {
    const client = makeClient({
      projects: [
        { id: "prj_a", name: "alpha-site", framework: null, updatedAt: 1 },
        { id: "prj_b", name: "beta-site", framework: null, updatedAt: 2 },
        { id: "prj_c", name: "gamma-site", framework: null, updatedAt: 3 },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { count: number; projects: unknown[] };
    expect(result.count).toBe(3);
    expect(result.projects).toHaveLength(3);
  });

  it("strips extra fields from project objects (only 5 allowed keys)", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_alpha",
          name: "alpha-site",
          framework: "nextjs",
          updatedAt: 1700000000000,
          latestDeployments: [
            { url: "alpha.vercel.app", state: "READY", createdAt: 1 },
          ],
          // Extra Vercel fields that should NOT pass through:
          accountId: "acc_should_be_stripped",
          env: [{ key: "FOO", value: "bar" }],
          link: { type: "github", repo: "x/y" },
          createdAt: 1699999999999,
          targets: { production: { id: "dpl_xyz" } },
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { projects: Array<Record<string, unknown>> };

    const project = result.projects[0]!;
    const keys = Object.keys(project).sort();
    expect(keys).toEqual(
      ["framework", "id", "latestDeploymentUrl", "name", "team", "updatedAt"].sort(),
    );
    // Belt-and-suspenders: explicitly assert each forbidden field is absent.
    expect(project).not.toHaveProperty("accountId");
    expect(project).not.toHaveProperty("env");
    expect(project).not.toHaveProperty("link");
    expect(project).not.toHaveProperty("createdAt");
    expect(project).not.toHaveProperty("targets");
    expect(project).not.toHaveProperty("latestDeployments");
  });
});

describe("listProjects — team field (multi-team support)", () => {
  it("propagates upstream team field (slug for team projects)", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_team",
          name: "team-site",
          framework: "nextjs",
          updatedAt: 1700000000000,
          latestDeployments: [],
          team: "alpha-team",
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { projects: Array<{ team: string }> };
    expect(result.projects[0]?.team).toBe("alpha-team");
  });

  it("defaults team='personal' when upstream omits it", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_p",
          name: "personal-site",
          framework: null,
          updatedAt: 1700000000000,
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { projects: Array<{ team: string }> };
    expect(result.projects[0]?.team).toBe("personal");
  });

  it("preserves per-row team assignment across mixed projects", async () => {
    const client = makeClient({
      projects: [
        {
          id: "prj_p",
          name: "personal-site",
          framework: null,
          updatedAt: 1,
          team: "personal",
        },
        {
          id: "prj_t",
          name: "team-site",
          framework: null,
          updatedAt: 2,
          team: "alpha-team",
        },
      ],
    });
    const result = (await listProjects.handler(
      listProjects.inputSchema.parse({}) as { limit: number },
      { client: client as unknown as never },
    )) as { projects: Array<{ name: string; team: string }> };
    const byName = Object.fromEntries(result.projects.map((p) => [p.name, p.team]));
    expect(byName["personal-site"]).toBe("personal");
    expect(byName["team-site"]).toBe("alpha-team");
  });
});
