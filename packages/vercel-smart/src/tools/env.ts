import { z } from "zod";
import { defineTool, guardDestructive, NotFoundError } from "smart-mcp-core";
import { assertRevealAllowed } from "../safety.js";
import type {
  VercelClient,
  ProjectEnv,
  UpsertProjectEnvBody,
  UpdateProjectEnvBody,
} from "../client.js";

type Context = {
  client: VercelClient;
};

// ---------- Shared projections (M4: 'value' is NEVER in the slim shape) ----------

// The slim projection the security review mandates: key/target/type/id +
// gitBranch/updatedAt. The raw upstream `value` (plaintext for plain vars,
// ciphertext for encrypted) is deliberately absent — reveal it only through the
// gated reveal_env / list_env(decrypt=true) paths.
interface SlimEnv {
  id: string;
  key: string;
  type: string;
  target: string[] | null;
  gitBranch: string | null;
  updatedAt: number | null;
}

// Only produced on the gated decrypt path. `decrypted:false` when Vercel returns
// no plaintext (notably type:'sensitive', which never decrypts).
interface RevealedEnv extends SlimEnv {
  value: string | null;
  decrypted: boolean;
}

const ENV_TYPES = ["encrypted", "plain", "sensitive"] as const;
const ENV_TARGETS = ["production", "preview", "development"] as const;

function normTargetArr(t: ProjectEnv["target"]): string[] | null {
  if (Array.isArray(t)) return t;
  if (typeof t === "string") return [t];
  return null;
}

function toSlim(e: ProjectEnv): SlimEnv {
  return {
    id: e.id,
    key: e.key,
    type: String(e.type),
    target: normTargetArr(e.target),
    gitBranch: e.gitBranch ?? null,
    updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : null,
  };
}

function toRevealed(e: ProjectEnv): RevealedEnv {
  const value = typeof e.value === "string" ? e.value : null;
  return { ...toSlim(e), value, decrypted: value !== null };
}

// Two env vars sharing a key but differing in their target set are distinct
// records; upsert keys on key+target+gitBranch. Match the same way.
function targetsEqual(existing: ProjectEnv["target"], desired: string[]): boolean {
  const arr = normTargetArr(existing);
  if (arr === null) return desired.length === 0;
  if (arr.length !== desired.length) return false;
  const set = new Set(arr);
  return desired.every((t) => set.has(t));
}

// ---------- list_env ----------

const listEnvInput = z.object({
  project: z.string().min(1),
  decrypt: z.boolean().optional().default(false),
  gitBranch: z.string().min(1).optional(),
});

type ListEnvInput = z.output<typeof listEnvInput>;

interface ListEnvOutput {
  project: string;
  decrypted: boolean;
  count: number;
  envs: Array<SlimEnv | RevealedEnv>;
}

export const listEnv = defineTool<ListEnvInput, ListEnvOutput, Context>({
  name: "list_env",
  description:
    "List a Vercel project's environment variables (metadata only). Set decrypt:true to include values — requires VERCEL_SMART_ALLOW_REVEAL=1.",
  // Cast: ZodDefault's input type is `boolean | undefined` but its output is
  // `boolean`, so the schema is invariant against z.ZodType<Input>.
  inputSchema: listEnvInput as unknown as z.ZodType<ListEnvInput>,
  handler: async (input, context) => {
    // M4: the decrypt path surfaces secret values, so gate it BEFORE any network
    // call — a blocked reveal must never even hit the API.
    if (input.decrypt) assertRevealAllowed();
    const res = await context.client.listProjectEnv(input.project, {
      decrypt: input.decrypt,
      gitBranch: input.gitBranch,
    });
    const envs = res.envs ?? [];
    return {
      project: input.project,
      decrypted: input.decrypt,
      count: envs.length,
      envs: input.decrypt ? envs.map(toRevealed) : envs.map(toSlim),
    };
  },
});

// ---------- reveal_env ----------

const revealEnvInput = z.object({
  project: z.string().min(1),
  id: z.string().min(1),
});

type RevealEnvInput = z.infer<typeof revealEnvInput>;

interface RevealEnvOutput {
  project: string;
  id: string;
  key: string;
  type: string;
  target: string[] | null;
  gitBranch: string | null;
  value: string | null;
  decrypted: boolean;
  sensitive: true;
  note?: string;
}

