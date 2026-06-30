import { asObject, nullableString } from "./null-helpers.js";

/**
 * Slim file shape. Drops the read-only fields `getContent` returns and
 * `updateContent` ignores (`lastModifyUser`, `createTime`, `updateTime`,
 * `functionSet`), keeping only the three writable fields.
 *
 * `name` is the filename WITHOUT extension (e.g. `Code`, `index`,
 * `appsscript`). `type` is the `FileType` enum (`SERVER_JS`, `HTML`, `JSON`).
 */
export type SlimFile = {
  name: string;
  type: string;
  source: string | null;
};

/** Slim project content: the writable file set plus the owning script id. */
export type SlimContent = {
  script_id: string | null;
  files: SlimFile[];
};

/** Map one raw Google `File` to the slim, writable-only shape. */
export function mapFile(raw: unknown): SlimFile {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapFile: expected an object file resource");
  }
  return {
    name: typeof obj.name === "string" ? obj.name : "",
    type: typeof obj.type === "string" ? obj.type : "",
    source: nullableString(obj.source),
  };
}

/** Map a raw Google `Content` resource into the slim shape. */
export function mapContent(raw: unknown): SlimContent {
  const obj = asObject(raw);
  if (!obj) {
    throw new Error("mapContent: expected an object content resource");
  }
  const files = Array.isArray(obj.files) ? obj.files.map(mapFile) : [];
  return {
    script_id: nullableString(obj.scriptId),
    files,
  };
}

/**
 * The exact writable payload `updateContent` expects for a single file:
 * `{ name, type, source }` and nothing else. `push_file` reuses this to
 * re-serialize every existing file (manifest included) so the read-modify-
 * write round-trip never drops a file or leaks a read-only field back up.
 */
export type FileWritePayload = {
  name: string;
  type: string;
  source: string;
};

/**
 * Reduce a raw file (from `getContent`) to the writable `{ name, type,
 * source }` triple `updateContent` accepts. Missing `source` becomes an
 * empty string (Google rejects a null source); missing `type` becomes the
 * empty string and surfaces as a server-side validation error rather than a
 * silent drop.
 */
export function toFileWritePayload(raw: unknown): FileWritePayload {
  const obj = asObject(raw) ?? {};
  return {
    name: typeof obj.name === "string" ? obj.name : "",
    type: typeof obj.type === "string" ? obj.type : "",
    source: typeof obj.source === "string" ? obj.source : "",
  };
}
