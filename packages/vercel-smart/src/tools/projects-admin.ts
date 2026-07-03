import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { VercelClient } from "../client.js";
import { assertProdAllowed } from "../safety.js";

type Context = {
  client: VercelClient;
};

// Local formatter for previews. canonical.ts keeps its own private copy; a tiny
// display helper is not a shared domain constant, and extracting it would mean
// touching another module.
function formatVal(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `'${v}'`;
  return String(v);
}

// ---------- list_teams (read, no gate) ----------

const listTeamsSchema = z.object({});

type ListTeamsInput = z.infer<typeof listTeamsSchema>;

interface SlimTeam {
  id: string;
  slug: string;
  name: string;
}

interface ListTeamsOutput {
  teams: SlimTeam[];
  count: number;
}

export const listTeams = defineTool<ListTeamsInput, ListTeamsOutput, Context>({
  name: "list_teams",
  description: "List Vercel teams the token can access.",
  inputSchema: listTeamsSchema,
  handler: async (_input, context) => {
    const { teams } = await context.client.listTeams();
    const list = teams ?? [];
    return {
      teams: list.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
      count: list.length,
    };
  },
});

// ---------- update_project_settings (guardDestructive, no prod gate) ----------

// The only settings this tool is allowed to touch. passwordProtection, secrets,
// and any auth-bearing field are deliberately excluded — a settings tool must
// not be a back door for changing who can reach the project.
const SETTING_FIELDS = [
  "framework",
  "buildCommand",
  "devCommand",
  "outputDirectory",
  "rootDirectory",
  "nodeVersion",
] as const;

type SettingField = (typeof SETTING_FIELDS)[number];

const updateProjectSettingsSchema = z.object({
  project: z.string().min(1),
  framework: z.string().min(1).nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  devCommand: z.string().nullable().optional(),
  outputDirectory: z.string().nullable().optional(),
  rootDirectory: z.string().nullable().optional(),
  nodeVersion: z.string().min(1).optional(),
  confirm: z.boolean().optional().default(false),
});

type UpdateProjectSettingsInput = z.output<typeof updateProjectSettingsSchema>;

interface SettingChange {
  field: SettingField;
  before: string | null;
  after: string | null;
}

