import type { DocsClient } from "./client.js";
import { docUrl } from "./tools/documents.js";
import {
  buildMarkdownPlan,
  parseMarkdown,
  tablesWriteBackwards,
  type TableDescriptor,
} from "./markdown.js";
import {
  insertTableRequest,
  insertTextRequest,
  tableCellSlots,
  type DocsRequest,
} from "./request-builders.js";

/**
 * Reusable create-doc-from-markdown orchestration, extracted verbatim from
 * `createDocFromMarkdownTool.handler` so both the docs-smart tool and the
 * flow-smart orchestrator render Google Docs through ONE code path. No
 * behavior change: the Phase A/B/C sequence and request order are identical.
 *
 * Phases (see markdown.ts for the why):
 *   A. create (title only), then ONE batchUpdate of the flow text + all styles
 *      (ranges recorded against the final flow layout — strategy A, no drift).
 *   B. insert the empty tables at their recorded flow indexes, WRITE-BACKWARDS
 *      (highest index first) so each insert leaves the lower indexes valid.
 *   C. documents.get to read the now-real cell indexes, then fill every cell
 *      WRITE-BACKWARDS across all tables in one batchUpdate.
 */

export type RenderMarkdownResult = {
  document_id: string;
  title: string;
  url: string;
  tables_filled: number;
};

/**
 * Build the cell-fill requests for ALL tables from a real (post-Phase-B)
 * documents.get response. Tables appear in body order = ascending recorded
 * insertIndex, so we match `tablesAsc[k]` to the k-th table in the document.
 * All fills across all tables are emitted in one descending-index pass.
 */
export function buildAllTableFillRequests(
  doc: unknown,
  tablesAsc: TableDescriptor[],
): DocsRequest[] {
  const fills: { index: number; text: string }[] = [];
  tablesAsc.forEach((table, ordinal) => {
    const { slots } = tableCellSlots(doc, ordinal);
    table.cells.forEach((row, r) => {
      row.forEach((text, c) => {
        if (text.length === 0) return;
        const slot = slots.find((s) => s.row === r && s.column === c);
        if (slot) fills.push({ index: slot.index, text });
      });
    });
  });
  fills.sort((a, b) => b.index - a.index); // write backwards across all cells
  return fills.map((f) => insertTextRequest({ text: f.text, index: f.index }));
}

/**
 * Create a brand-new Google Doc and render a Markdown subset into it. Returns
 * the new document id, the resolved title, an editor URL, and the number of
 * tables filled. Throws whatever the DocsClient throws (auth/not-found/
 * upstream) — the caller decides how to surface partial progress.
 */
export async function renderMarkdownToNewDoc(
  client: DocsClient,
  opts: { title: string; markdown: string },
): Promise<RenderMarkdownResult> {
  const blocks = parseMarkdown(opts.markdown);
  const plan = buildMarkdownPlan(blocks);

  // Phase A: create + flow text + styles.
  const created = await client.createDocument({ title: opts.title });
  const documentId =
    typeof created.documentId === "string" ? created.documentId : "";
  const title = typeof created.title === "string" ? created.title : opts.title;

  if (plan.flowRequests.length > 0) {
    await client.batchUpdate({
      documentId,
      requests: plan.flowRequests,
    });
  }

  let tablesFilled = 0;
  if (plan.tables.length > 0) {
    // Phase B: insert empty tables, write-backwards by recorded index.
    const backwards = tablesWriteBackwards(plan.tables);
    await client.batchUpdate({
      documentId,
      requests: backwards.map((t) =>
        insertTableRequest({
          rows: t.rows,
          columns: t.columns,
          index: t.insertIndex,
        }),
      ),
    });

    // Phase C: read real cell indexes, then fill write-backwards.
    const doc = await client.getDocument({ documentId });
    const tablesAsc = [...plan.tables].sort(
      (a, b) => a.insertIndex - b.insertIndex,
    );
    const fillRequests = buildAllTableFillRequests(doc, tablesAsc);
    if (fillRequests.length > 0) {
      await client.batchUpdate({ documentId, requests: fillRequests });
      tablesFilled = plan.tables.length;
    }
  }

  return {
    document_id: documentId,
    title,
    url: docUrl(documentId),
    tables_filled: tablesFilled,
  };
}
