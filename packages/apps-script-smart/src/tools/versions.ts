import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { AppsScriptContext } from "../context.js";
import { resolveAccount } from "./account.js";
import { mapVersion, type SlimVersion } from "../version-mapper.js";

// =============================================================================
// create_version
// =============================================================================

const createVersionInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  script_id: z.string().min(1),
  description: z.string().optional(),
});

type CreateVersionInput = z.infer<typeof createVersionInputSchema>;
type CreateVersionOutput = { version: SlimVersion };

export const createVersionTool = defineTool<
  CreateVersionInput,
  CreateVersionOutput,
  AppsScriptContext
>({
  name: "create_version",
  description: "Create an immutable version snapshot",
  inputSchema: createVersionInputSchema,
  handler: async (input, ctx) => {
    const account = resolveAccount(input.account, ctx);
    const raw = await ctx.client.createVersion(
      account,
      input.script_id,
      input.description,
    );
    return { version: mapVersion(raw) };
  },
});

// =============================================================================
// list_versions
// =============================================================================

const listVersionsInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  script_id: z.string().min(1),
  page_size: z.number().int().positive().optional(),
  page_token: z.string().optional(),
});

type ListVersionsInput = z.infer<typeof listVersionsInputSchema>;
type ListVersionsOutput = {
  versions: SlimVersion[];
  next_page_token: string | null;
};

export const listVersionsTool = defineTool<
  ListVersionsInput,
  ListVersionsOutput,
  AppsScriptContext
>({
  name: "list_versions",
  description: "List a project's versions",
  inputSchema: listVersionsInputSchema,
  handler: async (input, ctx) => {
    const account = resolveAccount(input.account, ctx);
    const res = await ctx.client.listVersions(account, {
      scriptId: input.script_id,
      ...(input.page_size !== undefined ? { pageSize: input.page_size } : {}),
      ...(input.page_token !== undefined
        ? { pageToken: input.page_token }
        : {}),
    });
    return {
      versions: res.items.map(mapVersion),
      next_page_token: res.nextPageToken ?? null,
    };
  },
});

// =============================================================================
// get_version
// =============================================================================

const getVersionInputSchema = z.object({
  /** Account to act as; omit for the default identity. */
  account: z.string().optional(),
  script_id: z.string().min(1),
  version_number: z.number().int(),
});

type GetVersionInput = z.infer<typeof getVersionInputSchema>;
type GetVersionOutput = { version: SlimVersion };

export const getVersionTool = defineTool<
  GetVersionInput,
  GetVersionOutput,
  AppsScriptContext
>({
  name: "get_version",
  description: "Get one project version",
  inputSchema: getVersionInputSchema,
  handler: async (input, ctx) => {
    const account = resolveAccount(input.account, ctx);
    const raw = await ctx.client.getVersion(
      account,
      input.script_id,
      input.version_number,
    );
    return { version: mapVersion(raw) };
  },
});
