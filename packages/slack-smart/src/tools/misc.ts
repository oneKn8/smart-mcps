import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { nullableString, nullableNumber, asObject } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// list_usergroups
// ---------------------------------------------------------------------------

const listUsergroupsInputSchema = z.object({
  include_disabled: z.boolean().optional(),
});

type ListUsergroupsInput = z.infer<typeof listUsergroupsInputSchema>;

type SlimUsergroup = {
  id: string;
  name: string;
  handle?: string;
  description?: string;
  user_count?: number;
};

function mapUsergroup(raw: unknown): SlimUsergroup {
  const obj = asObject(raw);
  const id = nullableString(obj["id"]) ?? "";
  const name = nullableString(obj["name"]) ?? "";
  const slim: SlimUsergroup = { id, name };
  const handle = nullableString(obj["handle"]);
  const description = nullableString(obj["description"]);
  const user_count = nullableNumber(obj["user_count"]);
  if (handle !== null) slim.handle = handle;
  if (description !== null && description !== "") slim.description = description;
  if (user_count !== null) slim.user_count = user_count;
  return slim;
}

type ListUsergroupsOutput = {
  usergroups: SlimUsergroup[];
  count: number;
};

export const list_usergroups = defineTool<
  ListUsergroupsInput,
  ListUsergroupsOutput,
  SlackContext
>({
  name: "list_usergroups",
  description: "List user groups in the workspace (user token, scope usergroups:read).",
  inputSchema: listUsergroupsInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.listUsergroups({
      ...(input.include_disabled !== undefined
        ? { include_disabled: input.include_disabled }
        : {}),
    });
    const usergroups = resp.usergroups.map(mapUsergroup);
    return { usergroups, count: usergroups.length };
  },
});

// ---------------------------------------------------------------------------
// team_info
// ---------------------------------------------------------------------------

const teamInfoInputSchema = z.object({});

type TeamInfoInput = z.infer<typeof teamInfoInputSchema>;

type TeamInfoOutput = {
  id: string;
  name: string;
  domain?: string;
  email_domain?: string;
  icon?: string;
};

export const team_info = defineTool<TeamInfoInput, TeamInfoOutput, SlackContext>({
  name: "team_info",
  description: "Get workspace team info (user token, scope team:read).",
  inputSchema: teamInfoInputSchema,
  handler: async (_input, context) => {
    const resp = await context.client.teamInfo();
    const team = asObject(resp.team);
    const id = nullableString(team["id"]) ?? "";
    const name = nullableString(team["name"]) ?? "";
    const out: TeamInfoOutput = { id, name };
    const domain = nullableString(team["domain"]);
    const email_domain = nullableString(team["email_domain"]);
    if (domain !== null) out.domain = domain;
    if (email_domain !== null) out.email_domain = email_domain;
    // icon is a nested object with image_* keys; expose the largest one if present
    const iconObj = asObject(team["icon"]);
    const icon =
      nullableString(iconObj["image_132"]) ??
      nullableString(iconObj["image_88"]) ??
      nullableString(iconObj["image_68"]) ??
      null;
    if (icon !== null) out.icon = icon;
    return out;
  },
});

// ---------------------------------------------------------------------------
// list_emoji
// ---------------------------------------------------------------------------

const listEmojiInputSchema = z.object({});

type ListEmojiInput = z.infer<typeof listEmojiInputSchema>;

type ListEmojiOutput = {
  count: number;
  emoji: Record<string, string>;
};

export const list_emoji = defineTool<ListEmojiInput, ListEmojiOutput, SlackContext>({
  name: "list_emoji",
  description: "List custom emoji in the workspace (user token, scope emoji:read).",
  inputSchema: listEmojiInputSchema,
  handler: async (_input, context) => {
    const resp = await context.client.listEmoji();
    const emoji = resp.emoji;
    return { count: Object.keys(emoji).length, emoji };
  },
});
