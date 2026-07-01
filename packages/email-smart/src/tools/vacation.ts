import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import type { GmailVacationSettings } from "../client.js";
import { mapVacation, type SlimVacation } from "../settings-mapper.js";
import { resolveAccount, rejectIfSmtp } from "./account.js";

// ---------- get_vacation ----------

const getVacationInputSchema = z.object({
  account: z.string().min(1).optional(),
});

type GetVacationInput = z.infer<typeof getVacationInputSchema>;

export const getVacation = defineTool<
  GetVacationInput,
  SlimVacation,
  EmailContext
>({
  name: "get_vacation",
  description: "Get vacation auto-reply settings.",
  inputSchema: getVacationInputSchema,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    const raw = await context.client.getVacation(account);
    return mapVacation(raw);
  },
});

// ---------- update_vacation ----------

const updateVacationInputSchema = z
  .object({
    account: z.string().min(1).optional(),
    enable_auto_reply: z.boolean(),
    response_subject: z.string().optional(),
    response_body_plain_text: z.string().optional(),
    response_body_html: z.string().optional(),
    restrict_to_contacts: z.boolean().optional(),
    restrict_to_domain: z.boolean().optional(),
    start_time: z.string().min(1).optional(),
    end_time: z.string().min(1).optional(),
  })
  .refine(
    (d) =>
      d.enable_auto_reply !== true ||
      (d.response_subject !== undefined && d.response_subject.length > 0) ||
      (d.response_body_plain_text !== undefined &&
        d.response_body_plain_text.length > 0) ||
      (d.response_body_html !== undefined && d.response_body_html.length > 0),
    {
      message:
        "enabling auto-reply requires a response_subject or a response body",
    },
  );

type UpdateVacationInput = z.infer<typeof updateVacationInputSchema>;

export const updateVacation = defineTool<
  UpdateVacationInput,
  SlimVacation,
  EmailContext
>({
  name: "update_vacation",
  description: "Set or disable vacation auto-reply.",
  // Cast required: the .refine() widens the schema type vs the resolved input.
  inputSchema:
    updateVacationInputSchema as unknown as z.ZodType<UpdateVacationInput>,
  handler: async (input, context) => {
    const account = resolveAccount(input.account, context);
    rejectIfSmtp(account, context.home);
    const settings: GmailVacationSettings = {
      enableAutoReply: input.enable_auto_reply,
    };
    if (input.response_subject !== undefined)
      settings.responseSubject = input.response_subject;
    if (input.response_body_plain_text !== undefined)
      settings.responseBodyPlainText = input.response_body_plain_text;
    if (input.response_body_html !== undefined)
      settings.responseBodyHtml = input.response_body_html;
    if (input.restrict_to_contacts !== undefined)
      settings.restrictToContacts = input.restrict_to_contacts;
    if (input.restrict_to_domain !== undefined)
      settings.restrictToDomain = input.restrict_to_domain;
    if (input.start_time !== undefined) settings.startTime = input.start_time;
    if (input.end_time !== undefined) settings.endTime = input.end_time;
    const raw = await context.client.updateVacation(account, settings);
    return mapVacation(raw);
  },
});
