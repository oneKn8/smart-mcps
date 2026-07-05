// Bounded cursor pagination for Slack list endpoints.
//
// Slack list methods (conversations.list, users.list, ...) return at most `limit`
// items plus a `response_metadata.next_cursor` for the next page. Fetching a
// single page silently drops everything past it — a real problem for an account
// with >100 DMs or a workspace with >200 members. This collects pages until the
// cursor is exhausted OR a page budget is hit (so a huge account can't spin
// forever), and reports whether it stopped early so callers can note truncation.

export async function collectPaged<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  maxPages = 12,
): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { items: pageItems, nextCursor } = await fetchPage(cursor);
    items.push(...pageItems);
    if (nextCursor === undefined || nextCursor === "") {
      return { items, capped: false };
    }
    cursor = nextCursor;
  }
  // Reached the page budget with a cursor still outstanding.
  return { items, capped: true };
}
