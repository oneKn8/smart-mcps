import { z } from "zod";
import { defineTool, ValidationError } from "smart-mcp-core";
import type { DocsContext } from "../context.js";
import {
  ALIGNMENTS,
  ORDERED_BULLET_PRESET,
  UNORDERED_BULLET_PRESET,
  buildParagraphStyle,
  buildTextStyle,
  createParagraphBulletsRequest,
  deleteParagraphBulletsRequest,
  updateParagraphStyleRequest,
  updateTextStyleRequest,
  type Alignment,
  type NamedStyleType,
} from "../request-builders.js";

function assertRange(startIndex: number, endIndex: number): void {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    throw new ValidationError("start_index and end_index must be integers.");
  }
  if (endIndex <= startIndex) {
    throw new ValidationError(
      `end_index (${endIndex}) must be greater than start_index (${startIndex}).`,
    );
  }
}

// =============================================================================
// set_text_style  (auto-builds the `fields` mask from supplied attributes)
// =============================================================================

const setTextStyleInputSchema = z.object({
  document_id: z.string().min(1),
  start_index: z.number().int(),
  end_index: z.number().int(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  font_size: z.number().positive().optional(),
  font_family: z.string().optional(),
  foreground_color: z.string().optional(),
  link_url: z.string().optional(),
});

type SetTextStyleInput = z.infer<typeof setTextStyleInputSchema>;
type SetTextStyleOutput = { document_id: string; fields: string };

export const setTextStyleTool = defineTool<
  SetTextStyleInput,
  SetTextStyleOutput,
  DocsContext
>({
  name: "set_text_style",
  description: "Set character formatting over a range",
  inputSchema: setTextStyleInputSchema,
  handler: async (input, ctx) => {
    assertRange(input.start_index, input.end_index);
    const built = buildTextStyle({
      ...(input.bold !== undefined ? { bold: input.bold } : {}),
      ...(input.italic !== undefined ? { italic: input.italic } : {}),
      ...(input.underline !== undefined ? { underline: input.underline } : {}),
      ...(input.strikethrough !== undefined
        ? { strikethrough: input.strikethrough }
        : {}),
      ...(input.font_size !== undefined ? { fontSize: input.font_size } : {}),
      ...(input.font_family !== undefined
        ? { fontFamily: input.font_family }
        : {}),
      ...(input.foreground_color !== undefined
        ? { foregroundColorHex: input.foreground_color }
        : {}),
      ...(input.link_url !== undefined ? { linkUrl: input.link_url } : {}),
    });
    if (!built) {
      throw new ValidationError(
        "set_text_style needs at least one style attribute (bold, italic, font_size, ...).",
      );
    }
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [
        updateTextStyleRequest({
          startIndex: input.start_index,
          endIndex: input.end_index,
          textStyle: built.textStyle,
          fields: built.fields,
        }),
      ],
    });
    return { document_id: input.document_id, fields: built.fields };
  },
});

// =============================================================================
// set_paragraph_style
// =============================================================================

const setParagraphStyleInputSchema = z.object({
  document_id: z.string().min(1),
  start_index: z.number().int(),
  end_index: z.number().int(),
  named_style_type: z
    .enum([
      "NORMAL_TEXT",
      "TITLE",
      "SUBTITLE",
      "HEADING_1",
      "HEADING_2",
      "HEADING_3",
      "HEADING_4",
      "HEADING_5",
      "HEADING_6",
    ])
    .optional(),
  alignment: z.enum(ALIGNMENTS).optional(),
  line_spacing: z.number().positive().optional(),
  space_above: z.number().optional(),
  space_below: z.number().optional(),
  indent_start: z.number().optional(),
  indent_first_line: z.number().optional(),
});

type SetParagraphStyleInput = z.infer<typeof setParagraphStyleInputSchema>;
type SetParagraphStyleOutput = { document_id: string; fields: string };

export const setParagraphStyleTool = defineTool<
  SetParagraphStyleInput,
  SetParagraphStyleOutput,
  DocsContext
>({
  name: "set_paragraph_style",
  description: "Set paragraph formatting over a range",
  inputSchema: setParagraphStyleInputSchema,
  handler: async (input, ctx) => {
    assertRange(input.start_index, input.end_index);
    const built = buildParagraphStyle({
      ...(input.named_style_type !== undefined
        ? { namedStyleType: input.named_style_type as NamedStyleType }
        : {}),
      ...(input.alignment !== undefined
        ? { alignment: input.alignment as Alignment }
        : {}),
      ...(input.line_spacing !== undefined
        ? { lineSpacing: input.line_spacing }
        : {}),
      ...(input.space_above !== undefined
        ? { spaceAbove: input.space_above }
        : {}),
      ...(input.space_below !== undefined
        ? { spaceBelow: input.space_below }
        : {}),
      ...(input.indent_start !== undefined
        ? { indentStart: input.indent_start }
        : {}),
      ...(input.indent_first_line !== undefined
        ? { indentFirstLine: input.indent_first_line }
        : {}),
    });
    if (!built) {
      throw new ValidationError(
        "set_paragraph_style needs at least one attribute (named_style_type, alignment, ...).",
      );
    }
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [
        updateParagraphStyleRequest({
          startIndex: input.start_index,
          endIndex: input.end_index,
          paragraphStyle: built.paragraphStyle,
          fields: built.fields,
        }),
      ],
    });
    return { document_id: input.document_id, fields: built.fields };
  },
});

