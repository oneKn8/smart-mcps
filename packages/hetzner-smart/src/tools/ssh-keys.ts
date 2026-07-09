import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { confirmField } from "./wait-schema.js";
import { nullableString } from "./null-helpers.js";

// Slim view of a Hetzner SSH key. Upstream also returns `created` and a public
// key blob; the tool layer drops everything outside these four fields.
export type SlimSshKey = {
  id: number;
  name: string;
  fingerprint: string | null;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Slim-maps a raw Hetzner SSH-key payload. Every field is guarded: upstream can
// null labels and (in trimmed responses) omit the fingerprint.
export function mapSshKey(raw: Record<string, unknown>): SlimSshKey {
  const labelsRaw = asObject(raw.labels);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    fingerprint: nullableString(raw.fingerprint),
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_ssh_keys
// =============================================================================

const listSshKeysInputSchema = z.object({
  name: z.string().optional(),
  label_selector: z.string().optional(),
});

type ListSshKeysInput = z.infer<typeof listSshKeysInputSchema>;

type ListSshKeysOutput = {
  ssh_keys: SlimSshKey[];
  count: number;
};

export const listSshKeys = defineTool<
  ListSshKeysInput,
  ListSshKeysOutput,
  HetznerContext
>({
  name: "list_ssh_keys",
  description: "List SSH keys.",
  inputSchema: listSshKeysInputSchema,
  handler: async (input, context) => {
    const params: { name?: string; label_selector?: string } = {};
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined) {
      params.label_selector = input.label_selector;
    }

    const body = await context.client.listSshKeys(params);
    const raw = body.ssh_keys;
    const keys = Array.isArray(raw) ? raw : [];
    return {
      ssh_keys: keys.map((k) => mapSshKey(k as Record<string, unknown>)),
      count: keys.length,
    };
  },
});

// =============================================================================
// get_ssh_key
// =============================================================================

const getSshKeyInputSchema = z.object({
  ssh_key_id: z.number().int().positive(),
});

type GetSshKeyInput = z.infer<typeof getSshKeyInputSchema>;

export const getSshKey = defineTool<GetSshKeyInput, SlimSshKey, HetznerContext>({
  name: "get_ssh_key",
  description: "Get an SSH key by ID.",
  inputSchema: getSshKeyInputSchema,
  handler: async (input, context) => {
    // getSshKey returns the ssh_key object already unwrapped.
    const key = await context.client.getSshKey(input.ssh_key_id);
    return mapSshKey(key);
  },
});

// =============================================================================
// create_ssh_key
// =============================================================================

const createSshKeyInputSchema = z.object({
  name: z.string().min(1),
  public_key: z.string().min(1),
  labels: z.record(z.string()).optional(),
});

type CreateSshKeyInput = z.infer<typeof createSshKeyInputSchema>;

export const createSshKey = defineTool<
  CreateSshKeyInput,
  SlimSshKey,
  HetznerContext
>({
  name: "create_ssh_key",
  description: "Add an SSH key.",
  inputSchema: createSshKeyInputSchema,
  handler: async (input, context) => {
    const body: {
      name: string;
      public_key: string;
      labels?: Record<string, string>;
    } = {
      name: input.name,
      public_key: input.public_key,
    };
    if (input.labels !== undefined) body.labels = input.labels;

    // Synchronous create: the raw body nests the resource under `ssh_key`.
    const created = await context.client.createSshKey(body);
    const key = asObject(created.ssh_key) ?? {};
    return mapSshKey(key);
  },
});

// =============================================================================
// delete_ssh_key
// =============================================================================

const deleteSshKeyInputSchema = z.object({
  ssh_key_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeleteSshKeyInput = z.infer<typeof deleteSshKeyInputSchema>;

type DeleteSshKeyOutput = {
  ssh_key_id: number;
  deleted: true;
};

export const deleteSshKey = defineTool<
  DeleteSshKeyInput,
  DeleteSshKeyOutput,
  HetznerContext
>({
  name: "delete_ssh_key",
  description: "Delete an SSH key.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: deleteSshKeyInputSchema as unknown as z.ZodType<DeleteSshKeyInput>,
  handler: async (input, context) => {
    // Fetch first so the preview names the real key, not just its id.
    const existing = await context.client.getSshKey(input.ssh_key_id);
    const name = nullableString(existing.name) ?? String(input.ssh_key_id);
    const preview = `Will permanently delete SSH key "${name}" (id ${input.ssh_key_id})`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteSshKey(input.ssh_key_id);
    return { ssh_key_id: input.ssh_key_id, deleted: true };
  },
});
