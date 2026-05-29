import { nullableString, nullableNumber } from "./null-helpers.js";

export type SlimMessage = {
  ts: string;
  text: string;
  user: string | null;
  type?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
};

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
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

  return slim;
}
