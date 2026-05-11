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
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
} from "../tools/labels.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";

function makeContext(): {
  context: EmailContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
} {
  const client = {
    listLabels: vi.fn(),
    getLabel: vi.fn(),
    createLabel: vi.fn(),
    updateLabel: vi.fn(),
    deleteLabel: vi.fn(),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    context: { client: client as unknown as EmailClient, home: tmpHome },
    client,
  };
}

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-labels-tool-test-"));
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

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  writeIdentity(tmpHome, "alice", aliceIdentity());
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

describe("create_label tool", () => {
  it("metadata: name and description", () => {
    expect(createLabel.name).toBe("create_label");
    expect(createLabel.description).toBe("Create a new user label.");
  });

  it("calls client.createLabel with name and returns slim label", async () => {
    const { context, client } = makeContext();
    client.createLabel.mockResolvedValue({
      id: "Label_99",
      name: "Critical",
      type: "user",
    });

    const result = await createLabel.handler(
      { account: "alice", name: "Critical" },
      context,
    );

    expect(client.createLabel).toHaveBeenCalledWith("alice", {
      name: "Critical",
    });
    expect(result).toEqual({
      id: "Label_99",
      name: "Critical",
      type: "user",
    });
  });

  it("passes visibility options through when provided", async () => {
    const { context, client } = makeContext();
    client.createLabel.mockResolvedValue({
      id: "Label_99",
      name: "Quiet",
      type: "user",
    });

    await createLabel.handler(
      {
        account: "alice",
        name: "Quiet",
        label_list_visibility: "labelHide",
        message_list_visibility: "hide",
      },
      context,
    );

    expect(client.createLabel).toHaveBeenCalledWith("alice", {
      name: "Quiet",
      labelListVisibility: "labelHide",
      messageListVisibility: "hide",
    });
  });

  it("rejects SMTP-transport accounts before any Gmail call", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();

    await expect(
      createLabel.handler({ account: "alice", name: "Critical" }, context),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.createLabel).not.toHaveBeenCalled();
  });

  it("rejects empty name via zod", () => {
    expect(() =>
      (createLabel.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", name: "" }),
    ).toThrow();
  });
});

describe("update_label tool", () => {
  it("metadata: name and description", () => {
    expect(updateLabel.name).toBe("update_label");
    expect(updateLabel.description).toBe(
      "Rename or change visibility of a user label.",
    );
  });

  it("resolves label name to id, then PATCHes with new_name", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Critical", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
    ]);
    client.updateLabel.mockResolvedValue({
      id: "Label_42",
      name: "Priority",
      type: "user",
    });

    const result = await updateLabel.handler(
      { account: "alice", label: "Critical", new_name: "Priority" },
      context,
    );

    expect(client.listLabels).toHaveBeenCalledWith("alice");
    expect(client.updateLabel).toHaveBeenCalledWith("alice", "Label_42", {
      name: "Priority",
    });
    expect(result).toEqual({
      id: "Label_42",
      name: "Priority",
      type: "user",
    });
  });

  it("accepts a label id directly as well", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Critical", type: "user" },
    ]);
    client.updateLabel.mockResolvedValue({
      id: "Label_42",
      name: "Critical",
      type: "user",
    });

    await updateLabel.handler(
      {
        account: "alice",
        label: "Label_42",
        label_list_visibility: "labelHide",
      },
      context,
    );

    expect(client.updateLabel).toHaveBeenCalledWith("alice", "Label_42", {
      labelListVisibility: "labelHide",
    });
  });

  it("refuses to update a system label", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
    ]);

    await expect(
      updateLabel.handler(
        { account: "alice", label: "INBOX", new_name: "Renamed" },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.updateLabel).not.toHaveBeenCalled();
  });

  it("NotFoundError when label does not exist", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([]);

    await expect(
      updateLabel.handler(
        { account: "alice", label: "Missing", new_name: "Whatever" },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(client.updateLabel).not.toHaveBeenCalled();
  });

  it("rejects when no patch field is provided", () => {
    expect(() =>
      (updateLabel.inputSchema as unknown as {
        parse: (i: unknown) => unknown;
      }).parse({ account: "alice", label: "Critical" }),
    ).toThrow();
  });

  it("rejects SMTP-transport accounts before any Gmail call", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();

    await expect(
      updateLabel.handler(
        { account: "alice", label: "Critical", new_name: "Priority" },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.listLabels).not.toHaveBeenCalled();
    expect(client.updateLabel).not.toHaveBeenCalled();
  });
});

describe("delete_label tool", () => {
  it("metadata: name and description", () => {
    expect(deleteLabel.name).toBe("delete_label");
    expect(deleteLabel.description).toBe("Permanently delete a user label.");
  });

  it("confirm gate: throws ConfirmRequiredError with preview when confirm=false", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Critical", type: "user" },
    ]);

    try {
      await deleteLabel.handler(
        { account: "alice", label: "Critical", confirm: false },
        context,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      const preview = (err as ConfirmRequiredError).preview;
      expect(preview).toContain('label "Critical"');
      expect(preview).toContain("Label_42");
      expect(preview).toContain("alice");
    }
    expect(client.deleteLabel).not.toHaveBeenCalled();
  });

  it("applied path: confirm=true calls client.deleteLabel and returns deleted=true", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "Label_42", name: "Critical", type: "user" },
    ]);
    client.deleteLabel.mockResolvedValue(undefined);

    const result = await deleteLabel.handler(
      { account: "alice", label: "Critical", confirm: true },
      context,
    );

    expect(client.deleteLabel).toHaveBeenCalledWith("alice", "Label_42");
    expect(result).toEqual({
      id: "Label_42",
      name: "Critical",
      deleted: true,
    });
  });

  it("refuses to delete a system label", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", type: "system" },
    ]);

    await expect(
      deleteLabel.handler(
        { account: "alice", label: "INBOX", confirm: true },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.deleteLabel).not.toHaveBeenCalled();
  });

  it("NotFoundError when label does not exist", async () => {
    const { context, client } = makeContext();
    client.listLabels.mockResolvedValue([]);

    await expect(
      deleteLabel.handler(
        { account: "alice", label: "Missing", confirm: true },
        context,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(client.deleteLabel).not.toHaveBeenCalled();
  });

  it("rejects SMTP-transport accounts before any Gmail call", async () => {
    writeIdentity(tmpHome, "alice", aliceSmtpIdentity());
    const { context, client } = makeContext();

    await expect(
      deleteLabel.handler(
        { account: "alice", label: "Critical", confirm: true },
        context,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.listLabels).not.toHaveBeenCalled();
    expect(client.deleteLabel).not.toHaveBeenCalled();
  });
});
