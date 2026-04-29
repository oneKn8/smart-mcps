import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TtlCache, TTL } from "../cache.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("get returns undefined for missing key", () => {
    const cache = new TtlCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("set then get returns value within TTL", () => {
    const cache = new TtlCache();
    cache.set("key", { foo: "bar" }, 60_000);
    expect(cache.get<{ foo: string }>("key")).toEqual({ foo: "bar" });
  });

  it("get returns undefined after TTL elapses", () => {
    const cache = new TtlCache();
    cache.set("key", "value", 60_000);
    expect(cache.get("key")).toBe("value");
    vi.advanceTimersByTime(60_001);
    expect(cache.get("key")).toBeUndefined();
  });

  it("set with ttlMs: 0 is a no-op", () => {
    const cache = new TtlCache();
    cache.set("key", "value", 0);
    expect(cache.get("key")).toBeUndefined();
  });

  it("set with negative ttlMs is a no-op", () => {
    const cache = new TtlCache();
    cache.set("key", "value", -1);
    expect(cache.get("key")).toBeUndefined();
  });

  it("set with Number.POSITIVE_INFINITY never expires", () => {
    const cache = new TtlCache();
    cache.set("key", "value", Number.POSITIVE_INFINITY);
    // Advance 100 years
    vi.advanceTimersByTime(100 * 365 * 24 * 60 * 60 * 1000);
    expect(cache.get("key")).toBe("value");
  });

  it("different keys don't collide", () => {
    const cache = new TtlCache();
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("re-setting same key overwrites", () => {
    const cache = new TtlCache();
    cache.set("key", "first", 60_000);
    cache.set("key", "second", 60_000);
    expect(cache.get("key")).toBe("second");
  });

  it("clear() empties the cache", () => {
    const cache = new TtlCache();
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("expired entries are evicted on get (internal map shrinks)", () => {
    const cache = new TtlCache();
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    // Internal access for eviction verification: cast to any to peek.
    const internal = cache as unknown as { store: Map<string, unknown> };
    expect(internal.store.size).toBe(2);
    vi.advanceTimersByTime(60_001);
    expect(cache.get("a")).toBeUndefined();
    expect(internal.store.size).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(internal.store.size).toBe(0);
  });

  it("TTL constants match the locked values", () => {
    expect(TTL.current).toBe(5 * 60_000);
    expect(TTL.hourly).toBe(30 * 60_000);
    expect(TTL.daily).toBe(60 * 60_000);
    expect(TTL.historical).toBe(Number.POSITIVE_INFINITY);
    expect(TTL.alerts).toBe(0);
    expect(TTL.airQuality).toBe(30 * 60_000);
    expect(TTL.geocode).toBe(24 * 60 * 60_000);
  });
});
