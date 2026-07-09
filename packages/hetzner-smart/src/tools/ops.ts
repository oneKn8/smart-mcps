import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import type { HetznerBody } from "../client.js";
import { mapServer, type SlimServer } from "./server-mapper.js";
import { priceForServerType, roundMonthly } from "./pricing-util.js";

// =============================================================================
// cost_audit + daily_status — account-wide spend and inventory snapshots.
// =============================================================================
//
// Both compose getAllPages over the account's resources with getPricing(),
// pricing each server by its type + location. Estimates are the sum of the
// on-demand monthly list price for every server (net EUR); they don't reflect
// actual metered usage, which Hetzner's REST surface doesn't expose per server.

function currencyOf(pricing: { currency?: unknown }): string {
  return typeof pricing.currency === "string" && pricing.currency.length > 0
    ? pricing.currency
    : "EUR";
}

// Monthly net EUR for one server, priced by its type at its own location.
function serverMonthly(pricing: HetznerBody, server: SlimServer): number | null {
  if (!server.server_type) return null;
  const price = priceForServerType(
    pricing,
    server.server_type,
    server.location ?? undefined,
  );
  return price.monthly === null ? null : roundMonthly(price.monthly);
}

function notNumber(value: unknown): boolean {
  return typeof value !== "number";
}

// =============================================================================
// cost_audit
// =============================================================================

const costAuditInputSchema = z.object({});

type CostAuditInput = z.infer<typeof costAuditInputSchema>;

type PerServer = {
  id: number;
  name: string;
  status: string;
  server_type: string | null;
  location: string | null;
  monthly_eur: number | null;
};

type CostAuditOutput = {
  currency: string;
  total_monthly_eur: number;
  server_count: number;
  running_count: number;
  per_server: PerServer[];
  stopped_but_charged: Array<{ id: number; name: string; monthly_eur: number | null }>;
};

export const costAudit = defineTool<
  CostAuditInput,
  CostAuditOutput,
  HetznerContext
>({
  name: "cost_audit",
  description: "Estimate total monthly server spend for the account.",
  inputSchema: costAuditInputSchema,
  handler: async (_input, context) => {
    const [servers, pricing] = await Promise.all([
      context.client.getAllPages<Record<string, unknown>>("/servers", "servers"),
      context.client.getPricing(),
    ]);

    const perServer: PerServer[] = [];
    const stopped: Array<{ id: number; name: string; monthly_eur: number | null }> = [];
    let total = 0;
    let running = 0;

    for (const raw of servers) {
      const slim = mapServer(raw);
      const monthly = serverMonthly(pricing, slim);
      perServer.push({
        id: slim.id,
        name: slim.name,
        status: slim.status,
        server_type: slim.server_type,
        location: slim.location,
        monthly_eur: monthly,
      });
      if (monthly !== null) total += monthly;
      if (slim.status === "running") {
        running += 1;
      } else {
        stopped.push({ id: slim.id, name: slim.name, monthly_eur: monthly });
      }
    }

    return {
      currency: currencyOf(pricing),
      total_monthly_eur: roundMonthly(total),
      server_count: servers.length,
      running_count: running,
      per_server: perServer,
      stopped_but_charged: stopped,
    };
  },
});

// =============================================================================
// daily_status
// =============================================================================

const dailyStatusInputSchema = z.object({});

type DailyStatusInput = z.infer<typeof dailyStatusInputSchema>;

type DailyStatusOutput = {
  servers: { total: number; by_status: Record<string, number> };
  volumes: { total: number; unattached: number };
  floating_ips: { total: number; unassigned: number };
  primary_ips: { total: number; unassigned: number };
  networks: number;
  load_balancers: number;
  estimated_monthly_eur: number;
};

export const dailyStatus = defineTool<
  DailyStatusInput,
  DailyStatusOutput,
  HetznerContext
>({
  name: "daily_status",
  description: "Account inventory snapshot with monthly cost estimate.",
  inputSchema: dailyStatusInputSchema,
  handler: async (_input, context) => {
    const [
      servers,
      volumes,
      floatingIps,
      primaryIps,
      networks,
      loadBalancers,
      pricing,
    ] = await Promise.all([
      context.client.getAllPages<Record<string, unknown>>("/servers", "servers"),
      context.client.getAllPages<Record<string, unknown>>("/volumes", "volumes"),
      context.client.getAllPages<Record<string, unknown>>(
        "/floating_ips",
        "floating_ips",
      ),
      context.client.getAllPages<Record<string, unknown>>(
        "/primary_ips",
        "primary_ips",
      ),
      context.client.getAllPages<Record<string, unknown>>("/networks", "networks"),
      context.client.getAllPages<Record<string, unknown>>(
        "/load_balancers",
        "load_balancers",
      ),
      context.client.getPricing(),
    ]);

    const byStatus: Record<string, number> = {};
    let estimated = 0;
    for (const raw of servers) {
      const status = typeof raw.status === "string" ? raw.status : "unknown";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      const monthly = serverMonthly(pricing, mapServer(raw));
      if (monthly !== null) estimated += monthly;
    }

    const unattachedVolumes = volumes.filter((v) => notNumber(v.server)).length;
    const unassignedFloating = floatingIps.filter((f) =>
      notNumber(f.server),
    ).length;
    const unassignedPrimary = primaryIps.filter((p) =>
      notNumber(p.assignee_id),
    ).length;

    return {
      servers: { total: servers.length, by_status: byStatus },
      volumes: { total: volumes.length, unattached: unattachedVolumes },
      floating_ips: { total: floatingIps.length, unassigned: unassignedFloating },
      primary_ips: { total: primaryIps.length, unassigned: unassignedPrimary },
      networks: networks.length,
      load_balancers: loadBalancers.length,
      estimated_monthly_eur: roundMonthly(estimated),
    };
  },
});
