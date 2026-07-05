import { describe, it, expect, vi } from "vitest";
import { collectPaged } from "../pagination.js";

describe("collectPaged", () => {
  it("returns a single page when there is no next cursor", async () => {
    const fetchPage = vi.fn(async () => ({ items: [1, 2, 3] as number[] }));
    const { items, capped } = await collectPaged(fetchPage);
    expect(items).toEqual([1, 2, 3]);
    expect(capped).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    // first call gets undefined cursor
    expect(fetchPage.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("follows the cursor across pages and concatenates", async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      __start: { items: [1, 2], nextCursor: "c2" },
      c2: { items: [3, 4], nextCursor: "c3" },
      c3: { items: [5] },
    };
    const seen: (string | undefined)[] = [];
    const fetchPage = async (cursor?: string) => {
      seen.push(cursor);
      return pages[cursor ?? "__start"]!;
    };
    const { items, capped } = await collectPaged(fetchPage);
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(capped).toBe(false);
    expect(seen).toEqual([undefined, "c2", "c3"]);
  });

  it("stops at the page budget and reports capped when a cursor remains", async () => {
    // Always returns a next cursor -> would loop forever without the budget.
    const fetchPage = async () => ({ items: [1], nextCursor: "always" });
    const { items, capped } = await collectPaged(fetchPage, 3);
    expect(items).toEqual([1, 1, 1]);
    expect(capped).toBe(true);
  });

  it("treats an empty-string cursor as exhausted", async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], nextCursor: "" }));
    const { items, capped } = await collectPaged(fetchPage);
    expect(items).toEqual([1]);
    expect(capped).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
