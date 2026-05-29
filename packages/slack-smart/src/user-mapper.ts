import { nullableString, nullableBoolean, asObject } from "./null-helpers.js";

export type SlimUser = {
  id: string;
  name: string;
  is_bot: boolean;
  deleted: boolean;
  real_name?: string;
  display_name?: string;
  email?: string;
  tz?: string;
};

export function mapUser(raw: unknown): SlimUser {
  const obj = asObject(raw);
  const profile = asObject(obj["profile"]);

  const id = nullableString(obj["id"]) ?? "";
  const name = nullableString(obj["name"]) ?? "";
  const is_bot = nullableBoolean(obj["is_bot"]) ?? false;
  const deleted = nullableBoolean(obj["deleted"]) ?? false;

  const slim: SlimUser = { id, name, is_bot, deleted };

  const real_name = nullableString(obj["real_name"]);
  if (real_name !== null && real_name !== "") slim.real_name = real_name;

  const display_name = nullableString(profile["display_name"]);
  if (display_name !== null && display_name !== "") slim.display_name = display_name;

  const email = nullableString(profile["email"]);
  if (email !== null && email !== "") slim.email = email;

  const tz = nullableString(obj["tz"]);
  if (tz !== null && tz !== "") slim.tz = tz;

  return slim;
}
