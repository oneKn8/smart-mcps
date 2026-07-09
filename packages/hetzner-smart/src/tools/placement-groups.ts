import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { confirmField } from "./wait-schema.js";

// Slim view of a Hetzner placement group. Upstream also returns `created`; the
// tool layer surfaces the server count and drops everything else.
export type SlimPlacementGroup = {
  id: number;
  name: string;
  type: string;
  servers_count: number;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Slim-maps a raw Hetzner placement-group payload. Every field is guarded: the
// upstream can null labels and (in trimmed responses) omit the servers array.
export function mapPlacementGroup(
  raw: Record<string, unknown>,
): SlimPlacementGroup {
  const labelsRaw = asObject(raw.labels);
  const servers = Array.isArray(raw.servers) ? raw.servers : [];

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    type: typeof raw.type === "string" ? raw.type : "",
    servers_count: servers.length,
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_placement_groups
// =============================================================================

const listPlacementGroupsInputSchema = z.object({
  name: z.string().min(1).optional(),
  label_selector: z.string().min(1).optional(),
});

type ListPlacementGroupsInput = z.infer<typeof listPlacementGroupsInputSchema>;

type ListPlacementGroupsOutput = {
  placement_groups: SlimPlacementGroup[];
  count: number;
};

export const listPlacementGroups = defineTool<
  ListPlacementGroupsInput,
  ListPlacementGroupsOutput,
  HetznerContext
>({
  name: "list_placement_groups",
  description: "List placement groups",
  inputSchema: listPlacementGroupsInputSchema,
  handler: async (input, context) => {
    const params: { name?: string; label_selector?: string } = {};
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined) {
      params.label_selector = input.label_selector;
    }

    const body = await context.client.listPlacementGroups(params);
    const raw = body.placement_groups;
    const groups = Array.isArray(raw) ? raw : [];
    return {
      placement_groups: groups.map((g) =>
        mapPlacementGroup(g as Record<string, unknown>),
      ),
      count: groups.length,
    };
  },
});

// =============================================================================
// create_placement_group
// =============================================================================

const createPlacementGroupInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["spread"]).optional().default("spread"),
  labels: z.record(z.string()).optional(),
});

type CreatePlacementGroupInput = z.infer<typeof createPlacementGroupInputSchema>;

export const createPlacementGroup = defineTool<
  CreatePlacementGroupInput,
  SlimPlacementGroup,
  HetznerContext
>({
  name: "create_placement_group",
  description: "Create a placement group",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    createPlacementGroupInputSchema as unknown as z.ZodType<CreatePlacementGroupInput>,
  handler: async (input, context) => {
    // Only forward fields the caller actually set; `type` always resolves via
    // its default. Placement-group create is synchronous (`{ placement_group }`).
    const body: Record<string, unknown> = {
      name: input.name,
      type: input.type,
    };
    if (input.labels !== undefined) body.labels = input.labels;

    const created = await context.client.createPlacementGroup(body);
    const group =
      asObject((created as Record<string, unknown>).placement_group) ?? {};
    return mapPlacementGroup(group);
  },
});

// =============================================================================
// delete_placement_group
// =============================================================================

const deletePlacementGroupInputSchema = z.object({
  placement_group_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeletePlacementGroupInput = z.infer<typeof deletePlacementGroupInputSchema>;

type DeletePlacementGroupOutput = {
  placement_group_id: number;
  deleted: true;
};

export const deletePlacementGroup = defineTool<
  DeletePlacementGroupInput,
  DeletePlacementGroupOutput,
  HetznerContext
>({
  name: "delete_placement_group",
  description: "Delete a placement group",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    deletePlacementGroupInputSchema as unknown as z.ZodType<DeletePlacementGroupInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE placement group ${input.placement_group_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deletePlacementGroup(input.placement_group_id);
    return { placement_group_id: input.placement_group_id, deleted: true };
  },
});
