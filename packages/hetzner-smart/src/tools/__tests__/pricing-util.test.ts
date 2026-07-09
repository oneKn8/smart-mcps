import { describe, it, expect, vi } from "vitest";
import {
  rankServerTypes,
  priceForServerType,
  firstPrice,
  parseNet,
  parseDecimal,
  roundMonthly,
  roundHourly,
} from "../pricing-util.js";
import type { HetznerClient } from "../../client.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
//
// Five server types. cx11 is DEPRECATED (must be excluded). cax11 is arm and
// priced only in fsn1 (drives the cheapest-location fallback when nbg1 asked).
const serverTypesList = [
  {
    id: 1,
    name: "cx22",
    cores: 2,
    memory: 4,
    disk: 40,
    cpu_type: "shared",
    architecture: "x86",
    storage_type: "local",
    category: "shared-x86",
    deprecated: false,
    prices: [
      { location: "nbg1", price_monthly: { net: "4.5900" }, price_hourly: { net: "0.0060" } },
      { location: "fsn1", price_monthly: { net: "4.2000" }, price_hourly: { net: "0.0055" } },
    ],
  },
  {
    id: 2,
    name: "cx32",
    cores: 4,
    memory: 8,
    disk: 80,
    cpu_type: "shared",
    architecture: "x86",
    storage_type: "local",
    category: "shared-x86",
    deprecated: false,
    prices: [
      { location: "nbg1", price_monthly: { net: "8.4900" }, price_hourly: { net: "0.0120" } },
    ],
  },
  {
    id: 3,
    name: "cax11",
    cores: 2,
    memory: 4,
    disk: 40,
    cpu_type: "shared",
    architecture: "arm",
    storage_type: "local",
    category: "shared-arm",
    deprecated: false,
    prices: [
      { location: "fsn1", price_monthly: { net: "3.7900" }, price_hourly: { net: "0.0049" } },
    ],
  },
  {
    id: 4,
    name: "cx11",
    cores: 1,
    memory: 2,
    disk: 20,
    cpu_type: "shared",
    architecture: "x86",
    storage_type: "local",
    category: "shared-x86",
    deprecated: true,
    prices: [
      { location: "nbg1", price_monthly: { net: "3.0000" }, price_hourly: { net: "0.0040" } },
    ],
  },
  {
    id: 5,
    name: "ccx13",
    cores: 2,
    memory: 8,
    disk: 80,
    cpu_type: "dedicated",
    architecture: "x86",
    storage_type: "local",
    category: "dedicated-x86",
    deprecated: false,
    prices: [
      { location: "nbg1", price_monthly: { net: "12.4900" }, price_hourly: { net: "0.0190" } },
    ],
  },
];

const pricingFixture = {
  currency: "EUR",
  vat_rate: "19.00",
  server_types: [
    {
      id: 1,
      name: "cx22",
      prices: [
        { location: "nbg1", price_hourly: { net: "0.0060" }, price_monthly: { net: "4.5900" } },
        { location: "fsn1", price_hourly: { net: "0.0055" }, price_monthly: { net: "4.2000" } },
      ],
    },
    {
      id: 2,
      name: "cx32",
      prices: [
        { location: "nbg1", price_hourly: { net: "0.0120" }, price_monthly: { net: "8.4900" } },
      ],
    },
  ],
  volume: { price_per_gb_month: { net: "0.0440" } },
  image: { price_per_gb_month: { net: "0.0110" } },
  server_backup: { percentage: "20.00" },
  primary_ips: [
    {
      type: "ipv4",
      prices: [
        { location: "nbg1", price_hourly: { net: "0.0008" }, price_monthly: { net: "0.5000" } },
        { location: "fsn1", price_hourly: { net: "0.0007" }, price_monthly: { net: "0.4000" } },
      ],
    },
  ],
  floating_ips: [
    {
      type: "ipv4",
      prices: [
        { location: "nbg1", price_monthly: { net: "1.0000" } },
        { location: "fsn1", price_monthly: { net: "0.9000" } },
      ],
    },
  ],
};

function fakeClient(types: Array<Record<string, unknown>>): HetznerClient {
  return {
    getAllPages: vi.fn().mockResolvedValue(types),
  } as unknown as HetznerClient;
}

// =============================================================================
// parseDecimal / parseNet / rounding
// =============================================================================

