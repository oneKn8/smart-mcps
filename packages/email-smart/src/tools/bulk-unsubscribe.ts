import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  ValidationError,
} from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity, type Identity } from "../identities.js";
import { mapMessage } from "../message-mapper.js";
import { buildRawMessage } from "../mime.js";

// =============================================================================
// bulk_unsubscribe — RFC 2369 (List-Unsubscribe) + RFC 8058 (one-click POST).
// =============================================================================
//
// The inbox-zero killer feature. For each distinct mailing list in the query
// result, attempts to honor the upstream-provided unsubscribe mechanism:
//
//   1. RFC 8058 one-click POST (if List-Unsubscribe-Post header present).
//   2. HTTPS GET to the URL in List-Unsubscribe (if no one-click).
//   3. Send a minimal "unsubscribe" email to the mailto: target (RFC 2368).
//
// A list is its List-Id (RFC 2919) when the sender sets one, else its sender
// address. Grouping by from-domain used to collapse every list a domain sends
// (googledev@ and googlecloud@ google.com) onto the first header seen, so the
// rest were silently never unsubscribed.
//
// Hard safety rule: dry_run=true (default) and confirm=false MUST NOT make
// any HTTP request outside the controlled Gmail API. Only header parsing
// happens in those modes. Tests assert this explicitly via fetch spies.

const FETCH_TIMEOUT_MS = 10_000;
const SAMPLE_SUBJECTS = 3;

