import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import type { HetznerBody } from "../client.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { nullableNumber, nullableString } from "./null-helpers.js";

// Pulls `body.image.id` (the snapshot id) out of a raw create_image response,
// guarding every nested access — Hetzner nulls out `image` on some error paths.
function extractImageId(body: HetznerBody): number | null {
  const image = body.image;
  if (image && typeof image === "object" && !Array.isArray(image)) {
    return nullableNumber((image as Record<string, unknown>).id);
  }
  return null;
}

// =============================================================================
// rebuild_server
// =============================================================================

const rebuildServerInputSchema = z.object({
  server_id: z.number().int().positive(),
  image: z.string().min(1),
  confirm: confirmField,
  wait: waitField,
});

type RebuildServerInput = z.infer<typeof rebuildServerInputSchema>;

type RebuildServerOutput = {
  server_id: number;
  action: ActionSummary | null;
  root_password: string | null;
};

export const rebuildServer = defineTool<
  RebuildServerInput,
  RebuildServerOutput,
  HetznerContext
>({
  name: "rebuild_server",
  description: "Rebuild a server from an image.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: rebuildServerInputSchema as unknown as z.ZodType<RebuildServerInput>,
  handler: async (input, context) => {
    const preview =
      `Will REBUILD server ${input.server_id} from image ${input.image}. ` +
      `This WIPES the disk — all data on it is permanently lost.`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = await context.client.serverAction(input.server_id, "rebuild", {
      image: input.image,
    });
    const action = await settleAction(context.client, body, input.wait);
    return {
      server_id: input.server_id,
      action,
      root_password: nullableString(body.root_password),
    };
  },
});

// =============================================================================
// change_server_type
// =============================================================================

const changeServerTypeInputSchema = z.object({
  server_id: z.number().int().positive(),
  server_type: z.string().min(1),
  upgrade_disk: z.boolean().optional().default(false),
  confirm: confirmField,
  wait: waitField,
});

type ChangeServerTypeInput = z.infer<typeof changeServerTypeInputSchema>;

type ChangeServerTypeOutput = {
  server_id: number;
  action: ActionSummary | null;
};

export const changeServerType = defineTool<
  ChangeServerTypeInput,
  ChangeServerTypeOutput,
  HetznerContext
>({
  name: "change_server_type",
  description: "Change a server type (resize).",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: changeServerTypeInputSchema as unknown as z.ZodType<ChangeServerTypeInput>,
  handler: async (input, context) => {
    const preview =
      `Will CHANGE server ${input.server_id} to type ${input.server_type}. ` +
      `Requires downtime (server powers off); disk cannot shrink.`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = await context.client.serverAction(
      input.server_id,
      "change_type",
      { server_type: input.server_type, upgrade_disk: input.upgrade_disk },
    );
    const action = await settleAction(context.client, body, input.wait);
    return { server_id: input.server_id, action };
  },
});

// =============================================================================
// create_snapshot
// =============================================================================

const createSnapshotInputSchema = z.object({
  server_id: z.number().int().positive(),
  description: z.string().optional(),
  labels: z.record(z.string()).optional(),
  wait: waitField,
});

type CreateSnapshotInput = z.infer<typeof createSnapshotInputSchema>;

type CreateSnapshotOutput = {
  server_id: number;
  image_id: number | null;
  action: ActionSummary | null;
};

export const createSnapshot = defineTool<
  CreateSnapshotInput,
  CreateSnapshotOutput,
  HetznerContext
>({
  name: "create_snapshot",
  description: "Create a snapshot image from a server.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: createSnapshotInputSchema as unknown as z.ZodType<CreateSnapshotInput>,
  handler: async (input, context) => {
    // Only forward the optional fields the caller actually supplied.
    const body: {
      type: "snapshot";
      description?: string;
      labels?: Record<string, string>;
    } = { type: "snapshot" };
    if (input.description !== undefined) body.description = input.description;
    if (input.labels !== undefined) body.labels = input.labels;

    const raw = await context.client.serverAction(
      input.server_id,
      "create_image",
      body,
    );
    const action = await settleAction(context.client, raw, input.wait);
    return {
      server_id: input.server_id,
      image_id: extractImageId(raw),
      action,
    };
  },
});

// =============================================================================
// change_server_protection
// =============================================================================

const changeServerProtectionInputSchema = z.object({
  server_id: z.number().int().positive(),
  delete: z.boolean().optional(),
  rebuild: z.boolean().optional(),
  wait: waitField,
});

type ChangeServerProtectionInput = z.infer<
  typeof changeServerProtectionInputSchema
>;

type ChangeServerProtectionOutput = {
  server_id: number;
  action: ActionSummary | null;
};

export const changeServerProtection = defineTool<
  ChangeServerProtectionInput,
  ChangeServerProtectionOutput,
  HetznerContext
>({
  name: "change_server_protection",
  description: "Change server delete and rebuild protection.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: changeServerProtectionInputSchema as unknown as z.ZodType<ChangeServerProtectionInput>,
  handler: async (input, context) => {
    // At least one protection flag must be supplied — enforced here rather than
    // via a schema `.refine()` (ZodEffects can serialize an empty JSON schema).
    if (input.delete === undefined && input.rebuild === undefined) {
      throw new Error(
        "change_server_protection requires at least one of `delete` or `rebuild`.",
      );
    }

    const body: { delete?: boolean; rebuild?: boolean } = {};
    if (input.delete !== undefined) body.delete = input.delete;
    if (input.rebuild !== undefined) body.rebuild = input.rebuild;

    const raw = await context.client.serverAction(
      input.server_id,
      "change_protection",
      body,
    );
    const action = await settleAction(context.client, raw, input.wait);
    return { server_id: input.server_id, action };
  },
});
