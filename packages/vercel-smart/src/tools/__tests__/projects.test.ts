import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { ConfirmRequiredError, PermissionError } from "smart-mcp-core";
import { listProjects } from "../projects.js";
import {
  listTeams,
  updateProjectSettings,
  pauseProject,
  unpauseProject,
  deleteProject,
} from "../projects-admin.js";

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

// ======================================================================
// projects-admin.ts — list_teams, update_project_settings, pause/unpause,
// delete_project
// ======================================================================

const PROD_ENV = "VERCEL_SMART_ALLOW_PROD";
const ALLOWLIST_ENV = "VERCEL_SMART_ALLOWED_PROJECTS";

// Snapshot + clear the prod-gate env vars so a test starts from a known,
// gate-closed state; the returned fn restores whatever the runner had.
function cleanProdEnv(): () => void {
  const origProd = process.env[PROD_ENV];
  const origAllow = process.env[ALLOWLIST_ENV];
  delete process.env[PROD_ENV];
  delete process.env[ALLOWLIST_ENV];
  return () => {
    if (origProd === undefined) delete process.env[PROD_ENV];
    else process.env[PROD_ENV] = origProd;
    if (origAllow === undefined) delete process.env[ALLOWLIST_ENV];
    else process.env[ALLOWLIST_ENV] = origAllow;
  };
}

type AdminClient = {
  resolveProjectStrict: ReturnType<typeof vi.fn>;
  updateProject: ReturnType<typeof vi.fn>;
  pauseProject: ReturnType<typeof vi.fn>;
  unpauseProject: ReturnType<typeof vi.fn>;
  deleteProject: ReturnType<typeof vi.fn>;
};

function makeAdminClient(opts: {
  project?: Record<string, unknown>;
  scope?: { kind: "personal" } | { kind: "team"; id: string; slug: string };
  updated?: Record<string, unknown>;
} = {}): AdminClient {
  const project = opts.project ?? { id: "prj_alpha", name: "alpha-site" };
  const scope = opts.scope ?? { kind: "personal" as const };
  return {
    resolveProjectStrict: vi.fn().mockResolvedValue({ project, scope }),
    updateProject: vi.fn().mockResolvedValue(opts.updated ?? project),
    pauseProject: vi.fn().mockResolvedValue(undefined),
    unpauseProject: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(undefined),
  };
}

async function callTool(
  tool: { inputSchema: z.ZodType<never>; handler: (input: never, ctx: never) => Promise<unknown> },
  raw: Record<string, unknown>,
  client: unknown,
): Promise<unknown> {
  const input = tool.inputSchema.parse(raw as never);
  return await tool.handler(input as never, { client } as never);
}

// ---------- list_teams ----------

