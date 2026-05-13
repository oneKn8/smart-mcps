import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";

// =============================================================================
// get_colors
// =============================================================================

const getColorsInputSchema = z.object({});
type GetColorsInput = z.infer<typeof getColorsInputSchema>;

type ColorPair = { background: string; foreground: string };

type GetColorsOutput = {
  event_colors: Record<string, ColorPair>;
  calendar_colors: Record<string, ColorPair>;
  updated: string;
};

/**
 * Map Google's `{ "<id>": { background, foreground } }` palette block into a
 * defensive record of valid pairs. Entries missing either color string are
 * dropped so the slim output never surfaces partial palette items.
 */
function mapPalette(value: unknown): Record<string, ColorPair> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ColorPair> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as { background?: unknown; foreground?: unknown };
    if (
      typeof obj.background !== "string" ||
      typeof obj.foreground !== "string"
    ) {
      continue;
    }
    out[id] = { background: obj.background, foreground: obj.foreground };
  }
  return out;
}

export const getColorsTool = defineTool<
  GetColorsInput,
  GetColorsOutput,
  CalendarContext
>({
  name: "get_colors",
  description: "Get event and calendar color palettes",
  inputSchema: getColorsInputSchema,
  handler: async (_input, ctx) => {
    const raw = await ctx.client.getColors();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("getColors returned a non-object resource");
    }
    const obj = raw as {
      event?: unknown;
      calendar?: unknown;
      updated?: unknown;
    };
    return {
      event_colors: mapPalette(obj.event),
      calendar_colors: mapPalette(obj.calendar),
      updated: typeof obj.updated === "string" ? obj.updated : "",
    };
  },
});
