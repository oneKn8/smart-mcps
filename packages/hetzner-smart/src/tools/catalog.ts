import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { nullableNumber, nullableString } from "./null-helpers.js";

// Read-only reference endpoints. None mutate, so no `wait`/`confirm`. Every
// nested/optional access is guarded — the upstream nulls out categories,
// architectures, and nested price objects freely. Slim shapes are single-use
// (only built here), so they stay inline rather than in a shared mapper file.

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// =============================================================================
// list_server_types
// =============================================================================

// Slim view of a Hetzner server type. Optional/nullable-at-source fields are
// guarded rather than assumed present; `id`/`name` fall back to safe defaults.
export type SlimServerType = {
  id: number;
  name: string;
  cores: number | null;
  memory: number | null;
  disk: number | null;
  cpu_type: string | null;
  architecture: string | null;
  storage_type: string | null;
  category: string | null;
  deprecated: boolean;
};

function mapServerType(raw: Record<string, unknown>): SlimServerType {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    cores: nullableNumber(raw.cores),
    memory: nullableNumber(raw.memory),
    disk: nullableNumber(raw.disk),
    cpu_type: nullableString(raw.cpu_type),
    architecture: nullableString(raw.architecture),
    storage_type: nullableString(raw.storage_type),
    category: nullableString(raw.category),
    deprecated: raw.deprecated === true,
  };
}

const listServerTypesInputSchema = z.object({
  architecture: z.enum(["x86", "arm"]).optional(),
  cpu_type: z.enum(["shared", "dedicated"]).optional(),
});

type ListServerTypesInput = z.infer<typeof listServerTypesInputSchema>;

type ListServerTypesOutput = {
  server_types: SlimServerType[];
  count: number;
};

export const listServerTypes = defineTool<
  ListServerTypesInput,
  ListServerTypesOutput,
  HetznerContext
>({
  name: "list_server_types",
  description: "List available server types.",
  inputSchema: listServerTypesInputSchema,
  handler: async (input, context) => {
    // GET /server_types carries no architecture/cpu_type query params, so the
    // filters are applied client-side against the slim-mapped rows.
    const body = await context.client.listServerTypes();
    const raw: unknown[] = Array.isArray(body.server_types)
      ? body.server_types
      : [];
    let mapped = raw.map((st) => mapServerType(st as Record<string, unknown>));
    if (input.architecture !== undefined) {
      mapped = mapped.filter((st) => st.architecture === input.architecture);
    }
    if (input.cpu_type !== undefined) {
      mapped = mapped.filter((st) => st.cpu_type === input.cpu_type);
    }
    return { server_types: mapped, count: mapped.length };
  },
});

// =============================================================================
// list_locations
// =============================================================================

export type SlimLocation = {
  id: number;
  name: string;
  city: string | null;
  country: string | null;
  network_zone: string | null;
};

function mapLocation(raw: Record<string, unknown>): SlimLocation {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    city: nullableString(raw.city),
    country: nullableString(raw.country),
    network_zone: nullableString(raw.network_zone),
  };
}

const listLocationsInputSchema = z.object({});

type ListLocationsInput = z.infer<typeof listLocationsInputSchema>;

type ListLocationsOutput = {
  locations: SlimLocation[];
  count: number;
};

export const listLocations = defineTool<
  ListLocationsInput,
  ListLocationsOutput,
  HetznerContext
>({
  name: "list_locations",
  description: "List datacenter locations.",
  inputSchema: listLocationsInputSchema,
  handler: async (_input, context) => {
    const body = await context.client.listLocations();
    const raw: unknown[] = Array.isArray(body.locations) ? body.locations : [];
    const locations = raw.map((l) =>
      mapLocation(l as Record<string, unknown>),
    );
    return { locations, count: locations.length };
  },
});

// =============================================================================
// list_datacenters
// =============================================================================

export type SlimDatacenter = {
  id: number;
  name: string;
  description: string | null;
  location: string | null;
};

