import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { CalendarContext } from "../context.js";
import { mapAclRule, type SlimAclRule } from "../acl-mapper.js";

// =============================================================================
// Shared scope/role enums (used across share / update / revoke tools)
// =============================================================================

const roleSchema = z.enum(["freeBusyReader", "reader", "writer", "owner"]);
const scopeTypeSchema = z.enum(["default", "user", "group", "domain"]);

/**
 * Best-effort lookup of a calendar's display name for previews. Falls back
 * to the raw id when the CalendarList entry can't be fetched (transient
 * failures, calendars the caller can't see in their list, etc.). Mirrors
 * the pattern in `delete_calendar` / `unsubscribe_calendar`.
 */
async function readCalendarSummaryOrFallback(
  ctx: CalendarContext,
  calendarId: string,
): Promise<string> {
  try {
    const entry = await ctx.client.getCalendarListEntry(calendarId);
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const s = (entry as { summary?: unknown }).summary;
      if (typeof s === "string" && s.length > 0) return s;
    }
  } catch {
    // swallow — preview falls back to id verbatim
  }
  return calendarId;
}

// =============================================================================
// list_calendar_shares
// =============================================================================

const listCalendarSharesInputSchema = z.object({
  calendar_id: z.string().optional().default("primary"),
});

type ListCalendarSharesInput = z.input<typeof listCalendarSharesInputSchema>;
type ListCalendarSharesParsed = z.infer<typeof listCalendarSharesInputSchema>;
type ListCalendarSharesOutput = { shares: SlimAclRule[] };

export const listCalendarSharesTool = defineTool<
  ListCalendarSharesInput,
  ListCalendarSharesOutput,
  CalendarContext
>({
  name: "list_calendar_shares",
  description: "List who can access a calendar",
  // Cast required because `calendar_id` has `.optional().default(...)`.
  inputSchema:
    listCalendarSharesInputSchema as unknown as z.ZodType<ListCalendarSharesInput>,
  handler: async (input, ctx) => {
    const parsed = input as ListCalendarSharesParsed;
    const raw = await ctx.client.listAcl({ calendarId: parsed.calendar_id });
    return { shares: raw.map(mapAclRule) };
  },
});

// =============================================================================
// share_calendar (destructive — grants access, confirm-gated)
// =============================================================================

