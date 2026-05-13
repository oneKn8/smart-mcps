#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type CalendarContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<CalendarContext>({
  name: "calendar-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