function mapDatacenter(raw: Record<string, unknown>): SlimDatacenter {
  const location = asObject(raw.location);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    description: nullableString(raw.description),
    location: nullableString(location?.name),
  };
}

const listDatacentersInputSchema = z.object({});

type ListDatacentersInput = z.infer<typeof listDatacentersInputSchema>;

type ListDatacentersOutput = {
  datacenters: SlimDatacenter[];
  count: number;
};

export const listDatacenters = defineTool<
  ListDatacentersInput,
  ListDatacentersOutput,
  HetznerContext
>({
  name: "list_datacenters",
  description: "List datacenters.",
  inputSchema: listDatacentersInputSchema,
  handler: async (_input, context) => {
    const body = await context.client.listDatacenters();
    const raw: unknown[] = Array.isArray(body.datacenters)
      ? body.datacenters
      : [];
    const datacenters = raw.map((d) =>
      mapDatacenter(d as Record<string, unknown>),
    );
    return { datacenters, count: datacenters.length };
  },
});

// =============================================================================
// list_isos
// =============================================================================

export type SlimIso = {
  id: number;
  name: string;
  description: string | null;
  type: string;
  architecture: string | null;
};

function mapIso(raw: Record<string, unknown>): SlimIso {
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    description: nullableString(raw.description),
    type: typeof raw.type === "string" ? raw.type : "",
    architecture: nullableString(raw.architecture),
  };
}

const listIsosInputSchema = z.object({
  architecture: z.enum(["x86", "arm"]).optional(),
});

type ListIsosInput = z.infer<typeof listIsosInputSchema>;

type ListIsosOutput = {
  isos: SlimIso[];
  count: number;
};

export const listIsos = defineTool<
  ListIsosInput,
  ListIsosOutput,
  HetznerContext
>({
  name: "list_isos",
  description: "List available ISO images.",
  inputSchema: listIsosInputSchema,
  handler: async (input, context) => {
    // Filter by architecture client-side to stay within the frozen client's
    // shared list-param shape (which carries no architecture key).
    const body = await context.client.listIsos();
    const raw: unknown[] = Array.isArray(body.isos) ? body.isos : [];
    let isos = raw.map((i) => mapIso(i as Record<string, unknown>));
    if (input.architecture !== undefined) {
      isos = isos.filter((i) => i.architecture === input.architecture);
    }
    return { isos, count: isos.length };
  },
});

// =============================================================================
// get_pricing
// =============================================================================

const getPricingInputSchema = z.object({});

type GetPricingInput = z.infer<typeof getPricingInputSchema>;

type GetPricingOutput = {
  currency: string;
  vat_rate: string;
  volume_price_per_gb_month: string | null;
  image_price_per_gb_month: string | null;
  server_backup_percentage: string | null;
  server_type_count: number;
};

export const getPricing = defineTool<
  GetPricingInput,
  GetPricingOutput,
  HetznerContext
>({
  name: "get_pricing",
  description: "Get account pricing summary.",
  inputSchema: getPricingInputSchema,
  handler: async (_input, context) => {
    // getPricing() returns the unwrapped pricing object. Nested per-unit prices
    // are `{ gross, net }`; we surface the gross (VAT-inclusive) value.
    const pricing = await context.client.getPricing();
    const volumePrice = asObject(asObject(pricing.volume)?.price_per_gb_month);
    const imagePrice = asObject(asObject(pricing.image)?.price_per_gb_month);
    const serverBackup = asObject(pricing.server_backup);
    return {
      currency: typeof pricing.currency === "string" ? pricing.currency : "",
      vat_rate: typeof pricing.vat_rate === "string" ? pricing.vat_rate : "",
      volume_price_per_gb_month: nullableString(volumePrice?.gross),
      image_price_per_gb_month: nullableString(imagePrice?.gross),
      server_backup_percentage: nullableString(serverBackup?.percentage),
      server_type_count: Array.isArray(pricing.server_types)
        ? pricing.server_types.length
        : 0,
    };
  },
});
