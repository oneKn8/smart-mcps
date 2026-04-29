// In-memory TTL cache. Stores arbitrary values keyed by string. Each entry has
// an expiration timestamp; lookups lazily evict expired entries on read. Used
// by WeatherClient to cache geocoding lookups, forecasts, and other upstream
// responses for the durations defined in the `TTL` constants below.
//
// Special values:
//   - `ttlMs <= 0`: set is a no-op (the entry is never stored — useful for
//     "never cache" cases like alerts which must always be fresh).
//   - `ttlMs === Number.POSITIVE_INFINITY`: the entry never expires (used for
//     immutable historical data).

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class TtlCache {
  private store = new Map<string, CacheEntry>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (
      entry.expiresAt !== Number.POSITIVE_INFINITY &&
      entry.expiresAt < Date.now()
    ) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return; // never cache
    const expiresAt =
      ttlMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  clear(): void {
    this.store.clear();
  }
}

// Locked TTL constants for the various Open-Meteo / NWS / Open-Meteo
// air-quality response types. Values are in milliseconds.
//
//   - current: 5 min — current conditions change minute-to-minute but a
//     5-minute cache is plenty fresh for chat-driven queries.
//   - hourly: 30 min — short-term hourly forecasts.
//   - daily: 1 hour — multi-day daily forecasts (Open-Meteo regenerates
//     these less frequently).
//   - historical: never expires — past observations are immutable.
//   - alerts: 0 — NWS alerts must always be fresh; never cache.
//   - airQuality: 30 min — same cadence as hourly forecasts.
//   - geocode: 24 hours — cities don't move, names rarely change.
export const TTL = {
  current: 5 * 60_000,
  hourly: 30 * 60_000,
  daily: 60 * 60_000,
  historical: Number.POSITIVE_INFINITY,
  alerts: 0,
  airQuality: 30 * 60_000,
  geocode: 24 * 60 * 60_000,
} as const;
