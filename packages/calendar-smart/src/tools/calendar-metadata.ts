import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { nullableString } from "../null-helpers.js";

// =============================================================================
// get_calendar_metadata
// =============================================================================

const getCalendarMetadataInputSchema = z.object({
  calendar_id: z.string().min(1),
});

type GetCalendarMetadataInput = z.infer<typeof getCalendarMetadataInputSchema>;

type ConferenceProperties = { allowed_solution_types: string[] };

type CalendarMetadata = {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  time_zone: string;
  conference_properties: ConferenceProperties | null;
};

type GetCalendarMetadataOutput = CalendarMetadata;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map Google's `conferenceProperties` block (which carries
 * `allowedConferenceSolutionTypes: string[]`) into the slim
 * `{ allowed_solution_types }` shape. Returns null when the upstream
 * resource omits the block or the inner array is missing/non-array.
 */
function mapConferenceProperties(value: unknown): ConferenceProperties | null {
  const obj = asObject(value);
  if (!obj) return null;
  const types = obj.allowedConferenceSolutionTypes;
  if (!Array.isArray(types)) return null;
  // Filter to strings defensively — Google should only emit string entries.
  const filtered = types.filter((t): t is string => typeof t === "string");
  return { allowed_solution_types: filtered };
}

export const getCalendarMetadataTool = defineTool<
  GetCalendarMetadataInput,
  GetCalendarMetadataOutput,
  CalendarContext
>({
  name: "get_calendar_metadata",
  description: "Get a calendar's bare metadata fields",
  inputSchema: getCalendarMetadataInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.getCalendarMetadata(input.calendar_id);
    const obj = asObject(raw);
    if (!obj) {
      throw new Error(
        `getCalendarMetadata(${input.calendar_id}) returned a non-object resource`,
      );
    }
    return {
      id: typeof obj.id === "string" ? obj.id : "",
      summary: typeof obj.summary === "string" ? obj.summary : "",
      description: nullableString(obj.description),
      location: nullableString(obj.location),
      time_zone: typeof obj.timeZone === "string" ? obj.timeZone : "",
      conference_properties: mapConferenceProperties(obj.conferenceProperties),
    };
  },
});
