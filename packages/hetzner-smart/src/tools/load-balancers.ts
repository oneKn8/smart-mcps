import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import type { HetznerBody, HetznerListParams } from "../client.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { nullableString } from "./null-helpers.js";

// Slim view of a Hetzner load balancer. Upstream nests type/location/public_net
// and carries algorithm, protection, private_net, created, etc. — all dropped.
export type SlimLoadBalancer = {
  id: number;
  name: string;
  load_balancer_type: string | null;
  public_ipv4: string | null;
  location: string | null;
  services_count: number;
  targets_count: number;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Slim-maps a raw load balancer payload. Every nested access is guarded — the
// upstream regularly nulls out public_net entries, location, and the type.
export function mapLoadBalancer(raw: Record<string, unknown>): SlimLoadBalancer {
  const lbType = asObject(raw.load_balancer_type);
  const publicNet = asObject(raw.public_net);
  const location = asObject(raw.location);
  const labelsRaw = asObject(raw.labels);

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    load_balancer_type: nullableString(lbType?.name),
    public_ipv4: nullableString(asObject(publicNet?.ipv4)?.ip),
    location: nullableString(location?.name),
    services_count: Array.isArray(raw.services) ? raw.services.length : 0,
    targets_count: Array.isArray(raw.targets) ? raw.targets.length : 0,
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_load_balancers
// =============================================================================

const listLoadBalancersInputSchema = z.object({
  name: z.string().min(1).optional(),
  label_selector: z.string().min(1).optional(),
});

type ListLoadBalancersInput = z.infer<typeof listLoadBalancersInputSchema>;

type ListLoadBalancersOutput = {
  load_balancers: SlimLoadBalancer[];
  count: number;
};

export const listLoadBalancers = defineTool<
  ListLoadBalancersInput,
  ListLoadBalancersOutput,
  HetznerContext
>({
  name: "list_load_balancers",
  description: "List load balancers.",
  inputSchema: listLoadBalancersInputSchema,
  handler: async (input, context) => {
    const params: HetznerListParams = {};
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined) {
      params.label_selector = input.label_selector;
    }

    const body = await context.client.listLoadBalancers(params);
    const raw = (body as HetznerBody).load_balancers;
    const arr = Array.isArray(raw) ? raw : [];
    const load_balancers = arr.map((r) =>
      mapLoadBalancer(r as Record<string, unknown>),
    );
    return { load_balancers, count: load_balancers.length };
  },
});

// =============================================================================
// get_load_balancer
// =============================================================================

const getLoadBalancerInputSchema = z.object({
  load_balancer_id: z.number().int().positive(),
});

type GetLoadBalancerInput = z.infer<typeof getLoadBalancerInputSchema>;

export const getLoadBalancer = defineTool<
  GetLoadBalancerInput,
  SlimLoadBalancer,
  HetznerContext
>({
  name: "get_load_balancer",
  description: "Get a load balancer by ID.",
  inputSchema: getLoadBalancerInputSchema,
  handler: async (input, context) => {
    const lb = await context.client.getLoadBalancer(input.load_balancer_id);
    return mapLoadBalancer(lb as Record<string, unknown>);
  },
});

// =============================================================================
// create_load_balancer
// =============================================================================

const createLoadBalancerInputSchema = z.object({
  name: z.string().min(1),
  load_balancer_type: z.string().min(1),
  location: z.string().min(1).optional(),
  network_zone: z.string().min(1).optional(),
  algorithm: z.enum(["round_robin", "least_connections"]).optional(),
  services: z.array(z.record(z.unknown())).optional(),
  targets: z.array(z.record(z.unknown())).optional(),
  public_interface: z.boolean().optional().default(true),
  network: z.number().int().positive().optional(),
  labels: z.record(z.string()).optional(),
  wait: waitField,
});

type CreateLoadBalancerInput = z.infer<typeof createLoadBalancerInputSchema>;

type CreateLoadBalancerOutput = {
  load_balancer: SlimLoadBalancer | null;
  action: ActionSummary | null;
};

export const createLoadBalancer = defineTool<
  CreateLoadBalancerInput,
  CreateLoadBalancerOutput,
  HetznerContext
>({
  name: "create_load_balancer",
  description: "Create a load balancer.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    createLoadBalancerInputSchema as unknown as z.ZodType<CreateLoadBalancerInput>,
  handler: async (input, context) => {
    const reqBody: Record<string, unknown> = {
      name: input.name,
      load_balancer_type: input.load_balancer_type,
      public_interface: input.public_interface,
    };
    if (input.location !== undefined) reqBody.location = input.location;
    if (input.network_zone !== undefined) {
      reqBody.network_zone = input.network_zone;
    }
    if (input.algorithm !== undefined) {
      reqBody.algorithm = { type: input.algorithm };
    }
    if (input.services !== undefined) reqBody.services = input.services;
    if (input.targets !== undefined) reqBody.targets = input.targets;
    if (input.network !== undefined) reqBody.network = input.network;
    if (input.labels !== undefined) reqBody.labels = input.labels;

    const body = await context.client.createLoadBalancer(reqBody);
    const lbRaw = asObject((body as HetznerBody).load_balancer);
    const load_balancer = lbRaw ? mapLoadBalancer(lbRaw) : null;
    const action = await settleAction(context.client, body, input.wait);
    return { load_balancer, action };
  },
});

// =============================================================================
// delete_load_balancer
// =============================================================================

const deleteLoadBalancerInputSchema = z.object({
  load_balancer_id: z.number().int().positive(),
  confirm: confirmField,
  wait: waitField,
});

type DeleteLoadBalancerInput = z.infer<typeof deleteLoadBalancerInputSchema>;

type DeleteLoadBalancerOutput = {
  load_balancer_id: number;
  action: ActionSummary | null;
  deleted: true;
};

export const deleteLoadBalancer = defineTool<
  DeleteLoadBalancerInput,
  DeleteLoadBalancerOutput,
  HetznerContext
>({
  name: "delete_load_balancer",
  description: "Delete a load balancer.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema:
    deleteLoadBalancerInputSchema as unknown as z.ZodType<DeleteLoadBalancerInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE load balancer ${input.load_balancer_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = await context.client.deleteLoadBalancer(
      input.load_balancer_id,
    );
    const action = await settleAction(context.client, body, input.wait);
    return { load_balancer_id: input.load_balancer_id, action, deleted: true };
  },
});
