import { z } from "zod";
import { defineTool } from "smart-mcp-core";
import type { GDriveContext } from "../context.js";
import { mapFile, type SlimFile } from "../file-mapper.js";

// =============================================================================
// create_folder
// =============================================================================

const createFolderInputSchema = z.object({
  name: z.string().min(1),
  parent_id: z.string().optional(),
});

type CreateFolderInput = z.infer<typeof createFolderInputSchema>;
type CreateFolderOutput = { file: SlimFile };

export const createFolderTool = defineTool<
  CreateFolderInput,
  CreateFolderOutput,
  GDriveContext
>({
  name: "create_folder",
  description: "Create a new folder",
  inputSchema: createFolderInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.createFolder({
      name: input.name,
      ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
    });
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// create_shortcut
// =============================================================================

const createShortcutInputSchema = z.object({
  name: z.string().min(1),
  target_id: z.string().min(1),
  parent_id: z.string().optional(),
});

type CreateShortcutInput = z.infer<typeof createShortcutInputSchema>;
type CreateShortcutOutput = { file: SlimFile };

export const createShortcutTool = defineTool<
  CreateShortcutInput,
  CreateShortcutOutput,
  GDriveContext
>({
  name: "create_shortcut",
  description: "Create a shortcut to a file",
  inputSchema: createShortcutInputSchema,
  handler: async (input, ctx) => {
    const raw = await ctx.client.createShortcut({
      name: input.name,
      targetId: input.target_id,
      ...(input.parent_id !== undefined ? { parentId: input.parent_id } : {}),
    });
    return { file: mapFile(raw) };
  },
});

// =============================================================================
// generate_ids
// =============================================================================

const generateIdsInputSchema = z.object({
  count: z.number().int().min(1).max(1000).optional().default(10),
});

type GenerateIdsInput = z.input<typeof generateIdsInputSchema>;
type GenerateIdsParsed = z.infer<typeof generateIdsInputSchema>;
type GenerateIdsOutput = { ids: string[] };

export const generateIdsTool = defineTool<
  GenerateIdsInput,
  GenerateIdsOutput,
  GDriveContext
>({
  name: "generate_ids",
  description: "Generate file IDs for uploads",
  // Cast required because `count` has `.optional().default(...)`.
  inputSchema:
    generateIdsInputSchema as unknown as z.ZodType<GenerateIdsInput>,
  handler: async (input, ctx) => {
    const parsed = input as GenerateIdsParsed;
    const out = await ctx.client.generateIds({ count: parsed.count });
    return { ids: out.ids };
  },
});
