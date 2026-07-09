import { describe, it, expect, vi } from "vitest";
import { listProcessesTool } from "../processes.js";

// Default account the context resolves to when a call omits `account`.
const ACCT = "acct";

function ctxOf(
  listProcesses: ReturnType<typeof vi.fn>,
): { client: never; defaultAccount: string } {
  return {
    client: { listProcesses } as unknown as never,
    defaultAccount: ACCT,
  };
}

describe("listProcessesTool", () => {
  it("forwards only the provided filters and maps processes", async () => {
    const listProcesses = vi.fn().mockResolvedValue({
      items: [{ functionName: "poll", processStatus: "COMPLETED" }],
    });
    const input = listProcessesTool.inputSchema.parse({
      script_id: "s1",
      function_name: "poll",
      statuses: ["COMPLETED"],
    }) as Parameters<typeof listProcessesTool.handler>[0];
    const out = await listProcessesTool.handler(input, ctxOf(listProcesses));
    expect(listProcesses).toHaveBeenCalledWith(ACCT, {
      scriptId: "s1",
      functionName: "poll",
      statuses: ["COMPLETED"],
    });
    expect(out.processes[0]?.function_name).toBe("poll");
    expect(out.next_page_token).toBeNull();
  });

  it("calls with empty filters when none provided", async () => {
    const listProcesses = vi
      .fn()
      .mockResolvedValue({ items: [], nextPageToken: "t" });
    const input = listProcessesTool.inputSchema.parse(
      {},
    ) as Parameters<typeof listProcessesTool.handler>[0];
    const out = await listProcessesTool.handler(input, ctxOf(listProcesses));
    expect(listProcesses).toHaveBeenCalledWith(ACCT, {});
    expect(out.next_page_token).toBe("t");
  });
});