export const revealEnv = defineTool<RevealEnvInput, RevealEnvOutput, Context>({
  name: "reveal_env",
  description:
    "Reveal one environment variable's decrypted value by its env id. Requires VERCEL_SMART_ALLOW_REVEAL=1. type:'sensitive' vars never decrypt.",
  inputSchema: revealEnvInput,
  handler: async (input, context) => {
    // M4: gate before the network call.
    assertRevealAllowed();
    const e = await context.client.revealProjectEnv(input.project, input.id);
    const type = String(e.type);
    const value = typeof e.value === "string" ? e.value : null;
    const decrypted = value !== null;
    const out: RevealEnvOutput = {
      project: input.project,
      id: e.id,
      key: e.key,
      type,
      target: normTargetArr(e.target),
      gitBranch: e.gitBranch ?? null,
      value,
      decrypted,
      // Output carries the plaintext secret — flag it so downstream never logs it.
      sensitive: true,
    };
    if (!decrypted) {
      out.note =
        type === "sensitive"
          ? "type 'sensitive' values are never returned decrypted by Vercel"
          : "no decrypted value returned for this variable";
    }
    return out;
  },
});

// ---------- set_env ----------

const setEnvInput = z.object({
  project: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  target: z.array(z.enum(ENV_TARGETS)).min(1),
  type: z.enum(ENV_TYPES).optional().default("encrypted"),
  gitBranch: z.string().min(1).optional(),
  comment: z.string().optional(),
  confirm: z.boolean().optional().default(false),
});

type SetEnvInput = z.output<typeof setEnvInput>;

interface SetEnvOutput {
  project: string;
  key: string;
  target: string[];
  type: string;
  action: "create" | "update" | "noop";
  changed: boolean;
}

// M4: preview redacts the value — key/target/type only, never the secret.
function buildSetPreview(
  project: string,
  key: string,
  targets: string[],
  type: string,
  action: "create" | "update",
): string {
  return [
    `${action === "create" ? "Create" : "Update"} env var on ${project}:`,
    `  key: ${key}`,
    `  target: ${targets.join(", ")}`,
    `  type: ${type}`,
    `  value: <redacted>`,
  ].join("\n");
}

export const setEnv = defineTool<SetEnvInput, SetEnvOutput, Context>({
  name: "set_env",
  description:
    "Create or update a Vercel environment variable (upsert). Destructive — requires confirm:true. Preview redacts the value.",
  inputSchema: setEnvInput as unknown as z.ZodType<SetEnvInput>,
  handler: async (input, context) => {
    const targets = input.target;
    const type = input.type;

    // Locate the record this upsert would replace (same key+target+gitBranch).
    // Listed WITHOUT decrypt so no gate is needed; that also means an existing
    // encrypted/sensitive value is not observable here, so we can only PROVE a
    // no-op for plain vars. Encrypted/sensitive fall through to the write path
    // (a redundant upsert is harmless and still passes the confirm gate) — this
    // keeps the decrypt gate the ONLY path that ever reads a secret value.
    const { envs } = await context.client.listProjectEnv(input.project);
    const existing = (envs ?? []).find(
      (e) =>
        e.key === input.key &&
        targetsEqual(e.target, targets) &&
        (e.gitBranch ?? null) === (input.gitBranch ?? null),
    );

    if (existing) {
      const sameType = String(existing.type) === type;
      const sameComment = (existing.comment ?? "") === (input.comment ?? "");
      const observableValue =
        typeof existing.value === "string" ? existing.value : null;
      const valueProvablyEqual =
        String(existing.type) === "plain" &&
        observableValue !== null &&
        observableValue === input.value;
      if (sameType && sameComment && valueProvablyEqual) {
        return {
          project: input.project,
          key: input.key,
          target: targets,
          type,
          action: "noop",
          changed: false,
        };
      }
    }

    const action: "create" | "update" = existing ? "update" : "create";
    const preview = buildSetPreview(input.project, input.key, targets, type, action);
    guardDestructive({ confirm: input.confirm, preview });

    const body: UpsertProjectEnvBody = {
      key: input.key,
      value: input.value,
      type,
      target: targets,
    };
    if (input.gitBranch !== undefined) body.gitBranch = input.gitBranch;
    if (input.comment !== undefined) body.comment = input.comment;

    await context.client.upsertProjectEnv(input.project, body);

    return {
      project: input.project,
      key: input.key,
      target: targets,
      type,
      action,
      changed: true,
    };
  },
});

// ---------- edit_env ----------

const editEnvInput = z
  .object({
    project: z.string().min(1),
    id: z.string().min(1),
    value: z.string().optional(),
    target: z.array(z.enum(ENV_TARGETS)).min(1).optional(),
    type: z.enum(ENV_TYPES).optional(),
    gitBranch: z.string().min(1).optional(),
    comment: z.string().optional(),
    confirm: z.boolean().optional().default(false),
  })
  .refine(
    (v) =>
      v.value !== undefined ||
      v.target !== undefined ||
      v.type !== undefined ||
      v.gitBranch !== undefined ||
      v.comment !== undefined,
    {
      message:
        "edit_env requires at least one field to change: value, target, type, gitBranch, or comment.",
    },
  );

