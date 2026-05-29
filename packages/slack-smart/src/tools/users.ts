import { z } from "zod";
import { defineTool, resolveOne, AmbiguousMatchError } from "smart-mcp-core";
import type { SlackContext } from "../context.js";
import { mapUser, type SlimUser } from "../user-mapper.js";
import { nullableString, nullableBoolean, asObject } from "../null-helpers.js";

// ---------------------------------------------------------------------------
// list_users
// ---------------------------------------------------------------------------

const listUsersInputSchema = z.object({
  // Cast required: ZodDefault makes limit's input type optional but output required.
  limit: z.number().int().min(1).max(200).optional().default(100),
  cursor: z.string().optional(),
});

type ListUsersInput = z.infer<typeof listUsersInputSchema>;

type ListUsersOutput = {
  users: SlimUser[];
  count: number;
  next_cursor?: string;
};

export const list_users = defineTool<ListUsersInput, ListUsersOutput, SlackContext>({
  name: "list_users",
  description: "List workspace members (up to 200 per page).",
  inputSchema: listUsersInputSchema as unknown as z.ZodType<ListUsersInput>,
  handler: async (input, context) => {
    const resp = await context.client.listUsers({
      limit: input.limit,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const users = resp.members.map((m) => mapUser(m));
    const next = resp.response_metadata?.next_cursor;
    return {
      users,
      count: users.length,
      ...(next !== undefined && next !== "" ? { next_cursor: next } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// user_info
// ---------------------------------------------------------------------------

const userInfoInputSchema = z.object({
  user: z.string(),
});

type UserInfoInput = z.infer<typeof userInfoInputSchema>;

export const user_info = defineTool<UserInfoInput, SlimUser, SlackContext>({
  name: "user_info",
  description: "Get slim profile for a single user by ID.",
  inputSchema: userInfoInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getUserInfo({ user: input.user });
    return mapUser(resp.user);
  },
});

// ---------------------------------------------------------------------------
// user_profile
// ---------------------------------------------------------------------------

const userProfileInputSchema = z.object({
  user: z.string().optional(),
});

type UserProfileInput = z.infer<typeof userProfileInputSchema>;

type SlimProfile = {
  display_name?: string;
  real_name?: string;
  email?: string;
  title?: string;
  phone?: string;
  status_text?: string;
  status_emoji?: string;
};

export const user_profile = defineTool<UserProfileInput, SlimProfile, SlackContext>({
  name: "user_profile",
  description: "Get extended profile fields for a user (omit user to fetch self).",
  inputSchema: userProfileInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getUserProfile({
      ...(input.user !== undefined ? { user: input.user } : {}),
    });
    const profile = asObject(resp.profile);

    const slim: SlimProfile = {};

    const display_name = nullableString(profile["display_name"]);
    if (display_name !== null && display_name !== "") slim.display_name = display_name;

    const real_name = nullableString(profile["real_name"]);
    if (real_name !== null && real_name !== "") slim.real_name = real_name;

    const email = nullableString(profile["email"]);
    if (email !== null && email !== "") slim.email = email;

    const title = nullableString(profile["title"]);
    if (title !== null && title !== "") slim.title = title;

    const phone = nullableString(profile["phone"]);
    if (phone !== null && phone !== "") slim.phone = phone;

    const status_text = nullableString(profile["status_text"]);
    if (status_text !== null && status_text !== "") slim.status_text = status_text;

    const status_emoji = nullableString(profile["status_emoji"]);
    if (status_emoji !== null && status_emoji !== "") slim.status_emoji = status_emoji;

    return slim;
  },
});

// ---------------------------------------------------------------------------
// lookup_by_email
// ---------------------------------------------------------------------------

const lookupByEmailInputSchema = z.object({
  email: z.string().email(),
});

type LookupByEmailInput = z.infer<typeof lookupByEmailInputSchema>;

export const lookup_by_email = defineTool<LookupByEmailInput, SlimUser, SlackContext>({
  name: "lookup_by_email",
  description: "Look up a workspace member by email address.",
  inputSchema: lookupByEmailInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.lookupByEmail({ email: input.email });
    return mapUser(resp.user);
  },
});

// ---------------------------------------------------------------------------
// user_presence
// ---------------------------------------------------------------------------

const userPresenceInputSchema = z.object({
  user: z.string().optional(),
});

type UserPresenceInput = z.infer<typeof userPresenceInputSchema>;

type PresenceOutput = {
  presence: string;
  online?: boolean;
};

export const user_presence = defineTool<UserPresenceInput, PresenceOutput, SlackContext>({
  name: "user_presence",
  description: "Get presence status for a user (omit user to fetch self).",
  inputSchema: userPresenceInputSchema,
  handler: async (input, context) => {
    const resp = await context.client.getPresence({
      ...(input.user !== undefined ? { user: input.user } : {}),
    });
    const out: PresenceOutput = { presence: resp.presence };
    // online is only present for the authed user's own presence
    const online = nullableBoolean(resp.online);
    if (online !== null) out.online = online;
    return out;
  },
});

// ---------------------------------------------------------------------------
// resolve_user
// ---------------------------------------------------------------------------

const resolveUserInputSchema = z.object({
  query: z.string().min(1),
});

type ResolveUserInput = z.infer<typeof resolveUserInputSchema>;

// Resolves against the first 200 users (personal-workspace assumption).
export const resolve_user = defineTool<ResolveUserInput, SlimUser, SlackContext>({
  name: "resolve_user",
  description: "Fuzzy-resolve a partial name or display name to a single workspace member.",
  inputSchema: resolveUserInputSchema,
  handler: async (input, context) => {
    const { members } = await context.client.listUsers({ limit: 200 });
    const slimUsers = members.map((m) => mapUser(m));
    // AmbiguousMatchError from resolveOne surfaces candidates automatically — let it propagate.
    return resolveOne(
      input.query,
      slimUsers,
      (u) => u.display_name ?? u.real_name ?? u.name,
      { threshold: 0.9 },
    );
  },
});

// Re-export AmbiguousMatchError for test convenience.
export { AmbiguousMatchError };
