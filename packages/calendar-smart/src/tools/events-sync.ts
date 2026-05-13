import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapEvent, type SlimEvent } from "../event-mapper.js";

// =============================================================================
// sync_events
// =============================================================================
//
// Incremental delta fetch over the events endpoint.
//
// First call: omit `sync_token`. The tool fetches with showDeleted=true and
// maxResults=2500 (Google's documented page size for sync), returning every
// event plus a `next_sync_token` to persist.
//
// Subsequent calls: pass the persisted `sync_token`. Google returns only the
// events that changed since the token was issued (created, updated, or
// cancelled — cancelled events appear with status='cancelled'). The new
// `next_sync_token` advances the cursor.
//
// 410 Gone from Google = sync token expired (~30-day retention). The client
// surfaces this as `syncTokenInvalid: true`; this tool translates that into
// `full_resync_required: true` and returns an empty event list. The caller
// is expected to restart the sync from scratch (no sync_token).
//
// Pagination beyond a single page is NOT exposed yet — multi-page sync needs
// a separate caller-driven loop with pageToken handling, which is deferred.
// =============================================================================

const syncEventsInputSchema = z.object({
  calendar_id: z.string().optional().default("primary"),
  sync_token: z.string().optional(),
});

type SyncEventsInput = z.input<typeof syncEventsInputSchema>;
type SyncEventsParsed = z.infer<typeof syncEventsInputSchema>;

type SyncEventsOutput = {
  events: SlimEvent[];
  next_sync_token: string | null;
  full_resync_required?: true;
};

export const syncEventsTool = defineTool<
  SyncEventsInput,
  SyncEventsOutput,
  CalendarContext
>({
  name: "sync_events",
  description: "Incrementally fetch event changes",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema: syncEventsInputSchema as unknown as z.ZodType<SyncEventsInput>,
  handler: async (input, ctx) => {
    const parsed = input as SyncEventsParsed;
    const opts: Parameters<typeof ctx.client.listEvents>[0] = {
      calendarId: parsed.calendar_id,
      maxResults: 2500,
      showDeleted: true,
    };
    if (parsed.sync_token !== undefined) opts.syncToken = parsed.sync_token;

    const result = await ctx.client.listEvents(opts);

    if (result.syncTokenInvalid === true) {
      // Token expired. Caller restarts with no sync_token.
      return {
        events: [],
        next_sync_token: null,
        full_resync_required: true,
      };
    }

    return {
      events: result.items.map((item) =>
        mapEvent(item, parsed.calendar_id),
      ),
      next_sync_token: result.nextSyncToken ?? null,
    };
  },
});
