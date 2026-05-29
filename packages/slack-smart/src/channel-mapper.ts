import { nullableString, nullableNumber, nullableBoolean } from "./null-helpers.js";

export type SlimChannel = {
  id: string;
  name: string | null;
  is_private: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_archived: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: string;
  purpose?: string;
  user?: string;
};

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function mapChannel(raw: Record<string, unknown>): SlimChannel {
  const topicObj = asObject(raw["topic"]);
  const purposeObj = asObject(raw["purpose"]);

  const topicValue = nullableString(topicObj["value"]);
  const purposeValue = nullableString(purposeObj["value"]);

  const id = nullableString(raw["id"]) ?? "";
  // Slack sends name="" for IMs (no name). Treat empty string as null.
  const rawName = nullableString(raw["name"]);
  const name = rawName !== null && rawName !== "" ? rawName : null;
  const is_private = nullableBoolean(raw["is_private"]) ?? false;
  const is_im = nullableBoolean(raw["is_im"]) ?? false;
  const is_mpim = nullableBoolean(raw["is_mpim"]) ?? false;
  const is_archived = nullableBoolean(raw["is_archived"]) ?? false;

  const slim: SlimChannel = { id, name, is_private, is_im, is_mpim, is_archived };

  const is_member = nullableBoolean(raw["is_member"]);
  if (is_member !== null) slim.is_member = is_member;

  const num_members = nullableNumber(raw["num_members"]);
  if (num_members !== null) slim.num_members = num_members;

  if (topicValue !== null && topicValue !== "") slim.topic = topicValue;

  if (purposeValue !== null && purposeValue !== "") slim.purpose = purposeValue;

  const user = nullableString(raw["user"]);
  if (user !== null && user !== "") slim.user = user;

  return slim;
}
