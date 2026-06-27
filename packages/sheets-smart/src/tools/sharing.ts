import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { SheetsContext } from "../context.js";
import { parseSpreadsheetId, quoteSheetTitle } from "../sheet-ref.js";
import { nullableString } from "../null-helpers.js";

// =============================================================================
// share_sheet
// =============================================================================

const shareSheetInputSchema = z.object({
  spreadsheet: z.string().min(1),
  role: z.enum(["reader", "commenter", "writer", "owner"]),
  type: z.enum(["user", "group", "domain", "anyone"]),
  email: z.string().optional(),
  notify: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false),
});

type ShareSheetInput = z.input<typeof shareSheetInputSchema>;
type ShareSheetParsed = z.infer<typeof shareSheetInputSchema>;

type ShareSheetOutput = {
  permission_id: string | null;
  web_view_link: string;
};

export const shareSheetTool = defineTool<
  ShareSheetInput,
  ShareSheetOutput,
  SheetsContext
>({
  name: "share_sheet",
  description: "Share a spreadsheet",
  inputSchema: shareSheetInputSchema as unknown as z.ZodType<ShareSheetInput>,
  handler: async (input, ctx) => {
    const parsed = input as ShareSheetParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);

    if (parsed.type === "user" && !parsed.email) {
      throw new ValidationError(
        "share_sheet: email is required when type is 'user'",
      );
    }

    guardDestructive({
      confirm: parsed.confirm,
      preview: `Share ${id} as ${parsed.role} with ${parsed.email ?? parsed.type}`,
    });

    const body: Record<string, unknown> = {
      role: parsed.role,
      type: parsed.type,
    };
    if (parsed.email !== undefined) body.emailAddress = parsed.email;

    const perm = await ctx.client.createPermission(id, body, {
      sendNotificationEmail: parsed.notify,
    });
    const link = await ctx.client.getWebViewLink(id);

    return {
      permission_id: nullableString(perm.id),
      web_view_link: link,
    };
  },
});

// =============================================================================
// quick_add_row
// =============================================================================

const quickAddRowInputSchema = z.object({
  spreadsheet: z.string().min(1),
  values: z.array(z.unknown()),
  tab: z.string().optional(),
});

type QuickAddRowInput = z.input<typeof quickAddRowInputSchema>;
type QuickAddRowParsed = z.infer<typeof quickAddRowInputSchema>;

type QuickAddRowOutput = { updated_range: string | null };

export const quickAddRowTool = defineTool<
  QuickAddRowInput,
  QuickAddRowOutput,
  SheetsContext
>({
  name: "quick_add_row",
  description: "Append one row quickly",
  inputSchema: quickAddRowInputSchema as unknown as z.ZodType<QuickAddRowInput>,
  handler: async (input, ctx) => {
    const parsed = input as QuickAddRowParsed;
    const id = parseSpreadsheetId(parsed.spreadsheet);
    const range = parsed.tab !== undefined ? quoteSheetTitle(parsed.tab) : "A1";
    const res = await ctx.client.appendValues(
      id,
      range,
      [parsed.values],
      "USER_ENTERED",
      "INSERT_ROWS",
    );
    const updates = res.updates ?? {};
    return { updated_range: updates.updatedRange ?? null };
  },
});
