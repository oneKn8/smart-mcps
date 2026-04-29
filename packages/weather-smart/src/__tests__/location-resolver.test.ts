import { describe, it, expect, vi } from "vitest";
import { resolveLocation } from "../location-resolver.js";
import type { GeocodeFn, Defaults } from "../location-resolver.js";

const metricDefaults: Defaults = { units: "metric" };

describe("resolveLocation", () => {
  it("lat/lng input passes through", async () => {
    const geocode = vi.fn();
    const resolved = await resolveLocation(
      { lat: 32.7767, lng: -96.797 },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    expect(resolved.lat).toBe(32.7767);
    expect(resolved.lng).toBe(-96.797);
    expect(resolved.timezone).toBe("auto");
    expect(geocode).not.toHaveBeenCalled();
  });

  it("lat/lng input formats name with 4 decimals", async () => {
    const geocode = vi.fn();
    const resolved = await resolveLocation(
      { lat: 32.7767, lng: -96.797 },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    // 32.7767 → "32.7767"; -96.797 → "-96.7970" (4-decimal pad)
    expect(resolved.name).toBe("32.7767,-96.7970");
  });

  it("location string triggers geocode and uses top match", async () => {
    const geocode = vi.fn().mockResolvedValue({
      matches: [
        {
          name: "Dallas",
          lat: 32.7767,
          lng: -96.797,
          timezone: "America/Chicago",
          admin1: "Texas",
          country: "United States",
        },
        {
          name: "Dallas",
          lat: 33.918,
          lng: -84.6402,
          timezone: "America/New_York",
          admin1: "Georgia",
          country: "United States",
        },
      ],
    });
    const resolved = await resolveLocation(
      { location: "Dallas" },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    expect(geocode).toHaveBeenCalledWith("Dallas");
    expect(resolved.lat).toBe(32.7767);
    expect(resolved.lng).toBe(-96.797);
    expect(resolved.timezone).toBe("America/Chicago");
  });

  it("formats name as 'name, admin1, country' when both present", async () => {
    const geocode = vi.fn().mockResolvedValue({
      matches: [
        {
          name: "Dallas",
          lat: 32.7767,
          lng: -96.797,
          timezone: "America/Chicago",
          admin1: "Texas",
          country: "United States",
        },
      ],
    });
    const resolved = await resolveLocation(
      { location: "Dallas" },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    expect(resolved.name).toBe("Dallas, Texas, United States");
  });

  it("uses defaults.location when input has no lat/lng/location", async () => {
    const geocode = vi.fn().mockResolvedValue({
      matches: [
        {
          name: "Austin",
          lat: 30.2672,
          lng: -97.7431,
          timezone: "America/Chicago",
          admin1: "Texas",
          country: "United States",
        },
      ],
    });
    const resolved = await resolveLocation(
      {},
      { units: "metric", location: "Austin" },
      geocode as unknown as GeocodeFn,
    );
    expect(geocode).toHaveBeenCalledWith("Austin");
    expect(resolved.name).toBe("Austin, Texas, United States");
  });

  it("throws 'location required' when nothing provided and no defaults", async () => {
    const geocode = vi.fn();
    await expect(
      resolveLocation({}, metricDefaults, geocode as unknown as GeocodeFn),
    ).rejects.toThrow(/location required/);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("throws 'no location match' when geocode returns empty", async () => {
    const geocode = vi.fn().mockResolvedValue({ matches: [] });
    await expect(
      resolveLocation(
        { location: "Atlantis" },
        metricDefaults,
        geocode as unknown as GeocodeFn,
      ),
    ).rejects.toThrow(/no location match for 'Atlantis'/);
  });

  it("lat/lng takes precedence over location (geocode not called)", async () => {
    const geocode = vi.fn();
    const resolved = await resolveLocation(
      { lat: 1.23, lng: 4.56, location: "Dallas" },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    expect(geocode).not.toHaveBeenCalled();
    expect(resolved.lat).toBe(1.23);
    expect(resolved.lng).toBe(4.56);
  });

  it("input.location takes precedence over defaults.location", async () => {
    const geocode = vi.fn().mockResolvedValue({
      matches: [
        {
          name: "Tokyo",
          lat: 35.6762,
          lng: 139.6503,
          timezone: "Asia/Tokyo",
          country: "Japan",
        },
      ],
    });
    await resolveLocation(
      { location: "Tokyo" },
      { units: "metric", location: "Austin" },
      geocode as unknown as GeocodeFn,
    );
    expect(geocode).toHaveBeenCalledWith("Tokyo");
    expect(geocode).not.toHaveBeenCalledWith("Austin");
  });

  it("filters undefined admin1/country from display name", async () => {
    const geocode = vi.fn().mockResolvedValue({
      matches: [
        {
          name: "Springfield",
          lat: 37.2153,
          lng: -93.2982,
          timezone: "America/Chicago",
        },
      ],
    });
    const resolved = await resolveLocation(
      { location: "Springfield" },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    expect(resolved.name).toBe("Springfield");
  });

  it("includes only present fields in display name (admin1 only)", async () => {
    const geocode = vi.fn().mockResolvedValue({
      matches: [
        {
          name: "Springfield",
          lat: 37.2153,
          lng: -93.2982,
          timezone: "America/Chicago",
          admin1: "Missouri",
        },
      ],
    });
    const resolved = await resolveLocation(
      { location: "Springfield" },
      metricDefaults,
      geocode as unknown as GeocodeFn,
    );
    expect(resolved.name).toBe("Springfield, Missouri");
  });
});
