/**
 * Slim shape returned by Gmail read tools. Strips upstream payload tree to
 * the fields callers actually use; full bodies are surfaced via `read_email`
 * only (see `extractBodies`).
 */
export type SlimMessage = {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  size_bytes: number;
};

type GmailHeader = { name: string; value: string };

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

function findHeader(headers: GmailHeader[], target: string): string {
  const lower = target.toLowerCase();
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === lower) {
      return typeof h.value === "string" ? h.value : "";
    }
  }
  return "";
}

function readHeaders(payload: Record<string, unknown>): GmailHeader[] {
  const raw = payload["headers"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (h): h is GmailHeader =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as { name?: unknown }).name === "string" &&
      typeof (h as { value?: unknown }).value === "string",
  );
}

export function mapMessage(raw: unknown): SlimMessage {
  const obj = asObject(raw);
  const payload = asObject(obj["payload"]);
  const headers = readHeaders(payload);

  const labels = Array.isArray(obj["labelIds"])
    ? (obj["labelIds"] as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  return {
    id: typeof obj["id"] === "string" ? (obj["id"] as string) : "",
    thread_id:
      typeof obj["threadId"] === "string" ? (obj["threadId"] as string) : "",
    from: findHeader(headers, "From"),
    to: findHeader(headers, "To"),
    subject: findHeader(headers, "Subject"),
    snippet: typeof obj["snippet"] === "string" ? (obj["snippet"] as string) : "",
    date: findHeader(headers, "Date"),
    labels,
    size_bytes:
      typeof obj["sizeEstimate"] === "number"
        ? (obj["sizeEstimate"] as number)
        : 0,
  };
}

/**
 * Walk a Gmail payload tree extracting decoded text/plain and text/html
 * bodies. Skips attachment parts (filename non-empty). Recurses into
 * multipart/* containers. Returns whichever bodies were found; may be empty.
 */
export function extractBodies(payload: unknown): {
  html?: string;
  text?: string;
} {
  const out: { html?: string; text?: string } = {};
  visit(payload, out);
  return out;
}

function visit(
  node: unknown,
  out: { html?: string; text?: string },
): void {
  const obj = asObject(node);
  const filename = obj["filename"];
  if (typeof filename === "string" && filename.length > 0) {
    // Attachment — skip entirely (don't recurse into it either).
    return;
  }

  const mimeType =
    typeof obj["mimeType"] === "string" ? (obj["mimeType"] as string) : "";
  const body = asObject(obj["body"]);
  const data = body["data"];

  if (typeof data === "string" && data.length > 0) {
    if (mimeType === "text/plain" && out.text === undefined) {
      out.text = decodeBody(data);
    } else if (mimeType === "text/html" && out.html === undefined) {
      out.html = decodeBody(data);
    }
  }

  const parts = obj["parts"];
  if (Array.isArray(parts)) {
    for (const child of parts) {
      visit(child, out);
    }
  }
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}
