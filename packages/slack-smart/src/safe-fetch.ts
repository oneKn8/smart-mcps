import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError, UpstreamError } from "smart-mcp-core";

// ---------------------------------------------------------------------------
// SSRF-hardened remote file fetch
// ---------------------------------------------------------------------------
//
// upload_file's content_url source pulls bytes from a caller-supplied URL. That
// URL is attacker-influenced (an agent can be steered to any string), so this
// fetch is a Server-Side Request Forgery surface. Defenses, all applied here:
//   - scheme allowlist (http/https only)
//   - reject loopback / private / link-local / cloud-metadata destinations,
//     both for IP-literal hosts and for every address a hostname resolves to
//   - re-validate on each redirect hop so a public URL cannot bounce to an
//     internal host (redirects are followed manually, never automatically)
//   - hard size cap enforced while streaming (abort past the ceiling)
//   - request timeout
//
// Residual risk: a hostname could rebind between our DNS check and the fetch's
// own resolution (classic DNS-rebinding TOCTOU). Fully closing that needs
// connection-level IP pinning; it is documented, not silently ignored.

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 3;

export type DnsLookupResult = { address: string; family: number };
export type DnsLookupFn = (host: string) => Promise<DnsLookupResult[]>;

export type FetchRemoteFileOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to node:dns/promises lookup (all records). */
  lookup?: DnsLookupFn;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

// ---------------------------------------------------------------------------
// IP classification (pure, unit-testable)
// ---------------------------------------------------------------------------

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function isBlockedIpv4Bytes(b: number[]): boolean {
  const a0 = b[0] ?? 0;
  const a1 = b[1] ?? 0;
  if (a0 === 0) return true; // 0.0.0.0/8 "this host"
  if (a0 === 10) return true; // 10.0.0.0/8 private
  if (a0 === 127) return true; // 127.0.0.0/8 loopback
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a0 === 169 && a1 === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return true; // 172.16.0.0/12 private
  if (a0 === 192 && a1 === 168) return true; // 192.168.0.0/16 private
  if (b.every((x) => x === 255)) return true; // 255.255.255.255 broadcast
  return false;
}

function ipv6ToBytes(ip: string): number[] | null {
  // strip a zone id (fe80::1%eth0)
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  // rewrite a trailing embedded IPv4 (::ffff:1.2.3.4) into two hextets
  const lastColon = ip.lastIndexOf(":");
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4ToBytes(ip.slice(lastColon + 1));
    if (!v4) return null;
    const h1 = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const h2 = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    ip = ip.slice(0, lastColon + 1) + h1 + ":" + h2;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      const v = parseInt(g, 16);
      out.push((v >> 8) & 0xff, v & 0xff);
    }
    return out;
  };

  let bytes: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0] ?? "");
    const right = parseGroups(halves[1] ?? "");
    if (left === null || right === null) return null;
    const fill = 16 - left.length - right.length;
    if (fill < 0) return null;
    bytes = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    const only = parseGroups(halves[0] ?? "");
    if (only === null) return null;
    bytes = only;
  }
  if (bytes.length !== 16) return null;
  return bytes;
}

function isBlockedIpv6Bytes(b: number[]): boolean {
  // unspecified ::
  if (b.every((x) => x === 0)) return true;
  // loopback ::1
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;
  // IPv4-mapped ::ffff:a.b.c.d — validate the embedded IPv4
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4Bytes(b.slice(12, 16));
  }
  // deprecated IPv4-compatible ::a.b.c.d (first 12 bytes zero) — validate embedded IPv4
  if (b.slice(0, 12).every((x) => x === 0)) {
    return isBlockedIpv4Bytes(b.slice(12, 16));
  }
  // unique local fc00::/7
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return true;
  // link-local fe80::/10
  if ((b[0] ?? 0) === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) return true;
  return false;
}

/**
 * True when an IP literal is loopback / private / link-local / metadata / etc.
 * Fails closed: an unparseable address is treated as blocked.
 */
