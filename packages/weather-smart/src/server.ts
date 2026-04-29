#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type WeatherContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<WeatherContext>({
  name: "weather-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