type EditEnvInput = z.output<typeof editEnvInput>;

interface EditEnvOutput {
  project: string;
  id: string;
  key: string;
  changed: string[];
  type: string;
  target: string[] | null;
  gitBranch: string | null;
}

// M4: value redacted; only the field NAME appears, never the secret.
function buildEditPreview(
  project: string,
  id: string,
  key: string,
  changed: string[],
  input: EditEnvInput,
): string {
  const lines = [`Update env var on ${project}:`, `  id: ${id}`, `  key: ${key}`];
  if (changed.includes("value")) lines.push(`  value: <redacted>`);
  if (changed.includes("target"))
    lines.push(`  target: ${(input.target ?? []).join(", ")}`);
  if (changed.includes("type")) lines.push(`  type: ${input.type}`);
  if (changed.includes("gitBranch"))
    lines.push(`  gitBranch: ${input.gitBranch ?? "null"}`);
  if (changed.includes("comment")) lines.push(`  comment: ${input.comment}`);
  return lines.join("\n");
}

export const editEnv = defineTool<EditEnvInput, EditEnvOutput, Context>({
  name: "edit_env",
  description:
    "Edit an existing Vercel environment variable by its env id. Destructive — requires confirm:true. Preview redacts the value.",
  inputSchema: editEnvInput as unknown as z.ZodType<EditEnvInput>,
  handler: async (input, context) => {
    // Validate the id exists (fail fast, before confirm) and recover the key for
    // a legible preview. Listed WITHOUT decrypt — no secret is read here.
    const { envs } = await context.client.listProjectEnv(input.project);
    const existing = (envs ?? []).find((e) => e.id === input.id);
    if (!existing) {
      throw new NotFoundError(
        `Env var not found on project '${input.project}': ${input.id}`,
      );
    }

    const body: UpdateProjectEnvBody = {};
    const changed: string[] = [];
    if (input.value !== undefined) {
      body.value = input.value;
      changed.push("value");
    }
    if (input.target !== undefined) {
      body.target = input.target;
      changed.push("target");
    }
    if (input.type !== undefined) {
      body.type = input.type;
      changed.push("type");
    }
    if (input.gitBranch !== undefined) {
      body.gitBranch = input.gitBranch;
      changed.push("gitBranch");
    }
    if (input.comment !== undefined) {
      body.comment = input.comment;
      changed.push("comment");
    }

    const preview = buildEditPreview(input.project, input.id, existing.key, changed, input);
    guardDestructive({ confirm: input.confirm, preview });

    const updated = await context.client.updateProjectEnv(input.project, input.id, body);

    return {
      project: input.project,
      id: input.id,
      key: existing.key,
      changed,
      type: String(updated.type ?? existing.type),
      target: normTargetArr(updated.target ?? existing.target),
      gitBranch: (updated.gitBranch ?? existing.gitBranch) ?? null,
    };
  },
});

// ---------- delete_env ----------

const deleteEnvInput = z.object({
  project: z.string().min(1),
  id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteEnvInput = z.output<typeof deleteEnvInput>;

interface DeleteEnvOutput {
  project: string;
  id: string;
  key: string;
  deleted: true;
}

export const deleteEnv = defineTool<DeleteEnvInput, DeleteEnvOutput, Context>({
  name: "delete_env",
  description:
    "Delete a Vercel environment variable by its env id. Destructive — requires confirm:true.",
  inputSchema: deleteEnvInput as unknown as z.ZodType<DeleteEnvInput>,
  handler: async (input, context) => {
    // Validate + recover metadata for the preview (no decrypt, no secret read).
    const { envs } = await context.client.listProjectEnv(input.project);
    const existing = (envs ?? []).find((e) => e.id === input.id);
    if (!existing) {
      throw new NotFoundError(
        `Env var not found on project '${input.project}': ${input.id}`,
      );
    }

    const preview = [
      `Delete env var on ${input.project}:`,
      `  id: ${input.id}`,
      `  key: ${existing.key}`,
      `  target: ${normTargetArr(existing.target)?.join(", ") ?? "-"}`,
      `  type: ${String(existing.type)}`,
    ].join("\n");
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteProjectEnv(input.project, input.id);

    return {
      project: input.project,
      id: input.id,
      key: existing.key,
      deleted: true,
    };
  },
});
