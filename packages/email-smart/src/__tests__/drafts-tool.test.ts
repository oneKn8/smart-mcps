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
} from "smart-mcp-core";
import {
  createDraft,
  listDrafts,
  sendDraft,
  updateDraft,
  deleteDraft,
} from "../tools/drafts.js";
import type { EmailClient } from "../client.js";
import type { EmailContext } from "../context.js";
import * as auditModule from "../audit.js";

let savedHome: string | undefined;
let tmpHome: string;

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "santo-drafts-tool-test-"));
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

function smtpIdentity(account: string): string {
  return [
    `account: ${account}`,
    `email: ${account}@example.com`,
    `display_name: ${account.toUpperCase()}`,
    "transport: smtp",
  ].join("\n");
}

function auditPath(home: string): string {
  return path.join(home, ".santo-agent", "audit", "send-log.jsonl");
}

type DraftRefResp = { id: string; messageId: string; threadId: string };

type FakeClient = {
  client: EmailClient;
  createDraftMock: ReturnType<typeof vi.fn>;
  listDraftsMock: ReturnType<typeof vi.fn>;
  getDraftMock: ReturnType<typeof vi.fn>;
  updateDraftMock: ReturnType<typeof vi.fn>;
  sendDraftMock: ReturnType<typeof vi.fn>;
  deleteDraftMock: ReturnType<typeof vi.fn>;
};

function makeFakeClient(overrides: {
  createDraft?: (account: string, raw: string) => Promise<DraftRefResp>;
  listDrafts?: (
    account: string,
    opts: { q?: string; maxResults?: number; pageToken?: string },
  ) => Promise<{
    drafts: DraftRefResp[];
    nextPageToken?: string;
    resultSizeEstimate: number;
  }>;
  getDraft?: (account: string, id: string, format: string) => Promise<unknown>;
  updateDraft?: (
    account: string,
    id: string,
    raw: string,
  ) => Promise<DraftRefResp>;
  sendDraft?: (
    account: string,
    id: string,
  ) => Promise<{ id: string; threadId: string; labelIds: string[] }>;
  deleteDraft?: (account: string, id: string) => Promise<void>;
} = {}): FakeClient {
  const createDraftMock = vi.fn(
    overrides.createDraft ??
      (async () => ({
        id: "draft_abc",
        messageId: "msg_xyz",
        threadId: "thr_111",
      })),
  );
  const listDraftsMock = vi.fn(
    overrides.listDrafts ??
      (async () => ({
        drafts: [],
        resultSizeEstimate: 0,
      })),
  );
  const getDraftMock = vi.fn(
    overrides.getDraft ??
      (async () => ({
        id: "draft_abc",
        message: {
          id: "msg_xyz",
          threadId: "thr_111",
          labelIds: ["DRAFT"],
          snippet: "hello",
          sizeEstimate: 1024,
          payload: {
            headers: [
              { name: "From", value: "Alice Example <alice@example.com>" },
              { name: "To", value: "bob@example.com" },
              { name: "Subject", value: "Hello" },
              { name: "Date", value: "Tue, 28 Apr 2026 12:00:00 GMT" },
            ],
          },
        },
      })),
  );
  const updateDraftMock = vi.fn(
    overrides.updateDraft ??
      (async () => ({
        id: "draft_abc",
        messageId: "msg_new",
        threadId: "thr_111",
      })),
  );
  const sendDraftMock = vi.fn(
    overrides.sendDraft ??
      (async () => ({
        id: "msg_sent_999",
        threadId: "thr_111",
        labelIds: ["SENT"],
      })),
  );
  const deleteDraftMock = vi.fn(overrides.deleteDraft ?? (async () => {}));

  const client = {
    createDraft: createDraftMock,
    listDrafts: listDraftsMock,
    getDraft: getDraftMock,
    updateDraft: updateDraftMock,
    sendDraft: sendDraftMock,
    deleteDraft: deleteDraftMock,
  } as unknown as EmailClient;

  return {
    client,
    createDraftMock,
    listDraftsMock,
    getDraftMock,
    updateDraftMock,
    sendDraftMock,
    deleteDraftMock,
  };
}

function buildContext(client: EmailClient, home: string): EmailContext {
  return { client, home } as unknown as EmailContext;
}

