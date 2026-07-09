import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  listServerTypes,
  listLocations,
  listDatacenters,
  listIsos,
  getPricing,
} from "../catalog.js";

// -----------------------------------------------------------------------------
// Fixtures — each carries upstream-only extras the slim mappers must strip.
// -----------------------------------------------------------------------------

const sharedX86Type = {
  id: 22,
  name: "cpx11",
  description: "CPX 11",
  cores: 2,
  memory: 2,
  disk: 40,
  cpu_type: "shared",
  architecture: "x86",
  storage_type: "network",
  category: "Standard",
  deprecated: false,
  // extras to strip:
  prices: [{ location: "fsn1", price_monthly: { gross: "5.83" } }],
  deprecation: null,
};

const sharedArmType = {
  id: 45,
  name: "cax11",
  cores: 2,
  memory: 4,
  disk: 40,
  cpu_type: "shared",
  architecture: "arm",
  storage_type: "local",
  category: null,
  deprecated: true,
};

const dedicatedX86Type = {
  id: 60,
  name: "ccx13",
  cores: 2,
  memory: 8,
  disk: 80,
  cpu_type: "dedicated",
  architecture: "x86",
  storage_type: "local",
  category: "Dedicated vCPU",
  deprecated: false,
};

const sampleLocation = {
  id: 1,
  name: "fsn1",
  description: "Falkenstein DC Park 1",
  country: "DE",
  city: "Falkenstein",
  latitude: 50.47612,
  longitude: 12.370071,
  network_zone: "eu-central",
};

const sampleDatacenter = {
  id: 4,
  name: "fsn1-dc14",
  description: "Falkenstein 1 virtual DC 14",
  location: { id: 1, name: "fsn1", city: "Falkenstein", country: "DE" },
  server_types: { supported: [22, 45], available: [22] },
};

const x86Iso = {
  id: 4711,
  name: "netboot-linux",
  description: "Rescue netboot",
  type: "public",
  architecture: "x86",
  deprecation: null,
  deprecated: null,
};

const armIso = {
  id: 5000,
  name: "arm-installer",
  description: null,
  type: "public",
  architecture: "arm",
};

const samplePricing = {
  currency: "EUR",
  vat_rate: "19.00",
  image: { price_per_gb_month: { gross: "0.0119000000", net: "0.0100000000" } },
  volume: { price_per_gb_month: { gross: "0.0476000000", net: "0.0400000000" } },
  server_backup: { percentage: "20" },
  server_types: [
    { id: 22, name: "cpx11", prices: [] },
    { id: 45, name: "cax11", prices: [] },
  ],
  floating_ips: [],
  primary_ips: [],
  load_balancer_types: [],
};

type FakeCatalogClient = {
  listServerTypes: ReturnType<typeof vi.fn>;
  listLocations: ReturnType<typeof vi.fn>;
  listDatacenters: ReturnType<typeof vi.fn>;
  listIsos: ReturnType<typeof vi.fn>;
  getPricing: ReturnType<typeof vi.fn>;
};

