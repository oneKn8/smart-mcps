import { z } from "zod";
import type { HetznerClient, HetznerAction } from "../client.js";

// Shared zod fragments for wait-aware / destructive tool inputs. Every mutating
// tool opts into `wait` (block until the action settles) and every destructive
// one into `confirm`.
export const waitField = z.boolean().optional().default(true);
export const confirmField = z.boolean().optional().default(false);

// Slim projection of a settled/running action returned to the caller.
export type ActionSummary = {
  id: number;
  command: string;
  status: string;
  progress: number;
  finished: string | null;
};

export function summarizeAction(a: HetznerAction): ActionSummary {
  return {
    id: a.id,
    command: a.command,
    status: a.status,
    progress: a.progress,
    finished: a.finished,
  };
}

// Given a raw mutation body, extract its primary action and — when `wait` is on
// and the action is still running — poll it to completion. Returns null for
// synchronous responses that carry no action (e.g. network/ssh-key creates).
export async function settleAction(
  client: HetznerClient,
  body: unknown,
  wait: boolean,
): Promise<ActionSummary | null> {
  const a = client.extractAction(body);
  if (!a) return null;
  if (wait && a.status === "running") {
    const done = await client.waitForAction(a.id);
    return summarizeAction(done);
  }
  return summarizeAction(a);
}