beforeEach(() => {
  savedHome = process.env.HOME;
  tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
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

// ---------- create_draft ----------

describe("create_draft — metadata", () => {
  it("has expected name and description", () => {
    expect(createDraft.name).toBe("create_draft");
    expect(createDraft.description).toBe(
      "Create a Gmail draft (does not send).",
    );
  });
});

describe("create_draft — happy path", () => {
  it("calls client.createDraft with base64url RAW MIME and returns slim shape", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    const result = await createDraft.handler(
      createDraft.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
      }) as never,
      ctx as never,
    );

    expect(fake.createDraftMock).toHaveBeenCalledTimes(1);
    const [account, raw] = fake.createDraftMock.mock.calls[0] as [
      string,
      string,
    ];
    expect(account).toBe("alice");
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("From: Alice Example <alice@example.com>");
    expect(decoded).toContain("To: bob@example.com");
    expect(decoded).toContain("Subject: Hello");

    expect(result).toEqual({
      draft_id: "draft_abc",
      message_id: "msg_xyz",
      thread_id: "thr_111",
      from: "Alice Example <alice@example.com>",
      to: "bob@example.com",
      subject: "Hello",
      created_at: "2026-04-28T12:00:00.000Z",
    });
  });

  it("does NOT append an audit log entry (drafts don't actually send)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await createDraft.handler(
      createDraft.inputSchema.parse({
        account: "alice",
        to: "bob@example.com",
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
      }) as never,
      ctx as never,
    );

    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });
});

describe("create_draft — transport gate", () => {
  it("rejects accounts with transport=smtp before any side effect", async () => {
    writeIdentity(tmpHome, "utd", smtpIdentity("utd"));
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      createDraft.handler(
        createDraft.inputSchema.parse({
          account: "utd",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>Hi</p>",
          text: "Hi",
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(fake.createDraftMock).not.toHaveBeenCalled();
  });
});

// ---------- list_drafts ----------

describe("list_drafts — metadata", () => {
  it("has expected name and description", () => {
    expect(listDrafts.name).toBe("list_drafts");
    expect(listDrafts.description).toBe("List Gmail drafts (slim shape).");
  });
});

describe("list_drafts — happy path", () => {
  it("maps each draft via getDraft+metadata and returns slim shape with count and pagination", async () => {
    const draftRefs: DraftRefResp[] = [
      { id: "d1", messageId: "m1", threadId: "t1" },
      { id: "d2", messageId: "m2", threadId: "t2" },
    ];
    let getDraftCalls: Array<{ id: string; format: string }> = [];
    const fake = makeFakeClient({
      listDrafts: async (_account, _opts) => ({
        drafts: draftRefs,
        nextPageToken: "next_xyz",
        resultSizeEstimate: 2,
      }),
      getDraft: async (_account, id, format) => {
        getDraftCalls.push({ id, format });
        return {
          id,
          message: {
            id: id === "d1" ? "m1" : "m2",
            threadId: id === "d1" ? "t1" : "t2",
            labelIds: ["DRAFT"],
            snippet: `snippet ${id}`,
            sizeEstimate: 100,
            payload: {
              headers: [
                { name: "From", value: "Alice Example <alice@example.com>" },
                { name: "To", value: "bob@example.com" },
                { name: "Subject", value: `Subject ${id}` },
                { name: "Date", value: "Tue, 28 Apr 2026 12:00:00 GMT" },
              ],
            },
          },
        };
      },
    });
    const ctx = buildContext(fake.client, tmpHome);

    const result = await listDrafts.handler(
      listDrafts.inputSchema.parse({
        account: "alice",
        max_results: 25,
        q: "subject:Subject",
        page_token: "cursor_abc",
      }) as never,
      ctx as never,
    );

    expect(fake.listDraftsMock).toHaveBeenCalledTimes(1);
    expect(fake.listDraftsMock.mock.calls[0]).toEqual([
      "alice",
      { maxResults: 25, q: "subject:Subject", pageToken: "cursor_abc" },
    ]);
    expect(getDraftCalls).toEqual([
      { id: "d1", format: "metadata" },
      { id: "d2", format: "metadata" },
    ]);
    expect(result.count).toBe(2);
    expect(result.next_page_token).toBe("next_xyz");
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]).toEqual({
      draft_id: "d1",
      message_id: "m1",
      thread_id: "t1",
      from: "Alice Example <alice@example.com>",
      to: "bob@example.com",
      subject: "Subject d1",
      snippet: "snippet d1",
      date: "Tue, 28 Apr 2026 12:00:00 GMT",
      labels: ["DRAFT"],
      size_bytes: 100,
    });
  });

  it("returns empty array with count: 0 when no drafts match", async () => {
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    const result = await listDrafts.handler(
      listDrafts.inputSchema.parse({
        account: "alice",
      }) as never,
      ctx as never,
    );

    expect(result.drafts).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.next_page_token).toBeUndefined();
  });

  it("omits next_page_token when upstream did not return one", async () => {
    const fake = makeFakeClient({
      listDrafts: async () => ({
        drafts: [{ id: "d1", messageId: "m1", threadId: "t1" }],
        resultSizeEstimate: 1,
      }),
    });
    const ctx = buildContext(fake.client, tmpHome);

    const result = await listDrafts.handler(
      listDrafts.inputSchema.parse({
        account: "alice",
      }) as never,
      ctx as never,
    );

    expect(result.count).toBe(1);
    expect("next_page_token" in result).toBe(false);
  });
});

