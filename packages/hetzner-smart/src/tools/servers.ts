import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import type { HetznerListParams, HetznerMetricsParams } from "../client.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { mapServer, type SlimServer } from "./server-mapper.js";
import { nullableString, nullableNumber } from "./null-helpers.js";

// Local object guard — the upstream nests everything and regularly nulls keys.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// =============================================================================
// list_servers
// =============================================================================

const listServersInputSchema = z.object({
  status: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  label_selector: z.string().min(1).optional(),
  page: z.number().int().positive().optional(),
  per_page: z.number().int().positive().optional(),
});

type ListServersInput = z.infer<typeof listServersInputSchema>;

type ListServersOutput = {
  servers: SlimServer[];
  count: number;
};

export const listServers = defineTool<
  ListServersInput,
  ListServersOutput,
  HetznerContext
>({
  name: "list_servers",
  description: "List Hetzner Cloud servers.",
  inputSchema: listServersInputSchema,
  handler: async (input, context) => {
    const params: HetznerListParams = {};
    if (input.status !== undefined) params.status = input.status;
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined)
      params.label_selector = input.label_selector;
    if (input.page !== undefined) params.page = input.page;
    if (input.per_page !== undefined) params.per_page = input.per_page;

    const body = await context.client.listServers(params);
    const raw = Array.isArray(body.servers) ? body.servers : [];
    const servers = raw.map((s) => mapServer(s as Record<string, unknown>));
    return { servers, count: servers.length };
  },
});

// =============================================================================
// get_server
// =============================================================================

const getServerInputSchema = z.object({
  server_id: z.number().int().positive(),
});

type GetServerInput = z.infer<typeof getServerInputSchema>;

export const getServer = defineTool<GetServerInput, SlimServer, HetznerContext>({
  name: "get_server",
  description: "Get a server by ID.",
  inputSchema: getServerInputSchema,
  handler: async (input, context) => {
    const server = await context.client.getServer(input.server_id);
    return mapServer(server as Record<string, unknown>);
  },
});

// =============================================================================
// create_server
// =============================================================================

const createServerInputSchema = z.object({
  name: z.string().min(1),
  server_type: z.string().min(1),
  image: z.string().min(1),
  location: z.string().min(1).optional(),
  ssh_keys: z.array(z.string()).optional(),
  firewalls: z.array(z.number().int().positive()).optional(),
  volumes: z.array(z.number().int().positive()).optional(),
  networks: z.array(z.number().int().positive()).optional(),
  placement_group: z.number().int().positive().optional(),
  user_data: z.string().optional(),
  labels: z.record(z.string()).optional(),
  start_after_create: z.boolean().optional().default(true),
  public_ipv4: z.boolean().optional().default(true),
  public_ipv6: z.boolean().optional().default(true),
  wait: waitField,
});

type CreateServerInput = z.infer<typeof createServerInputSchema>;

type CreateServerOutput = {
  server: SlimServer | null;
  action: ActionSummary | null;
  root_password: string | null;
};

export const createServer = defineTool<
  CreateServerInput,
  CreateServerOutput,
  HetznerContext
>({
  name: "create_server",
  description: "Create a new server.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: createServerInputSchema as unknown as z.ZodType<CreateServerInput>,
  handler: async (input, context) => {
    const reqBody: Record<string, unknown> = {
      name: input.name,
      server_type: input.server_type,
      image: input.image,
      start_after_create: input.start_after_create,
      public_net: {
        enable_ipv4: input.public_ipv4,
        enable_ipv6: input.public_ipv6,
      },
    };
    if (input.location !== undefined) reqBody.location = input.location;
    if (input.ssh_keys !== undefined) reqBody.ssh_keys = input.ssh_keys;
    if (input.firewalls !== undefined)
      reqBody.firewalls = input.firewalls.map((id) => ({ firewall: id }));
    if (input.volumes !== undefined) reqBody.volumes = input.volumes;
    if (input.networks !== undefined) reqBody.networks = input.networks;
    if (input.placement_group !== undefined)
      reqBody.placement_group = input.placement_group;
    if (input.user_data !== undefined) reqBody.user_data = input.user_data;
    if (input.labels !== undefined) reqBody.labels = input.labels;

    const created = await context.client.createServer(reqBody);
    const action = await settleAction(context.client, created, input.wait);
    const rootPassword = nullableString(created.root_password);

    const serverRaw = asRecord(created.server);
    let server: SlimServer | null = serverRaw ? mapServer(serverRaw) : null;

    // On wait the action has settled, so re-fetch for the now-assigned public IP.
    if (input.wait && server && server.id > 0) {
      const refreshed = await context.client.getServer(server.id);
      server = mapServer(refreshed as Record<string, unknown>);
    }

    return { server, action, root_password: rootPassword };
  },
});

