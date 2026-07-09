import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import {
  waitField,
  confirmField,
  settleAction,
  type ActionSummary,
} from "./wait-schema.js";
import { nullableNumber, nullableString } from "./null-helpers.js";
import type { HetznerListParams } from "../client.js";

// Slim view of a Hetzner Volume. Upstream carries `linux_device`, `created`,
// full location/datacenter objects and more — all stripped to the fields the
// TOOLSPEC pins. Every nested access is guarded (upstream nulls freely).
export type SlimVolume = {
  id: number;
  name: string;
  size: number | null;
  server: number | null;
  location: string | null;
  format: string | null;
  status: string;
  protection_delete: boolean;
  labels: Record<string, string>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mapVolume(raw: Record<string, unknown>): SlimVolume {
  const location = asObject(raw.location);
  const protection = asObject(raw.protection);
  const labelsRaw = asObject(raw.labels);

  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    name: typeof raw.name === "string" ? raw.name : "",
    size: nullableNumber(raw.size),
    server: nullableNumber(raw.server),
    location: nullableString(location?.name),
    format: nullableString(raw.format),
    status: typeof raw.status === "string" ? raw.status : "",
    protection_delete: protection?.delete === true,
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_volumes
// =============================================================================

const listVolumesInputSchema = z.object({
  status: z.string().optional(),
  name: z.string().optional(),
  label_selector: z.string().optional(),
  page: z.number().int().positive().optional(),
  per_page: z.number().int().positive().optional(),
});

type ListVolumesInput = z.infer<typeof listVolumesInputSchema>;

type ListVolumesOutput = {
  volumes: SlimVolume[];
  count: number;
};

export const listVolumes = defineTool<
  ListVolumesInput,
  ListVolumesOutput,
  HetznerContext
>({
  name: "list_volumes",
  description: "List volumes with optional filters",
  inputSchema: listVolumesInputSchema,
  handler: async (input, context) => {
    const params: HetznerListParams = {};
    if (input.status !== undefined) params.status = input.status;
    if (input.name !== undefined) params.name = input.name;
    if (input.label_selector !== undefined)
      params.label_selector = input.label_selector;
    if (input.page !== undefined) params.page = input.page;
    if (input.per_page !== undefined) params.per_page = input.per_page;

    const body = await context.client.listVolumes(params);
    const raw = Array.isArray(body.volumes) ? body.volumes : [];
    const volumes = raw.map((v) => mapVolume(v as Record<string, unknown>));
    return { volumes, count: volumes.length };
  },
});

// =============================================================================
// get_volume
// =============================================================================

const getVolumeInputSchema = z.object({
  volume_id: z.number().int().positive(),
});

type GetVolumeInput = z.infer<typeof getVolumeInputSchema>;

export const getVolume = defineTool<GetVolumeInput, SlimVolume, HetznerContext>({
  name: "get_volume",
  description: "Get a volume by ID",
  inputSchema: getVolumeInputSchema,
  handler: async (input, context) => {
    const volume = await context.client.getVolume(input.volume_id);
    return mapVolume(volume as Record<string, unknown>);
  },
});

// =============================================================================
// create_volume
// =============================================================================

const createVolumeInputSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().positive(),
  location: z.string().min(1).optional(),
  server: z.number().int().positive().optional(),
  format: z.string().min(1).optional(),
  automount: z.boolean().optional(),
  labels: z.record(z.string()).optional(),
  wait: waitField,
});

type CreateVolumeInput = z.infer<typeof createVolumeInputSchema>;

type CreateVolumeOutput = {
  volume: SlimVolume | null;
  action: ActionSummary | null;
};

export const createVolume = defineTool<
  CreateVolumeInput,
  CreateVolumeOutput,
  HetznerContext
>({
  name: "create_volume",
  description: "Create a volume",
  // Cast: z.ZodType<Input> is invariant; ZodDefault input type differs from output type.
  inputSchema: createVolumeInputSchema as unknown as z.ZodType<CreateVolumeInput>,
  handler: async (input, context) => {
    const body: Record<string, unknown> = {
      name: input.name,
      size: input.size,
    };
    if (input.location !== undefined) body.location = input.location;
    if (input.server !== undefined) body.server = input.server;
    if (input.format !== undefined) body.format = input.format;
    if (input.automount !== undefined) body.automount = input.automount;
    if (input.labels !== undefined) body.labels = input.labels;

    const created = await context.client.createVolume(body);
    const action = await settleAction(context.client, created, input.wait);
    const volumeRaw = asObject(created.volume);
    const volume = volumeRaw ? mapVolume(volumeRaw) : null;
    return { volume, action };
  },
});

