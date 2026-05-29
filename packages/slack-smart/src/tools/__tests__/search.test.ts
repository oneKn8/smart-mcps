import { describe, it, expect, vi, beforeEach } from "vitest";
import { search_messages, search_files } from "../search.js";

// ---------------------------------------------------------------------------
// Fake client factory
// ---------------------------------------------------------------------------

type FakeClient = {
  searchMessages: ReturnType<typeof vi.fn>;
  searchFiles: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    searchMessages: vi.fn(),
    searchFiles: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(tool: { inputSchema: { parse: (v: unknown) => T } }, raw: unknown): T {
  return tool.inputSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// search_messages
// ---------------------------------------------------------------------------

describe("search_messages — schema defaults", () => {
  it("defaults count=20, sort=score, sort_dir=desc, cursor=*", () => {
    const parsed = parse(search_messages, { query: "hello" }) as {
      count: number;
      sort: string;
      sort_dir: string;
      cursor: string;
    };
    expect(parsed.count).toBe(20);
    expect(parsed.sort).toBe("score");
    expect(parsed.sort_dir).toBe("desc");
    expect(parsed.cursor).toBe("*");
  });
});

describe("search_messages — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("passes query and defaults to searchMessages", async () => {
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: { matches: [], total: 0 },
      response_metadata: { next_cursor: "" },
    });
    const input = parse(search_messages, { query: "test" });
    await search_messages.handler(input, ctx(client));
    expect(client.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "test",
        count: 20,
        sort: "score",
        sort_dir: "desc",
        cursor: "*",
      }),
    );
  });

  it("maps matches to slim shape and strips extras", async () => {
    const rawMatch = {
      ts: "1234567890.000001",
      text: "hello world",
      user: "U001",
      username: "alice",
      channel: { id: "C001", name: "general" },
      permalink: "https://example.slack.com/archives/C001/p123",
      extra_field: "drop_me",
      attachments: [],
    };
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: { matches: [rawMatch], total: 1 },
      response_metadata: { next_cursor: "" },
    });
    const input = parse(search_messages, { query: "hello" });
    const result = (await search_messages.handler(input, ctx(client))) as {
      matches: Record<string, unknown>[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.matches).toHaveLength(1);
    const m = result.matches[0]!;
    expect(m.ts).toBe("1234567890.000001");
    expect(m.text).toBe("hello world");
    expect(m.user).toBe("U001");
    expect(m.username).toBe("alice");
    expect(m.channel_id).toBe("C001");
    expect(m.channel_name).toBe("general");
    expect(m.permalink).toBe("https://example.slack.com/archives/C001/p123");
    expect(m).not.toHaveProperty("extra_field");
    expect(m).not.toHaveProperty("attachments");
  });

  it("surfaces next_cursor only when non-empty", async () => {
    client.searchMessages.mockResolvedValueOnce({
      ok: true,
      messages: { matches: [], total: 0 },
      response_metadata: { next_cursor: "page2" },
    });
    const input = parse(search_messages, { query: "q" });
    const withCursor = (await search_messages.handler(input, ctx(client))) as Record<string, unknown>;
    expect(withCursor).toHaveProperty("next_cursor", "page2");

    client.searchMessages.mockResolvedValueOnce({
      ok: true,
      messages: { matches: [], total: 0 },
      response_metadata: { next_cursor: "" },
    });
    const withoutCursor = (await search_messages.handler(input, ctx(client))) as Record<string, unknown>;
    expect(withoutCursor).not.toHaveProperty("next_cursor");
  });

  it("omits optional match fields when absent", async () => {
    const minimalMatch = {
      ts: "1234567890.000002",
      text: "bare",
    };
    client.searchMessages.mockResolvedValue({
      ok: true,
      messages: { matches: [minimalMatch], total: 1 },
      response_metadata: { next_cursor: "" },
    });
    const input = parse(search_messages, { query: "bare" });
    const result = (await search_messages.handler(input, ctx(client))) as {
      matches: Record<string, unknown>[];
    };
    const m = result.matches[0]!;
    expect(m.ts).toBe("1234567890.000002");
    expect(m.text).toBe("bare");
    expect(m).not.toHaveProperty("user");
    expect(m).not.toHaveProperty("username");
    expect(m).not.toHaveProperty("channel_id");
    expect(m).not.toHaveProperty("channel_name");
    expect(m).not.toHaveProperty("permalink");
  });
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

describe("search_files — schema defaults", () => {
  it("defaults count=20, sort=score, sort_dir=desc, cursor=*", () => {
    const parsed = parse(search_files, { query: "doc" }) as {
      count: number;
      sort: string;
      sort_dir: string;
      cursor: string;
    };
    expect(parsed.count).toBe(20);
    expect(parsed.sort).toBe("score");
    expect(parsed.sort_dir).toBe("desc");
    expect(parsed.cursor).toBe("*");
  });
});

describe("search_files — handler", () => {
  let client: FakeClient;

  beforeEach(() => {
    client = makeClient();
  });

  it("maps files to slim shape and strips extras", async () => {
    const rawFile = {
      id: "F001",
      name: "report.pdf",
      title: "Q1 Report",
      filetype: "pdf",
      permalink: "https://example.slack.com/files/U001/F001/report.pdf",
      user: "U001",
      created: 1700000000,
      extra_field: "drop_me",
    };
    client.searchFiles.mockResolvedValue({
      ok: true,
      files: { matches: [rawFile], total: 1 },
      response_metadata: { next_cursor: "" },
    });
    const input = parse(search_files, { query: "report" });
    const result = (await search_files.handler(input, ctx(client))) as {
      files: Record<string, unknown>[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.files).toHaveLength(1);
    const f = result.files[0]!;
    expect(f.id).toBe("F001");
    expect(f.name).toBe("report.pdf");
    expect(f.title).toBe("Q1 Report");
    expect(f.filetype).toBe("pdf");
    expect(f.permalink).toContain("report.pdf");
    expect(f.user).toBe("U001");
    expect(f.created).toBe(1700000000);
    expect(f).not.toHaveProperty("extra_field");
  });

  it("surfaces next_cursor only when non-empty", async () => {
    client.searchFiles.mockResolvedValueOnce({
      ok: true,
      files: { matches: [], total: 0 },
      response_metadata: { next_cursor: "filepage2" },
    });
    const input = parse(search_files, { query: "q" });
    const withCursor = (await search_files.handler(input, ctx(client))) as Record<string, unknown>;
    expect(withCursor).toHaveProperty("next_cursor", "filepage2");

    client.searchFiles.mockResolvedValueOnce({
      ok: true,
      files: { matches: [], total: 0 },
      response_metadata: { next_cursor: "" },
    });
    const withoutCursor = (await search_files.handler(input, ctx(client))) as Record<string, unknown>;
    expect(withoutCursor).not.toHaveProperty("next_cursor");
  });

  it("omits optional file fields when absent", async () => {
    const minimalFile = { id: "F002" };
    client.searchFiles.mockResolvedValue({
      ok: true,
      files: { matches: [minimalFile], total: 1 },
      response_metadata: { next_cursor: "" },
    });
    const input = parse(search_files, { query: "bare" });
    const result = (await search_files.handler(input, ctx(client))) as {
      files: Record<string, unknown>[];
    };
    const f = result.files[0]!;
    expect(f.id).toBe("F002");
    expect(f).not.toHaveProperty("name");
    expect(f).not.toHaveProperty("title");
    expect(f).not.toHaveProperty("filetype");
    expect(f).not.toHaveProperty("permalink");
    expect(f).not.toHaveProperty("user");
    expect(f).not.toHaveProperty("created");
  });
});
