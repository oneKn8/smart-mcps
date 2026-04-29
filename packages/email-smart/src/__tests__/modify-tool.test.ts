import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConfirmRequiredError,
  NotFoundError,
  ValidationError,
} from "smart-mcp-core";
import {
  markReadByQuery,
  archiveByQuery,
  trashByQuery,
  applyLabelByQuery,
} from "../tools/modify.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-modify-tool-test-"));
}

function writeIdentity(home: string, account: string, body: string): void {
  const dir = path.join(home, ".santo-agent", "identities");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${account}.yaml`), body);
}

function aliceIdentity(): string {
  return [
    "account: alice",
    "email: alice@example.com",
    "display_name: Alice Example",
  ].join("\n");
}

function aliceSmtpIdentity(): string {
  return [
    "account: alice",
    "email: alice@example.com",
    "display_name: Alice Example",
    "transport: smtp",
  ].join("\n");
}

function makeMessageRaw(opts: {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
}): unknown {
  const headers: Array<{ name: string; value: string }> = [];
  if (opts.from !== undefined)
    headers.push({ name: "From", value: opts.from });
  if (opts.subject !== undefined)
    headers.push({ name: "Subject", value: opts.subject });
  return {
    id: opts.id,
    threadId: opts.threadId ?? `thr_${opts.id}`,
    labelIds: ["INBOX"],
    snippet: "",
    sizeEstimate: 0,
    payload: { headers },
  };
}

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModify: vi.fn(),
    batchTrash: vi.fn(),
    listLabels: vi.fn(),
  };
  return {
    context: {
      client: client as unknown as EmailClient,
      home: tmpHome,
    },
    client,
  };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
  writeIdentity(tmpHome, "alice", aliceIdentity());
});

afterEach(() => {
  vi.useRealTimers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------- mark_read_by_query ----------

describe("mark_read_by_query tool", () => {
  it("metadata: name and description", () => {
    expect(markReadByQuery.name).toBe("mark_read_by_query");
    expect(markReadByQuery.description).toBe(
      "Bulk mark as read by Gmail query.",
    );
  });

  it("dry_run (default) returns preview without calling batchModify", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id, subject: `s-${id}` }),
    );

    const parsed = (markReadByQuery.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof markReadByQuery.handler>[0];
    }).parse({ account: "alice", q: "from:newsletter is:unread" });

    const result = await markReadByQuery.handler(parsed, context);

    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.matched).toBe(2);
    expect(result.scanned).toBe(2);
    expect(result.preview).toHaveLength(2);
  });

  it("confirm gate: dry_run=false + confirm=false throws ConfirmRequiredError with exact preview text", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
        { id: "m3", threadId: "t3" },
      ],
      resultSizeEstimate: 3,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );

    try {
      await markReadByQuery.handler(
        {
          account: "alice",
          q: "from:newsletter",
          max: 100,
          dry_run: false,
          confirm: false,
        },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toBe(
        "Will mark 3 messages as read for account alice. Query: from:newsletter",
      );
    }
    expect(client.batchModify).not.toHaveBeenCalled();
  });

  it("applied path: dry_run=false + confirm=true calls batchModify with UNREAD remove and returns applied=true", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );
    client.batchModify.mockResolvedValue(undefined);

    const result = await markReadByQuery.handler(
      {
        account: "alice",
        q: "from:newsletter",
        max: 100,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).toHaveBeenCalledWith("alice", {
      ids: ["m1", "m2"],
      removeLabelIds: ["UNREAD"],
    });
    expect(result.applied).toBe(true);
    expect(result.matched).toBe(2);
  });

  it("rejects SMTP-transport accounts before any Gmail call", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();

    await expect(
      markReadByQuery.handler(
        {
          account: "alice",
          q: "from:newsletter",
          max: 100,
          dry_run: true,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.listMessages).not.toHaveBeenCalled();
    expect(client.batchModify).not.toHaveBeenCalled();
  });

  it("query passthrough: forwards exact q string to listMessages", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    const q = "from:bills@utility.com older_than:7d label:UNREAD";
    await markReadByQuery.handler(
      { account: "alice", q, max: 100, dry_run: true, confirm: false },
      context,
    );

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q,
      maxResults: 100,
    });
  });

  it("max cap: rejects max > 500 via zod", () => {
    expect(() =>
      (markReadByQuery.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", q: "test", max: 501 }),
    ).toThrow();
  });

  it("dry_run wins over confirm (both true → still preview only)", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const result = await markReadByQuery.handler(
      {
        account: "alice",
        q: "test",
        max: 100,
        dry_run: true,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("preview is capped at first 10 of matched", async () => {
    const { context, client } = makeContext();
    const ids = Array.from({ length: 25 }, (_v, i) => ({
      id: `m${i}`,
      threadId: `t${i}`,
    }));
    client.listMessages.mockResolvedValue({
      messages: ids,
      resultSizeEstimate: 25,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );

    const result = await markReadByQuery.handler(
      {
        account: "alice",
        q: "test",
        max: 100,
        dry_run: true,
        confirm: false,
      },
      context,
    );
    expect(result.matched).toBe(25);
    expect(result.preview).toHaveLength(10);
    // Preview-fetch should have been called only 10 times, not 25.
    expect(client.getMessage).toHaveBeenCalledTimes(10);
  });
});

// ---------- archive_by_query ----------

describe("archive_by_query tool", () => {
  it("metadata: name and description", () => {
    expect(archiveByQuery.name).toBe("archive_by_query");
    expect(archiveByQuery.description).toBe(
      "Bulk archive by Gmail query (removes INBOX).",
    );
  });

  it("dry_run (default) returns preview without calling batchModify", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const parsed = (archiveByQuery.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof archiveByQuery.handler>[0];
    }).parse({ account: "alice", q: "older_than:30d" });

    const result = await archiveByQuery.handler(parsed, context);

    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.matched).toBe(1);
  });

  it("confirm gate: throws with exact preview text", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );

    try {
      await archiveByQuery.handler(
        {
          account: "alice",
          q: "older_than:30d",
          max: 100,
          dry_run: false,
          confirm: false,
        },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will archive 2 messages for account alice (removes INBOX label). Query: older_than:30d",
      );
    }
  });

  it("applied path: calls batchModify with INBOX removal", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));
    client.batchModify.mockResolvedValue(undefined);

    const result = await archiveByQuery.handler(
      {
        account: "alice",
        q: "older_than:30d",
        max: 100,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).toHaveBeenCalledWith("alice", {
      ids: ["m1"],
      removeLabelIds: ["INBOX"],
    });
    expect(result.applied).toBe(true);
  });

  it("rejects SMTP transport", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();

    await expect(
      archiveByQuery.handler(
        {
          account: "alice",
          q: "test",
          max: 100,
          dry_run: true,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("query passthrough", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await archiveByQuery.handler(
      {
        account: "alice",
        q: "from:promo",
        max: 50,
        dry_run: true,
        confirm: false,
      },
      context,
    );

    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "from:promo",
      maxResults: 50,
    });
  });

  it("max cap: rejects max > 500 via zod", () => {
    expect(() =>
      (archiveByQuery.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", q: "test", max: 600 }),
    ).toThrow();
  });

  it("dry_run wins over confirm", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const result = await archiveByQuery.handler(
      {
        account: "alice",
        q: "test",
        max: 100,
        dry_run: true,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });
});

// ---------- trash_by_query ----------

describe("trash_by_query tool", () => {
  it("metadata: name and description", () => {
    expect(trashByQuery.name).toBe("trash_by_query");
    expect(trashByQuery.description).toBe(
      "Bulk move to trash by Gmail query.",
    );
  });

  it("dry_run (default) returns preview without calling batchTrash", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const parsed = (trashByQuery.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof trashByQuery.handler>[0];
    }).parse({ account: "alice", q: "from:spam" });

    const result = await trashByQuery.handler(parsed, context);

    expect(client.batchTrash).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("confirm gate: preview includes 30-day auto-purge note", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );

    try {
      await trashByQuery.handler(
        {
          account: "alice",
          q: "from:spam",
          max: 100,
          dry_run: false,
          confirm: false,
        },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will move 2 messages to Trash for account alice; auto-purged in 30 days; reversible until then. Query: from:spam",
      );
    }
  });

  it("applied path: calls batchTrash and returns applied=true", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );
    client.batchTrash.mockResolvedValue(undefined);

    const result = await trashByQuery.handler(
      {
        account: "alice",
        q: "from:spam",
        max: 100,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.batchTrash).toHaveBeenCalledWith("alice", ["m1", "m2"]);
    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(true);
  });

  it("rejects SMTP transport", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();

    await expect(
      trashByQuery.handler(
        {
          account: "alice",
          q: "test",
          max: 100,
          dry_run: true,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("query passthrough", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await trashByQuery.handler(
      {
        account: "alice",
        q: "label:Trash-candidate",
        max: 100,
        dry_run: true,
        confirm: false,
      },
      context,
    );
    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "label:Trash-candidate",
      maxResults: 100,
    });
  });

  it("max cap: rejects max > 500 via zod", () => {
    expect(() =>
      (trashByQuery.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", q: "test", max: 1000 }),
    ).toThrow();
  });

  it("dry_run wins over confirm", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const result = await trashByQuery.handler(
      {
        account: "alice",
        q: "test",
        max: 100,
        dry_run: true,
        confirm: true,
      },
      context,
    );
    expect(client.batchTrash).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });
});

// ---------- apply_label_by_query ----------

describe("apply_label_by_query tool", () => {
  it("metadata: name and description", () => {
    expect(applyLabelByQuery.name).toBe("apply_label_by_query");
    expect(applyLabelByQuery.description).toBe(
      "Bulk apply or remove label by query.",
    );
  });

  it("dry_run (default) resolves label and returns preview without batchModify", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const parsed = (applyLabelByQuery.inputSchema as unknown as {
      parse: (i: unknown) => Parameters<typeof applyLabelByQuery.handler>[0];
    }).parse({
      account: "alice",
      q: "from:news",
      add_label: "Newsletters",
    });

    const result = await applyLabelByQuery.handler(parsed, context);

    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.matched).toBe(1);
  });

  it("confirm gate (add only): exact preview text", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    try {
      await applyLabelByQuery.handler(
        {
          account: "alice",
          q: "from:news",
          add_label: "Newsletters",
          max: 100,
          dry_run: false,
          confirm: false,
        },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will add label Newsletters on 1 messages for account alice. Query: from:news",
      );
    }
  });

  it("confirm gate (remove only): exact preview text", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_99", name: "Old", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t2" },
      ],
      resultSizeEstimate: 2,
    });
    client.getMessage.mockImplementation(async (_a, id: string) =>
      makeMessageRaw({ id }),
    );

    try {
      await applyLabelByQuery.handler(
        {
          account: "alice",
          q: "label:Old",
          remove_label: "Old",
          max: 100,
          dry_run: false,
          confirm: false,
        },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will remove label Old on 2 messages for account alice. Query: label:Old",
      );
    }
  });

  it("confirm gate (add + remove): exact preview text", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_A", name: "Newsletters", type: "user" },
      { id: "Label_B", name: "Old", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    try {
      await applyLabelByQuery.handler(
        {
          account: "alice",
          q: "from:foo",
          add_label: "Newsletters",
          remove_label: "Old",
          max: 100,
          dry_run: false,
          confirm: false,
        },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        "Will add label Newsletters and remove label Old on 1 messages for account alice. Query: from:foo",
      );
    }
  });

  it("applied path: passes resolved label IDs to batchModify", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_A", name: "Newsletters", type: "user" },
      { id: "Label_B", name: "Old", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));
    client.batchModify.mockResolvedValue(undefined);

    const result = await applyLabelByQuery.handler(
      {
        account: "alice",
        q: "test",
        add_label: "Newsletters",
        remove_label: "Old",
        max: 100,
        dry_run: false,
        confirm: true,
      },
      context,
    );

    expect(client.batchModify).toHaveBeenCalledWith("alice", {
      ids: ["m1"],
      addLabelIds: ["Label_A"],
      removeLabelIds: ["Label_B"],
    });
    expect(result.applied).toBe(true);
  });

  it("unknown label name → NotFoundError before any modify call", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);

    await expect(
      applyLabelByQuery.handler(
        {
          account: "alice",
          q: "test",
          add_label: "Nonexistent",
          max: 100,
          dry_run: true,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(client.listMessages).not.toHaveBeenCalled();
    expect(client.batchModify).not.toHaveBeenCalled();
  });

  it("rejects when neither add_label nor remove_label is provided", () => {
    expect(() =>
      (applyLabelByQuery.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", q: "test" }),
    ).toThrow();
  });

  it("rejects SMTP transport before any Gmail call", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);

    await expect(
      applyLabelByQuery.handler(
        {
          account: "alice",
          q: "test",
          add_label: "Newsletters",
          max: 100,
          dry_run: true,
          confirm: false,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.listLabels).not.toHaveBeenCalled();
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("query passthrough", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [],
      resultSizeEstimate: 0,
    });

    await applyLabelByQuery.handler(
      {
        account: "alice",
        q: "from:weekly@example.com",
        add_label: "Newsletters",
        max: 75,
        dry_run: true,
        confirm: false,
      },
      context,
    );
    expect(client.listMessages).toHaveBeenCalledWith("alice", {
      q: "from:weekly@example.com",
      maxResults: 75,
    });
  });

  it("max cap: rejects max > 500 via zod", () => {
    expect(() =>
      (applyLabelByQuery.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({
        account: "alice",
        q: "test",
        add_label: "X",
        max: 999,
      }),
    ).toThrow();
  });

  it("dry_run wins over confirm", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Newsletters", type: "user" },
    ]);
    client.listMessages.mockResolvedValue({
      messages: [{ id: "m1", threadId: "t1" }],
      resultSizeEstimate: 1,
    });
    client.getMessage.mockResolvedValue(makeMessageRaw({ id: "m1" }));

    const result = await applyLabelByQuery.handler(
      {
        account: "alice",
        q: "test",
        add_label: "Newsletters",
        max: 100,
        dry_run: true,
        confirm: true,
      },
      context,
    );
    expect(client.batchModify).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });
});

// ---------- shared: failed individual previews don't blow up call ----------

describe("modify tools — preview robustness", () => {
  it("mark_read_by_query: a failed preview fetch does not abort the dry_run call", async () => {
    const { context, client } = makeContext();
    client.listMessages.mockResolvedValue({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "missing", threadId: "t2" },
        { id: "m3", threadId: "t3" },
      ],
      resultSizeEstimate: 3,
    });
    client.getMessage.mockImplementation(async (_a, id: string) => {
      if (id === "missing") throw new NotFoundError("not found");
      return makeMessageRaw({ id });
    });

    const result = await markReadByQuery.handler(
      {
        account: "alice",
        q: "test",
        max: 100,
        dry_run: true,
        confirm: false,
      },
      context,
    );
    expect(result.matched).toBe(3);
    // Preview keeps the two that succeeded.
    expect(result.preview.length).toBe(2);
  });
});
