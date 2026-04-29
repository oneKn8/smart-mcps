import type { ToolDefinition } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { geocode } from "./geocode.js";

export const tools = [
  geocode,
] as unknown as ToolDefinition<unknown, unknown, WeatherContext>[];
