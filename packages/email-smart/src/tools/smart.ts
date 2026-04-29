import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { readAudit, type AuditEntry } from "../audit.js";
import { mapMessage, type SlimMessage } from "../message-mapper.js";

// ---------- daily_status ----------

const dailyStatusInputSchema = z.object({
  account: z.string().min(1),
  hours: z.number().int().min(1).max(720).optional().default(24),
});

type DailyStatusInput = z.infer<typeof dailyStatusInputSchema>;

type DailyStatusOutput = {
  account: string;
  window_hours: number;
  sends: {
    total: number;
    recent: AuditEntry[];
    latest_at: string | null;
  };
  inbox: {
    unread_count: number;
  };
  notes: string[];
};

function tsCompareDesc(a: AuditEntry, b: AuditEntry): number {
  if (a.ts < b.ts) return 1;
  if (a.ts > b.ts) return -1;
  return 0;
}

export const dailyStatus = defineTool<
  DailyStatusInput,
  DailyStatusOutput,
  EmailContext
>({
  name: "daily_status",
  description: "Today's send count + unread inbox + recent failures.",
  // Cast required: ZodDefault on `hours` widens the input type.
  inputSchema: dailyStatusInputSchema as unknown as z.ZodType<DailyStatusInput>,
  handler: async (input, context) => {
    const all = readAudit(context.home).filter(
      (e) => e.account === input.account,
    );
    const cutoff = Date.now() - input.hours * 3600 * 1000;
    const recent = all
      .filter((e) => {
        const ms = Date.parse(e.ts);
        return !Number.isNaN(ms) && ms >= cutoff;
      })
      .sort(tsCompareDesc);

    const notes: string[] = [];
    const partials = recent.filter((e) => e.gmail_id.length === 0);
    if (partials.length > 0) {
      notes.push(
        `${partials.length} audit entry(ies) missing gmail_id (likely from a failed send)`,
      );
    }
    if (recent.length === 0) {
      notes.push(
        `no sends from account "${input.account}" in last ${input.hours}h`,
      );
    }

    const list = await context.client.listMessages(input.account, {
      q: "is:unread",
      maxResults: 1,
    });

    return {
      account: input.account,
      window_hours: input.hours,
      sends: {
        total: recent.length,
        recent: recent.slice(0, 10),
        latest_at: recent.length > 0 ? (recent[0]?.ts ?? null) : null,
      },
      inbox: {
        unread_count: list.resultSizeEstimate ?? 0,
      },
      notes,
    };
  },
});

// ---------- inbox_zero_dry_run ----------

const inboxZeroDryRunInputSchema = z.object({
  account: z.string().min(1),
  max: z.number().int().min(1).max(500).optional().default(200),
});

type InboxZeroDryRunInput = z.infer<typeof inboxZeroDryRunInputSchema>;

type NoisySender = {
  from_domain: string;
  count: number;
  sample_subjects: string[];
  suggested_query: string;
};

type StaleEntry = {
  id: string;
  from: string;
  subject: string;
  date: string;
};

type InboxZeroDryRunOutput = {
  account: string;
  scanned: number;
  total_unread: number;
  noisy_senders: NoisySender[];
  stale_unread: StaleEntry[];
  suggested_actions: string[];
};

const NOISY_DOMAIN_MIN = 3;
const HEALTHY_UNREAD_MAX = 50;

const NEWSLETTER_KEYWORDS = [
  "newsletter",
  "digest",
  "weekly",
  "unsubscribe",
  "subscription",
];

function extractDomain(from: string): string {
  // Try angle-bracket form: "Name <user@domain>"
  const angle = from.match(/<([^>@\s]+)@([^>\s]+)>/);
  if (angle && typeof angle[2] === "string") {
    return angle[2].toLowerCase();
  }
  // Fallback to bare email: "user@domain"
  const bare = from.match(/([^\s@]+)@(\S+)/);
  if (bare && typeof bare[2] === "string") {
    return bare[2].replace(/[>,;]+$/, "").toLowerCase();
  }
  return "<unknown>";
}

function matchesNewsletterHeuristic(subject: string): boolean {
  const lower = subject.toLowerCase();
  return NEWSLETTER_KEYWORDS.some((kw) => lower.includes(kw));
}

