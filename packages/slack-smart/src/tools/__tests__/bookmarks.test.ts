import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmRequiredError } from "smart-mcp-core";
import {
  list_bookmarks,
  add_bookmark,
  edit_bookmark,
  remove_bookmark,
} from "../bookmarks.js";

type FakeClient = {
  listBookmarks: ReturnType<typeof vi.fn>;
  addBookmark: ReturnType<typeof vi.fn>;
  editBookmark: ReturnType<typeof vi.fn>;
  removeBookmark: ReturnType<typeof vi.fn>;
};

function makeClient(): FakeClient {
  return {
    listBookmarks: vi.fn(),
    addBookmark: vi.fn(),
    editBookmark: vi.fn(),
    removeBookmark: vi.fn(),
  };
}

function ctx(client: FakeClient) {
  return { client: client as unknown as never };
}

function parse<T>(
  tool: { inputSchema: { parse: (v: unknown) => T } },
  raw: unknown,
): T {
  return tool.inputSchema.parse(raw);
}

describe("list_bookmarks", () => {
  it("slims bookmarks and drops upstream extras", async () => {
    const client = makeClient();
    client.listBookmarks.mockResolvedValue({
      ok: true,
      bookmarks: [
        {
          id: "Bk1",
          title: "Docs",
          link: "https://example.com",
          emoji: ":book:",
          type: "link",
          channel_id: "C001",
          extra: "drop",
        },
      ],
    });
    const result = (await list_bookmarks.handler(
      parse(list_bookmarks, { channel_id: "C001" }),
      ctx(client),
    )) as { bookmarks: Array<Record<string, unknown>>; count: number };
    expect(client.listBookmarks).toHaveBeenCalledWith({ channel_id: "C001" });
    expect(result.count).toBe(1);
    expect(result.bookmarks[0]).toEqual({
      id: "Bk1",
      title: "Docs",
      link: "https://example.com",
      emoji: ":book:",
      type: "link",
      channel_id: "C001",
    });
    expect(result.bookmarks[0]).not.toHaveProperty("extra");
  });
});

describe("add_bookmark", () => {
  it("throws ConfirmRequiredError without confirm", async () => {
    const client = makeClient();
    await expect(
      add_bookmark.handler(
        parse(add_bookmark, { channel_id: "C001", title: "Docs", link: "https://x.com" }),
        ctx(client),
      ),
    ).rejects.toThrow(ConfirmRequiredError);
    expect(client.addBookmark).not.toHaveBeenCalled();
  });

  it("adds with default type 'link' and confirm:true", async () => {
    const client = makeClient();
    client.addBookmark.mockResolvedValue({
      ok: true,
      bookmark: { id: "Bk9", title: "Docs", link: "https://x.com", type: "link" },
    });
    const result = (await add_bookmark.handler(
      parse(add_bookmark, {
        channel_id: "C001",
        title: "Docs",
        link: "https://x.com",
        confirm: true,
      }),
      ctx(client),
    )) as { ok: boolean; bookmark: Record<string, unknown> };
    expect(client.addBookmark).toHaveBeenCalledWith({
      channel_id: "C001",
      title: "Docs",
      type: "link",
      link: "https://x.com",
    });
    expect(result.ok).toBe(true);
    expect(result.bookmark.id).toBe("Bk9");
  });
});

describe("edit_bookmark", () => {
  it("throws ConfirmRequiredError without confirm", async () => {
    const client = makeClient();
    await expect(
      edit_bookmark.handler(
        parse(edit_bookmark, { channel_id: "C001", bookmark_id: "Bk1", title: "New" }),
        ctx(client),
      ),
    ).rejects.toThrow(ConfirmRequiredError);
    expect(client.editBookmark).not.toHaveBeenCalled();
  });

  it("edits with confirm:true", async () => {
    const client = makeClient();
    client.editBookmark.mockResolvedValue({
      ok: true,
      bookmark: { id: "Bk1", title: "New" },
    });
    await edit_bookmark.handler(
      parse(edit_bookmark, {
        channel_id: "C001",
        bookmark_id: "Bk1",
        title: "New",
        confirm: true,
      }),
      ctx(client),
    );
    expect(client.editBookmark).toHaveBeenCalledWith({
      channel_id: "C001",
      bookmark_id: "Bk1",
      title: "New",
    });
  });
});

describe("remove_bookmark", () => {
  it("throws ConfirmRequiredError without confirm", async () => {
    const client = makeClient();
    await expect(
      remove_bookmark.handler(
        parse(remove_bookmark, { channel_id: "C001", bookmark_id: "Bk1" }),
        ctx(client),
      ),
    ).rejects.toThrow(ConfirmRequiredError);
    expect(client.removeBookmark).not.toHaveBeenCalled();
  });

  it("removes with confirm:true", async () => {
    const client = makeClient();
    client.removeBookmark.mockResolvedValue({ ok: true });
    const result = (await remove_bookmark.handler(
      parse(remove_bookmark, {
        channel_id: "C001",
        bookmark_id: "Bk1",
        confirm: true,
      }),
      ctx(client),
    )) as { ok: boolean; bookmark_id: string };
    expect(client.removeBookmark).toHaveBeenCalledWith({
      channel_id: "C001",
      bookmark_id: "Bk1",
    });
    expect(result).toEqual({ ok: true, bookmark_id: "Bk1" });
  });
});
