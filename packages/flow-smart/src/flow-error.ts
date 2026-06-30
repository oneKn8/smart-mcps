import { UpstreamError } from "smart-mcp-core";

/**
 * Error propagation for multi-step flows. When an underlying sibling client
 * throws mid-flow, we must NOT surface a bare error: the caller needs to know
 * which step failed AND what already succeeded (e.g. "created project X and
 * version 3, then create_deployment failed: ..."). That partial-progress
 * honesty is part of flow-smart's contract.
 */
export class FlowStepError extends UpstreamError {
  /** Machine-readable id of the step that threw (e.g. `create_deployment`). */
  readonly step: string;
  /** Human-readable list of steps that completed before the failure. */
  readonly completed: string[];
  /** The reason string lifted from the underlying error. */
  readonly reason: string;

  constructor(step: string, reason: string, completed: string[], cause: unknown) {
    const prefix =
      completed.length > 0 ? `Completed: ${completed.join("; ")}. ` : "";
    super(`${prefix}Step "${step}" failed: ${reason}`, { cause });
    this.name = "FlowStepError";
    this.step = step;
    this.completed = [...completed];
    this.reason = reason;
  }
}

/** Lift a human-readable reason from any thrown value. */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A running record of completed steps, threaded through a flow so that any
 * failing step can report what came before it. `run(step, fn)` executes one
 * step; on throw it raises a {@link FlowStepError} carrying the prior progress.
 * `note(text)` records a completed step's human summary.
 */
export class FlowProgress {
  private readonly completed: string[] = [];

  /** Record that a step finished, with a human-readable summary. */
  note(text: string): void {
    this.completed.push(text);
  }

  /** Snapshot of completed-step summaries (defensive copy). */
  done(): string[] {
    return [...this.completed];
  }

  /**
   * Execute one named step. On success returns its value; on failure throws a
   * FlowStepError naming the step, the underlying reason, and every step that
   * completed before it. Re-throws an existing FlowStepError unchanged so a
   * nested flow's progress is not double-wrapped.
   */
  async run<T>(step: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FlowStepError) throw err;
      throw new FlowStepError(step, reasonOf(err), this.completed, err);
    }
  }
}