describe("listTeams", () => {
  it("has correct name, description, and zod input schema", () => {
    expect(listTeams.name).toBe("list_teams");
    expect(listTeams.description).toBe("List Vercel teams the token can access.");
    expect(listTeams.inputSchema).toBeInstanceOf(z.ZodType);
    expect(listTeams.inputSchema.parse({})).toEqual({});
  });

  it("maps teams to slim {id, slug, name} and counts them", async () => {
    const client = {
      listTeams: vi.fn().mockResolvedValue({
        teams: [
          { id: "team_a", slug: "alpha", name: "Alpha Inc", extra: "drop-me" },
          { id: "team_b", slug: "beta", name: "Beta LLC" },
        ],
      }),
    };
    const result = (await callTool(
      listTeams as never,
      {},
      client,
    )) as { teams: Array<Record<string, unknown>>; count: number };
    expect(result.count).toBe(2);
    expect(result.teams[0]).toEqual({ id: "team_a", slug: "alpha", name: "Alpha Inc" });
    expect(result.teams[0]).not.toHaveProperty("extra");
  });

  it("returns empty list when upstream omits teams", async () => {
    const client = { listTeams: vi.fn().mockResolvedValue({}) };
    const result = (await callTool(listTeams as never, {}, client)) as {
      teams: unknown[];
      count: number;
    };
    expect(result.teams).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// ---------- update_project_settings ----------

describe("updateProjectSettings", () => {
  it("has correct name and zod input schema with confirm default false", () => {
    expect(updateProjectSettings.name).toBe("update_project_settings");
    expect(updateProjectSettings.inputSchema).toBeInstanceOf(z.ZodType);
    const parsed = updateProjectSettings.inputSchema.parse({ project: "alpha-site" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("rejects empty project string", () => {
    expect(() => updateProjectSettings.inputSchema.parse({ project: "" })).toThrow();
  });

  it("resolves strictly (M5) with the input project", async () => {
    const client = makeAdminClient({
      project: { id: "prj_alpha", name: "alpha-site", framework: "nextjs" },
    });
    await callTool(updateProjectSettings as never, { project: "alpha-site" }, client);
    expect(client.resolveProjectStrict).toHaveBeenCalledWith("alpha-site");
  });

  it("no-op when the requested setting already matches (no confirm needed, no PATCH)", async () => {
    const client = makeAdminClient({
      project: { id: "prj_alpha", name: "alpha-site", framework: "nextjs" },
    });
    const result = (await callTool(
      updateProjectSettings as never,
      { project: "alpha-site", framework: "nextjs", confirm: false },
      client,
    )) as { ok: boolean; changes: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([]);
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it("no-op when no setting fields are provided at all", async () => {
    const client = makeAdminClient({
      project: { id: "prj_alpha", name: "alpha-site", framework: "nextjs" },
    });
    const result = (await callTool(
      updateProjectSettings as never,
      { project: "alpha-site" },
      client,
    )) as { changes: unknown[] };
    expect(result.changes).toEqual([]);
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it("confirm:false throws ConfirmRequiredError with a diff preview; no PATCH", async () => {
    const client = makeAdminClient({
      project: { id: "prj_alpha", name: "alpha-site", framework: "nextjs" },
    });
    let caught: unknown = null;
    try {
      await callTool(
        updateProjectSettings as never,
        { project: "alpha-site", framework: "vite", confirm: false },
        client,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const preview = (caught as ConfirmRequiredError).preview ?? "";
    expect(preview).toContain("framework");
    expect(preview).toContain("nextjs");
    expect(preview).toContain("vite");
    expect(client.updateProject).not.toHaveBeenCalled();
  });

  it("confirm:true PATCHes only the changed fields and reports before/after", async () => {
    const client = makeAdminClient({
      project: {
        id: "prj_alpha",
        name: "alpha-site",
        framework: "nextjs",
        buildCommand: null,
      },
      updated: {
        id: "prj_alpha",
        name: "alpha-site",
        framework: "vite",
        buildCommand: "npm run build",
      },
    });
    const result = (await callTool(
      updateProjectSettings as never,
      {
        project: "alpha-site",
        framework: "vite",
        buildCommand: "npm run build",
        devCommand: undefined,
        confirm: true,
      },
      client,
    )) as {
      changes: Array<{ field: string; before: unknown; after: unknown }>;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    // Only the two changed fields are sent — no devCommand/rootDirectory/etc.
    expect(client.updateProject).toHaveBeenCalledWith("alpha-site", {
      framework: "vite",
      buildCommand: "npm run build",
    });
    const fields = result.changes.map((c) => c.field).sort();
    expect(fields).toEqual(["buildCommand", "framework"]);
    expect(result.before.framework).toBe("nextjs");
    expect(result.after.framework).toBe("vite");
    expect(result.before.buildCommand).toBeNull();
    expect(result.after.buildCommand).toBe("npm run build");
  });

  it("treats a missing current field as null when diffing (null -> null is a no-op)", async () => {
    const client = makeAdminClient({
      project: { id: "prj_alpha", name: "alpha-site" }, // buildCommand absent
    });
    const result = (await callTool(
      updateProjectSettings as never,
      { project: "alpha-site", buildCommand: null, confirm: true },
      client,
    )) as { changes: unknown[] };
    expect(result.changes).toEqual([]);
    expect(client.updateProject).not.toHaveBeenCalled();
  });
});

// ---------- pause_project ----------

describe("pauseProject — prod gate, strict resolve, confirm gate", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = cleanProdEnv();
  });
  afterEach(() => {
    restore();
  });

  it("has correct name and confirm default false", () => {
    expect(pauseProject.name).toBe("pause_project");
    const parsed = pauseProject.inputSchema.parse({ project: "alpha-site" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("blocks with PermissionError when VERCEL_SMART_ALLOW_PROD is unset (never resolves or pauses)", async () => {
    const client = makeAdminClient();
    let caught: unknown = null;
    try {
      await callTool(
        pauseProject as never,
        { project: "alpha-site", confirm: true },
        client,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect(client.resolveProjectStrict).not.toHaveBeenCalled();
    expect(client.pauseProject).not.toHaveBeenCalled();
  });

  it("prod allowed but confirm:false throws ConfirmRequiredError; no pause call", async () => {
    process.env[PROD_ENV] = "1";
    const client = makeAdminClient();
    let caught: unknown = null;
    try {
      await callTool(
        pauseProject as never,
        { project: "alpha-site", confirm: false },
        client,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    expect((caught as ConfirmRequiredError).preview).toContain("alpha-site");
    expect(client.pauseProject).not.toHaveBeenCalled();
  });

  it("prod allowed + confirm:true pauses the project", async () => {
    process.env[PROD_ENV] = "1";
    const client = makeAdminClient();
    const result = (await callTool(
      pauseProject as never,
      { project: "alpha-site", confirm: true },
      client,
    )) as { ok: boolean; paused: boolean };
    expect(client.pauseProject).toHaveBeenCalledWith("alpha-site");
    expect(result).toMatchObject({ ok: true, paused: true, project: "alpha-site" });
  });

  it("allowlist mismatch is blocked even with the prod flag set", async () => {
    process.env[PROD_ENV] = "1";
    process.env[ALLOWLIST_ENV] = "some-other-project";
    const client = makeAdminClient();
    let caught: unknown = null;
    try {
      await callTool(
        pauseProject as never,
        { project: "alpha-site", confirm: true },
        client,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect(client.pauseProject).not.toHaveBeenCalled();
  });
});

// ---------- unpause_project ----------

describe("unpauseProject — prod gate, no confirm", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = cleanProdEnv();
  });
  afterEach(() => {
    restore();
  });

  it("blocks with PermissionError when the prod gate is closed (never unpauses)", async () => {
    const client = makeAdminClient();
    let caught: unknown = null;
    try {
      await callTool(unpauseProject as never, { project: "alpha-site" }, client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect(client.unpauseProject).not.toHaveBeenCalled();
  });

  it("prod allowed: unpauses with no confirm required", async () => {
    process.env[PROD_ENV] = "1";
    const client = makeAdminClient();
    const result = (await callTool(
      unpauseProject as never,
      { project: "alpha-site" },
      client,
    )) as { ok: boolean; paused: boolean };
    expect(client.unpauseProject).toHaveBeenCalledWith("alpha-site");
    expect(result).toMatchObject({ ok: true, paused: false, project: "alpha-site" });
  });
});

// ---------- delete_project ----------

describe("deleteProject — prod gate + confirm, strong preview", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = cleanProdEnv();
  });
  afterEach(() => {
    restore();
  });

  it("has correct name and confirm default false", () => {
    expect(deleteProject.name).toBe("delete_project");
    const parsed = deleteProject.inputSchema.parse({ project: "alpha-site" }) as {
      confirm: boolean;
    };
    expect(parsed.confirm).toBe(false);
  });

  it("blocks with PermissionError when the prod gate is closed (never resolves or deletes)", async () => {
    const client = makeAdminClient();
    let caught: unknown = null;
    try {
      await callTool(
        deleteProject as never,
        { project: "alpha-site", confirm: true },
        client,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionError);
    expect(client.resolveProjectStrict).not.toHaveBeenCalled();
    expect(client.deleteProject).not.toHaveBeenCalled();
  });

  it("prod allowed but confirm:false throws ConfirmRequiredError with a strong preview naming the project + team", async () => {
    process.env[PROD_ENV] = "1";
    const client = makeAdminClient({
      project: { id: "prj_alpha", name: "alpha-site" },
      scope: { kind: "team", id: "team_x", slug: "gamma-team" },
    });
    let caught: unknown = null;
    try {
      await callTool(
        deleteProject as never,
        { project: "alpha-site", confirm: false },
        client,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmRequiredError);
    const preview = (caught as ConfirmRequiredError).preview ?? "";
    expect(preview).toContain("alpha-site");
    expect(preview).toContain("prj_alpha");
    expect(preview).toContain("gamma-team");
    expect(preview.toUpperCase()).toContain("IRREVERSIBLE");
    expect(client.deleteProject).not.toHaveBeenCalled();
  });

  it("prod allowed + confirm:true deletes the project", async () => {
    process.env[PROD_ENV] = "1";
    const client = makeAdminClient();
    const result = (await callTool(
      deleteProject as never,
      { project: "alpha-site", confirm: true },
      client,
    )) as { ok: boolean; deleted: boolean };
    expect(client.deleteProject).toHaveBeenCalledWith("alpha-site");
    expect(result).toMatchObject({ ok: true, deleted: true, project: "alpha-site" });
  });
});