const shareCalendarInputSchema = z.object({
  calendar_id: z.string().optional().default("primary"),
  role: roleSchema,
  scope_type: scopeTypeSchema,
  scope_value: z.string().optional(),
  send_notifications: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type ShareCalendarInput = z.input<typeof shareCalendarInputSchema>;
type ShareCalendarParsed = z.infer<typeof shareCalendarInputSchema>;
type ShareCalendarOutput = { share: SlimAclRule };

export const shareCalendarTool = defineTool<
  ShareCalendarInput,
  ShareCalendarOutput,
  CalendarContext
>({
  name: "share_calendar",
  description: "Share a calendar with someone",
  // Cast required because several fields have `.optional().default(...)`.
  inputSchema:
    shareCalendarInputSchema as unknown as z.ZodType<ShareCalendarInput>,
  handler: async (input, ctx) => {
    const parsed = input as ShareCalendarParsed;

    // Scope-shape invariant: `default` MUST omit value; user/group/domain
    // MUST include it. Google rejects mismatches with 400, but a friendlier
    // up-front error spells out the rule for the LLM caller.
    if (parsed.scope_type === "default") {
      if (parsed.scope_value !== undefined) {
        throw new ValidationError(
          "scope_value must be omitted when scope_type is 'default' " +
            "(default scope = anyone with the link, has no specific principal).",
        );
      }
    } else if (
      parsed.scope_value === undefined ||
      parsed.scope_value.length === 0
    ) {
      throw new ValidationError(
        `scope_value is required when scope_type is '${parsed.scope_type}'.`,
      );
    }

    const summary = await readCalendarSummaryOrFallback(
      ctx,
      parsed.calendar_id,
    );
    const principalLabel =
      parsed.scope_type === "default"
        ? "default"
        : `${parsed.scope_type}:${parsed.scope_value}`;
    const preview =
      `Grant ${parsed.role} access to ${principalLabel} ` +
      `on calendar '${summary}' (id: ${parsed.calendar_id})`;
    guardDestructive({ confirm: parsed.confirm, preview });

    const scope: Record<string, unknown> = { type: parsed.scope_type };
    if (parsed.scope_type !== "default" && parsed.scope_value !== undefined) {
      scope.value = parsed.scope_value;
    }
    const body: Record<string, unknown> = {
      role: parsed.role,
      scope,
    };

    const raw = await ctx.client.insertAclRule({
      calendarId: parsed.calendar_id,
      body,
      sendNotifications: parsed.send_notifications,
    });
    return { share: mapAclRule(raw) };
  },
});

// =============================================================================
// update_calendar_share (destructive — changes permissions, confirm-gated)
// =============================================================================

const updateCalendarShareInputSchema = z.object({
  calendar_id: z.string().optional().default("primary"),
  rule_id: z.string().min(1),
  role: roleSchema,
  confirm: z.boolean().optional().default(false),
});

type UpdateCalendarShareInput = z.input<typeof updateCalendarShareInputSchema>;
type UpdateCalendarShareParsed = z.infer<
  typeof updateCalendarShareInputSchema
>;
type UpdateCalendarShareOutput = { share: SlimAclRule };

/**
 * Read the existing rule's `scope` block so the PUT body can carry it
 * verbatim. Google's PUT requires the full `{ role, scope }` shape; sending
 * just `role` clears the scope and effectively breaks the rule. The cleaner
 * "fetch then mutate" flow keeps the tool surface to a single role-change
 * input without forcing the LLM to know the scope.
 */
function readScopeBlock(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const s = (raw as { scope?: unknown }).scope;
    if (s && typeof s === "object" && !Array.isArray(s)) {
      return s as Record<string, unknown>;
    }
  }
  // Defensive default — Google should always return scope, but if it ever
  // doesn't we'd rather pass a minimal default block than blow up.
  return { type: "default" };
}

export const updateCalendarShareTool = defineTool<
  UpdateCalendarShareInput,
  UpdateCalendarShareOutput,
  CalendarContext
>({
  name: "update_calendar_share",
  description: "Change someone's calendar access level",
  // Cast required because several fields have `.optional().default(...)`.
  inputSchema:
    updateCalendarShareInputSchema as unknown as z.ZodType<UpdateCalendarShareInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdateCalendarShareParsed;

    const summary = await readCalendarSummaryOrFallback(
      ctx,
      parsed.calendar_id,
    );
    const preview =
      `Change ${parsed.rule_id} on '${summary}' to role: ${parsed.role}`;
    guardDestructive({ confirm: parsed.confirm, preview });

    // Fetch the existing rule so the PUT body can carry its scope verbatim.
    // 404s here surface as NotFoundError from the client, which is the
    // correct behavior (caller is asked to fix the rule_id).
    const existing = await ctx.client.getAclRule({
      calendarId: parsed.calendar_id,
      ruleId: parsed.rule_id,
    });
    const scope = readScopeBlock(existing);

    const raw = await ctx.client.updateAclRule({
      calendarId: parsed.calendar_id,
      ruleId: parsed.rule_id,
      body: { role: parsed.role, scope },
    });
    return { share: mapAclRule(raw) };
  },
});

// =============================================================================
// revoke_calendar_share (destructive — removes access, confirm-gated)
// =============================================================================

const revokeCalendarShareInputSchema = z.object({
  calendar_id: z.string().optional().default("primary"),
  rule_id: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type RevokeCalendarShareInput = z.input<typeof revokeCalendarShareInputSchema>;
type RevokeCalendarShareParsed = z.infer<
  typeof revokeCalendarShareInputSchema
>;
type RevokeCalendarShareOutput = { revoked: true };

export const revokeCalendarShareTool = defineTool<
  RevokeCalendarShareInput,
  RevokeCalendarShareOutput,
  CalendarContext
>({
  name: "revoke_calendar_share",
  description: "Revoke someone's calendar access",
  // Cast required because several fields have `.optional().default(...)`.
  inputSchema:
    revokeCalendarShareInputSchema as unknown as z.ZodType<RevokeCalendarShareInput>,
  handler: async (input, ctx) => {
    const parsed = input as RevokeCalendarShareParsed;

    const summary = await readCalendarSummaryOrFallback(
      ctx,
      parsed.calendar_id,
    );
    const preview =
      `Revoke ${parsed.rule_id} from calendar '${summary}' ` +
      `(id: ${parsed.calendar_id})`;
    guardDestructive({ confirm: parsed.confirm, preview });

    await ctx.client.deleteAclRule({
      calendarId: parsed.calendar_id,
      ruleId: parsed.rule_id,
    });
    return { revoked: true };
  },
});
