import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import { nullableNumber, nullableString } from "./null-helpers.js";

// Slim view of a Runpod NetworkVolume. Mirrors the camelCase convention used by
// SlimPod/SlimTemplate so downstream consumers see one consistent shape across
// listings. Upstream extras beyond these four fields are dropped.
export type SlimVolume = {
  id: string;
  name: string | null;
  size: number | null;
  dataCenterId: string | null;
};

export function mapVolume(v: Record<string, unknown>): SlimVolume {
  return {
    id: typeof v.id === "string" ? v.id : "",
    name: nullableString(v.name),
    size: nullableNumber(v.size),
    dataCenterId: nullableString(v.dataCenterId),
  };
}

// =============================================================================
// list_network_volumes
// =============================================================================

const listNetworkVolumesInputSchema = z.object({});

type ListNetworkVolumesInput = z.infer<typeof listNetworkVolumesInputSchema>;

type ListNetworkVolumesOutput = {
  volumes: SlimVolume[];
  count: number;
};

export const listNetworkVolumes = defineTool<
  ListNetworkVolumesInput,
  ListNetworkVolumesOutput,
  RunpodContext
>({
  name: "list_network_volumes",
  description: "List network volumes.",
  inputSchema: listNetworkVolumesInputSchema,
  handler: async (_input, context) => {
    const { networkVolumes } = await context.client.listNetworkVolumes();
    return {
      volumes: networkVolumes.map((v) => mapVolume(v as Record<string, unknown>)),
      count: networkVolumes.length,
    };
  },
});

// =============================================================================
// create_network_volume
// =============================================================================

const createNetworkVolumeInputSchema = z.object({
  name: z.string().min(1),
  size_gb: z.number().int().min(1).max(4000),
  data_center_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type CreateNetworkVolumeInput = z.infer<typeof createNetworkVolumeInputSchema>;

export const createNetworkVolume = defineTool<
  CreateNetworkVolumeInput,
  SlimVolume,
  RunpodContext
>({
  name: "create_network_volume",
  description: "Create a network volume.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `confirm | undefined` but its output type is the resolved boolean.
  inputSchema: createNetworkVolumeInputSchema as unknown as z.ZodType<CreateNetworkVolumeInput>,
  handler: async (input, context) => {
    const preview =
      `Will create ${input.size_gb}GB volume ${input.name} in ${input.data_center_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    const created = await context.client.createNetworkVolume({
      name: input.name,
      size: input.size_gb,
      dataCenterId: input.data_center_id,
    });
    return mapVolume(created as Record<string, unknown>);
  },
});

// =============================================================================
// get_network_volume
// =============================================================================

const getNetworkVolumeInputSchema = z.object({
  volume_id: z.string().min(1),
});

type GetNetworkVolumeInput = z.infer<typeof getNetworkVolumeInputSchema>;

export const getNetworkVolume = defineTool<
  GetNetworkVolumeInput,
  SlimVolume,
  RunpodContext
>({
  name: "get_network_volume",
  description: "Get a network volume by ID.",
  inputSchema: getNetworkVolumeInputSchema,
  handler: async (input, context) => {
    const volume = await context.client.getNetworkVolume(input.volume_id);
    return mapVolume(volume as Record<string, unknown>);
  },
});

// =============================================================================
// update_network_volume
// =============================================================================

const updateNetworkVolumeInputSchema = z.object({
  volume_id: z.string().min(1),
  name: z.string().min(1).optional(),
  size_gb: z.number().int().min(1).max(4000).optional(),
  confirm: z.boolean().optional().default(false),
});

type UpdateNetworkVolumeInput = z.infer<typeof updateNetworkVolumeInputSchema>;

export const updateNetworkVolume = defineTool<
  UpdateNetworkVolumeInput,
  SlimVolume,
  RunpodContext
>({
  name: "update_network_volume",
  description: "Rename or grow a network volume.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `confirm | undefined` but its output type is the resolved boolean.
  inputSchema: updateNetworkVolumeInputSchema as unknown as z.ZodType<UpdateNetworkVolumeInput>,
  handler: async (input, context) => {
    // Runpod volumes can only GROW; be explicit that a smaller size is rejected
    // upstream rather than fabricate a shrink capability in the preview.
    const preview = `Will update volume ${input.volume_id} (size can only increase)`;
    guardDestructive({ confirm: input.confirm, preview });

    // Only forward fields the caller actually provided.
    const body: { name?: string; size?: number } = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.size_gb !== undefined) body.size = input.size_gb;

    const updated = await context.client.updateNetworkVolume(input.volume_id, body);
    return mapVolume(updated as Record<string, unknown>);
  },
});

// =============================================================================
// delete_network_volume
// =============================================================================

const deleteNetworkVolumeInputSchema = z.object({
  volume_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteNetworkVolumeInput = z.infer<typeof deleteNetworkVolumeInputSchema>;

type DeleteNetworkVolumeOutput = {
  volume_id: string;
  deleted: true;
};

export const deleteNetworkVolume = defineTool<
  DeleteNetworkVolumeInput,
  DeleteNetworkVolumeOutput,
  RunpodContext
>({
  name: "delete_network_volume",
  description: "Delete a network volume.",
  // Cast required because z.ZodType<Input> is invariant; ZodDefault's input
  // type is `confirm | undefined` but its output type is the resolved boolean.
  inputSchema: deleteNetworkVolumeInputSchema as unknown as z.ZodType<DeleteNetworkVolumeInput>,
  handler: async (input, context) => {
    const preview =
      `Will PERMANENTLY DELETE volume ${input.volume_id} (data lost)`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteNetworkVolume(input.volume_id);
    return { volume_id: input.volume_id, deleted: true };
  },
});