export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4ToBytes(ip);
  if (v4) return isBlockedIpv4Bytes(v4);
  const v6 = ipv6ToBytes(ip);
  if (v6) return isBlockedIpv6Bytes(v6);
  return true; // unknown format -> block
}

/** True for `localhost` and any `*.localhost` name (never routed off-box). */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

// ---------------------------------------------------------------------------
// URL validation + fetch
// ---------------------------------------------------------------------------

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Parse + validate a URL: http(s) only, host not loopback/private, and every
 * resolved address public. Throws ValidationError (caller error) or
 * UpstreamError (resolution failure).
 */
export async function assertPublicUrl(
  rawUrl: string,
  lookup: DnsLookupFn,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError(`content_url is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(
      `content_url must use http or https, got "${url.protocol}"`,
    );
  }
  const host = stripBrackets(url.hostname);
  if (host === "") {
    throw new ValidationError("content_url has no host");
  }
  if (isBlockedHostname(host)) {
    throw new ValidationError(
      `content_url host "${host}" is not allowed (loopback)`,
    );
  }
  // IP literal: check directly, no DNS.
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      throw new ValidationError(
        `content_url points at a blocked address (${host})`,
      );
    }
    return url;
  }
  // Hostname: resolve and reject if ANY record is blocked (guards split-horizon
  // DNS and records that mix a public and a private address).
  let addrs: DnsLookupResult[];
  try {
    addrs = await lookup(host);
  } catch {
    throw new UpstreamError(`content_url host "${host}" could not be resolved`);
  }
  if (addrs.length === 0) {
    throw new UpstreamError(`content_url host "${host}" did not resolve`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new ValidationError(
        `content_url host "${host}" resolves to a blocked address (${a.address})`,
      );
    }
  }
  return url;
}

async function readCapped(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if (res.body === null) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new ValidationError(
        `content_url body is ${buf.length} bytes, over the ${maxBytes}-byte limit`,
      );
    }
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        controller.abort();
        throw new ValidationError(
          `content_url stream exceeded the ${maxBytes}-byte limit`,
        );
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Fetch a remote file's bytes with the SSRF + size + timeout defenses above.
 * Returns the raw bytes; the caller owns filename/upload wiring.
 */
export async function fetchRemoteFile(
  rawUrl: string,
  opts: FetchRemoteFileOptions = {},
): Promise<{ bytes: Uint8Array }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup: DnsLookupFn =
    opts.lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));

  let target = rawUrl;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) {
      throw new UpstreamError(
        `content_url exceeded the ${MAX_REDIRECTS}-redirect limit`,
      );
    }
    // Re-validate on EVERY hop so a redirect cannot land on a blocked host.
    await assertPublicUrl(target, lookup);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "*/*" },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new UpstreamError(
          `content_url fetch timed out after ${timeoutMs}ms`,
        );
      }
      throw new UpstreamError(
        `content_url fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // An opaque redirect (older runtimes) hides the destination — refuse it
    // rather than follow a target we cannot validate.
    if (res.type === "opaqueredirect" || res.status === 0) {
      clearTimeout(timer);
      throw new UpstreamError(
        "content_url redirect could not be validated; refusing to follow",
      );
    }
    // Redirect: re-validate the new target on the next loop iteration.
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      if (loc === null || loc === "") {
        throw new UpstreamError(
          `content_url returned ${res.status} with no Location header`,
        );
      }
      let next: URL;
      try {
        next = new URL(loc, target);
      } catch {
        throw new UpstreamError(
          `content_url redirect Location is not a valid URL: ${loc}`,
        );
      }
      target = next.toString();
      continue;
    }

    if (!res.ok) {
      clearTimeout(timer);
      throw new UpstreamError(`content_url returned HTTP ${res.status}`);
    }

    // Pre-check the declared size before draining the body.
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > maxBytes) {
        controller.abort();
        clearTimeout(timer);
        throw new ValidationError(
          `content_url file is ${n} bytes, over the ${maxBytes}-byte limit`,
        );
      }
    }

    try {
      const bytes = await readCapped(res, maxBytes, controller);
      return { bytes };
    } finally {
      clearTimeout(timer);
    }
  }
}
