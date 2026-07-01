import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NotFoundError,
  ValidationError,
  ConfirmRequiredError,
} from "smart-mcp-core";
import { createFilter, listFilters, deleteFilter } from "../tools/filters.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listLabels: vi.fn(),
    createFilter: vi.fn(),
    listFilters: vi.fn(),
    deleteFilter: vi.fn(),
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "santo-filters-tool-test-"));
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

describe("create_filter tool", () => {
  it("resolves label NAMES to ids and passes system ids through (Critical / INBOX)", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_7", name: "Critical", type: "user" },
    ]);
    client.createFilter.mockImplementation(async (_a, opts) => ({
      id: "F_new",
      criteria: opts.criteria,
      action: opts.action,
    }));

    const result = await createFilter.handler(
      {
        account: "alice",
        criteria: { from: "boss@corp.com" },
        action: { add_label_ids: ["Critical"], remove_label_ids: ["INBOX"] },
      },
      context,
    );

    // The client is called with resolved ids: "Critical" -> "Label_7",
    // "INBOX" stays "INBOX".
    expect(client.createFilter).toHaveBeenCalledWith("alice", {
      criteria: { from: "boss@corp.com" },
      action: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] },
    });
    expect(result).toEqual({
      id: "F_new",
      criteria: { from: "boss@corp.com" },
      action: { add_label_ids: ["Label_7"], remove_label_ids: ["INBOX"] },
    });
  });

  it("accepts label ids directly (passes through unchanged)", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_7", name: "Critical", type: "user" },
    ]);
    client.createFilter.mockImplementation(async (_a, opts) => ({
      id: "F_x",
      criteria: opts.criteria,
      action: opts.action,
    }));

    await createFilter.handler(
      {
        account: "alice",
        criteria: { subject: "invoice" },
        action: { add_label_ids: ["Label_7"] },
      },
      context,
    );

    expect(client.createFilter).toHaveBeenCalledWith("alice", {
      criteria: { subject: "invoice" },
      action: { addLabelIds: ["Label_7"] },
    });
  });

  it("maps all criteria fields to camelCase for the client (forward gated, confirm:true)", async () => {
    const { context, client } = makeContext();
    client.createFilter.mockImplementation(async (_a, opts) => ({
      id: "F_c",
      criteria: opts.criteria,
      action: opts.action,
    }));

    await createFilter.handler(
      {
        account: "alice",
        criteria: {
          from: "a@b.com",
          to: "me@x.com",
          subject: "hi",
          query: "has:attachment",
          negated_query: "unsubscribe",
          has_attachment: true,
          exclude_chats: true,
          size: 1000000,
          size_comparison: "larger",
        },
        action: { forward: "dest@x.com" },
        confirm: true,
      },
      context,
    );

    expect(client.createFilter).toHaveBeenCalledWith("alice", {
      criteria: {
        from: "a@b.com",
        to: "me@x.com",
        subject: "hi",
        query: "has:attachment",
        negatedQuery: "unsubscribe",
        hasAttachment: true,
        excludeChats: true,
        size: 1000000,
        sizeComparison: "larger",
      },
      action: { forward: "dest@x.com" },
    });
    // forward-only action does not fetch labels.
    expect(client.listLabels).not.toHaveBeenCalled();
  });

  it("gates a forward filter: ConfirmRequiredError without confirm", async () => {
    const { context, client } = makeContext();
    await expect(
      createFilter.handler(
        {
          account: "alice",
          criteria: { from: "a@b.com" },
          action: { forward: "attacker@evil.com" },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);
    // No filter is created and no labels are fetched before the gate.
    expect(client.createFilter).not.toHaveBeenCalled();
    expect(client.listLabels).not.toHaveBeenCalled();
  });

  it("surfaces the forward destination in the confirm preview", async () => {
    const { context } = makeContext();
    await expect(
      createFilter.handler(
        {
          account: "alice",
          criteria: { from: "a@b.com" },
          action: { forward: "attacker@evil.com" },
        },
        context,
      ),
    ).rejects.toMatchObject({
      preview: expect.stringContaining("attacker@evil.com"),
    });
  });

  it("does NOT gate a label-only filter (no confirm needed)", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_7", name: "Critical", type: "user" },
    ]);
    client.createFilter.mockImplementation(async (_a, opts) => ({
      id: "F_lbl",
      criteria: opts.criteria,
      action: opts.action,
    }));
    await createFilter.handler(
      {
        account: "alice",
        criteria: { from: "a@b.com" },
        action: { add_label_ids: ["Critical"] },
      },
      context,
    );
    expect(client.createFilter).toHaveBeenCalledWith("alice", {
      criteria: { from: "a@b.com" },
      action: { addLabelIds: ["Label_7"] },
    });
  });

  it("throws on an ambiguous token that is both a label name and another label's id", async () => {
    const { context, client } = makeContext();
    // "Work" is the NAME of Label_7 and also the ID of a different label.
    client.listLabels.mockResolvedValue([
      { id: "Label_7", name: "Work", type: "user" },
      { id: "Work", name: "Personal", type: "user" },
    ]);
    await expect(
      createFilter.handler(
        {
          account: "alice",
          criteria: { from: "a@b.com" },
          action: { add_label_ids: ["Work"] },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.createFilter).not.toHaveBeenCalled();
  });

  it("throws on a duplicate label name rather than silently picking one", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_1", name: "Finance", type: "user" },
      { id: "Label_2", name: "Finance", type: "user" },
    ]);
    await expect(
      createFilter.handler(
        {
          account: "alice",
          criteria: { from: "a@b.com" },
          action: { add_label_ids: ["Finance"] },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.createFilter).not.toHaveBeenCalled();
  });

  it("resolves NAME-first: a token matching a name maps to that label's id", async () => {
    const { context, client } = makeContext();
    // Token "Archive" is a NAME here; name-first must win and map to Label_9.
    client.listLabels.mockResolvedValue([
      { id: "Label_9", name: "Archive", type: "user" },
    ]);
    client.createFilter.mockImplementation(async (_a, opts) => ({
      id: "F_nf",
      criteria: opts.criteria,
      action: opts.action,
    }));
    await createFilter.handler(
      {
        account: "alice",
        criteria: { from: "a@b.com" },
        action: { add_label_ids: ["Archive"] },
      },
      context,
    );
    expect(client.createFilter).toHaveBeenCalledWith("alice", {
      criteria: { from: "a@b.com" },
      action: { addLabelIds: ["Label_9"] },
    });
  });

  it("throws NotFoundError for an unknown label name", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
    ]);
    await expect(
      createFilter.handler(
        {
          account: "alice",
          criteria: { from: "a@b.com" },
          action: { add_label_ids: ["Nonexistent"] },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(client.createFilter).not.toHaveBeenCalled();
  });

  it("rejects an smtp identity", async () => {
    writeIdentity("smtpy", "smtp");
    const { context, client } = makeContext();
    await expect(
      createFilter.handler(
        {
          account: "smtpy",
          criteria: { from: "a@b.com" },
          action: { add_label_ids: ["INBOX"] },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.createFilter).not.toHaveBeenCalled();
  });
});

describe("list_filters tool", () => {
  it("slims each raw filter and counts them", async () => {
    const { context, client } = makeContext();
    client.listFilters.mockResolvedValue([
      {
        id: "F_1",
        criteria: { from: "a@b.com", surprise: 1 },
        action: { addLabelIds: ["Label_1"] },
      },
      { id: "F_2", criteria: {}, action: { removeLabelIds: ["INBOX"] } },
    ]);

    const result = await listFilters.handler({ account: "alice" }, context);
    expect(client.listFilters).toHaveBeenCalledWith("alice");
    expect(result).toEqual({
      count: 2,
      filters: [
        {
          id: "F_1",
          criteria: { from: "a@b.com" },
          action: { add_label_ids: ["Label_1"] },
        },
        { id: "F_2", criteria: {}, action: { remove_label_ids: ["INBOX"] } },
      ],
    });
  });
});

describe("delete_filter tool", () => {
  it("deletes by id and reports deleted", async () => {
    const { context, client } = makeContext();
    client.deleteFilter.mockResolvedValue(undefined);
    const result = await deleteFilter.handler(
      { account: "alice", filter_id: "F_9" },
      context,
    );
    expect(client.deleteFilter).toHaveBeenCalledWith("alice", "F_9");
    expect(result).toEqual({ id: "F_9", deleted: true });
  });
});
