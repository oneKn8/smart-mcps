import { z } from "zod";
import {
  defineTool,
  guardDestructive,
  NotFoundError,
  ValidationError,
} from "smart-mcp-core";
import type { EmailContext } from "../context.js";
import { loadIdentity } from "../identities.js";

const VISIBILITY = z.enum(["labelShow", "labelHide", "labelShowIfUnread"]);
const MSG_VISIBILITY = z.enum(["show", "hide"]);

function rejectIfSmtp(account: string, home: string | undefined): void {
  const identity = loadIdentity(account, home);
  if (identity.transport !== "oauth") {
    throw new ValidationError(
      `account "${account}" uses transport "${identity.transport}"; this tool requires oauth transport`,
    );
  }
}

async function resolveUserLabelId(
  context: EmailContext,
  account: string,
  identifier: string,
): Promise<{ id: string; name: string; type: "system" | "user" }> {
  const labels = await context.client.listLabels(account);
  const hit =
    labels.find((l) => l.id === identifier) ??
    labels.find((l) => l.name === identifier);
  if (hit === undefined) {
    throw new NotFoundError(
      `label not found: ${identifier}; run list_labels to see available labels`,
    );
  }
  const type: "system" | "user" = hit.type === "system" ? "system" : "user";
  return { id: hit.id, name: hit.name, type };
}

// ---------- list_labels ----------

const listLabelsInputSchema = z.object({
  account: z.string().min(1),
});

type ListLabelsInput = z.infer<typeof listLabelsInputSchema>;

type SlimLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  messages_total?: number;
  messages_unread?: number;
  threads_unread?: number;
};

type ListLabelsOutput = {
  labels: SlimLabel[];
  count: number;
};

function coerceLabelType(t: string): "system" | "user" {
  return t === "system" ? "system" : "user";
}

export const listLabels = defineTool<
  ListLabelsInput,
  ListLabelsOutput,
  EmailContext
>({
  name: "list_labels",
  description: "List all Gmail labels for account.",
  inputSchema: listLabelsInputSchema,
  handler: async (input, context) => {
    const basics = await context.client.listLabels(input.account);
    const out: SlimLabel[] = [];

    for (const basic of basics) {
      try {
        const detail = await context.client.getLabel(input.account, basic.id);
        const slim: SlimLabel = {
          id: detail.id,
          name: detail.name,
          type: coerceLabelType(detail.type),
        };
        if (detail.messagesTotal !== undefined)
          slim.messages_total = detail.messagesTotal;
        if (detail.messagesUnread !== undefined)
          slim.messages_unread = detail.messagesUnread;
        if (detail.threadsUnread !== undefined)
          slim.threads_unread = detail.threadsUnread;
        out.push(slim);
      } catch {
        // Skip the single label whose detail fetch failed; surface the rest.
        continue;
      }
    }

    return { labels: out, count: out.length };
  },
});

// ---------- create_label ----------

const createLabelInputSchema = z.object({
  account: z.string().min(1),
  name: z.string().min(1),
  label_list_visibility: VISIBILITY.optional(),
  message_list_visibility: MSG_VISIBILITY.optional(),
});

type CreateLabelInput = z.infer<typeof createLabelInputSchema>;

type LabelRefOutput = {
  id: string;
  name: string;
  type: "system" | "user";
};

export const createLabel = defineTool<
  CreateLabelInput,
  LabelRefOutput,
  EmailContext
>({
  name: "create_label",
  description: "Create a new user label.",
  inputSchema: createLabelInputSchema,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);
    const opts: {
      name: string;
      labelListVisibility?: "labelShow" | "labelHide" | "labelShowIfUnread";
      messageListVisibility?: "show" | "hide";
    } = { name: input.name };
    if (input.label_list_visibility !== undefined)
      opts.labelListVisibility = input.label_list_visibility;
    if (input.message_list_visibility !== undefined)
      opts.messageListVisibility = input.message_list_visibility;
    const created = await context.client.createLabel(input.account, opts);
    return {
      id: created.id,
      name: created.name,
      type: created.type === "system" ? "system" : "user",
    };
  },
});

// ---------- update_label ----------

const updateLabelInputSchema = z
  .object({
    account: z.string().min(1),
    label: z.string().min(1),
    new_name: z.string().min(1).optional(),
    label_list_visibility: VISIBILITY.optional(),
    message_list_visibility: MSG_VISIBILITY.optional(),
  })
  .refine(
    (d) =>
      d.new_name !== undefined ||
      d.label_list_visibility !== undefined ||
      d.message_list_visibility !== undefined,
    {
      message:
        "must provide at least one of new_name, label_list_visibility, message_list_visibility",
    },
  );

type UpdateLabelInput = z.infer<typeof updateLabelInputSchema>;

export const updateLabel = defineTool<
  UpdateLabelInput,
  LabelRefOutput,
  EmailContext
>({
  name: "update_label",
  description: "Rename or change visibility of a user label.",
  inputSchema: updateLabelInputSchema as unknown as z.ZodType<UpdateLabelInput>,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);
    const resolved = await resolveUserLabelId(
      context,
      input.account,
      input.label,
    );
    if (resolved.type === "system") {
      throw new ValidationError(
        `cannot update system label: ${resolved.name}; only user labels are editable`,
      );
    }
    const patch: {
      name?: string;
      labelListVisibility?: "labelShow" | "labelHide" | "labelShowIfUnread";
      messageListVisibility?: "show" | "hide";
    } = {};
    if (input.new_name !== undefined) patch.name = input.new_name;
    if (input.label_list_visibility !== undefined)
      patch.labelListVisibility = input.label_list_visibility;
    if (input.message_list_visibility !== undefined)
      patch.messageListVisibility = input.message_list_visibility;
    const updated = await context.client.updateLabel(
      input.account,
      resolved.id,
      patch,
    );
    return {
      id: updated.id,
      name: updated.name,
      type: updated.type === "system" ? "system" : "user",
    };
  },
});

// ---------- delete_label ----------

const deleteLabelInputSchema = z.object({
  account: z.string().min(1),
  label: z.string().min(1),
  confirm: z.boolean().optional().default(false),
});

type DeleteLabelInput = z.infer<typeof deleteLabelInputSchema>;

type DeleteLabelOutput = {
  id: string;
  name: string;
  deleted: boolean;
};

export const deleteLabel = defineTool<
  DeleteLabelInput,
  DeleteLabelOutput,
  EmailContext
>({
  name: "delete_label",
  description: "Permanently delete a user label.",
  inputSchema: deleteLabelInputSchema as unknown as z.ZodType<DeleteLabelInput>,
  handler: async (input, context) => {
    rejectIfSmtp(input.account, context.home);
    const resolved = await resolveUserLabelId(
      context,
      input.account,
      input.label,
    );
    if (resolved.type === "system") {
      throw new ValidationError(
        `cannot delete system label: ${resolved.name}; only user labels can be deleted`,
      );
    }
    guardDestructive({
      confirm: input.confirm,
      preview: `Will permanently delete label "${resolved.name}" (id ${resolved.id}) for account ${input.account}. The label will be removed from every message that carries it; messages themselves are not deleted.`,
    });
    await context.client.deleteLabel(input.account, resolved.id);
    return { id: resolved.id, name: resolved.name, deleted: true };
  },
});
