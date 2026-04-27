import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodTypeAny } from "zod";
import { ValidationError, toMcpResult, type McpToolResult } from "./errors.js";

export type ToolDefinition<Input = unknown, Output = unknown, Context = unknown> = {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  handler: (input: Input, context: Context) => Promise<Output>;
};

export function defineTool<Input, Output, Context = unknown>(
  def: Omit<ToolDefinition<Input, Output, Context>, "inputSchema"> & {
    inputSchema: z.ZodType<Input>;
  },
): ToolDefinition<Input, Output, Context> {
  return def as ToolDefinition<Input, Output, Context>;
}

export async function runToolSafely<Input, Output, Context>(
  tool: ToolDefinition<Input, Output, Context>,
  rawInput: unknown,
  context: Context,
): Promise<McpToolResult> {
  let parsed: Input;
  try {
    parsed = tool.inputSchema.parse(rawInput) as Input;
  } catch (err) {
    return toMcpResult(
      new ValidationError(
        `Invalid input for tool ${tool.name}`,
        { detail: err instanceof z.ZodError ? err.flatten() : String(err) },
      ),
    );
  }
  try {
    const result = await tool.handler(parsed, context);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return toMcpResult(err);
  }
}

export type CreateMcpServerOpts<Context> = {
  name: string;
  version: string;
  tools: ToolDefinition<unknown, unknown, Context>[];
  context: Context;
};

export async function createMcpServer<Context>(
  opts: CreateMcpServerOpts<Context>,
): Promise<void> {
  const { name, version, tools, context } = opts;
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  const toolsByName = new Map(tools.map(t => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return toMcpResult(
        new ValidationError(`Unknown tool: ${request.params.name}`, {
          detail: { available: [...toolsByName.keys()] },
        }),
      );
    }
    return runToolSafely(tool, request.params.arguments ?? {}, context);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Minimal zod -> JSON Schema converter (handles the common shapes we use:
// objects, strings, numbers, booleans, arrays, optionals, defaults, enums).
// For exotic schemas, write the JSON Schema by hand and pass via a wrapper.
function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const typeName = def.typeName;

  if (typeName === "ZodObject") {
    const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      const innerDef = (value as unknown as { _def: { typeName: string } })._def;
      if (innerDef.typeName !== "ZodOptional" && innerDef.typeName !== "ZodDefault") {
        required.push(key);
      }
    }
    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }
  if (typeName === "ZodString") return { type: "string" };
  if (typeName === "ZodNumber") return { type: "number" };
  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodArray") {
    const inner = (schema as unknown as { _def: { type: ZodTypeAny } })._def.type;
    return { type: "array", items: zodToJsonSchema(inner) };
  }
  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    const inner = (schema as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
    return zodToJsonSchema(inner);
  }
  if (typeName === "ZodEnum") {
    const values = (schema as unknown as { _def: { values: string[] } })._def.values;
    return { type: "string", enum: values };
  }
  if (typeName === "ZodLiteral") {
    const value = (schema as unknown as { _def: { value: unknown } })._def.value;
    return { const: value };
  }
  // Fallback — expose nothing useful but don't blow up
  return {};
}
