import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { nullableNumber } from "./null-helpers.js";

// =============================================================================
// account_summary
// =============================================================================

const accountSummaryInputSchema = z.object({});

type AccountSummaryInput = z.infer<typeof accountSummaryInputSchema>;

type AccountSummaryOutput = {
  balance_usd: number | null;
  spend_per_hr: number | null;
  spend_limit: number | null;
  min_balance: number | null;
  active_pod_count: number;
  runway_hours: number | null;
  notes: string[];
};

export const accountSummary = defineTool<
  AccountSummaryInput,
  AccountSummaryOutput,
  RunpodContext
>({
  name: "account_summary",
  description: "Account balance, burn rate, and runway.",
  inputSchema: accountSummaryInputSchema,
  handler: async (_input, context) => {
    const balance = await context.client.getBalance();
    const { pods } = await context.client.listPods({ desiredStatus: "RUNNING" });

    const balance_usd = nullableNumber(balance.clientBalance);
    const spend_per_hr = nullableNumber(balance.currentSpendPerHr);
    const spend_limit = nullableNumber(balance.spendLimit);
    const min_balance = nullableNumber(balance.minBalance);

    // Runway is only meaningful when we know both the balance and a positive
    // burn rate. A zero/absent burn rate implies indefinite runway, which we
    // represent as null rather than fabricating Infinity. Round to 1 decimal.
    let runway_hours: number | null = null;
    if (spend_per_hr !== null && spend_per_hr > 0 && balance_usd !== null) {
      runway_hours = Math.round((balance_usd / spend_per_hr) * 10) / 10;
    }

    const notes: string[] = [];
    if (runway_hours !== null && runway_hours < 24) {
      notes.push(`Low runway: ${runway_hours}h at current burn.`);
    }
    if (
      balance_usd !== null &&
      min_balance !== null &&
      balance_usd <= min_balance
    ) {
      notes.push(
        `Balance $${balance_usd} is at or below the minimum $${min_balance}.`,
      );
    }

    return {
      balance_usd,
      spend_per_hr,
      spend_limit,
      min_balance,
      active_pod_count: pods.length,
      runway_hours,
      notes,
    };
  },
});
