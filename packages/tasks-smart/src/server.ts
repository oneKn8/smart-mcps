#!/usr/bin/env node
import { createMcpServer } from "smart-mcp-core";
import { buildContext, type TasksContext } from "./context.js";
import { tools } from "./tools/index.js";

await createMcpServer<TasksContext>({
  name: "tasks-smart",
  version: "0.1.0",
  tools,
  context: buildContext(),
});
