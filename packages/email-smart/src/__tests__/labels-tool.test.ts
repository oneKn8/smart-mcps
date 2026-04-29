import { describe, it, expect, vi } from "vitest";
import { listLabels } from "../tools/labels.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listLabels: vi.fn(),
    getLabel: vi.fn(),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    context: { client: client as unknown as EmailClient },
    client,
  };
}

describe("list_labels tool", () => {
  it("enriches each label from listLabels with counts via getLabel", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_1", name: "Newsletters", type: "user" },
      { id: "STARRED", name: "STARRED", type: "system" },
    ]);
    client.getLabel.mockImplementation(async (_a, id: string) => {
      if (id === "INBOX")
        return {
          id: "INBOX",
          name: "INBOX",
          type: "system",
          messagesTotal: 1000,
          messagesUnread: 25,
          threadsUnread: 12,
        };
      if (id === "Label_1")
        return {
          id: "Label_1",
          name: "Newsletters",
          type: "user",
          messagesTotal: 50,
          messagesUnread: 5,
          threadsUnread: 3,
        };
      return { id: "STARRED", name: "STARRED", type: "system" };
    });

    const result = await listLabels.handler({ account: "alice" }, context);

    expect(client.listLabels).toHaveBeenCalledWith("alice");
    expect(client.getLabel).toHaveBeenCalledTimes(3);
    expect(result.count).toBe(3);
    expect(result.labels[0]).toEqual({
      id: "INBOX",
      name: "INBOX",
      type: "system",
      messages_total: 1000,
      messages_unread: 25,
      threads_unread: 12,
    });
    expect(result.labels[1]).toEqual({
      id: "Label_1",
      name: "Newsletters",
      type: "user",
      messages_total: 50,
      messages_unread: 5,
      threads_unread: 3,
    });
    // STARRED has no counts surfaced
    expect(result.labels[2]).toEqual({
      id: "STARRED",
      name: "STARRED",
      type: "system",
    });
  });

  it("skips a label whose getLabel call fails and continues with the rest", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "L1", name: "One", type: "user" },
      { id: "L2", name: "Two", type: "user" },
      { id: "L3", name: "Three", type: "user" },
    ]);
    client.getLabel.mockImplementation(async (_a, id: string) => {
      if (id === "L2") throw new Error("transient gmail failure");
      return {
        id,
        name: id === "L1" ? "One" : "Three",
        type: "user",
        messagesTotal: 7,
        messagesUnread: 1,
        threadsUnread: 1,
      };
    });

    const result = await listLabels.handler({ account: "alice" }, context);

    expect(result.count).toBe(2);
    expect(result.labels.map((l) => l.id)).toEqual(["L1", "L3"]);
  });

  it("returns empty result when account has no labels", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([]);

    const result = await listLabels.handler({ account: "alice" }, context);
    expect(result).toEqual({ labels: [], count: 0 });
    expect(client.getLabel).not.toHaveBeenCalled();
  });

  it("preserves system vs user type from listLabels", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "L1", name: "Custom", type: "user" },
    ]);
    client.getLabel.mockImplementation(async (_a, id: string) => ({
      id,
      name: id === "INBOX" ? "INBOX" : "Custom",
      type: id === "INBOX" ? "system" : "user",
    }));

    const result = await listLabels.handler({ account: "alice" }, context);
    expect(result.labels[0]?.type).toBe("system");
    expect(result.labels[1]?.type).toBe("user");
  });

  it("rejects empty account via zod", () => {
    expect(() =>
      (listLabels.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "" }),
    ).toThrow();
  });
});
