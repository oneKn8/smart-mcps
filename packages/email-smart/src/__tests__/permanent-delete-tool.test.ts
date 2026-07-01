import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfirmRequiredError, ValidationError } from "smart-mcp-core";
import {
  deleteMessagePermanent,
  deleteThreadPermanent,
  batchDeleteMessages,
} from "../tools/permanent-delete.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    deleteMessage: vi.fn(),
    deleteThread: vi.fn(),
    batchDeleteMessages: vi.fn(),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    context: { client: client as unknown as EmailClient, home: tmpHome },
    client,
  };
}

let savedHome: string | undefined;
let tmpHome: string;

function writeIdentity(account: string, transport = "oauth"): void {
  const dir = path.join(tmpHome, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${account}.yaml`),
    [
      `account: ${account}`,
      `email: ${account}@example.com`,
      `display_name: ${account}`,
      `transport: ${transport}`,
    ].join("\n"),
  );
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-permdelete-tool-test-"));
  process.env.HOME = tmpHome;
  delete process.env.EMAIL_DEFAULT_ACCOUNT;
  writeIdentity("alice");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("delete_message_permanent tool", () => {
  it("gate: confirm=false throws ConfirmRequiredError with the irreversible warning", async () => {
    const { context, client } = makeContext();
    try {
      await deleteMessagePermanent.handler(
        { account: "alice", message_id: "msg_1" },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY delete msg_1");
      expect(preview).toContain("bypasses trash");
      expect(preview).toContain("CANNOT be recovered");
    }
    expect(client.deleteMessage).not.toHaveBeenCalled();
  });

  it("confirm=true permanently deletes and reports deleted", async () => {
    const { context, client } = makeContext();
    client.deleteMessage.mockResolvedValue(undefined);
    const result = await deleteMessagePermanent.handler(
      { account: "alice", message_id: "msg_1", confirm: true },
      context,
    );
    expect(client.deleteMessage).toHaveBeenCalledWith("alice", "msg_1");
    expect(result).toEqual({ id: "msg_1", deleted: true });
  });

  it("rejects an smtp identity before any Gmail call", async () => {
    writeIdentity("smtpy", "smtp");
    const { context, client } = makeContext();
    await expect(
      deleteMessagePermanent.handler(
        { account: "smtpy", message_id: "msg_1", confirm: true },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.deleteMessage).not.toHaveBeenCalled();
  });
});

describe("delete_thread_permanent tool", () => {
  it("gate: confirm=false throws ConfirmRequiredError with the irreversible warning", async () => {
    const { context, client } = makeContext();
    try {
      await deleteThreadPermanent.handler(
        { account: "alice", thread_id: "thr_1" },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY delete thr_1");
      expect(preview).toContain("bypasses trash");
      expect(preview).toContain("CANNOT be recovered");
    }
    expect(client.deleteThread).not.toHaveBeenCalled();
  });

  it("confirm=true permanently deletes and reports deleted", async () => {
    const { context, client } = makeContext();
    client.deleteThread.mockResolvedValue(undefined);
    const result = await deleteThreadPermanent.handler(
      { account: "alice", thread_id: "thr_1", confirm: true },
      context,
    );
    expect(client.deleteThread).toHaveBeenCalledWith("alice", "thr_1");
    expect(result).toEqual({ id: "thr_1", deleted: true });
  });
});

describe("batch_delete_messages tool", () => {
  it("dry_run default: returns the ids that WOULD be deleted, applied=false, no client call", async () => {
    const { context, client } = makeContext();
    const parsed = (batchDeleteMessages.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof batchDeleteMessages.handler>[0];
    }).parse({ account: "alice", message_ids: ["m1", "m2", "m3"] });

    const result = await batchDeleteMessages.handler(parsed, context);
    expect(result).toEqual({
      count: 3,
      message_ids: ["m1", "m2", "m3"],
      applied: false,
    });
    expect(client.batchDeleteMessages).not.toHaveBeenCalled();
  });

  it("dry_run wins over confirm: dry_run defaulted true + confirm=true still previews", async () => {
    const { context, client } = makeContext();
    const parsed = (batchDeleteMessages.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof batchDeleteMessages.handler>[0];
    }).parse({ account: "alice", message_ids: ["m1"], confirm: true });

    const result = await batchDeleteMessages.handler(parsed, context);
    expect(result.applied).toBe(false);
    expect(client.batchDeleteMessages).not.toHaveBeenCalled();
  });

  it("dry_run=false + confirm=false throws ConfirmRequiredError stating the exact count", async () => {
    const { context, client } = makeContext();
    try {
      await batchDeleteMessages.handler(
        { account: "alice", message_ids: ["m1", "m2"], dry_run: false },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain("PERMANENTLY delete 2 messages");
      expect(preview).toContain("CANNOT be recovered");
    }
    expect(client.batchDeleteMessages).not.toHaveBeenCalled();
  });

  it("dry_run=false + confirm=true calls the client and reports applied=true", async () => {
    const { context, client } = makeContext();
    client.batchDeleteMessages.mockResolvedValue(undefined);
    const result = await batchDeleteMessages.handler(
      {
        account: "alice",
        message_ids: ["m1", "m2"],
        dry_run: false,
        confirm: true,
      },
      context,
    );
    expect(client.batchDeleteMessages).toHaveBeenCalledWith("alice", [
      "m1",
      "m2",
    ]);
    expect(result).toEqual({
      count: 2,
      message_ids: ["m1", "m2"],
      applied: true,
    });
  });

  it("rejects an empty message_ids array via zod", () => {
    expect(() =>
      (batchDeleteMessages.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", message_ids: [] }),
    ).toThrow();
  });
});