describe("parseDecimal", () => {
  it("parses decimal strings", () => {
    expect(parseDecimal("4.5900")).toBe(4.59);
  });
  it("passes through finite numbers", () => {
    expect(parseDecimal(3.5)).toBe(3.5);
  });
  it("returns null for NaN strings, non-strings, and infinities", () => {
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
    expect(parseDecimal(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseNet", () => {
  it("pulls the net field of a money object", () => {
    expect(parseNet({ net: "4.59", gross: "5.46" })).toBe(4.59);
    expect(parseNet({ net: 2 })).toBe(2);
  });
  it("returns null when net is missing, NaN, or the object is absent", () => {
    expect(parseNet({ gross: "5.46" })).toBeNull();
    expect(parseNet({ net: "oops" })).toBeNull();
    expect(parseNet(null)).toBeNull();
    expect(parseNet(42)).toBeNull();
  });
});

describe("rounding", () => {
  it("rounds monthly to 2dp and hourly to 4dp", () => {
    expect(roundMonthly(0.918)).toBe(0.92);
    expect(roundMonthly(10.005)).toBe(10.01);
    expect(roundHourly(0.00601)).toBe(0.006);
    expect(roundHourly(0.012345)).toBe(0.0123);
  });
});

// =============================================================================
// rankServerTypes
// =============================================================================

describe("rankServerTypes", () => {
  it("excludes deprecated types and sorts cheapest-monthly first", async () => {
    const client = fakeClient(serverTypesList);
    const ranked = await rankServerTypes(client);
    expect(client.getAllPages).toHaveBeenCalledWith("/server_types", "server_types");
    // cx11 (deprecated) dropped; cheapest-location prices; ascending monthly.
    expect(ranked.map((r) => r.name)).toEqual(["cax11", "cx22", "cx32", "ccx13"]);
    expect(ranked.every((r) => r.name !== "cx11")).toBe(true);
    // cx22's cheapest location is fsn1 (4.20) when no location is pinned.
    const cx22 = ranked.find((r) => r.name === "cx22")!;
    expect(cx22.price_monthly_eur).toBe(4.2);
    expect(cx22.location).toBe("fsn1");
    expect(cx22.price_hourly_eur).toBe(0.0055);
  });

  it("filters by min_cores (>=)", async () => {
    const ranked = await rankServerTypes(fakeClient(serverTypesList), {
      min_cores: 4,
    });
    expect(ranked.map((r) => r.name)).toEqual(["cx32"]);
  });

  it("filters by min_memory (>=)", async () => {
    const ranked = await rankServerTypes(fakeClient(serverTypesList), {
      min_memory: 8,
    });
    expect(ranked.map((r) => r.name)).toEqual(["cx32", "ccx13"]);
  });

  it("filters by arch and cpu_type", async () => {
    const arm = await rankServerTypes(fakeClient(serverTypesList), { arch: "arm" });
    expect(arm.map((r) => r.name)).toEqual(["cax11"]);
    const dedicated = await rankServerTypes(fakeClient(serverTypesList), {
      cpu_type: "dedicated",
    });
    expect(dedicated.map((r) => r.name)).toEqual(["ccx13"]);
  });

  it("applies cheapest-location fallback when the pinned location is absent", async () => {
    const ranked = await rankServerTypes(fakeClient(serverTypesList), {
      location: "nbg1",
    });
    // cax11 has no nbg1 row -> falls back to its only (fsn1) row.
    const cax11 = ranked.find((r) => r.name === "cax11")!;
    expect(cax11.location).toBe("fsn1");
    expect(cax11.price_monthly_eur).toBe(3.79);
    // cx22 has an nbg1 row -> uses it (4.59, not the cheaper fsn1 4.20).
    const cx22 = ranked.find((r) => r.name === "cx22")!;
    expect(cx22.location).toBe("nbg1");
    expect(cx22.price_monthly_eur).toBe(4.59);
  });

  it("handles types with no priced rows (null price sorted last)", async () => {
    const types = [
      {
        id: 9,
        name: "noprice",
        cores: 2,
        memory: 4,
        disk: 40,
        cpu_type: "shared",
        architecture: "x86",
        storage_type: "local",
        deprecated: false,
        prices: [],
      },
      serverTypesList[0], // cx22, priced
    ];
    const ranked = await rankServerTypes(fakeClient(types));
    expect(ranked.map((r) => r.name)).toEqual(["cx22", "noprice"]);
    const noprice = ranked.find((r) => r.name === "noprice")!;
    expect(noprice.price_monthly_eur).toBeNull();
    expect(noprice.price_hourly_eur).toBeNull();
    expect(noprice.location).toBeNull();
  });
});

// =============================================================================
// priceForServerType
// =============================================================================

describe("priceForServerType", () => {
  it("resolves a pinned location", () => {
    const p = priceForServerType(pricingFixture, "cx22", "nbg1");
    expect(p).toEqual({ hourly: 0.006, monthly: 4.59, location: "nbg1" });
  });

  it("falls back to the cheapest location when none is pinned", () => {
    const p = priceForServerType(pricingFixture, "cx22");
    expect(p.location).toBe("fsn1");
    expect(p.monthly).toBe(4.2);
  });

  it("falls back to cheapest when the pinned location is absent", () => {
    const p = priceForServerType(pricingFixture, "cx22", "hel1");
    expect(p.location).toBe("fsn1");
    expect(p.monthly).toBe(4.2);
  });

  it("returns nulls for an unknown server type", () => {
    expect(priceForServerType(pricingFixture, "nope")).toEqual({
      hourly: null,
      monthly: null,
      location: null,
    });
  });
});

// =============================================================================
// firstPrice
// =============================================================================

describe("firstPrice", () => {
  it("resolves a pinned location for primary IPs", () => {
    expect(firstPrice(pricingFixture.primary_ips, "ipv4", "nbg1")).toBe(0.5);
  });

  it("falls back to the cheapest location", () => {
    expect(firstPrice(pricingFixture.primary_ips, "ipv4")).toBe(0.4);
    expect(firstPrice(pricingFixture.floating_ips, "ipv4")).toBe(0.9);
  });

  it("reads the requested field for floating IPs", () => {
    expect(firstPrice(pricingFixture.floating_ips, "ipv4", "nbg1", "price_monthly")).toBe(1);
  });

  it("returns null for a missing type or non-array entries", () => {
    expect(firstPrice(pricingFixture.primary_ips, "ipv6")).toBeNull();
    expect(firstPrice(undefined, "ipv4")).toBeNull();
    expect(firstPrice([], "ipv4")).toBeNull();
  });
});
