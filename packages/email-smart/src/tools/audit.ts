import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { readAudit, type AuditEntry } from "../audit.js";

// ---------- list_recent_sends ----------

const listRecentSendsInputSchema = z.object({
  account: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});
type ListRecentSendsInput = z.infer<typeof listRecentSendsInputSchema>;

type ListRecentSendsOutput = {
  entries: AuditEntry[];
  total: number;
  returned: number;
};

function tsCompareDesc(a: AuditEntry, b: AuditEntry): number {
  // Sort newest-first by lexicographic ts compare. ISO 8601 strings sort
  // correctly when they share the same offset shape (Z or +HH:MM); mixing
  // offsets in the same log would skew ordering, but that's outside this
  // tool's contract — ts is written by us as `new Date().toISOString()`.
  if (a.ts < b.ts) return 1;
  if (a.ts > b.ts) return -1;
  return 0;
}

export const listRecentSendsTool = defineTool<
  ListRecentSendsInput,
  ListRecentSendsOutput,
  EmailContext
>({
  name: "list_recent_sends",
  description: "Recent sent-email log entries (paginated).",
  // Cast required: ZodDefault on `limit`/`offset` widens schema input type vs
  // the resolved output the handler sees.
  inputSchema: listRecentSendsInputSchema as unknown as z.ZodType<ListRecentSendsInput>,
  handler: async (input, context) => {
    const all = readAudit(context.home);
    const filtered =
      input.account !== undefined
        ? all.filter((e) => e.account === input.account)
        : all;
    const sorted = [...filtered].sort(tsCompareDesc);
    const page = sorted.slice(input.offset, input.offset + input.limit);
    return {
      entries: page,
      total: filtered.length,
      returned: page.length,
    };
  },
});

// ---------- search_audit ----------

const searchAuditInputSchema = z.object({
  account: z.string().optional(),
  to_contains: z.string().optional(),
  subject_contains: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(50),
});
type SearchAuditInput = z.infer<typeof searchAuditInputSchema>;

type SearchAuditOutput = {
  entries: AuditEntry[];
  matched: number;
};

function parseIsoBoundary(value: string, field: "since" | "until"): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ValidationError(
      `invalid ISO timestamp for "${field}": ${value}`,
    );
  }
  return ms;
}

export const searchAuditTool = defineTool<
  SearchAuditInput,
  SearchAuditOutput,
  EmailContext
>({
  name: "search_audit",
  description: "Search past sends by recipient, subject, or date.",
  // Cast required: ZodDefault on `limit` widens schema input type vs the
  // resolved output the handler sees.
  inputSchema: searchAuditInputSchema as unknown as z.ZodType<SearchAuditInput>,
  handler: async (input, context) => {
    const sinceMs =
      input.since !== undefined ? parseIsoBoundary(input.since, "since") : undefined;
    const untilMs =
      input.until !== undefined ? parseIsoBoundary(input.until, "until") : undefined;

    const toNeedle = input.to_contains?.toLowerCase();
    const subjectNeedle = input.subject_contains?.toLowerCase();

    const all = readAudit(context.home);
    const matched = all.filter((e) => {
      if (input.account !== undefined && e.account !== input.account) return false;
      if (toNeedle !== undefined && !e.to.toLowerCase().includes(toNeedle)) return false;
      if (
        subjectNeedle !== undefined &&
        !e.subject.toLowerCase().includes(subjectNeedle)
      ) {
        return false;
      }
      if (sinceMs !== undefined || untilMs !== undefined) {
        const entryMs = Date.parse(e.ts);
        if (Number.isNaN(entryMs)) return false;
        if (sinceMs !== undefined && entryMs < sinceMs) return false;
        if (untilMs !== undefined && entryMs > untilMs) return false;
      }
      return true;
    });

    const sorted = [...matched].sort(tsCompareDesc);
    const page = sorted.slice(0, input.limit);
    return {
      entries: page,
      matched: matched.length,
    };
  },
});
