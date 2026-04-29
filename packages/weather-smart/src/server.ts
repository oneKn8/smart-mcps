#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { tools } from "./tools/index.js";

await createMcpServer({
  name: "weather-smart",
  version: "0.1.0",
  tools,
  context: {},
});
