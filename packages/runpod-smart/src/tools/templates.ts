import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { RunpodContext } from "../context.js";

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

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

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
