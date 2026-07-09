import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { nullableString, nullableNumber } from "./null-helpers.js";
import { parseNet, firstPrice, roundMonthly } from "./pricing-util.js";

// =============================================================================
// cleanup_waste — dry-run-first sweep of cheap billable waste.
// =============================================================================
//
// Reports stopped servers (still billed, but NEVER auto-deleted — deleting a box
// is far too destructive for a sweep) and deletes only the cheap, unambiguous
// waste: unattached volumes, and unassigned floating / primary IPs. `dry_run`
// defaults true and WINS over confirm; the destructive path is guarded.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numId(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

const cleanupWasteInputSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type CleanupWasteInput = z.infer<typeof cleanupWasteInputSchema>;

type Candidates = {
  stopped_servers: Array<{ id: number; name: string }>;
  unattached_volumes: Array<{ id: number; name: string; size: number | null }>;
  unassigned_floating_ips: Array<{ id: number; ip: string | null }>;
  unassigned_primary_ips: Array<{ id: number; ip: string | null }>;
};

type CleanupWasteOutput = {
  dry_run: boolean;
  candidates: Candidates;
  estimated_monthly_savings_eur: number;
  deleted: Array<{ type: string; id: number }>;
};

function buildPreview(c: Candidates, savings: number): string {
  return (
    `Will delete ${c.unattached_volumes.length} unattached volume(s), ` +
    `${c.unassigned_floating_ips.length} floating IP(s), and ` +
    `${c.unassigned_primary_ips.length} primary IP(s); ` +
    `${c.stopped_servers.length} stopped server(s) reported only (NOT deleted). ` +
    `Est. savings ~${savings} EUR/mo.`
  );
}

export const cleanupWaste = defineTool<
  CleanupWasteInput,
  CleanupWasteOutput,
  HetznerContext
>({
  name: "cleanup_waste",
  description: "Delete unattached volumes and unassigned IPs.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: cleanupWasteInputSchema as unknown as z.ZodType<CleanupWasteInput>,
  handler: async (input, context) => {
    const [servers, volumes, floatingIps, primaryIps, pricing] =
      await Promise.all([
        context.client.getAllPages<Record<string, unknown>>(
          "/servers",
          "servers",
        ),
        context.client.getAllPages<Record<string, unknown>>(
          "/volumes",
          "volumes",
        ),
        context.client.getAllPages<Record<string, unknown>>(
          "/floating_ips",
          "floating_ips",
        ),
        context.client.getAllPages<Record<string, unknown>>(
          "/primary_ips",
          "primary_ips",
        ),
        context.client.getPricing(),
      ]);

    // Stopped servers: reported only, never deleted.
    const stoppedServers: Array<{ id: number; name: string }> = [];
    for (const raw of servers) {
      const rec = asRecord(raw);
      if (rec?.status === "off") {
        stoppedServers.push({
          id: numId(rec.id),
          name: nullableString(rec.name) ?? "",
        });
      }
    }

    // Unattached volumes: server not a number => not attached.
    const volPerGb = parseNet(asRecord(pricing.volume)?.price_per_gb_month) ?? 0;
    const unattachedVolumes: Array<{ id: number; name: string; size: number | null }> = [];
    let volSavings = 0;
    for (const raw of volumes) {
      const rec = asRecord(raw);
      if (!rec || typeof rec.server === "number") continue;
      const size = nullableNumber(rec.size);
      unattachedVolumes.push({
        id: numId(rec.id),
        name: nullableString(rec.name) ?? "",
        size,
      });
      if (size !== null) volSavings += volPerGb * size;
    }

    // Unassigned floating IPs: server not a number => not assigned.
    const unassignedFloating: Array<{ id: number; ip: string | null }> = [];
    let floatSavings = 0;
    for (const raw of floatingIps) {
      const rec = asRecord(raw);
      if (!rec || typeof rec.server === "number") continue;
      const type = typeof rec.type === "string" ? rec.type : "ipv4";
      unassignedFloating.push({ id: numId(rec.id), ip: nullableString(rec.ip) });
      const p = firstPrice(pricing.floating_ips, type);
      if (p !== null) floatSavings += p;
    }

    // Unassigned primary IPs: assignee_id not a number => not assigned.
    const unassignedPrimary: Array<{ id: number; ip: string | null }> = [];
    let primarySavings = 0;
    for (const raw of primaryIps) {
      const rec = asRecord(raw);
      if (!rec || typeof rec.assignee_id === "number") continue;
      const type = typeof rec.type === "string" ? rec.type : "ipv4";
      unassignedPrimary.push({ id: numId(rec.id), ip: nullableString(rec.ip) });
      const p = firstPrice(pricing.primary_ips, type);
      if (p !== null) primarySavings += p;
    }

    const candidates: Candidates = {
      stopped_servers: stoppedServers,
      unattached_volumes: unattachedVolumes,
      unassigned_floating_ips: unassignedFloating,
      unassigned_primary_ips: unassignedPrimary,
    };
    const estimatedSavings = roundMonthly(
      volSavings + floatSavings + primarySavings,
    );

    // dry_run wins over confirm: preview only, delete nothing.
    if (input.dry_run) {
      return {
        dry_run: true,
        candidates,
        estimated_monthly_savings_eur: estimatedSavings,
        deleted: [],
      };
    }

    guardDestructive({
      confirm: input.confirm,
      preview: buildPreview(candidates, estimatedSavings),
    });

    // Apply path — sequential deletes; stopped servers are never touched.
    const deleted: Array<{ type: string; id: number }> = [];
    for (const v of unattachedVolumes) {
      await context.client.deleteVolume(v.id);
      deleted.push({ type: "volume", id: v.id });
    }
    for (const f of unassignedFloating) {
      await context.client.deleteFloatingIp(f.id);
      deleted.push({ type: "floating_ip", id: f.id });
    }
    for (const p of unassignedPrimary) {
      await context.client.deletePrimaryIp(p.id);
      deleted.push({ type: "primary_ip", id: p.id });
    }

    return {
      dry_run: false,
      candidates,
      estimated_monthly_savings_eur: estimatedSavings,
      deleted,
    };
  },
});
