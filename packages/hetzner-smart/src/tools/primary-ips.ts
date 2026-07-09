import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import type { HetznerListParams } from "../client.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { nullableNumber, nullableString } from "./null-helpers.js";

// Slim view of a Hetzner Primary IP. The upstream payload nests the datacenter
// object and carries dns_ptr/protection/blocked/created extras the tool layer
// drops. Every nested access is guarded — upstream regularly nulls these out.
export type SlimPrimaryIp = {
  id: number;
  name: string;
  ip: string;
  type: string;
  assignee_id: number | null;
  datacenter: string | null;
  auto_delete: boolean;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mapPrimaryIp(raw: Record<string, unknown>): SlimPrimaryIp {
  const datacenter = asObject(raw.datacenter);
  const labelsRaw = asObject(raw.labels);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    ip: typeof raw.ip === "string" ? raw.ip : "",
    type: typeof raw.type === "string" ? raw.type : "",
    assignee_id: nullableNumber(raw.assignee_id),
    datacenter: nullableString(datacenter?.name),
    auto_delete: raw.auto_delete === true,
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_primary_ips
// =============================================================================

const listPrimaryIpsInputSchema = z.object({
  label_selector: z.string().optional(),
  name: z.string().optional(),
});

type ListPrimaryIpsInput = z.infer<typeof listPrimaryIpsInputSchema>;

type ListPrimaryIpsOutput = {
  primary_ips: SlimPrimaryIp[];
  count: number;
};

export const listPrimaryIps = defineTool<
  ListPrimaryIpsInput,
  ListPrimaryIpsOutput,
  HetznerContext
>({
  name: "list_primary_ips",
  description: "List primary IPs.",
  inputSchema: listPrimaryIpsInputSchema,
  handler: async (input, context) => {
    const params: HetznerListParams = {};
    if (input.label_selector !== undefined)
      params.label_selector = input.label_selector;
    if (input.name !== undefined) params.name = input.name;

    const body = await context.client.listPrimaryIps(params);
    const list = Array.isArray(body.primary_ips)
      ? (body.primary_ips as unknown[])
      : [];
    return {
      primary_ips: list.map((p) => mapPrimaryIp(p as Record<string, unknown>)),
      count: list.length,
    };
  },
});

// =============================================================================
// create_primary_ip
// =============================================================================

const createPrimaryIpInputSchema = z.object({
  type: z.enum(["ipv4", "ipv6"]),
  name: z.string().min(1),
  datacenter: z.string().min(1),
  assignee_id: z.number().int().positive().optional(),
  auto_delete: z.boolean().optional(),
  labels: z.record(z.string()).optional(),
  wait: waitField,
});

type CreatePrimaryIpInput = z.infer<typeof createPrimaryIpInputSchema>;

type CreatePrimaryIpOutput = {
  primary_ip: SlimPrimaryIp | null;
  action: ActionSummary | null;
};

export const createPrimaryIp = defineTool<
  CreatePrimaryIpInput,
  CreatePrimaryIpOutput,
  HetznerContext
>({
  name: "create_primary_ip",
  description: "Create a primary IP.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    createPrimaryIpInputSchema as unknown as z.ZodType<CreatePrimaryIpInput>,
  handler: async (input, context) => {
    // assignee_type is required upstream and always "server" (primary IPs only
    // attach to servers). Only forward the optional fields the caller supplied.
    const reqBody: Record<string, unknown> = {
      type: input.type,
      name: input.name,
      datacenter: input.datacenter,
      assignee_type: "server",
    };
    if (input.assignee_id !== undefined) reqBody.assignee_id = input.assignee_id;
    if (input.auto_delete !== undefined) reqBody.auto_delete = input.auto_delete;
    if (input.labels !== undefined) reqBody.labels = input.labels;

    const body = await context.client.createPrimaryIp(reqBody);
    const raw = asObject(body.primary_ip);
    const action = await settleAction(context.client, body, input.wait);
    return {
      primary_ip: raw ? mapPrimaryIp(raw) : null,
      action,
    };
  },
});

// =============================================================================
// delete_primary_ip
// =============================================================================

const deletePrimaryIpInputSchema = z.object({
  primary_ip_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeletePrimaryIpInput = z.infer<typeof deletePrimaryIpInputSchema>;

type DeletePrimaryIpOutput = {
  primary_ip_id: number;
  deleted: true;
};

export const deletePrimaryIp = defineTool<
  DeletePrimaryIpInput,
  DeletePrimaryIpOutput,
  HetznerContext
>({
  name: "delete_primary_ip",
  description: "Delete a primary IP.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    deletePrimaryIpInputSchema as unknown as z.ZodType<DeletePrimaryIpInput>,
  handler: async (input, context) => {
    // No getPrimaryIp endpoint exists, so the preview is honestly id-scoped —
    // no fabricated name/ip. Deleting frees the address permanently.
    const preview = `Will PERMANENTLY DELETE primary IP ${input.primary_ip_id} (frees the address)`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deletePrimaryIp(input.primary_ip_id);
    return { primary_ip_id: input.primary_ip_id, deleted: true };
  },
});

// =============================================================================
// assign_primary_ip
// =============================================================================

const assignPrimaryIpInputSchema = z.object({
  primary_ip_id: z.number().int().positive(),
  assignee_id: z.number().int().positive(),
  wait: waitField,
});

type AssignPrimaryIpInput = z.infer<typeof assignPrimaryIpInputSchema>;

type AssignPrimaryIpOutput = {
  primary_ip_id: number;
  action: ActionSummary | null;
};

export const assignPrimaryIp = defineTool<
  AssignPrimaryIpInput,
  AssignPrimaryIpOutput,
  HetznerContext
>({
  name: "assign_primary_ip",
  description: "Assign a primary IP to a server.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    assignPrimaryIpInputSchema as unknown as z.ZodType<AssignPrimaryIpInput>,
  handler: async (input, context) => {
    const body = await context.client.primaryIpAction(
      input.primary_ip_id,
      "assign",
      { assignee_id: input.assignee_id, assignee_type: "server" },
    );
    const action = await settleAction(context.client, body, input.wait);
    return { primary_ip_id: input.primary_ip_id, action };
  },
});

// =============================================================================
// unassign_primary_ip
// =============================================================================

const unassignPrimaryIpInputSchema = z.object({
  primary_ip_id: z.number().int().positive(),
  wait: waitField,
});

type UnassignPrimaryIpInput = z.infer<typeof unassignPrimaryIpInputSchema>;

type UnassignPrimaryIpOutput = {
  primary_ip_id: number;
  action: ActionSummary | null;
};

export const unassignPrimaryIp = defineTool<
  UnassignPrimaryIpInput,
  UnassignPrimaryIpOutput,
  HetznerContext
>({
  name: "unassign_primary_ip",
  description: "Unassign a primary IP from its server.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    unassignPrimaryIpInputSchema as unknown as z.ZodType<UnassignPrimaryIpInput>,
  handler: async (input, context) => {
    const body = await context.client.primaryIpAction(
      input.primary_ip_id,
      "unassign",
    );
    const action = await settleAction(context.client, body, input.wait);
    return { primary_ip_id: input.primary_ip_id, action };
  },
});
