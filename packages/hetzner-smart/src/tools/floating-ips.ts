import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { nullableString, nullableNumber } from "./null-helpers.js";

// Slim view of a Hetzner Floating IP. Upstream extras (description, dns_ptr,
// blocked, protection, created) are dropped. `ip`/`type` are typed as strings
// but every nested access is still guarded — the upstream can null anything.
export type SlimFloatingIp = {
  id: number;
  name: string | null;
  ip: string;
  type: string;
  server: number | null;
  home_location: string | null;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mapFloatingIp(raw: Record<string, unknown>): SlimFloatingIp {
  const homeLocation = asObject(raw.home_location);
  const labelsRaw = asObject(raw.labels);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: nullableString(raw.name),
    ip: typeof raw.ip === "string" ? raw.ip : "",
    type: typeof raw.type === "string" ? raw.type : "",
    server: nullableNumber(raw.server),
    home_location: nullableString(homeLocation?.name),
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_floating_ips
// =============================================================================

const listFloatingIpsInputSchema = z.object({
  label_selector: z.string().optional(),
  name: z.string().optional(),
});

type ListFloatingIpsInput = z.infer<typeof listFloatingIpsInputSchema>;

type ListFloatingIpsOutput = {
  floating_ips: SlimFloatingIp[];
  count: number;
};

export const listFloatingIps = defineTool<
  ListFloatingIpsInput,
  ListFloatingIpsOutput,
  HetznerContext
>({
  name: "list_floating_ips",
  description: "List floating IPs.",
  inputSchema: listFloatingIpsInputSchema,
  handler: async (input, context) => {
    const params: { label_selector?: string; name?: string } = {};
    if (input.label_selector !== undefined)
      params.label_selector = input.label_selector;
    if (input.name !== undefined) params.name = input.name;

    const body = await context.client.listFloatingIps(params);
    const arr = Array.isArray(body.floating_ips) ? body.floating_ips : [];
    return {
      floating_ips: arr.map((f) => mapFloatingIp(f as Record<string, unknown>)),
      count: arr.length,
    };
  },
});

// =============================================================================
// create_floating_ip
// =============================================================================

const createFloatingIpInputSchema = z.object({
  type: z.enum(["ipv4", "ipv6"]),
  home_location: z.string().min(1).optional(),
  server: z.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  labels: z.record(z.string()).optional(),
  wait: waitField,
});

type CreateFloatingIpInput = z.infer<typeof createFloatingIpInputSchema>;

type CreateFloatingIpOutput = {
  floating_ip: SlimFloatingIp | null;
  action: ActionSummary | null;
};

export const createFloatingIp = defineTool<
  CreateFloatingIpInput,
  CreateFloatingIpOutput,
  HetznerContext
>({
  name: "create_floating_ip",
  description: "Create a floating IP.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: createFloatingIpInputSchema as unknown as z.ZodType<CreateFloatingIpInput>,
  handler: async (input, context) => {
    // Only forward the fields the caller actually provided; `type` is required.
    const body: Record<string, unknown> = { type: input.type };
    if (input.home_location !== undefined) body.home_location = input.home_location;
    if (input.server !== undefined) body.server = input.server;
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.labels !== undefined) body.labels = input.labels;

    const created = await context.client.createFloatingIp(body);
    const raw = asObject(created.floating_ip);
    const action = await settleAction(context.client, created, input.wait);
    return {
      floating_ip: raw ? mapFloatingIp(raw) : null,
      action,
    };
  },
});

// =============================================================================
// delete_floating_ip
// =============================================================================

const deleteFloatingIpInputSchema = z.object({
  floating_ip_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeleteFloatingIpInput = z.infer<typeof deleteFloatingIpInputSchema>;

type DeleteFloatingIpOutput = {
  floating_ip_id: number;
  deleted: true;
};

export const deleteFloatingIp = defineTool<
  DeleteFloatingIpInput,
  DeleteFloatingIpOutput,
  HetznerContext
>({
  name: "delete_floating_ip",
  description: "Delete a floating IP.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: deleteFloatingIpInputSchema as unknown as z.ZodType<DeleteFloatingIpInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE floating IP ${input.floating_ip_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteFloatingIp(input.floating_ip_id);
    return { floating_ip_id: input.floating_ip_id, deleted: true };
  },
});

// =============================================================================
// assign_floating_ip
// =============================================================================

const assignFloatingIpInputSchema = z.object({
  floating_ip_id: z.number().int().positive(),
  server_id: z.number().int().positive(),
  wait: waitField,
});

type AssignFloatingIpInput = z.infer<typeof assignFloatingIpInputSchema>;

type AssignFloatingIpOutput = {
  floating_ip_id: number;
  action: ActionSummary | null;
};

export const assignFloatingIp = defineTool<
  AssignFloatingIpInput,
  AssignFloatingIpOutput,
  HetznerContext
>({
  name: "assign_floating_ip",
  description: "Assign a floating IP to a server.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: assignFloatingIpInputSchema as unknown as z.ZodType<AssignFloatingIpInput>,
  handler: async (input, context) => {
    const body = await context.client.floatingIpAction(
      input.floating_ip_id,
      "assign",
      { server: input.server_id },
    );
    const action = await settleAction(context.client, body, input.wait);
    return { floating_ip_id: input.floating_ip_id, action };
  },
});

// =============================================================================
// unassign_floating_ip
// =============================================================================

const unassignFloatingIpInputSchema = z.object({
  floating_ip_id: z.number().int().positive(),
  wait: waitField,
});

type UnassignFloatingIpInput = z.infer<typeof unassignFloatingIpInputSchema>;

type UnassignFloatingIpOutput = {
  floating_ip_id: number;
  action: ActionSummary | null;
};

export const unassignFloatingIp = defineTool<
  UnassignFloatingIpInput,
  UnassignFloatingIpOutput,
  HetznerContext
>({
  name: "unassign_floating_ip",
  description: "Unassign a floating IP.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: unassignFloatingIpInputSchema as unknown as z.ZodType<UnassignFloatingIpInput>,
  handler: async (input, context) => {
    const body = await context.client.floatingIpAction(
      input.floating_ip_id,
      "unassign",
    );
    const action = await settleAction(context.client, body, input.wait);
    return { floating_ip_id: input.floating_ip_id, action };
  },
});