// ---------- send_draft ----------

describe("send_draft — metadata", () => {
  it("has expected name and description", () => {
    expect(sendDraft.name).toBe("send_draft");
    expect(sendDraft.description).toBe(
      "Send an existing Gmail draft by ID.",
    );
  });
});

describe("send_draft — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is omitted; never calls sendDraft; never writes audit", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      sendDraft.handler(
        sendDraft.inputSchema.parse({
          account: "alice",
          draft_id: "draft_abc",
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(fake.sendDraftMock).not.toHaveBeenCalled();
    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });

  it("preview text uses exact format with draft id, sender, subject, and recipient", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    try {
      await sendDraft.handler(
        sendDraft.inputSchema.parse({
          account: "alice",
          draft_id: "draft_abc",
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        'Will SEND draft draft_abc from Alice Example <alice@example.com>: "Hello" → bob@example.com',
      );
    }
  });
});

describe("send_draft — happy path", () => {
  it("calls client.sendDraft and appends audit log entry on success", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient({
      getDraft: async () => ({
        id: "draft_abc",
        message: {
          id: "msg_xyz",
          threadId: "thr_111",
          payload: {
            headers: [
              { name: "From", value: "Alice Example <alice@example.com>" },
              { name: "To", value: "bob@example.com" },
              { name: "Cc", value: "carol@example.com" },
              { name: "Subject", value: "Sync" },
            ],
          },
        },
      }),
    });
    const ctx = buildContext(fake.client, tmpHome);

    const result = await sendDraft.handler(
      sendDraft.inputSchema.parse({
        account: "alice",
        draft_id: "draft_abc",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(fake.sendDraftMock).toHaveBeenCalledTimes(1);
    expect(fake.sendDraftMock.mock.calls[0]).toEqual(["alice", "draft_abc"]);

    expect(result).toEqual({
      gmail_id: "msg_sent_999",
      thread_id: "thr_111",
      from: "Alice Example <alice@example.com>",
      to: "bob@example.com",
      subject: "Sync",
      sent_at: "2026-04-28T12:00:00.000Z",
    });

    const lines = fs
      .readFileSync(auditPath(tmpHome), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toEqual({
      ts: result.sent_at,
      account: "alice",
      to: "bob@example.com",
      cc: "carol@example.com",
      bcc: "",
      subject: "Sync",
      gmail_id: "msg_sent_999",
      gmail_thread_id: "thr_111",
    });
  });

  it("returns audit_warning when audit append fails (soft-fail wrap)", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    const appendSpy = vi
      .spyOn(auditModule, "appendAudit")
      .mockImplementation(() => {
        throw new Error("ENOSPC: disk full");
      });

    try {
      const result = await sendDraft.handler(
        sendDraft.inputSchema.parse({
          account: "alice",
          draft_id: "draft_abc",
          confirm: true,
        }) as never,
        ctx as never,
      );

      expect(result.gmail_id).toBe("msg_sent_999");
      expect((result as { audit_warning?: string }).audit_warning).toEqual(
        expect.stringContaining("audit append failed"),
      );
      expect((result as { audit_warning?: string }).audit_warning).toEqual(
        expect.stringContaining("ENOSPC"),
      );
    } finally {
      appendSpy.mockRestore();
    }
  });
});

describe("send_draft — error paths", () => {
  it("propagates NotFoundError when draft does not exist", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient({
      getDraft: async (_a, id) => {
        throw new NotFoundError(`draft not found: ${id}`);
      },
    });
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      sendDraft.handler(
        sendDraft.inputSchema.parse({
          account: "alice",
          draft_id: "missing_draft",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(fake.sendDraftMock).not.toHaveBeenCalled();
  });

  it("rejects accounts with transport=smtp before any side effect", async () => {
    writeIdentity(tmpHome, "utd", smtpIdentity("utd"));
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      sendDraft.handler(
        sendDraft.inputSchema.parse({
          account: "utd",
          draft_id: "draft_abc",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(fake.sendDraftMock).not.toHaveBeenCalled();
    expect(fake.getDraftMock).not.toHaveBeenCalled();
  });
});

// ---------- update_draft ----------

describe("update_draft — metadata", () => {
  it("has expected name and description", () => {
    expect(updateDraft.name).toBe("update_draft");
    expect(updateDraft.description).toBe(
      "Update an existing Gmail draft.",
    );
  });
});

describe("update_draft — happy path", () => {
  it("calls client.updateDraft with draft_id + new RAW MIME and returns slim shape", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    const result = await updateDraft.handler(
      updateDraft.inputSchema.parse({
        account: "alice",
        draft_id: "draft_abc",
        to: "bob@example.com",
        subject: "Updated subject",
        html: "<p>Updated</p>",
        text: "Updated",
      }) as never,
      ctx as never,
    );

    expect(fake.updateDraftMock).toHaveBeenCalledTimes(1);
    const [account, id, raw] = fake.updateDraftMock.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(account).toBe("alice");
    expect(id).toBe("draft_abc");
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    expect(decoded).toContain("Subject: Updated subject");
    expect(decoded).toContain("To: bob@example.com");

    expect(result).toEqual({
      draft_id: "draft_abc",
      message_id: "msg_new",
      thread_id: "thr_111",
      from: "Alice Example <alice@example.com>",
      to: "bob@example.com",
      subject: "Updated subject",
      updated_at: "2026-04-28T12:00:00.000Z",
    });
  });

  it("does NOT append an audit log entry", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await updateDraft.handler(
      updateDraft.inputSchema.parse({
        account: "alice",
        draft_id: "draft_abc",
        to: "bob@example.com",
        subject: "Updated",
        html: "<p>x</p>",
        text: "x",
      }) as never,
      ctx as never,
    );

    expect(fs.existsSync(auditPath(tmpHome))).toBe(false);
  });
});

describe("update_draft — transport gate", () => {
  it("rejects accounts with transport=smtp before any side effect", async () => {
    writeIdentity(tmpHome, "utd", smtpIdentity("utd"));
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      updateDraft.handler(
        updateDraft.inputSchema.parse({
          account: "utd",
          draft_id: "draft_abc",
          to: "bob@example.com",
          subject: "Hi",
          html: "<p>x</p>",
          text: "x",
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(fake.updateDraftMock).not.toHaveBeenCalled();
  });
});

// ---------- delete_draft ----------

describe("delete_draft — metadata", () => {
  it("has expected name and description", () => {
    expect(deleteDraft.name).toBe("delete_draft");
    expect(deleteDraft.description).toBe(
      "Permanently delete a Gmail draft (not recoverable).",
    );
  });
});

describe("delete_draft — confirm gate", () => {
  it("throws ConfirmRequiredError when confirm is omitted; never calls deleteDraft", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      deleteDraft.handler(
        deleteDraft.inputSchema.parse({
          account: "alice",
          draft_id: "draft_abc",
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ConfirmRequiredError);

    expect(fake.deleteDraftMock).not.toHaveBeenCalled();
  });

  it("preview text uses exact format emphasizing permanent + not recoverable", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    try {
      await deleteDraft.handler(
        deleteDraft.inputSchema.parse({
          account: "alice",
          draft_id: "draft_abc",
        }) as never,
        ctx as never,
      );
      throw new Error("expected ConfirmRequiredError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfirmRequiredError);
      expect((err as ConfirmRequiredError).preview).toBe(
        'Will PERMANENTLY DELETE draft draft_abc (not recoverable from Trash). Subject: "Hello"',
      );
    }
  });
});

describe("delete_draft — happy path", () => {
  it("calls client.deleteDraft and returns deleted: true", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    const result = await deleteDraft.handler(
      deleteDraft.inputSchema.parse({
        account: "alice",
        draft_id: "draft_abc",
        confirm: true,
      }) as never,
      ctx as never,
    );

    expect(fake.deleteDraftMock).toHaveBeenCalledTimes(1);
    expect(fake.deleteDraftMock.mock.calls[0]).toEqual(["alice", "draft_abc"]);
    expect(result).toEqual({
      draft_id: "draft_abc",
      deleted: true,
    });
  });
});

describe("delete_draft — error paths", () => {
  it("propagates NotFoundError when draft does not exist", async () => {
    writeIdentity(tmpHome, "alice", aliceIdentity());
    const fake = makeFakeClient({
      getDraft: async (_a, id) => {
        throw new NotFoundError(`draft not found: ${id}`);
      },
    });
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      deleteDraft.handler(
        deleteDraft.inputSchema.parse({
          account: "alice",
          draft_id: "missing_draft",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(fake.deleteDraftMock).not.toHaveBeenCalled();
  });

  it("rejects accounts with transport=smtp before any side effect", async () => {
    writeIdentity(tmpHome, "utd", smtpIdentity("utd"));
    const fake = makeFakeClient();
    const ctx = buildContext(fake.client, tmpHome);

    await expect(
      deleteDraft.handler(
        deleteDraft.inputSchema.parse({
          account: "utd",
          draft_id: "draft_abc",
          confirm: true,
        }) as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringMatching(/smtp.*oauth only/s),
    });

    expect(fake.deleteDraftMock).not.toHaveBeenCalled();
    expect(fake.getDraftMock).not.toHaveBeenCalled();
  });
});
