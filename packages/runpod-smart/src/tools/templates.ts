import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";
import {
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./null-helpers.js";

// Slim view of a Runpod Template. Mirrors the camelCase convention used by
// SlimPod so downstream consumers see one consistent shape across listings.
// Upstream-only fields (env, dockerEntrypoint, readme, earned, isRunpod,
// containerRegistryAuthId, ports, runtimeInMin, volumeMountPath, dockerStartCmd)
// are dropped because they bloat the response without helping the "which
// templates do I have?" question this tool answers. Callers needing those
// fields can fetch a single template by id once that endpoint lands.
type SlimTemplate = {
  id: string;
  name: string | null;
  imageName: string | null;
  containerDiskInGb: number | null;
  volumeInGb: number | null;
  isServerless: boolean | null;
  isPublic: boolean | null;
  category: string | null;
};

function mapTemplate(t: Record<string, unknown>): SlimTemplate {
  return {
    id: typeof t.id === "string" ? t.id : "",
    name: nullableString(t.name),
    imageName: nullableString(t.imageName),
    containerDiskInGb: nullableNumber(t.containerDiskInGb),
    volumeInGb: nullableNumber(t.volumeInGb),
    isServerless: nullableBoolean(t.isServerless),
    isPublic: nullableBoolean(t.isPublic),
    category: nullableString(t.category),
  };
}

// =============================================================================
// list_templates
// =============================================================================

const listTemplatesInputSchema = z.object({});

type ListTemplatesInput = z.infer<typeof listTemplatesInputSchema>;

type ListTemplatesOutput = {
  templates: SlimTemplate[];
  count: number;
};

export const listTemplates = defineTool<
  ListTemplatesInput,
  ListTemplatesOutput,
  RunpodContext
>({
  name: "list_templates",
  description: "List Runpod pod templates.",
  inputSchema: listTemplatesInputSchema,
  handler: async (_input, context) => {
    const { templates } = await context.client.listTemplates();
    return {
      templates: templates.map((t) => mapTemplate(t as Record<string, unknown>)),
      count: templates.length,
    };
  },
});

// =============================================================================
// Shared template-body construction
// =============================================================================

// The optional field set shared by create_template and update_template.
// Kept as a raw zod shape so both schemas can spread it (create pins name/image
// as required; update makes everything optional).
const templateOptionalShape = {
  container_disk_gb: z.number().int().min(0).optional(),
  volume_gb: z.number().int().min(0).optional(),
  volume_mount_path: z.string().optional(),
  ports: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  is_serverless: z.boolean().optional(),
  is_public: z.boolean().optional(),
  category: z.enum(["NVIDIA", "AMD", "CPU"]).optional(),
  readme: z.string().optional(),
  docker_start_cmd: z.array(z.string()).optional(),
  container_registry_auth_id: z.string().optional(),
};

// The full accepted template field surface (superset of create + update).
// `name`/`image` are optional here so update can reuse the same builder.
type TemplateFields = {
  name?: string;
  image?: string;
  container_disk_gb?: number;
  volume_gb?: number;
  volume_mount_path?: string;
  ports?: string[];
  env?: Record<string, string>;
  is_serverless?: boolean;
  is_public?: boolean;
  category?: "NVIDIA" | "AMD" | "CPU";
  readme?: string;
  docker_start_cmd?: string[];
  container_registry_auth_id?: string;
};

// Ordered [snake_case input key, camelCase wire key] pairs. Drives both the
// request body (only defined fields are sent) and update_template's
// changed-fields preview list, so the two can never drift apart.
const TEMPLATE_FIELD_MAP: ReadonlyArray<readonly [keyof TemplateFields, string]> = [
  ["name", "name"],
  ["image", "imageName"],
  ["container_disk_gb", "containerDiskInGb"],
  ["volume_gb", "volumeInGb"],
  ["volume_mount_path", "volumeMountPath"],
  ["ports", "ports"],
  ["env", "env"],
  ["is_serverless", "isServerless"],
  ["is_public", "isPublic"],
  ["category", "category"],
  ["readme", "readme"],
  ["docker_start_cmd", "dockerStartCmd"],
  ["container_registry_auth_id", "containerRegistryAuthId"],
];

// Build the wire body, mapping snake_case -> camelCase and omitting any field
// the caller didn't provide (mirrors launch_pod's conditional body-building).
function buildTemplateBody(input: TemplateFields): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [snake, camel] of TEMPLATE_FIELD_MAP) {
    const value = input[snake];
    if (value !== undefined) body[camel] = value;
  }
  return body;
}

