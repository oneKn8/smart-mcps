import { z } from "zod";
import { defineTool, guardDestructive, ValidationError } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import { mapPermission, type SlimPermission } from "../permission-mapper.js";

// =============================================================================
// Shared role / type enums (Drive Permission resource)
// =============================================================================

const roleSchema = z.enum([
  "owner",
  "organizer",
  "fileOrganizer",
  "writer",
  "commenter",
  "reader",
]);
const typeSchema = z.enum(["user", "group", "domain", "anyone"]);

// =============================================================================
// share (permissions.create — sensitive, confirm-gated with exposure preview)
// =============================================================================

const shareInputSchema = z.object({
  file_id: z.string().min(1),
  role: roleSchema,
  type: typeSchema,
  email_address: z.string().optional(),
  domain: z.string().optional(),
  send_notification_email: z.boolean().optional(),
  transfer_ownership: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});

type ShareInput = z.input<typeof shareInputSchema>;
type ShareParsed = z.infer<typeof shareInputSchema>;
type ShareOutput = { permission: SlimPermission };

export const shareTool = defineTool<ShareInput, ShareOutput, GDriveContext>({
  name: "share",
  description: "Share a file with someone",
  // Cast required because several fields have `.optional().default(...)`.
  inputSchema: shareInputSchema as unknown as z.ZodType<ShareInput>,
  handler: async (input, ctx) => {
    const parsed = input as ShareParsed;

    // Scope-shape invariant: user/group need an email, domain needs a domain,
    // anyone needs neither. Google rejects mismatches with 400; a friendlier
    // up-front error spells out the rule for the LLM caller.
    if (parsed.type === "user" || parsed.type === "group") {
      if (parsed.email_address === undefined || parsed.email_address.length === 0) {
        throw new ValidationError(
          `email_address is required when type is '${parsed.type}'.`,
        );
      }
    } else if (parsed.type === "domain") {
      if (parsed.domain === undefined || parsed.domain.length === 0) {
        throw new ValidationError(
          "domain is required when type is 'domain'.",
        );
      }
    } else if (parsed.type === "anyone") {
      if (parsed.email_address !== undefined || parsed.domain !== undefined) {
        throw new ValidationError(
          "email_address/domain must be omitted when type is 'anyone' " +
            "(anyone = public link, has no specific principal).",
        );
      }
    }

    // Granting `owner` implies an ownership transfer; Drive requires
    // transferOwnership=true in that case.
    const transferOwnership = parsed.role === "owner" || parsed.transfer_ownership;

    // Default notifications sensibly: on for a specific user, off for the
    // broader group/domain/anyone types (avoid spamming a whole org / no-op
    // for a public link).
    const sendNotificationEmail =
      parsed.send_notification_email ?? parsed.type === "user";

    const target =
      parsed.type === "anyone"
        ? "anyone (public link)"
        : parsed.type === "domain"
          ? `domain ${parsed.domain}`
          : `${parsed.type} ${parsed.email_address}`;
    let preview = `Grant '${parsed.role}' access to ${target} on file \`${parsed.file_id}\`.`;
    if (parsed.type === "anyone") {
      preview +=
        " WARNING: type 'anyone' makes this file PUBLIC / link-accessible to the entire world.";
    }
    if (transferOwnership) {
      preview +=
        " WARNING: this TRANSFERS OWNERSHIP — you will be downgraded to writer and may lose control of the file.";
    }
    guardDestructive({ confirm: parsed.confirm, preview });

    const raw = await ctx.client.createPermission(parsed.file_id, {
      role: parsed.role,
      type: parsed.type,
      ...(parsed.email_address !== undefined
        ? { emailAddress: parsed.email_address }
        : {}),
      ...(parsed.domain !== undefined ? { domain: parsed.domain } : {}),
      sendNotificationEmail,
      ...(transferOwnership ? { transferOwnership: true } : {}),
    });
    return { permission: mapPermission(raw) };
  },
});

// =============================================================================
// list_permissions (permissions.list)
// =============================================================================

const listPermissionsInputSchema = z.object({
  file_id: z.string().min(1),
});

type ListPermissionsInput = z.infer<typeof listPermissionsInputSchema>;
type ListPermissionsOutput = { permissions: SlimPermission[] };

export const listPermissionsTool = defineTool<
  ListPermissionsInput,
  ListPermissionsOutput,
  GDriveContext
>({
  name: "list_permissions",
  description: "List who can access a file",
  inputSchema: listPermissionsInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.listPermissions(input.file_id);
    return { permissions: raw.map(mapPermission) };
  },
});

// =============================================================================
// update_permission (permissions.update — gated when elevating to owner)
// =============================================================================

const updatePermissionInputSchema = z.object({
  file_id: z.string().min(1),
  permission_id: z.string().min(1),
  role: roleSchema,
  transfer_ownership: z.boolean().optional().default(false),
  confirm: z.boolean().optional().default(false),
});

type UpdatePermissionInput = z.input<typeof updatePermissionInputSchema>;
type UpdatePermissionParsed = z.infer<typeof updatePermissionInputSchema>;
type UpdatePermissionOutput = { permission: SlimPermission };

export const updatePermissionTool = defineTool<
  UpdatePermissionInput,
  UpdatePermissionOutput,
  GDriveContext
>({
  name: "update_permission",
  description: "Change someone's access level",
  // Cast required because several fields have `.optional().default(...)`.
  inputSchema:
    updatePermissionInputSchema as unknown as z.ZodType<UpdatePermissionInput>,
  handler: async (input, ctx) => {
    const parsed = input as UpdatePermissionParsed;
    const transferOwnership =
      parsed.role === "owner" || parsed.transfer_ownership;

    // Only elevating to owner / transferring ownership is hard to reverse;
    // plain role changes (e.g. writer -> reader) apply without a gate.
    if (transferOwnership) {
      const preview =
        `Change permission \`${parsed.permission_id}\` on file \`${parsed.file_id}\` ` +
        `to role '${parsed.role}'. WARNING: this TRANSFERS OWNERSHIP — you will be ` +
        "downgraded to writer and may lose control of the file.";
      guardDestructive({ confirm: parsed.confirm, preview });
    }

    const raw = await ctx.client.updatePermission(
      parsed.file_id,
      parsed.permission_id,
      {
        role: parsed.role,
        ...(transferOwnership ? { transferOwnership: true } : {}),
      },
    );
    return { permission: mapPermission(raw) };
  },
});

// =============================================================================
// unshare (permissions.delete — revoking access is reversible via re-share)
// =============================================================================

const unshareInputSchema = z.object({
  file_id: z.string().min(1),
  permission_id: z.string().min(1),
});

type UnshareInput = z.infer<typeof unshareInputSchema>;
type UnshareOutput = { unshared: true };

export const unshareTool = defineTool<
  UnshareInput,
  UnshareOutput,
  GDriveContext
>({
  name: "unshare",
  description: "Revoke someone's file access",
  inputSchema: unshareInputSchema,
  handler: async (input, ctx) => {
    await ctx.client.deletePermission(input.file_id, input.permission_id);
    return { unshared: true };
  },
});