function makeClient(
  overrides: Partial<FakeCatalogClient> = {},
): FakeCatalogClient {
  return {
    listServerTypes: vi.fn().mockResolvedValue({
      server_types: [sharedX86Type, sharedArmType, dedicatedX86Type],
    }),
    listLocations: vi.fn().mockResolvedValue({ locations: [sampleLocation] }),
    listDatacenters: vi
      .fn()
      .mockResolvedValue({ datacenters: [sampleDatacenter] }),
    listIsos: vi.fn().mockResolvedValue({ isos: [x86Iso, armIso] }),
    getPricing: vi.fn().mockResolvedValue(samplePricing),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<FakeCatalogClient> = {}) {
  return { client: makeClient(overrides) as unknown as never };
}

// =============================================================================
// list_server_types
// =============================================================================

describe("listServerTypes — metadata + schema", () => {
  it("has correct name, description, and zod schema", () => {
    expect(listServerTypes.name).toBe("list_server_types");
    expect(listServerTypes.description).toBeTruthy();
    expect(listServerTypes.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input and valid enum filters", () => {
    expect(() => listServerTypes.inputSchema.parse({})).not.toThrow();
    expect(() =>
      listServerTypes.inputSchema.parse({ architecture: "arm" }),
    ).not.toThrow();
    expect(() =>
      listServerTypes.inputSchema.parse({ cpu_type: "dedicated" }),
    ).not.toThrow();
  });

  it("rejects an invalid architecture enum value", () => {
    expect(() =>
      listServerTypes.inputSchema.parse({ architecture: "risc-v" }),
    ).toThrow();
  });

  it("rejects an invalid cpu_type enum value", () => {
    expect(() =>
      listServerTypes.inputSchema.parse({ cpu_type: "quantum" }),
    ).toThrow();
  });
});

describe("listServerTypes — handler", () => {
  it("calls the client and returns the slim shape only", async () => {
    const ctx = makeCtx();
    const result = (await listServerTypes.handler(
      listServerTypes.inputSchema.parse({}),
      ctx,
    )) as { server_types: Array<Record<string, unknown>>; count: number };

    expect(
      (ctx.client as unknown as FakeCatalogClient).listServerTypes,
    ).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).sort()).toEqual(["count", "server_types"]);
    expect(result.count).toBe(3);
    const slim = result.server_types[0]!;
    expect(Object.keys(slim).sort()).toEqual(
      [
        "id",
        "name",
        "cores",
        "memory",
        "disk",
        "cpu_type",
        "architecture",
        "storage_type",
        "category",
        "deprecated",
      ].sort(),
    );
    expect(slim).toEqual({
      id: 22,
      name: "cpx11",
      cores: 2,
      memory: 2,
      disk: 40,
      cpu_type: "shared",
      architecture: "x86",
      storage_type: "network",
      category: "Standard",
      deprecated: false,
    });
    expect(slim).not.toHaveProperty("prices");
    expect(slim).not.toHaveProperty("description");
  });

  it("filters by architecture client-side", async () => {
    const ctx = makeCtx();
    const result = (await listServerTypes.handler(
      listServerTypes.inputSchema.parse({ architecture: "arm" }),
      ctx,
    )) as { server_types: Array<{ name: string }>; count: number };
    expect(result.count).toBe(1);
    expect(result.server_types[0]!.name).toBe("cax11");
  });

  it("filters by cpu_type client-side", async () => {
    const ctx = makeCtx();
    const result = (await listServerTypes.handler(
      listServerTypes.inputSchema.parse({ cpu_type: "dedicated" }),
      ctx,
    )) as { server_types: Array<{ name: string }>; count: number };
    expect(result.count).toBe(1);
    expect(result.server_types[0]!.name).toBe("ccx13");
  });

  it("combines architecture and cpu_type filters", async () => {
    const ctx = makeCtx();
    const result = (await listServerTypes.handler(
      listServerTypes.inputSchema.parse({
        architecture: "x86",
        cpu_type: "shared",
      }),
      ctx,
    )) as { server_types: Array<{ name: string }>; count: number };
    expect(result.count).toBe(1);
    expect(result.server_types[0]!.name).toBe("cpx11");
  });

  it("null-safes optional fields when upstream omits them", async () => {
    const ctx = makeCtx({
      listServerTypes: vi
        .fn()
        .mockResolvedValue({ server_types: [{ id: 99 }] }),
    });
    const result = (await listServerTypes.handler(
      listServerTypes.inputSchema.parse({}),
      ctx,
    )) as { server_types: Array<Record<string, unknown>> };
    const slim = result.server_types[0]!;
    expect(slim.id).toBe(99);
    expect(slim.name).toBe("");
    expect(slim.cores).toBeNull();
    expect(slim.cpu_type).toBeNull();
    expect(slim.category).toBeNull();
    expect(slim.deprecated).toBe(false);
  });

  it("returns empty list when upstream omits the array", async () => {
    const ctx = makeCtx({
      listServerTypes: vi.fn().mockResolvedValue({}),
    });
    const result = (await listServerTypes.handler(
      listServerTypes.inputSchema.parse({}),
      ctx,
    )) as { server_types: unknown[]; count: number };
    expect(result.server_types).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// list_locations
// =============================================================================

describe("listLocations — metadata + schema", () => {
  it("has correct name, description, and zod schema", () => {
    expect(listLocations.name).toBe("list_locations");
    expect(listLocations.description).toBeTruthy();
    expect(listLocations.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listLocations.inputSchema.parse({})).not.toThrow();
  });
});

describe("listLocations — handler", () => {
  it("calls the client and returns the slim shape only", async () => {
    const ctx = makeCtx();
    const result = (await listLocations.handler(
      listLocations.inputSchema.parse({}),
      ctx,
    )) as { locations: Array<Record<string, unknown>>; count: number };

    expect(
      (ctx.client as unknown as FakeCatalogClient).listLocations,
    ).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).sort()).toEqual(["count", "locations"]);
    expect(result.count).toBe(1);
    const slim = result.locations[0]!;
    expect(Object.keys(slim).sort()).toEqual(
      ["id", "name", "city", "country", "network_zone"].sort(),
    );
    expect(slim).toEqual({
      id: 1,
      name: "fsn1",
      city: "Falkenstein",
      country: "DE",
      network_zone: "eu-central",
    });
    expect(slim).not.toHaveProperty("latitude");
    expect(slim).not.toHaveProperty("description");
  });
});

// =============================================================================
// list_datacenters
// =============================================================================

describe("listDatacenters — metadata + schema", () => {
  it("has correct name, description, and zod schema", () => {
    expect(listDatacenters.name).toBe("list_datacenters");
    expect(listDatacenters.description).toBeTruthy();
    expect(listDatacenters.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => listDatacenters.inputSchema.parse({})).not.toThrow();
  });
});

describe("listDatacenters — handler", () => {
  it("calls the client and flattens location to its name", async () => {
    const ctx = makeCtx();
    const result = (await listDatacenters.handler(
      listDatacenters.inputSchema.parse({}),
      ctx,
    )) as { datacenters: Array<Record<string, unknown>>; count: number };

    expect(
      (ctx.client as unknown as FakeCatalogClient).listDatacenters,
    ).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).sort()).toEqual(["count", "datacenters"]);
    const slim = result.datacenters[0]!;
    expect(Object.keys(slim).sort()).toEqual(
      ["id", "name", "description", "location"].sort(),
    );
    expect(slim).toEqual({
      id: 4,
      name: "fsn1-dc14",
      description: "Falkenstein 1 virtual DC 14",
      location: "fsn1",
    });
    expect(slim).not.toHaveProperty("server_types");
  });

  it("null-safes location when upstream omits the nested object", async () => {
    const ctx = makeCtx({
      listDatacenters: vi
        .fn()
        .mockResolvedValue({ datacenters: [{ id: 7, name: "hel1-dc2" }] }),
    });
    const result = (await listDatacenters.handler(
      listDatacenters.inputSchema.parse({}),
      ctx,
    )) as { datacenters: Array<Record<string, unknown>> };
    const slim = result.datacenters[0]!;
    expect(slim.location).toBeNull();
    expect(slim.description).toBeNull();
  });
});