// =============================================================================
// update_server
// =============================================================================

const updateServerInputSchema = z.object({
  server_id: z.number().int().positive(),
  name: z.string().min(1).optional(),
  labels: z.record(z.string()).optional(),
});

type UpdateServerInput = z.infer<typeof updateServerInputSchema>;

export const updateServer = defineTool<
  UpdateServerInput,
  SlimServer,
  HetznerContext
>({
  name: "update_server",
  description: "Rename or relabel a server.",
  inputSchema: updateServerInputSchema,
  handler: async (input, context) => {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.labels !== undefined) patch.labels = input.labels;

    const updated = await context.client.updateServer(input.server_id, patch);
    // PUT /servers/{id} returns `{ server }`; fall back to the raw body.
    const serverObj = asRecord(updated.server) ?? updated;
    return mapServer(serverObj);
  },
});

// =============================================================================
// delete_server
// =============================================================================

const deleteServerInputSchema = z.object({
  server_id: z.number().int().positive(),
  confirm: confirmField,
  wait: waitField,
});

type DeleteServerInput = z.infer<typeof deleteServerInputSchema>;

type DeleteServerOutput = {
  server_id: number;
  action: ActionSummary | null;
  deleted: true;
};

export const deleteServer = defineTool<
  DeleteServerInput,
  DeleteServerOutput,
  HetznerContext
>({
  name: "delete_server",
  description: "Delete a server permanently.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: deleteServerInputSchema as unknown as z.ZodType<DeleteServerInput>,
  handler: async (input, context) => {
    const info = mapServer(
      (await context.client.getServer(input.server_id)) as Record<
        string,
        unknown
      >,
    );
    const preview = `Will PERMANENTLY DELETE server ${info.name} (id ${input.server_id}, ipv4 ${info.ipv4 ?? "none"})`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = await context.client.deleteServer(input.server_id);
    const action = await settleAction(context.client, body, input.wait);
    return { server_id: input.server_id, action, deleted: true };
  },
});

// =============================================================================
// get_server_metrics
// =============================================================================

const getServerMetricsInputSchema = z.object({
  server_id: z.number().int().positive(),
  type: z.array(z.enum(["cpu", "disk", "network"])).optional().default(["cpu"]),
  start: z.string().min(1).optional(),
  end: z.string().min(1).optional(),
  step: z.number().int().positive().optional(),
});

type GetServerMetricsInput = z.infer<typeof getServerMetricsInputSchema>;

type GetServerMetricsOutput = {
  server_id: number;
  start: string;
  end: string;
  step: number | null;
  series: string[];
};

export const getServerMetrics = defineTool<
  GetServerMetricsInput,
  GetServerMetricsOutput,
  HetznerContext
>({
  name: "get_server_metrics",
  description: "Get server CPU, disk, network metrics.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: getServerMetricsInputSchema as unknown as z.ZodType<GetServerMetricsInput>,
  handler: async (input, context) => {
    const end = input.end ?? new Date().toISOString();
    const start = input.start ?? new Date(Date.now() - 3_600_000).toISOString();

    const params: HetznerMetricsParams = {
      type: input.type.join(","),
      start,
      end,
    };
    if (input.step !== undefined) params.step = input.step;

    const body = await context.client.getServerMetrics(input.server_id, params);
    const metrics = asRecord(body.metrics);
    const timeSeries = asRecord(metrics?.time_series);
    const series = timeSeries ? Object.keys(timeSeries) : [];

    return {
      server_id: input.server_id,
      start,
      end,
      step: nullableNumber(metrics?.step),
      series,
    };
  },
});