// =============================================================================
// set_heading  (convenience over updateParagraphStyle)
// =============================================================================

const HEADING_CHOICES = {
  title: "TITLE",
  subtitle: "SUBTITLE",
  normal: "NORMAL_TEXT",
  heading_1: "HEADING_1",
  heading_2: "HEADING_2",
  heading_3: "HEADING_3",
  heading_4: "HEADING_4",
  heading_5: "HEADING_5",
  heading_6: "HEADING_6",
} as const;

const setHeadingInputSchema = z.object({
  document_id: z.string().min(1),
  start_index: z.number().int(),
  end_index: z.number().int(),
  heading: z.enum([
    "title",
    "subtitle",
    "normal",
    "heading_1",
    "heading_2",
    "heading_3",
    "heading_4",
    "heading_5",
    "heading_6",
  ]),
});

type SetHeadingInput = z.infer<typeof setHeadingInputSchema>;
type SetHeadingOutput = { document_id: string; named_style_type: string };

export const setHeadingTool = defineTool<
  SetHeadingInput,
  SetHeadingOutput,
  DocsContext
>({
  name: "set_heading",
  description: "Apply a heading style to paragraphs",
  inputSchema: setHeadingInputSchema,
  handler: async (input, ctx) => {
    assertRange(input.start_index, input.end_index);
    const named = HEADING_CHOICES[input.heading];
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [
        updateParagraphStyleRequest({
          startIndex: input.start_index,
          endIndex: input.end_index,
          paragraphStyle: { namedStyleType: named },
          fields: "namedStyleType",
        }),
      ],
    });
    return { document_id: input.document_id, named_style_type: named };
  },
});

// =============================================================================
// make_bullets
// =============================================================================

const makeBulletsInputSchema = z.object({
  document_id: z.string().min(1),
  start_index: z.number().int(),
  end_index: z.number().int(),
  ordered: z.boolean().optional().default(false),
  preset: z.string().optional(),
});

type MakeBulletsInput = z.input<typeof makeBulletsInputSchema>;
type MakeBulletsParsed = z.infer<typeof makeBulletsInputSchema>;
type MakeBulletsOutput = { document_id: string; preset: string };

export const makeBulletsTool = defineTool<
  MakeBulletsInput,
  MakeBulletsOutput,
  DocsContext
>({
  name: "make_bullets",
  description: "Turn paragraphs into a bulleted list",
  // Cast required because `ordered` has `.optional().default(...)`.
  inputSchema: makeBulletsInputSchema as unknown as z.ZodType<MakeBulletsInput>,
  handler: async (input, ctx) => {
    const parsed = input as MakeBulletsParsed;
    assertRange(parsed.start_index, parsed.end_index);
    const preset =
      parsed.preset ??
      (parsed.ordered ? ORDERED_BULLET_PRESET : UNORDERED_BULLET_PRESET);
    await ctx.client.batchUpdate({
      documentId: parsed.document_id,
      requests: [
        createParagraphBulletsRequest({
          startIndex: parsed.start_index,
          endIndex: parsed.end_index,
          bulletPreset: preset,
        }),
      ],
    });
    return { document_id: parsed.document_id, preset };
  },
});

// =============================================================================
// remove_bullets
// =============================================================================

const removeBulletsInputSchema = z.object({
  document_id: z.string().min(1),
  start_index: z.number().int(),
  end_index: z.number().int(),
});

type RemoveBulletsInput = z.infer<typeof removeBulletsInputSchema>;
type RemoveBulletsOutput = { document_id: string };

export const removeBulletsTool = defineTool<
  RemoveBulletsInput,
  RemoveBulletsOutput,
  DocsContext
>({
  name: "remove_bullets",
  description: "Remove bullets from paragraphs in a range",
  inputSchema: removeBulletsInputSchema,
  handler: async (input, ctx) => {
    assertRange(input.start_index, input.end_index);
    await ctx.client.batchUpdate({
      documentId: input.document_id,
      requests: [
        deleteParagraphBulletsRequest({
          startIndex: input.start_index,
          endIndex: input.end_index,
        }),
      ],
    });
    return { document_id: input.document_id };
  },
});