interface UpdateProjectSettingsOutput {
  ok: boolean;
  project: string;
  id: string;
  changes: SettingChange[];
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

function normalizeSetting(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

function buildSettingsPreview(project: string, changes: SettingChange[]): string {
  const lines = [`Will update settings on project '${project}':`];
  for (const c of changes) {
    lines.push(`  ${c.field}: ${formatVal(c.before)} -> ${formatVal(c.after)}`);
  }
  return lines.join("\n");
}

export const updateProjectSettings = defineTool<
  UpdateProjectSettingsInput,
  UpdateProjectSettingsOutput,
  Context
>({
  name: "update_project_settings",
  description:
    "Update build/framework settings on a Vercel project (framework, buildCommand, devCommand, outputDirectory, rootDirectory, nodeVersion). Destructive; requires confirm.",
  inputSchema: updateProjectSettingsSchema as unknown as z.ZodType<UpdateProjectSettingsInput>,
  handler: async (input, context) => {
    // M5 — strict resolution: a bare name that lives in more than one team throws
    // rather than silently patching the wrong project.
    const { project } = await context.client.resolveProjectStrict(input.project);
    const projectName = project.name;
    const projectId = project.id;

    // Diff each caller-supplied field against the project's current value; skip
    // fields the caller did not pass, and skip no-op fields.
    const changes: SettingChange[] = [];
    const patch: Record<string, string | null> = {};
    for (const field of SETTING_FIELDS) {
      const provided = input[field];
      if (provided === undefined) continue;
      const before = normalizeSetting(project[field]);
      const after = provided;
      if (before === after) continue;
      changes.push({ field, before, after });
      patch[field] = after;
    }

    if (changes.length === 0) {
      return {
        ok: true,
        project: projectName,
        id: projectId,
        changes: [],
        before: {},
        after: {},
      };
    }

    const before: Record<string, string | null> = {};
    for (const c of changes) before[c.field] = c.before;

    const preview = buildSettingsPreview(projectName, changes);
    guardDestructive({ confirm: input.confirm, preview });

    const updated = await context.client.updateProject(input.project, patch);

    const after: Record<string, string | null> = {};
    for (const c of changes) {
      after[c.field] = normalizeSetting((updated as Record<string, unknown>)[c.field]);
    }

    return {
      ok: true,
      project: projectName,
      id: projectId,
      changes,
      before,
      after,
    };
  },
});

// ---------- pause_project (M1 prod gate + guardDestructive) ----------

const pauseProjectSchema = z.object({
  project: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type PauseProjectInput = z.output<typeof pauseProjectSchema>;

interface PauseUnpauseOutput {
  ok: boolean;
  paused: boolean;
  project: string;
  id: string;
}

export const pauseProject = defineTool<PauseProjectInput, PauseUnpauseOutput, Context>({
  name: "pause_project",
  description:
    "Pause a Vercel project so it stops serving production traffic. Production-affecting: requires the prod gate and confirm.",
  inputSchema: pauseProjectSchema as unknown as z.ZodType<PauseProjectInput>,
  handler: async (input, context) => {
    // M1 — primary gate, before any network call. confirm:true alone can never
    // authorize this; the human-set env var must be present.
    assertProdAllowed(input.project, "pause_project");
    const { project } = await context.client.resolveProjectStrict(input.project);
    const preview =
      `Will PAUSE project '${project.name}' (${project.id}). ` +
      `Its production deployment STOPS serving traffic until the project is unpaused.`;
    guardDestructive({ confirm: input.confirm, preview });
    await context.client.pauseProject(input.project);
    return { ok: true, paused: true, project: project.name, id: project.id };
  },
});

// ---------- unpause_project (M1 prod gate; restorative, no confirm) ----------

const unpauseProjectSchema = z.object({
  project: z.string().min(1),
});

type UnpauseProjectInput = z.infer<typeof unpauseProjectSchema>;

export const unpauseProject = defineTool<UnpauseProjectInput, PauseUnpauseOutput, Context>({
  name: "unpause_project",
  description:
    "Resume a paused Vercel project so it serves traffic again. Production-affecting: requires the prod gate.",
  inputSchema: unpauseProjectSchema,
  handler: async (input, context) => {
    // Restorative, so no confirm speed-bump, but it still changes production
    // serving state and therefore stays behind the prod gate (M1).
    assertProdAllowed(input.project, "unpause_project");
    const { project } = await context.client.resolveProjectStrict(input.project);
    await context.client.unpauseProject(input.project);
    return { ok: true, paused: false, project: project.name, id: project.id };
  },
});

// ---------- delete_project (M1 prod gate + guardDestructive, strong preview) ----------

const deleteProjectSchema = z.object({
  project: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteProjectInput = z.output<typeof deleteProjectSchema>;

interface DeleteProjectOutput {
  ok: boolean;
  deleted: boolean;
  project: string;
  id: string;
}

export const deleteProject = defineTool<DeleteProjectInput, DeleteProjectOutput, Context>({
  name: "delete_project",
  description:
    "Permanently delete a Vercel project and all of its deployments, domains, and environment variables. Irreversible and production-affecting: requires the prod gate and confirm.",
  inputSchema: deleteProjectSchema as unknown as z.ZodType<DeleteProjectInput>,
  handler: async (input, context) => {
    // Highest blast radius in this package. M1 first, then strict resolve so the
    // preview can name exactly which project (and team) is about to be destroyed.
    assertProdAllowed(input.project, "delete_project");
    const { project, scope } = await context.client.resolveProjectStrict(input.project);
    const scopeName = scope.kind === "personal" ? "personal" : scope.slug;
    const preview =
      `IRREVERSIBLE: permanently DELETE project '${project.name}' (id ${project.id}) ` +
      `in team '${scopeName}'. This removes ALL of its deployments, domains, and ` +
      `environment variables and CANNOT be undone.`;
    guardDestructive({ confirm: input.confirm, preview });
    await context.client.deleteProject(input.project);
    return { ok: true, deleted: true, project: project.name, id: project.id };
  },
});