// The snake_case names of the fields the caller actually provided — used to
// render update_template's "(<changed fields>)" preview.
function changedTemplateFields(input: TemplateFields): string[] {
  return TEMPLATE_FIELD_MAP.map(([snake]) => snake).filter(
    (snake) => input[snake] !== undefined,
  );
}

// =============================================================================
// create_template
// =============================================================================

const createTemplateInputSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  ...templateOptionalShape,
  confirm: z.boolean().optional().default(false),
});

type CreateTemplateInput = z.infer<typeof createTemplateInputSchema>;

export const createTemplate = defineTool<
  CreateTemplateInput,
  SlimTemplate,
  RunpodContext
>({
  name: "create_template",
  description: "Create a reusable pod or serverless template.",
  // Cast required: `confirm` uses `.optional().default(...)`, so the schema's
  // input type (with `| undefined` everywhere) is wider than the resolved
  // output type that the handler actually receives.
  inputSchema: createTemplateInputSchema as unknown as z.ZodType<CreateTemplateInput>,
  handler: async (input, context) => {
    const preview = `Will create template ${input.name} from ${input.image}`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = buildTemplateBody(input);
    const created = await context.client.createTemplate(body);
    return mapTemplate(created as Record<string, unknown>);
  },
});

// =============================================================================
// get_template
// =============================================================================

const getTemplateInputSchema = z.object({
  template_id: z.string().min(1),
  include_public: z.boolean().optional(),
  include_runpod: z.boolean().optional(),
  include_endpoint_bound: z.boolean().optional(),
});

type GetTemplateInput = z.infer<typeof getTemplateInputSchema>;

export const getTemplate = defineTool<GetTemplateInput, SlimTemplate, RunpodContext>({
  name: "get_template",
  description: "Get a template by ID.",
  inputSchema: getTemplateInputSchema,
  handler: async (input, context) => {
    // Only forward the include flags the caller actually set (false is a
    // meaningful value, so gate on `!== undefined`, not truthiness).
    const opts: {
      includePublic?: boolean;
      includeRunpod?: boolean;
      includeEndpointBound?: boolean;
    } = {};
    if (input.include_public !== undefined) opts.includePublic = input.include_public;
    if (input.include_runpod !== undefined) opts.includeRunpod = input.include_runpod;
    if (input.include_endpoint_bound !== undefined) {
      opts.includeEndpointBound = input.include_endpoint_bound;
    }

    const template = await context.client.getTemplate(input.template_id, opts);
    return mapTemplate(template as Record<string, unknown>);
  },
});

// =============================================================================
// update_template
// =============================================================================

const updateTemplateInputSchema = z.object({
  template_id: z.string().min(1),
  name: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  ...templateOptionalShape,
  confirm: z.boolean().optional().default(false),
});

type UpdateTemplateInput = z.infer<typeof updateTemplateInputSchema>;

export const updateTemplate = defineTool<
  UpdateTemplateInput,
  SlimTemplate,
  RunpodContext
>({
  name: "update_template",
  description: "Update a template.",
  // Cast required: `confirm` uses `.optional().default(...)`, so the schema's
  // input type (with `| undefined` everywhere) is wider than the resolved
  // output type that the handler actually receives.
  inputSchema: updateTemplateInputSchema as unknown as z.ZodType<UpdateTemplateInput>,
  handler: async (input, context) => {
    const changed = changedTemplateFields(input);
    const preview = `Will update template ${input.template_id} (${changed.join(", ")})`;
    guardDestructive({ confirm: input.confirm, preview });

    const body = buildTemplateBody(input);
    const updated = await context.client.updateTemplate(input.template_id, body);
    return mapTemplate(updated as Record<string, unknown>);
  },
});

// =============================================================================
// delete_template
// =============================================================================

const deleteTemplateInputSchema = z.object({
  template_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteTemplateInput = z.infer<typeof deleteTemplateInputSchema>;

type DeleteTemplateOutput = {
  template_id: string;
  deleted: true;
};

export const deleteTemplate = defineTool<
  DeleteTemplateInput,
  DeleteTemplateOutput,
  RunpodContext
>({
  name: "delete_template",
  description: "Delete a template.",
  // Cast required: `confirm` uses `.optional().default(...)`, so the schema's
  // input type (with `| undefined` everywhere) is wider than the resolved
  // output type that the handler actually receives.
  inputSchema: deleteTemplateInputSchema as unknown as z.ZodType<DeleteTemplateInput>,
  handler: async (input, context) => {
    const preview = `Will PERMANENTLY DELETE template ${input.template_id}`;
    guardDestructive({ confirm: input.confirm, preview });

    await context.client.deleteTemplate(input.template_id);
    return { template_id: input.template_id, deleted: true };
  },
});
