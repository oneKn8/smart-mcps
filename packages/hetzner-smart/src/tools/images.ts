import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";
import { confirmField } from "./wait-schema.js";
import { nullableString, nullableNumber } from "./null-helpers.js";

// Slim view of a Hetzner image (system/snapshot/backup/app). Every nested and
// optional field is guarded; upstream extras (bound_to, created_from,
// rapid_deploy, deprecated, protection, ...) are dropped at this boundary.
export type SlimImage = {
  id: number;
  type: string;
  name: string | null;
  description: string | null;
  status: string;
  os_flavor: string | null;
  os_version: string | null;
  architecture: string | null;
  disk_size: number | null;
  image_size: number | null;
  created: string | null;
  labels: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mapImage(raw: Record<string, unknown>): SlimImage {
  const labelsRaw = asRecord(raw.labels);
  return {
    id: typeof raw.id === "number" ? raw.id : 0,
    type: typeof raw.type === "string" ? raw.type : "",
    name: nullableString(raw.name),
    description: nullableString(raw.description),
    status: typeof raw.status === "string" ? raw.status : "",
    os_flavor: nullableString(raw.os_flavor),
    os_version: nullableString(raw.os_version),
    architecture: nullableString(raw.architecture),
    disk_size: nullableNumber(raw.disk_size),
    image_size: nullableNumber(raw.image_size),
    created: nullableString(raw.created),
    labels: labelsRaw ? (labelsRaw as Record<string, string>) : {},
  };
}

// =============================================================================
// list_images
// =============================================================================

const listImagesInputSchema = z.object({
  type: z.enum(["system", "snapshot", "backup", "app"]).optional(),
  status: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  architecture: z.string().min(1).optional(),
  label_selector: z.string().min(1).optional(),
});

type ListImagesInput = z.infer<typeof listImagesInputSchema>;

type ListImagesOutput = {
  images: SlimImage[];
  count: number;
};

export const listImages = defineTool<
  ListImagesInput,
  ListImagesOutput,
  HetznerContext
>({
  name: "list_images",
  description: "List images, snapshots, and backups.",
  inputSchema: listImagesInputSchema,
  handler: async (input, context) => {
    // Only forward filters the caller actually supplied. `type`/`architecture`
    // are valid /images query params beyond the shared list param shape.
    const params: {
      type?: string;
      status?: string;
      name?: string;
      architecture?: string;
      label_selector?: string;
    } = {};
    if (input.type !== undefined) params.type = input.type;
    if (input.status !== undefined) params.status = input.status;
    if (input.name !== undefined) params.name = input.name;
    if (input.architecture !== undefined) params.architecture = input.architecture;
    if (input.label_selector !== undefined) {
      params.label_selector = input.label_selector;
    }

    const body = await context.client.listImages(params);
    const images = Array.isArray(body.images) ? body.images : [];
    return {
      images: images.map((img) => mapImage(img as Record<string, unknown>)),
      count: images.length,
    };
  },
});

// =============================================================================
// get_image
// =============================================================================

const getImageInputSchema = z.object({
  image_id: z.number().int().positive(),
});

type GetImageInput = z.infer<typeof getImageInputSchema>;

export const getImage = defineTool<GetImageInput, SlimImage, HetznerContext>({
  name: "get_image",
  description: "Get an image by ID.",
  inputSchema: getImageInputSchema,
  handler: async (input, context) => {
    // getImage returns the resource already unwrapped (not `{ image }`).
    const image = await context.client.getImage(input.image_id);
    return mapImage(image);
  },
});

// =============================================================================
// delete_image
// =============================================================================

const deleteImageInputSchema = z.object({
  image_id: z.number().int().positive(),
  confirm: confirmField,
});

type DeleteImageInput = z.infer<typeof deleteImageInputSchema>;

type DeleteImageOutput = {
  image_id: number;
  deleted: true;
};

export const deleteImage = defineTool<
  DeleteImageInput,
  DeleteImageOutput,
  HetznerContext
>({
  name: "delete_image",
  description: "Delete an image or snapshot.",
  // Cast: z.ZodType<Input> is invariant; ZodDefault's input type differs from its output type.
  inputSchema: deleteImageInputSchema as unknown as z.ZodType<DeleteImageInput>,
  handler: async (input, context) => {
    const preview =
      `Will PERMANENTLY DELETE image ${input.image_id} (cannot be undone)`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteImage(input.image_id);
    return { image_id: input.image_id, deleted: true };
  },
});