// Gmail's auto-categorization is the strongest noise signal — anything Gmail
// itself bucketed as Promotions or Updates is almost always marketing.
const NOISE_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"]);

function looksLikeNoise(msg: SlimMessage): boolean {
  if (matchesNewsletterHeuristic(msg.subject)) return true;
  return msg.labels.some((l) => NOISE_LABELS.has(l));
}

export const inboxZeroDryRun = defineTool<
  InboxZeroDryRunInput,
  InboxZeroDryRunOutput,
  EmailContext
>({
  name: "inbox_zero_dry_run",
  description: "Preview noise-clearing actions on inbox.",
  // Cast required: ZodDefault on `max` widens the input type.
  inputSchema:
    inboxZeroDryRunInputSchema as unknown as z.ZodType<InboxZeroDryRunInput>,
  handler: async (input, context) => {
    // Pull both the inbox window AND the total unread count in parallel —
    // the heuristic only sees the most-recent N, so the absolute unread
    // figure is critical context the suggested_actions must surface.
    const [inboxList, unreadList] = await Promise.all([
      context.client.listMessages(input.account, {
        q: "in:inbox",
        maxResults: input.max,
      }),
      context.client.listMessages(input.account, {
        q: "is:unread",
        maxResults: 1,
      }),
    ]);
    const totalUnread = unreadList.resultSizeEstimate ?? 0;

    const slims: SlimMessage[] = [];
    for (const ref of inboxList.messages) {
      const raw = await context.client.getMessage(
        input.account,
        ref.id,
        "metadata",
      );
      slims.push(mapMessage(raw));
    }

    // Group by from-domain.
    const byDomain = new Map<string, SlimMessage[]>();
    for (const m of slims) {
      const domain = extractDomain(m.from);
      const bucket = byDomain.get(domain);
      if (bucket === undefined) byDomain.set(domain, [m]);
      else bucket.push(m);
    }

    const noisy: NoisySender[] = [];
    for (const [domain, msgs] of byDomain) {
      if (msgs.length < NOISY_DOMAIN_MIN) continue;
      if (!msgs.some(looksLikeNoise)) continue;
      noisy.push({
        from_domain: domain,
        count: msgs.length,
        sample_subjects: msgs.slice(0, 3).map((m) => m.subject),
        suggested_query: `from:@${domain} in:inbox`,
      });
    }
    // Sort noisiest-first for human readability.
    noisy.sort((a, b) => b.count - a.count);

    // Stale: UNREAD label and date older than 30 days.
    const staleCutoff = Date.now() - 30 * 86400 * 1000;
    const stale: StaleEntry[] = [];
    for (const m of slims) {
      if (!m.labels.includes("UNREAD")) continue;
      const ms = Date.parse(m.date);
      if (Number.isNaN(ms)) continue;
      if (ms >= staleCutoff) continue;
      stale.push({ id: m.id, from: m.from, subject: m.subject, date: m.date });
      if (stale.length >= 20) break;
    }

    const suggested: string[] = [];
    if (noisy.length > 0) {
      const names = noisy.map((n) => n.from_domain).join(", ");
      suggested.push(
        `${noisy.length} noisy sender(s) identified: ${names} — consider archive_by_query with each`,
      );
    }
    if (stale.length > 0) {
      suggested.push(
        `${stale.length} stale unread message(s) older than 30 days — consider mark_read_by_query with q='is:unread older_than:30d'`,
      );
    }
    // Honest framing: "healthy" only when total_unread is small AND nothing
    // suspicious in the scanned window. Otherwise tell the user the scan
    // didn't find anything but the absolute unread count is non-trivial.
    if (noisy.length === 0 && stale.length === 0) {
      if (totalUnread <= HEALTHY_UNREAD_MAX) {
        suggested.push(`Inbox is healthy (${totalUnread} unread)`);
      } else {
        suggested.push(
          `${totalUnread} unread overall, but nothing matched the noise heuristic in the most recent ${slims.length} message(s); try a larger max or a targeted query like 'is:unread older_than:30d'`,
        );
      }
    } else {
      suggested.push(`${totalUnread} unread total across all labels`);
    }

    return {
      account: input.account,
      scanned: slims.length,
      total_unread: totalUnread,
      noisy_senders: noisy,
      stale_unread: stale,
      suggested_actions: suggested,
    };
  },
});
