import { nullableString, nullableNumber } from "./null-helpers.js";

// Slim server shape shared by list_servers / get_server / deploy_server /
// daily_status / cost_audit. Extracted here because >=3 tools build it.
export type SlimServer = {
  id: number;
  name: string;
  status: string;
  ipv4: string | null;
  ipv6: string | null;
  server_type: string | null;
  cores: number | null;
  memory: number | null;
  disk: number | null;
  architecture: string | null;
  location: string | null;
  image: string | null;
  created: string | null;
  labels: Record<string, string>;
  protection_delete: boolean;
  protection_rebuild: boolean;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Slim-maps a raw Hetzner server payload. Every nested access is guarded — the
// upstream regularly nulls out public_net entries, images, and datacenters.
export function mapServer(raw: Record<string, unknown>): SlimServer {
  const publicNet = asObject(raw.public_net);
  const serverType = asObject(raw.server_type);
  const location =
    asObject(raw.location) ?? asObject(asObject(raw.datacenter)?.location);
  const protection = asObject(raw.protection);
  const labelsRaw = asObject(raw.labels);

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    status: typeof raw.status === "string" ? raw.status : "",
    ipv4: nullableString(asObject(publicNet?.ipv4)?.ip),
    ipv6: nullableString(asObject(publicNet?.ipv6)?.ip),
    server_type: nullableString(serverType?.name),
    cores: nullableNumber(serverType?.cores),
    memory: nullableNumber(serverType?.memory),
    disk: nullableNumber(serverType?.disk),
    architecture: nullableString(serverType?.architecture),
    location: nullableString(location?.name),
    image: nullableString(asObject(raw.image)?.name),
    created: nullableString(raw.created),
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
    protection_delete: protection?.delete === true,
    protection_rebuild: protection?.rebuild === true,
  };
}