// =============================================================================
// delete_volume
// =============================================================================

const deleteVolumeInputSchema = z.object({
  volume_id: z.number().int().positive(),
  confirm: confirmField,
  wait: waitField,
});

type DeleteVolumeInput = z.infer<typeof deleteVolumeInputSchema>;

type DeleteVolumeOutput = {
  volume_id: number;
  action: ActionSummary | null;
  deleted: true;
};

export const deleteVolume = defineTool<
  DeleteVolumeInput,
  DeleteVolumeOutput,
  HetznerContext
>({
  name: "delete_volume",
  description: "Delete a volume permanently",
  // Cast: z.ZodType<Input> is invariant; ZodDefault input type differs from output type.
  inputSchema: deleteVolumeInputSchema as unknown as z.ZodType<DeleteVolumeInput>,
  handler: async (input, context) => {
    // Fetch first so the preview names the real volume + size (honest scope).
    const existing = await context.client.getVolume(input.volume_id);
    const slim = mapVolume(existing as Record<string, unknown>);
    const preview =
      `Will PERMANENTLY DELETE volume "${slim.name}" ` +
      `(id ${input.volume_id}, ${slim.size ?? "unknown"}GB); data is lost`;
    guardDestructive({ confirm: input.confirm, preview });

    // DELETE /volumes/{id} is synchronous (204) — no action envelope. settleAction
    // over the void result resolves to null, keeping the output shape uniform.
    await context.client.deleteVolume(input.volume_id);
    const action = await settleAction(context.client, undefined, input.wait);
    return { volume_id: input.volume_id, action, deleted: true };
  },
});

// =============================================================================
// attach_volume
// =============================================================================

const attachVolumeInputSchema = z.object({
  volume_id: z.number().int().positive(),
  server_id: z.number().int().positive(),
  automount: z.boolean().optional(),
  wait: waitField,
});

type AttachVolumeInput = z.infer<typeof attachVolumeInputSchema>;

type VolumeActionOutput = {
  volume_id: number;
  action: ActionSummary | null;
};

export const attachVolume = defineTool<
  AttachVolumeInput,
  VolumeActionOutput,
  HetznerContext
>({
  name: "attach_volume",
  description: "Attach a volume to a server",
  // Cast: z.ZodType<Input> is invariant; ZodDefault input type differs from output type.
  inputSchema: attachVolumeInputSchema as unknown as z.ZodType<AttachVolumeInput>,
  handler: async (input, context) => {
    const actionBody: Record<string, unknown> = { server: input.server_id };
    if (input.automount !== undefined) actionBody.automount = input.automount;

    const body = await context.client.volumeAction(
      input.volume_id,
      "attach",
      actionBody,
    );
    const action = await settleAction(context.client, body, input.wait);
    return { volume_id: input.volume_id, action };
  },
});

// =============================================================================
// detach_volume
// =============================================================================

const detachVolumeInputSchema = z.object({
  volume_id: z.number().int().positive(),
  wait: waitField,
});

type DetachVolumeInput = z.infer<typeof detachVolumeInputSchema>;

export const detachVolume = defineTool<
  DetachVolumeInput,
  VolumeActionOutput,
  HetznerContext
>({
  name: "detach_volume",
  description: "Detach a volume from its server",
  // Cast: z.ZodType<Input> is invariant; ZodDefault input type differs from output type.
  inputSchema: detachVolumeInputSchema as unknown as z.ZodType<DetachVolumeInput>,
  handler: async (input, context) => {
    const body = await context.client.volumeAction(input.volume_id, "detach");
    const action = await settleAction(context.client, body, input.wait);
    return { volume_id: input.volume_id, action };
  },
});

// =============================================================================
// resize_volume
// =============================================================================

const resizeVolumeInputSchema = z.object({
  volume_id: z.number().int().positive(),
  size: z.number().int().positive(),
  wait: waitField,
});

type ResizeVolumeInput = z.infer<typeof resizeVolumeInputSchema>;

export const resizeVolume = defineTool<
  ResizeVolumeInput,
  VolumeActionOutput,
  HetznerContext
>({
  name: "resize_volume",
  description: "Grow a volume to a larger size",
  // Cast: z.ZodType<Input> is invariant; ZodDefault input type differs from output type.
  inputSchema: resizeVolumeInputSchema as unknown as z.ZodType<ResizeVolumeInput>,
  handler: async (input, context) => {
    const body = await context.client.volumeAction(input.volume_id, "resize", {
      size: input.size,
    });
    const action = await settleAction(context.client, body, input.wait);
    return { volume_id: input.volume_id, action };
  },
});
