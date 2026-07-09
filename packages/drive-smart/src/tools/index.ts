import type { ToolDefinition } from "smart-mcp-core";
import type { DriveContext } from "../context.js";
import { driveRoots } from "./roots.js";
import { driveScan } from "./scan.js";
import { driveStats } from "./stats.js";
import { driveSearch } from "./search.js";
import { driveLargest } from "./largest.js";
import { driveDuplicates } from "./duplicates.js";
import { drivePlanCleanup } from "./cleanup.js";

export const tools: ToolDefinition<unknown, unknown, DriveContext>[] = [
  driveRoots as unknown as ToolDefinition<unknown, unknown, DriveContext>,
  driveScan as unknown as ToolDefinition<unknown, unknown, DriveContext>,
  driveStats as unknown as ToolDefinition<unknown, unknown, DriveContext>,
  driveSearch as unknown as ToolDefinition<unknown, unknown, DriveContext>,
  driveLargest as unknown as ToolDefinition<unknown, unknown, DriveContext>,
  driveDuplicates as unknown as ToolDefinition<unknown, unknown, DriveContext>,
  drivePlanCleanup as unknown as ToolDefinition<unknown, unknown, DriveContext>,
];
