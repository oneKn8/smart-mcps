import { nullableString } from "./null-helpers.js";
import { bodyContent } from "./request-builders.js";

/**
 * Slim document metadata. Strips the heavy `body`/`namedStyles`/`lists`/
 * `inlineObjects` payload that a documents.get returns — callers that want text
 * use `read_text`, callers that want structure call `get_document` with the raw
 * client. This is the LLM-friendly identity of a doc.
 */
export type SlimDocument = {
  document_id: string;
  title: string;
  revision_id: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mapDocument(raw: unknown): SlimDocument {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapDocument: expected an object document resource");
  }
  return {
    document_id: typeof obj.documentId === "string" ? obj.documentId : "",
    title: typeof obj.title === "string" ? obj.title : "",
    revision_id: nullableString(obj.revisionId),
  };
}

type StructuralElement = {
  paragraph?: { elements?: unknown[] };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: StructuralElement[] }>;
    }>;
  };
  // sectionBreak / tableOfContents contribute structure, not body text
};

function elementText(el: StructuralElement): string {
  if (el.paragraph) {
    let text = "";
    for (const pe of el.paragraph.elements ?? []) {
      const peObj = asObject(pe);
      const textRun = peObj ? asObject(peObj.textRun) : null;
      if (textRun && typeof textRun.content === "string") {
        text += textRun.content;
      }
      // inlineObjectElement / pageBreak / horizontalRule / person / richLink
      // carry no plain-text content; skipped gracefully.
    }
    return text;
  }
  if (el.table) {
    let text = "";
    for (const row of el.table.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        for (const cEl of cell.content ?? []) {
          text += elementText(cEl); // cells hold StructuralElement[] — recurse
        }
      }
    }
    return text;
  }
  return "";
}

/**
 * Reconstruct the plain text of a documents.get response by walking
 * `body.content -> paragraph -> elements -> textRun.content` (and recursing
 * into tables). No Docs API helper exists for this; the walk is the documented
 * extraction recipe. Section breaks and tables-of-contents contribute no text
 * and are skipped without error.
 *
 * With the default `includeTabsContent=false`, the first tab's content is
 * flattened into `document.body`, so this single walk covers the common case.
 */
export function readDocumentText(doc: unknown): string {
  let text = "";
  for (const el of bodyContent(doc) as StructuralElement[]) {
    text += elementText(el);
  }
  return text;
}
