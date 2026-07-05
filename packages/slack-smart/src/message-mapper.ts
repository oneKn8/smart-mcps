import { nullableString, nullableNumber, asObject } from "./null-helpers.js";

// A file attached to a message, slimmed to just what a caller needs to then
// fetch it with read_file. A file-share message has empty `text`, so without
// this the attachment (and its id) is invisible to every message consumer.
export type SlimMessageFile = {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
};

export type SlimMessage = {
  ts: string;
  text: string;
  user: string | null;
  type?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
  files?: SlimMessageFile[];
};

/** Slim `message.files` down to discoverable attachment stubs, or undefined. */
export function slimMessageFiles(raw: unknown): SlimMessageFile[] | undefined {
  const obj = asObject(raw);
  const arr = obj["files"];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const files = arr
    .map((f): SlimMessageFile | null => {
      const o = asObject(f);
      const id = nullableString(o["id"]);
      if (id === null) return null;
      const file: SlimMessageFile = { id };
      const name = nullableString(o["name"]);
      if (name !== null) file.name = name;
      const mimetype = nullableString(o["mimetype"]);
      if (mimetype !== null) file.mimetype = mimetype;
      const filetype = nullableString(o["filetype"]);
      if (filetype !== null) file.filetype = filetype;
      const size = nullableNumber(o["size"]);
      if (size !== null) file.size = size;
      return file;
    })
    .filter((f): f is SlimMessageFile => f !== null);
  return files.length > 0 ? files : undefined;
}

export function mapMessage(raw: unknown): SlimMessage {
  const obj = asObject(raw);

  const ts = nullableString(obj["ts"]) ?? "";
  const text = nullableString(obj["text"]) ?? "";
  const user = nullableString(obj["user"]);

  const slim: SlimMessage = { ts, text, user };

  const type = nullableString(obj["type"]);
  if (type !== null) slim.type = type;

  const subtype = nullableString(obj["subtype"]);
  if (subtype !== null) slim.subtype = subtype;

  const thread_ts = nullableString(obj["thread_ts"]);
  if (thread_ts !== null) slim.thread_ts = thread_ts;

  const reply_count = nullableNumber(obj["reply_count"]);
  if (reply_count !== null) slim.reply_count = reply_count;

  const bot_id = nullableString(obj["bot_id"]);
  if (bot_id !== null) slim.bot_id = bot_id;

  const files = slimMessageFiles(raw);
  if (files !== undefined) slim.files = files;

  return slim;
}
