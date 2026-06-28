import {
  AuthError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "./errors.js";

export type FetchJsonOpts = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  token?: string;             // bearer token; if set, adds Authorization header
  timeoutMs?: number;         // default 30_000
  retries?: number;           // default 3 — applies to 429/5xx only
  baseDelayMs?: number;       // default 250 — exponential: base * 2^attempt
  searchParams?: Record<string, string | number | boolean | undefined>;
};

const DEBUG = process.env.DEBUG === "1";

export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    token,
    timeoutMs = 30_000,
    retries = 3,
    baseDelayMs = 250,
    searchParams,
  } = opts;

  const finalUrl = appendSearch(url, searchParams);
  const finalHeaders: Record<string, string> = {
    accept: "application/json",
    ...headers,
  };
  if (token) finalHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) finalHeaders["content-type"] = "application/json";

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await doFetch({
        url: finalUrl,
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        timeoutMs,
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const errOut = await mapErrorResponse(response, finalUrl, method);

      // Retry only on 429 and 5xx
      const retriable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retriable && attempt < retries) {
        lastErr = errOut;
        const delay = computeDelay(errOut, baseDelayMs, attempt);
        if (DEBUG) console.error(`[smart-mcp-core] retry ${attempt + 1}/${retries} after ${delay}ms (${response.status})`);
        await sleep(delay);
        continue;
      }
      throw errOut;
    } catch (err) {
      if (err instanceof AuthError ||
          err instanceof PermissionError ||
          err instanceof NotFoundError ||
          err instanceof ValidationError ||
          err instanceof RateLimitError ||
          err instanceof UpstreamError) {
        if (attempt === retries) throw err;
        if (err instanceof AuthError || err instanceof PermissionError || err instanceof NotFoundError || err instanceof ValidationError) {
          throw err; // non-retriable
        }
        lastErr = err;
        await sleep(computeDelay(err, baseDelayMs, attempt));
        continue;
      }
      // Network / abort / unknown — wrap and retry
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === retries) {
        throw new UpstreamError(`Network failure: ${lastErr.message}`, { cause: err });
      }
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastErr ?? new UpstreamError("Exhausted retries with no error");
}

async function doFetch(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    if (DEBUG) console.error(`[smart-mcp-core] ${opts.method} ${opts.url}`);
    return await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mapErrorResponse(response: Response, url: string, method: string): Promise<Error> {
  const detail = await safeReadDetail(response);
  const message = `${method} ${url} → ${response.status}`;
  switch (response.status) {
    case 400:
      return new ValidationError(message, { detail });
    case 401:
      return new AuthError(message, { detail });
    case 403:
      // A 403 is ambiguous: token-lacks-scope vs caller-lacks-permission on the
      // resource (e.g. trashing a file you don't own). Only the former is fixed
      // by re-consent, so split them — see isResourcePermissionDenied.
      return isResourcePermissionDenied(detail)
        ? new PermissionError(message, {
            detail,
            recovery:
              "You don't have permission on this resource — most likely you don't own it. " +
              "Items shared with you (that you don't own) can't be deleted or modified via the API; remove them from your Drive instead.",
          })
        : new AuthError(message, { detail });
    case 404:
      return new NotFoundError(message, { detail });
    case 429: {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSec = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
      return new RateLimitError(message, {
        detail,
        retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
      });
    }
    default:
      return new UpstreamError(message, { detail });
  }
}

/**
 * Distinguishes a resource-ownership 403 from a scope-insufficient 403. Only the
 * ownership case carries these Drive markers; scope errors (e.g. Gmail's
 * "Insufficient Permission") do not, so they correctly fall through to AuthError.
 */
function isResourcePermissionDenied(detail: unknown): boolean {
  const text = JSON.stringify(detail ?? "").toLowerCase();
  return (
    text.includes("insufficientfilepermissions") ||
    text.includes("does not have sufficient permission")
  );
}

async function safeReadDetail(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function appendSearch(
  url: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function computeDelay(err: Error, baseDelayMs: number, attempt: number): number {
  if (err instanceof RateLimitError && err.retryAfterSec) {
    return err.retryAfterSec * 1000;
  }
  return baseDelayMs * Math.pow(2, attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