// =============================================================================
// list_isos
// =============================================================================

describe("listIsos — metadata + schema", () => {
  it("has correct name, description, and zod schema", () => {
    expect(listIsos.name).toBe("list_isos");
    expect(listIsos.description).toBeTruthy();
    expect(listIsos.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts empty input and rejects a bad architecture", () => {
    expect(() => listIsos.inputSchema.parse({})).not.toThrow();
    expect(() =>
      listIsos.inputSchema.parse({ architecture: "sparc" }),
    ).toThrow();
  });
});

describe("listIsos — handler", () => {
  it("calls the client and returns the slim shape only", async () => {
    const ctx = makeCtx();
    const result = (await listIsos.handler(
      listIsos.inputSchema.parse({}),
      ctx,
    )) as { isos: Array<Record<string, unknown>>; count: number };

    expect(
      (ctx.client as unknown as FakeCatalogClient).listIsos,
    ).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).sort()).toEqual(["count", "isos"]);
    expect(result.count).toBe(2);
    const slim = result.isos[0]!;
    expect(Object.keys(slim).sort()).toEqual(
      ["id", "name", "description", "type", "architecture"].sort(),
    );
    expect(slim).toEqual({
      id: 4711,
      name: "netboot-linux",
      description: "Rescue netboot",
      type: "public",
      architecture: "x86",
    });
    expect(slim).not.toHaveProperty("deprecation");
  });

  it("filters by architecture client-side", async () => {
    const ctx = makeCtx();
    const result = (await listIsos.handler(
      listIsos.inputSchema.parse({ architecture: "arm" }),
      ctx,
    )) as { isos: Array<{ name: string }>; count: number };
    expect(result.count).toBe(1);
    expect(result.isos[0]!.name).toBe("arm-installer");
  });

  it("null-safes description when upstream omits it", async () => {
    const ctx = makeCtx();
    const result = (await listIsos.handler(
      listIsos.inputSchema.parse({ architecture: "arm" }),
      ctx,
    )) as { isos: Array<Record<string, unknown>> };
    expect(result.isos[0]!.description).toBeNull();
  });
});

// =============================================================================
// get_pricing
// =============================================================================

describe("getPricing — metadata + schema", () => {
  it("has correct name, description, and zod schema", () => {
    expect(getPricing.name).toBe("get_pricing");
    expect(getPricing.description).toBeTruthy();
    expect(getPricing.inputSchema).toBeInstanceOf(z.ZodType);
  });

  it("accepts an empty input object", () => {
    expect(() => getPricing.inputSchema.parse({})).not.toThrow();
  });
});

describe("getPricing — handler", () => {
  it("calls the client and returns the slim pricing summary", async () => {
    const ctx = makeCtx();
    const result = (await getPricing.handler(
      getPricing.inputSchema.parse({}),
      ctx,
    )) as Record<string, unknown>;

    expect(
      (ctx.client as unknown as FakeCatalogClient).getPricing,
    ).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).sort()).toEqual(
      [
        "currency",
        "vat_rate",
        "volume_price_per_gb_month",
        "image_price_per_gb_month",
        "server_backup_percentage",
        "server_type_count",
      ].sort(),
    );
    expect(result).toEqual({
      currency: "EUR",
      vat_rate: "19.00",
      volume_price_per_gb_month: "0.0476000000",
      image_price_per_gb_month: "0.0119000000",
      server_backup_percentage: "20",
      server_type_count: 2,
    });
  });

  it("null-safes nested prices when upstream omits them", async () => {
    const ctx = makeCtx({
      getPricing: vi
        .fn()
        .mockResolvedValue({ currency: "EUR", vat_rate: "19.00" }),
    });
    const result = (await getPricing.handler(
      getPricing.inputSchema.parse({}),
      ctx,
    )) as Record<string, unknown>;
    expect(result.volume_price_per_gb_month).toBeNull();
    expect(result.image_price_per_gb_month).toBeNull();
    expect(result.server_backup_percentage).toBeNull();
    expect(result.server_type_count).toBe(0);
    expect(result.currency).toBe("EUR");
  });
});
