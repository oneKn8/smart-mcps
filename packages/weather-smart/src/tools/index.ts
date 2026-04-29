import type { ToolDefinition } from "smart-mcp-core";
import type { WeatherContext } from "../context.js";
import { geocode } from "./geocode.js";
import { getCurrent } from "./current.js";
import { getForecast, getHourly } from "./forecast.js";
import { getHistorical } from "./historical.js";
import { getAirQuality } from "./air-quality.js";
import { getAlerts } from "./alerts.js";
import { dailyBrief } from "./brief.js";
import { umbrellaCheck } from "./umbrella.js";

export const tools = [
  geocode,
  getCurrent,
  getForecast,
  getHourly,
  getHistorical,
  getAirQuality,
  getAlerts,
  dailyBrief,
  umbrellaCheck,
] as unknown as ToolDefinition<unknown, unknown, WeatherContext>[];