const bulkUnsubscribeInputSchema = z.object({
  account: z.string().min(1),
  q: z.string().min(1),
  max: z.number().int().min(1).max(100).optional().default(20),
  archive_after: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type BulkUnsubscribeInput = z.infer<typeof bulkUnsubscribeInputSchema>;

type Method = "one_click" | "url" | "mailto" | "none";

type ListEntry = {
  from: string;
  from_domain: string;
  list_id?: string;
  message_count: number;
  method: Method;
  list_unsubscribe_value?: string;
  attempted: boolean;
  success: boolean;
  reason?: string;
  sample_subjects: string[];
  message_ids: string[];
};

type BulkUnsubscribeOutput = {
  scanned: number;
  by_list: ListEntry[];
  archived_count: number;
  dry_run: boolean;
};

// ----------------------------- helpers ---------------------------------------

/**
 * Extract the lowercased address from a From header. Handles "Name <user@domain>"
 * and bare "user@domain" forms. Falls back to "<unknown>" when neither matches.
 */
function extractAddress(from: string): string {
  const angle = from.match(/<([^>@\s]+@[^>\s]+)>/);
  if (angle && typeof angle[1] === "string") {
    return angle[1].toLowerCase();
  }
  const bare = from.match(/([^\s<@]+@\S+)/);
  if (bare && typeof bare[1] === "string") {
    return bare[1].replace(/[>,;]+$/, "").toLowerCase();
  }
  return "<unknown>";
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "<unknown>" : address.slice(at + 1);
}

/** "Name <list.id.example>" -> "list.id.example"; "" when absent. */
function normalizeListId(value: string): string {
  const inner = value.match(/<([^>]+)>/);
  const raw = inner && typeof inner[1] === "string" ? inner[1] : value;
  return raw.replace(/\s+/g, "").toLowerCase();
}

type GmailHeader = { name: string; value: string };

function readPayloadHeaders(rawMessage: unknown): GmailHeader[] {
  if (typeof rawMessage !== "object" || rawMessage === null) return [];
  const obj = rawMessage as Record<string, unknown>;
  const payload = obj["payload"];
  if (typeof payload !== "object" || payload === null) return [];
  const headers = (payload as Record<string, unknown>)["headers"];
  if (!Array.isArray(headers)) return [];
  return headers.filter(
    (h): h is GmailHeader =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as { name?: unknown }).name === "string" &&
      typeof (h as { value?: unknown }).value === "string",
  );
}

/** Case-insensitive header lookup. Returns "" when missing. */
function findHeader(headers: GmailHeader[], target: string): string {
  const lower = target.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return "";
}

type ParsedUnsub = {
  url?: string;
  mailto?: string;
};

/**
 * Parse a List-Unsubscribe header value per RFC 2369. Handles:
 *   - <https://x.com/u>
 *   - <mailto:u@x.com>
 *   - <https://x.com/u>, <mailto:u@x.com>
 *   - header folding inside a URI (LinkedIn wraps long URIs mid-token)
 *   - commas inside a bracketed URI (query strings like ?lists=1,2)
 *   - bare tokens (no angle brackets)
 *
 * Returns the first https URL and first mailto URI found. Callers prefer URL
 * over mailto when picking method.
 */
function parseListUnsubscribe(value: string): ParsedUnsub {
  if (value.trim().length === 0) return {};
  // RFC 2369 brackets every URI, so take what is inside the brackets rather
  // than splitting on commas, which a URI may legally contain. Fall back to
  // comma-separated bare tokens for senders that omit the brackets.
  const bracketed = [...value.matchAll(/<([^>]*)>/g)].map((m) => m[1] ?? "");
  const tokens = bracketed.length > 0 ? bracketed : value.split(",");
  const out: ParsedUnsub = {};
  for (const tok of tokens) {
    // Whitespace is never part of a URI; any found inside one is folding.
    const inner = tok.replace(/\s+/g, "");
    const lower = inner.toLowerCase();
    if (
      out.url === undefined &&
      (lower.startsWith("https://") || lower.startsWith("http://"))
    ) {
      out.url = inner;
    } else if (out.mailto === undefined && lower.startsWith("mailto:")) {
      out.mailto = inner;
    }
  }
  return out;
}

/**
 * RFC 8058 one-click detector. Spec MUST be exactly
 * "List-Unsubscribe=One-Click" but real senders vary case — be lenient.
 */
function isOneClickPost(postHeaderValue: string): boolean {
  if (postHeaderValue.length === 0) return false;
  return postHeaderValue
    .toLowerCase()
    .replace(/\s+/g, "")
    .includes("list-unsubscribe=one-click");
}

type ParsedMailto = { address: string; subject: string; body: string };

/**
 * Parse a `mailto:` URI per RFC 2368. Returns the address and any subject/body
 * params. Defaults: subject="unsubscribe", body="" when params absent.
 */
function parseMailto(mailto: string): ParsedMailto {
  let address = "";
  let subject = "unsubscribe";
  let body = "";
  try {
    const u = new URL(mailto);
    address = decodeURIComponent(u.pathname);
    const s = u.searchParams.get("subject");
    if (s !== null && s.length > 0) subject = s;
    const b = u.searchParams.get("body");
    if (b !== null) body = b;
  } catch {
    // Best-effort: strip "mailto:" prefix and any query string manually.
    const stripped = mailto.replace(/^mailto:/i, "");
    const qIx = stripped.indexOf("?");
    address = qIx === -1 ? stripped : stripped.slice(0, qIx);
  }
  return { address, subject, body };
}

function pickMethod(
  parsed: ParsedUnsub,
  hasOneClickPost: boolean,
): Method {
  if (parsed.url !== undefined && hasOneClickPost) return "one_click";
  if (parsed.url !== undefined) return "url";
  if (parsed.mailto !== undefined) return "mailto";
  return "none";
}

/** fetch with 10s AbortController timeout. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function executeUnsubscribe(
  method: Method,
  parsed: ParsedUnsub,
  account: string,
  identity: Identity,
  context: EmailContext,
): Promise<{ success: boolean; reason?: string }> {
  if (method === "one_click" && parsed.url !== undefined) {
    try {
      const res = await fetchWithTimeout(parsed.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      if (res.status >= 200 && res.status < 300) return { success: true };
      return { success: false, reason: String(res.status) };
    } catch (err) {
      return { success: false, reason: (err as Error).message };
    }
  }
  if (method === "url" && parsed.url !== undefined) {
    try {
      const res = await fetchWithTimeout(parsed.url, { method: "GET" });
      if (res.status >= 200 && res.status < 300) return { success: true };
      return { success: false, reason: String(res.status) };
    } catch (err) {
      return { success: false, reason: (err as Error).message };
    }
  }
  if (method === "mailto" && parsed.mailto !== undefined) {
    const { address, subject, body } = parseMailto(parsed.mailto);
    if (address.length === 0) {
      return { success: false, reason: "could not parse mailto address" };
    }
    try {
      const raw = buildRawMessage({
        identity,
        to: address,
        subject,
        text: body,
        html: body.length > 0 ? `<p>${body}</p>` : "<p></p>",
      });
      await context.client.sendMessage(account, raw);
      return { success: true };
    } catch (err) {
      return { success: false, reason: (err as Error).message };
    }
  }
  return { success: false, reason: "no usable unsubscribe target" };
}

// ----------------------------- list grouping ---------------------------------

type ListAccumulator = {
  from: string;
  from_domain: string;
  list_id: string;
  message_ids: string[];
  subjects: string[];
  list_unsubscribe_value: string;
  list_unsubscribe_post_value: string;
};

async function fetchAndGroup(
  context: EmailContext,
  account: string,
  ids: string[],
): Promise<ListAccumulator[]> {
  const byKey = new Map<string, ListAccumulator>();
  // A byte-identical List-Unsubscribe header is one list even when the From
  // address rotates per message.
  const keyByHeader = new Map<string, string>();
  for (const id of ids) {
    let raw: unknown;
    try {
      raw = await context.client.getMessage(account, id, "full");
    } catch (err) {
      console.error(
        `[email-smart] bulk_unsubscribe: skipping ${id}: ${(err as Error).message}`,
      );
      continue;
    }
    const headers = readPayloadHeaders(raw);
    const slim = mapMessage(raw);
    const from = extractAddress(slim.from);
    const listId = normalizeListId(findHeader(headers, "List-Id"));
    const listUnsub = findHeader(headers, "List-Unsubscribe");
    const listUnsubPost = findHeader(headers, "List-Unsubscribe-Post");

    let key = listId.length > 0 ? `list:${listId}` : `from:${from}`;
    if (!byKey.has(key) && listUnsub.length > 0) {
      key = keyByHeader.get(listUnsub) ?? key;
    }
    if (listUnsub.length > 0 && !keyByHeader.has(listUnsub)) {
      keyByHeader.set(listUnsub, key);
    }

    let acc = byKey.get(key);
    if (acc === undefined) {
      acc = {
        from,
        from_domain: domainOf(from),
        list_id: listId,
        message_ids: [],
        subjects: [],
        list_unsubscribe_value: listUnsub,
        list_unsubscribe_post_value: listUnsubPost,
      };
      byKey.set(key, acc);
    } else {
      // Keep the FIRST seen header for the list: listMessages returns newest
      // first, so that is the freshest unsubscribe token.
      if (acc.list_unsubscribe_value.length === 0 && listUnsub.length > 0) {
        acc.list_unsubscribe_value = listUnsub;
      }
      if (
        acc.list_unsubscribe_post_value.length === 0 &&
        listUnsubPost.length > 0
      ) {
        acc.list_unsubscribe_post_value = listUnsubPost;
      }
    }
    acc.message_ids.push(slim.id.length > 0 ? slim.id : id);
    if (acc.subjects.length < SAMPLE_SUBJECTS) acc.subjects.push(slim.subject);
  }
  return [...byKey.values()];
}

// ----------------------------- tool ------------------------------------------

export const bulkUnsubscribe = defineTool<
  BulkUnsubscribeInput,
  BulkUnsubscribeOutput,
  EmailContext
>({
  name: "bulk_unsubscribe",
  description: "Unsubscribe from senders matching query.",
  // Cast required: ZodDefault on max/archive_after/dry_run/confirm widens the
  // schema's input type vs the resolved input the handler receives.
  inputSchema:
    bulkUnsubscribeInputSchema as unknown as z.ZodType<BulkUnsubscribeInput>,
  handler: async (input, context) => {
    const identity = loadIdentity(input.account, context.home);
    if (identity.transport !== "oauth") {
      throw new ValidationError(
        `account "${input.account}" uses transport "${identity.transport}"; bulk_unsubscribe requires oauth transport`,
      );
    }

    const list = await context.client.listMessages(input.account, {
      q: input.q,
      maxResults: input.max,
    });
    const ids = list.messages.map((m) => m.id);
    const lists = await fetchAndGroup(context, input.account, ids);

    // Build dry-run preview entries up front. dry_run=true returns these
    // as-is (no side effects).
    const previewEntries: ListEntry[] = [];
    for (const acc of lists) {
      const parsed = parseListUnsubscribe(acc.list_unsubscribe_value);
      const oneClick = isOneClickPost(acc.list_unsubscribe_post_value);
      const method = pickMethod(parsed, oneClick);
      const entry: ListEntry = {
        from: acc.from,
        from_domain: acc.from_domain,
        message_count: acc.message_ids.length,
        method,
        attempted: false,
        success: false,
        sample_subjects: acc.subjects,
        message_ids: acc.message_ids,
      };
      if (acc.list_id.length > 0) entry.list_id = acc.list_id;
      if (acc.list_unsubscribe_value.length > 0) {
        entry.list_unsubscribe_value = acc.list_unsubscribe_value;
      }
      if (method === "none") {
        entry.reason = "no List-Unsubscribe header present";
      }
      previewEntries.push(entry);
    }

    if (input.dry_run) {
      return {
        scanned: ids.length,
        by_list: previewEntries,
        archived_count: 0,
        dry_run: true,
      };
    }

    const action = input.archive_after
      ? "unsubscribe + archive"
      : "unsubscribe only";
    const preview = `Will process up to ${input.max} messages matching '${input.q}'; will ${action} per mailing list. Action only on confirm.`;
    guardDestructive({ confirm: input.confirm, preview });

    // Execute per list. Errors in one list do NOT abort the batch.
    let archivedCount = 0;
    const results: ListEntry[] = [];
    for (const [i, entry] of previewEntries.entries()) {
      const acc = lists[i]!;
      if (entry.method === "none") {
        // Already populated reason above; mark attempted=false explicitly.
        results.push(entry);
        continue;
      }
      const parsed = parseListUnsubscribe(acc.list_unsubscribe_value);
      let outcome: { success: boolean; reason?: string };
      try {
        outcome = await executeUnsubscribe(
          entry.method,
          parsed,
          input.account,
          identity,
          context,
        );
      } catch (err) {
        outcome = { success: false, reason: (err as Error).message };
      }
      const finalEntry: ListEntry = {
        ...entry,
        attempted: true,
        success: outcome.success,
      };
      if (outcome.reason !== undefined) finalEntry.reason = outcome.reason;

      if (outcome.success && input.archive_after) {
        try {
          await context.client.batchModify(input.account, {
            ids: acc.message_ids,
            removeLabelIds: ["INBOX"],
          });
          archivedCount += acc.message_ids.length;
        } catch (err) {
          // Archive is a best-effort post-step; surface it on stderr but do
          // not flip success — the unsubscribe itself worked.
          console.error(
            `[email-smart] bulk_unsubscribe: archive failed for ${entry.from}: ${(err as Error).message}`,
          );
        }
      }
      results.push(finalEntry);
    }

    return {
      scanned: ids.length,
      by_list: results,
      archived_count: archivedCount,
      dry_run: false,
    };
  },
});
