import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { waitField, settleAction, type ActionSummary } from "./wait-schema.js";
import { mapServer, type SlimServer } from "./server-mapper.js";
import { nullableString } from "./null-helpers.js";
import {
  rankServerTypes,
  priceForServerType,
  roundMonthly,
} from "./pricing-util.js";

// =============================================================================
// deploy_server — flagship shortcut: pick a type, optionally firewall it, boot.
// =============================================================================
//
// Composes rankServerTypes (when no explicit server_type is given) + an optional
// quick firewall (SSH/HTTP/HTTPS open) + createServer, then settles the boot
// action and surfaces the assigned IP plus the monthly price. NOT confirm-gated:
// creating the box IS the intent, but the cost is surfaced so the caller sees
// what they signed up for.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const deployServerInputSchema = z.object({
  name: z.string().min(1),
  server_type: z.string().min(1).optional(),
  min_cores: z.number().int().positive().optional(),
  min_memory: z.number().positive().optional(),
  arch: z.enum(["x86", "arm"]).optional().default("x86"),
  location: z.string().min(1).optional().default("nbg1"),
  image: z.string().min(1).optional().default("ubuntu-24.04"),
  ssh_key: z.string().min(1).optional(),
  quick_firewall: z.boolean().optional().default(false),
  user_data: z.string().optional(),
  labels: z.record(z.string()).optional(),
  wait: waitField,
});

type DeployServerInput = z.infer<typeof deployServerInputSchema>;

type DeployServerOutput = {
  server_id: number;
  name: string;
  status: string;
  ipv4: string | null;
  ipv6: string | null;
  server_type: string;
  location: string | null;
  root_password: string | null;
  monthly_cost_eur: number | null;
  firewall_id: number | null;
  action: ActionSummary | null;
};

// Opens SSH (22), HTTP (80), HTTPS (443) inbound from anywhere (IPv4 + IPv6).
function quickFirewallRules(): Array<Record<string, unknown>> {
  const anywhere = ["0.0.0.0/0", "::/0"];
  return ["22", "80", "443"].map((port) => ({
    direction: "in",
    protocol: "tcp",
    port,
    source_ips: anywhere,
  }));
}

export const deployServer = defineTool<
  DeployServerInput,
  DeployServerOutput,
  HetznerContext
>({
  name: "deploy_server",
  description: "Pick cheapest type, firewall, and boot a server.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: deployServerInputSchema as unknown as z.ZodType<DeployServerInput>,
  handler: async (input, context) => {
    // Resolve the server type: explicit wins; otherwise the cheapest match.
    let resolvedType = input.server_type;
    if (resolvedType === undefined) {
      const ranked = await rankServerTypes(context.client, {
        min_cores: input.min_cores,
        min_memory: input.min_memory,
        arch: input.arch,
        location: input.location,
      });
      const top = ranked[0];
      if (!top) {
        throw new ValidationError(
          `No Hetzner server type matches the filters (arch=${input.arch}` +
            `${input.min_cores !== undefined ? `, min_cores=${input.min_cores}` : ""}` +
            `${input.min_memory !== undefined ? `, min_memory=${input.min_memory}` : ""}).`,
        );
      }
      resolvedType = top.name;
    }

    // Optional quick firewall, created before the server so it can be attached.
    let firewallId: number | null = null;
    if (input.quick_firewall) {
      const fwBody = await context.client.createFirewall({
        name: `${input.name}-fw`,
        rules: quickFirewallRules(),
      });
      const id = asRecord(fwBody.firewall)?.id;
      if (typeof id === "number") firewallId = id;
    }

    const reqBody: Record<string, unknown> = {
      name: input.name,
      server_type: resolvedType,
      image: input.image,
      location: input.location,
      ssh_keys: input.ssh_key ? [input.ssh_key] : [],
      firewalls: firewallId ? [{ firewall: firewallId }] : [],
      start_after_create: true,
      public_net: { enable_ipv4: true, enable_ipv6: true },
    };
    if (input.user_data !== undefined) reqBody.user_data = input.user_data;
    if (input.labels !== undefined) reqBody.labels = input.labels;

    const created = await context.client.createServer(reqBody);
    const action = await settleAction(context.client, created, input.wait);
    const rootPassword = nullableString(created.root_password);

    let server: SlimServer | null = null;
    const serverRaw = asRecord(created.server);
    if (serverRaw) server = mapServer(serverRaw);

    // On wait the boot action has settled, so re-fetch for the assigned IP.
    if (input.wait && server && server.id > 0) {
      const refreshed = await context.client.getServer(server.id);
      server = mapServer(refreshed as Record<string, unknown>);
    }

    const pricing = await context.client.getPricing();
    const price = priceForServerType(pricing, resolvedType, input.location);
    const monthly = price.monthly === null ? null : roundMonthly(price.monthly);

    return {
      server_id: server?.id ?? 0,
      name: input.name,
      status: server?.status ?? "",
      ipv4: server?.ipv4 ?? null,
      ipv6: server?.ipv6 ?? null,
      server_type: resolvedType,
      location: server?.location ?? input.location,
      root_password: rootPassword,
      monthly_cost_eur: monthly,
      firewall_id: firewallId,
      action,
    };
  },
});
