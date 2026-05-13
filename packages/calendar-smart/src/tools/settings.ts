import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";

// =============================================================================
// list_user_settings
// =============================================================================

const listUserSettingsInputSchema = z.object({});

type ListUserSettingsInput = z.infer<typeof listUserSettingsInputSchema>;
type ListUserSettingsOutput = { settings: Record<string, string> };

/**
 * Flatten Google's `[{ id, value }, ...]` setting items into a flat
 * `{ <id>: <value> }` map. Items missing either field are skipped — Google
 * shouldn't ever emit such items, but defensive parsing keeps the tool from
 * leaking `undefined` values into the slim output.
 */
function flattenSettings(items: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as { id?: unknown; value?: unknown };
    if (typeof obj.id !== "string" || obj.id.length === 0) continue;
    if (typeof obj.value !== "string") continue;
    out[obj.id] = obj.value;
  }
  return out;
}

export const listUserSettingsTool = defineTool<
  ListUserSettingsInput,
  ListUserSettingsOutput,
  CalendarContext
>({
  name: "list_user_settings",
  description: "List your calendar preferences",
  inputSchema: listUserSettingsInputSchema,
  handler: async (_input, ctx) => {
    const items = await ctx.client.listSettings();
    return { settings: flattenSettings(items) };
  },
});

// =============================================================================
// get_user_setting
// =============================================================================

const getUserSettingInputSchema = z.object({
  setting_id: z.string().min(1),
});

type GetUserSettingInput = z.infer<typeof getUserSettingInputSchema>;
type GetUserSettingOutput = { id: string; value: string };

export const getUserSettingTool = defineTool<
  GetUserSettingInput,
  GetUserSettingOutput,
  CalendarContext
>({
  name: "get_user_setting",
  description: "Get one calendar preference by ID",
  inputSchema: getUserSettingInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getSetting(input.setting_id);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `getSetting(${input.setting_id}) returned a non-object resource`,
      );
    }
    const obj = raw as { id?: unknown; value?: unknown };
    return {
      id: typeof obj.id === "string" ? obj.id : input.setting_id,
      value: typeof obj.value === "string" ? obj.value : "",
    };
  },
});
