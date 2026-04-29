import type { ToolDefinition } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { geocode } from "./geocode.js";
import { getCurrent } from "./current.js";
import { getForecast, getHourly } from "./forecast.js";

export const tools = [
  geocode,
  getCurrent,
  getForecast,
  getHourly,
] as unknown as ToolDefinition<unknown, unknown, WeatherContext>[];
