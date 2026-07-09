import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { confirmField } from "./wait-schema.js";
import { nullableString } from "./null-helpers.js";

// Slim view of a Hetzner private Network. Upstream nests subnets/routes/servers
// as arrays and protection under `protection`; we surface counts plus the delete
// guard and drop everything else (created, load_balancers, expose_routes...).
export type SlimNetwork = {
  id: number;
  name: string;
  ip_range: string | null;
  subnets_count: number;
  servers_count: number;
  protection_delete: boolean;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mapNetwork(raw: Record<string, unknown>): SlimNetwork {
  const protection = asObject(raw.protection);
  const labelsRaw = asObject(raw.labels);
  const subnets = Array.isArray(raw.subnets) ? raw.subnets : [];
  const servers = Array.isArray(raw.servers) ? raw.servers : [];

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    ip_range: nullableString(raw.ip_range),
    subnets_count: subnets.length,
    servers_count: servers.length,
    protection_delete: protection?.delete === true,
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_networks
// =============================================================================

const listNetworksInputSchema = z.object({
  name: z.string().min(1).optional(),
  label_selector: z.string().min(1).optional(),
});

type ListNetworksInput = z.infer<typeof listNetworksInputSchema>;

type ListNetworksOutput = {
  networks: SlimNetwork[];
  count: number;
};

export const listNetworks = defineTool<
  ListNetworksInput,
  ListNetworksOutput,
  HetznerContext
>({
  name: "list_networks",
  description: "List private networks",
  inputSchema: listNetworksInputSchema,
  handler: async (input, context) => {
    const params: { name?: string; label_selector?: string } = {};
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined) {
      params.label_selector = input.label_selector;
    }

    const body = await context.client.listNetworks(params);
    const networks = Array.isArray(body.networks) ? body.networks : [];
    return {
      networks: networks.map((n) => mapNetwork(n as Record<string, unknown>)),
      count: networks.length,
    };
  },
});

// =============================================================================
// get_network
// =============================================================================

const getNetworkInputSchema = z.object({
  network_id: z.number().int().positive(),
});

type GetNetworkInput = z.infer<typeof getNetworkInputSchema>;

export const getNetwork = defineTool<GetNetworkInput, SlimNetwork, HetznerContext>({
  name: "get_network",
  description: "Get a private network by ID",
  inputSchema: getNetworkInputSchema,
  handler: async (input, context) => {
    // getNetwork returns the resource ALREADY UNWRAPPED (not `{ network }`).
    const network = await context.client.getNetwork(input.network_id);
    return mapNetwork(network as Record<string, unknown>);
  },
});

// =============================================================================
// create_network
// =============================================================================

const subnetSchema = z.object({
  type: z.string().min(1),
  ip_range: z.string().min(1),
  network_zone: z.string().min(1),
  vswitch_id: z.number().int().positive().optional(),
});

const routeSchema = z.object({
  destination: z.string().min(1),
  gateway: z.string().min(1),
});

const createNetworkInputSchema = z.object({
  name: z.string().min(1),
  ip_range: z.string().min(1),
  subnets: z.array(subnetSchema).optional(),
  routes: z.array(routeSchema).optional(),
  labels: z.record(z.string()).optional(),
});

type CreateNetworkInput = z.infer<typeof createNetworkInputSchema>;

export const createNetwork = defineTool<
  CreateNetworkInput,
  SlimNetwork,
  HetznerContext
>({
  name: "create_network",
  description: "Create a private network",
  inputSchema: createNetworkInputSchema,
  handler: async (input, context) => {
    // Only forward fields the caller actually set; Hetzner rejects unknown nulls.
    const body: Record<string, unknown> = {
      name: input.name,
      ip_range: input.ip_range,
    };
    if (input.subnets !== undefined) body.subnets = input.subnets;
    if (input.routes !== undefined) body.routes = input.routes;
    if (input.labels !== undefined) body.labels = input.labels;

    // createNetwork is synchronous — it returns the full body `{ network }`.
    const created = await context.client.createNetwork(body);
    const network = asObject((created as Record<string, unknown>).network) ?? {};
    return mapNetwork(network);
  },
});

// =============================================================================
// delete_network
// =============================================================================

const deleteNetworkInputSchema = z.object({
  network_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeleteNetworkInput = z.infer<typeof deleteNetworkInputSchema>;

type DeleteNetworkOutput = {
  network_id: number;
  deleted: true;
};

export const deleteNetwork = defineTool<
  DeleteNetworkInput,
  DeleteNetworkOutput,
  HetznerContext
>({
  name: "delete_network",
  description: "Delete a private network",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: deleteNetworkInputSchema as unknown as z.ZodType<DeleteNetworkInput>,
  handler: async (input, context) => {
    const preview =
      `Will PERMANENTLY DELETE network ${input.network_id} (subnets and routes removed)`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteNetwork(input.network_id);
    return { network_id: input.network_id, deleted: true };
  },
});
