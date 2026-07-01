import { z } from "zod";
import { defineTool, guardDestructive } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import type { GmailImapSettings, GmailPopSettings } from "../client.js";
import {
  mapImap,
  mapPop,
  mapLanguage,
  type SlimImap,
  type SlimPop,
  type SlimLanguage,
} from "../settings-mapper.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

// ---------- get_imap ----------

const getImapInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type GetImapInput = z.infer<typeof getImapInputSchema>;

export const getImap = defineTool<GetImapInput, SlimImap, EmailContext>({
  name: "get_imap",
  description: "Get IMAP access settings.",
  inputSchema: getImapInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.getImap(account);
    return mapImap(raw);
  },
});

// ---------- update_imap ----------

const updateImapInputSchema = z
  .object({
    account: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    auto_expunge: z.boolean().optional(),
    expunge_behavior: z
      .enum(["expungeBehaviorUnspecified", "archive", "trash", "deleteForever"])
      .optional(),
    max_folder_size: z.number().int().min(0).optional(),
    // Gate for the data-loss path: `deleteForever` makes every future IMAP-client
    // delete permanent (bypasses trash). Other imap updates stay ungated.
    confirm: z.boolean().optional().default(false),
  })
  .refine(
    (d) =>
      d.enabled !== undefined ||
      d.auto_expunge !== undefined ||
      d.expunge_behavior !== undefined ||
      d.max_folder_size !== undefined,
    { message: "must provide at least one IMAP field to update" },
  );

type UpdateImapInput = z.infer<typeof updateImapInputSchema>;

export const updateImap = defineTool<UpdateImapInput, SlimImap, EmailContext>({
  name: "update_imap",
  description: "Update IMAP access settings.",
  // Cast required: the .refine() widens the schema type vs the resolved input.
  inputSchema: updateImapInputSchema as unknown as z.ZodType<UpdateImapInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    if (input.expunge_behavior === "deleteForever") {
      guardDestructive({
        confirm: input.confirm,
        preview:
          "Will set IMAP expunge to deleteForever — future IMAP-client deletes PERMANENTLY delete mail (bypass trash), not recoverable.",
      });
    }
    const settings: GmailImapSettings = {};
    if (input.enabled !== undefined) settings.enabled = input.enabled;
    if (input.auto_expunge !== undefined)
      settings.autoExpunge = input.auto_expunge;
    if (input.expunge_behavior !== undefined)
      settings.expungeBehavior = input.expunge_behavior;
    if (input.max_folder_size !== undefined)
      settings.maxFolderSize = input.max_folder_size;
    const raw = await context.client.updateImap(account, settings);
    return mapImap(raw);
  },
});

// ---------- get_pop ----------

const getPopInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type GetPopInput = z.infer<typeof getPopInputSchema>;

export const getPop = defineTool<GetPopInput, SlimPop, EmailContext>({
  name: "get_pop",
  description: "Get POP access settings.",
  inputSchema: getPopInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.getPop(account);
    return mapPop(raw);
  },
});

// ---------- update_pop ----------

const updatePopInputSchema = z
  .object({
    account: z.string().min(1).optional(),
    access_window: z
      .enum(["accessWindowUnspecified", "disabled", "fromNowOn", "allMail"])
      .optional(),
    disposition: z
      .enum([
        "dispositionUnspecified",
        "leaveInInbox",
        "archive",
        "trash",
        "markRead",
      ])
      .optional(),
  })
  .refine(
    (d) => d.access_window !== undefined || d.disposition !== undefined,
    { message: "must provide access_window or disposition" },
  );

type UpdatePopInput = z.infer<typeof updatePopInputSchema>;

export const updatePop = defineTool<UpdatePopInput, SlimPop, EmailContext>({
  name: "update_pop",
  description: "Update POP access settings.",
  // Cast required: the .refine() widens the schema type vs the resolved input.
  inputSchema: updatePopInputSchema as unknown as z.ZodType<UpdatePopInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    const settings: GmailPopSettings = {};
    if (input.access_window !== undefined)
      settings.accessWindow = input.access_window;
    if (input.disposition !== undefined)
      settings.disposition = input.disposition;
    const raw = await context.client.updatePop(account, settings);
    return mapPop(raw);
  },
});

// ---------- update_language ----------

const updateLanguageInputSchema = z.object({
  account: z.string().min(1).optional(),
  display_language: z.string().min(1),
});

type UpdateLanguageInput = z.infer<typeof updateLanguageInputSchema>;

export const updateLanguage = defineTool<
  UpdateLanguageInput,
  SlimLanguage,
  EmailContext
>({
  name: "update_language",
  description: "Set Gmail display language.",
  inputSchema: updateLanguageInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    const raw = await context.client.updateLanguage(
      account,
      input.display_language,
    );
    return mapLanguage(raw);
  },
});
