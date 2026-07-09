import type { HetznerClient, HetznerBody } from "../client.js";
import { nullableString, nullableNumber } from "./null-helpers.js";

// Shared pricing helpers for the smart shortcuts (deploy/pricing/ops/cleanup).
// Hetzner quotes every money value as a `{ net, gross }` pair of DECIMAL STRINGS
// in EUR. These helpers parse the `net` side safely (null on absent/NaN), rank
// server types by monthly price, and read prices out of the pricing catalog.
// This module is NOT a tool — it exports plain functions the tool files compose.

// Local object guard — the upstream nests everything and regularly nulls keys.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Parses a decimal that upstream may hand back as a string ("4.5900") or, more
// rarely, a number. Returns null when the value is absent or not finite.
export function parseDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Pulls the EUR `net` amount out of a `{ net, gross }` money object. Null when
// the object or its `net` field is missing / non-numeric.
export function parseNet(money: unknown): number | null {
  const rec = asRecord(money);
  if (!rec) return null;
  return parseDecimal(rec.net);
}

// Monthly costs display to 2 decimal places; hourly to 4 (Hetzner's own
// granularity). Callers round at the boundary so intermediate math stays exact.
export function roundMonthly(n: number): number {
  return Math.round(n * 100) / 100;
}

export function roundHourly(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// A single resolved price row: the net EUR hourly/monthly for one location.
type PriceRow = {
  hourly: number | null;
  monthly: number | null;
  location: string | null;
};

function rowToPrice(row: Record<string, unknown>): PriceRow {
  return {
    hourly: parseNet(row.price_hourly),
    monthly: parseNet(row.price_monthly),
    location: nullableString(row.location),
  };
}

// Picks a price row out of a `prices` array. When `location` is given and a row
// matches it, that row wins; otherwise the cheapest-by-monthly row is returned
// (the "cheapest-location fallback"). Null-priced rows are ignored when ranking
// cheapest; if none carry a monthly price, the first row (or empty) is returned.
function pickPriceRow(prices: unknown, location?: string): PriceRow {
  const empty: PriceRow = { hourly: null, monthly: null, location: null };
  if (!Array.isArray(prices)) return empty;
  const rows = prices
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== undefined);

  if (location !== undefined) {
    const match = rows.find((r) => r.location === location);
    if (match) return rowToPrice(match);
  }

  let best: PriceRow | null = null;
  for (const r of rows) {
    const p = rowToPrice(r);
    if (p.monthly === null) continue;
    if (best === null || best.monthly === null || p.monthly < best.monthly) {
      best = p;
    }
  }
  if (best) return best;

  const first = rows[0];
  return first ? rowToPrice(first) : empty;
}

// Slim, priced view of a Hetzner server type. Prices are the net EUR for the
// requested (or cheapest) location, rounded to Hetzner's display granularity.
export type PricedType = {
  name: string;
  cores: number;
  memory: number;
  disk: number;
  cpu_type: string;
  architecture: string;
  storage_type: string | null;
  deprecated: boolean;
  price_hourly_eur: number | null;
  price_monthly_eur: number | null;
  location: string | null;
};

export interface RankFilters {
  min_cores?: number;
  min_memory?: number;
  arch?: string;
  cpu_type?: string;
  location?: string;
}

function byMonthlyAsc(a: PricedType, b: PricedType): number {
  if (a.price_monthly_eur === null && b.price_monthly_eur === null) return 0;
  if (a.price_monthly_eur === null) return 1;
  if (b.price_monthly_eur === null) return -1;
  return a.price_monthly_eur - b.price_monthly_eur;
}

// Reads every server type (all pages), drops deprecated ones, applies the
// numeric/arch/cpu filters, resolves each survivor's price for the requested
// (or cheapest) location, and returns them ranked cheapest-monthly first.
export async function rankServerTypes(
  client: HetznerClient,
  filters: RankFilters = {},
): Promise<PricedType[]> {
  const raw = await client.getAllPages<Record<string, unknown>>(
    "/server_types",
    "server_types",
  );

  const out: PricedType[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.deprecated === true) continue;

    const cores = nullableNumber(rec.cores);
    const memory = nullableNumber(rec.memory);
    if (
      filters.min_cores !== undefined &&
      (cores === null || cores < filters.min_cores)
    ) {
      continue;
    }
    if (
      filters.min_memory !== undefined &&
      (memory === null || memory < filters.min_memory)
    ) {
      continue;
    }

    const architecture = nullableString(rec.architecture);
    if (filters.arch !== undefined && architecture !== filters.arch) continue;

    const cpuType = nullableString(rec.cpu_type);
    if (filters.cpu_type !== undefined && cpuType !== filters.cpu_type) continue;

    const price = pickPriceRow(rec.prices, filters.location);
    out.push({
      name: typeof rec.name === "string" ? rec.name : "",
      cores: cores ?? 0,
      memory: memory ?? 0,
      disk: nullableNumber(rec.disk) ?? 0,
      cpu_type: cpuType ?? "",
      architecture: architecture ?? "",
      storage_type: nullableString(rec.storage_type),
      deprecated: rec.deprecated === true,
      price_hourly_eur: price.hourly === null ? null : roundHourly(price.hourly),
      price_monthly_eur:
        price.monthly === null ? null : roundMonthly(price.monthly),
      location: price.location,
    });
  }

  out.sort(byMonthlyAsc);
  return out;
}

// Looks up a named server type in the pricing catalog and resolves its price
// for the requested (or cheapest) location. Returns unrounded net EUR values;
// callers round at the display boundary.
export function priceForServerType(
  pricing: HetznerBody,
  typeName: string,
  location?: string,
): { hourly: number | null; monthly: number | null; location: string | null } {
  const types = pricing.server_types;
  if (!Array.isArray(types)) {
    return { hourly: null, monthly: null, location: null };
  }
  const match = types
    .map(asRecord)
    .find((r): r is Record<string, unknown> => r?.name === typeName);
  if (!match) return { hourly: null, monthly: null, location: null };
  return pickPriceRow(match.prices, location);
}

// Generic price reader for the `primary_ips` / `floating_ips` catalog arrays,
// each shaped `[{ type, prices: [{ location, price_monthly, price_hourly? }] }]`.
// Finds the entry for `type`, then the row for `location` (else cheapest by
// `field`). Returns the net EUR value, or null when nothing matches.
export function firstPrice(
  entries: unknown,
  type: string,
  location?: string,
  field: "price_monthly" | "price_hourly" = "price_monthly",
): number | null {
  if (!Array.isArray(entries)) return null;
  const entry = entries
    .map(asRecord)
    .find((e): e is Record<string, unknown> => e?.type === type);
  if (!entry) return null;

  const prices = entry.prices;
  if (!Array.isArray(prices)) return null;
  const rows = prices
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== undefined);

  if (location !== undefined) {
    const match = rows.find((r) => r.location === location);
    if (match) return parseNet(match[field]);
  }

  let best: number | null = null;
  for (const r of rows) {
    const v = parseNet(r[field]);
    if (v === null) continue;
    if (best === null || v < best) best = v;
  }
  if (best !== null) return best;

  const first = rows[0];
  return first ? parseNet(first[field]) : null;
}
