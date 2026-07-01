/**
 * Slim, snake_case shapes returned by the Gmail settings tools (filters,
 * vacation, imap/pop/language, send-as). Each mapper takes the raw camelCase
 * Gmail resource and copies only the fields callers use, dropping upstream
 * extras and never setting a key to `undefined` (so `Object.keys` reflects
 * exactly what was present).
 */

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

// ---------- Filter ----------

export type SlimFilterCriteria = {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negated_query?: string;
  has_attachment?: boolean;
  exclude_chats?: boolean;
  size?: number;
  size_comparison?: string;
};

export type SlimFilterAction = {
  add_label_ids?: string[];
  remove_label_ids?: string[];
  forward?: string;
};

export type SlimFilter = {
  id: string;
  criteria: SlimFilterCriteria;
  action: SlimFilterAction;
};

export function mapFilter(raw: unknown): SlimFilter {
  const obj = asObject(raw);
  const c = asObject(obj["criteria"]);
  const a = asObject(obj["action"]);

  const criteria: SlimFilterCriteria = {};
  const from = str(c["from"]);
  if (from !== undefined) criteria.from = from;
  const to = str(c["to"]);
  if (to !== undefined) criteria.to = to;
  const subject = str(c["subject"]);
  if (subject !== undefined) criteria.subject = subject;
  const query = str(c["query"]);
  if (query !== undefined) criteria.query = query;
  const negatedQuery = str(c["negatedQuery"]);
  if (negatedQuery !== undefined) criteria.negated_query = negatedQuery;
  const hasAttachment = bool(c["hasAttachment"]);
  if (hasAttachment !== undefined) criteria.has_attachment = hasAttachment;
  const excludeChats = bool(c["excludeChats"]);
  if (excludeChats !== undefined) criteria.exclude_chats = excludeChats;
  const size = num(c["size"]);
  if (size !== undefined) criteria.size = size;
  const sizeComparison = str(c["sizeComparison"]);
  if (sizeComparison !== undefined) criteria.size_comparison = sizeComparison;

  const action: SlimFilterAction = {};
  const addLabelIds = strArray(a["addLabelIds"]);
  if (addLabelIds !== undefined) action.add_label_ids = addLabelIds;
  const removeLabelIds = strArray(a["removeLabelIds"]);
  if (removeLabelIds !== undefined) action.remove_label_ids = removeLabelIds;
  const forward = str(a["forward"]);
  if (forward !== undefined) action.forward = forward;

  return { id: str(obj["id"]) ?? "", criteria, action };
}

// ---------- Vacation ----------

export type SlimVacation = {
  enable_auto_reply: boolean;
  response_subject?: string;
  response_body_plain_text?: string;
  response_body_html?: string;
  restrict_to_contacts?: boolean;
  restrict_to_domain?: boolean;
  start_time?: string;
  end_time?: string;
};

export function mapVacation(raw: unknown): SlimVacation {
  const obj = asObject(raw);
  const out: SlimVacation = {
    enable_auto_reply: bool(obj["enableAutoReply"]) ?? false,
  };
  const responseSubject = str(obj["responseSubject"]);
  if (responseSubject !== undefined) out.response_subject = responseSubject;
  const responseBodyPlainText = str(obj["responseBodyPlainText"]);
  if (responseBodyPlainText !== undefined)
    out.response_body_plain_text = responseBodyPlainText;
  const responseBodyHtml = str(obj["responseBodyHtml"]);
  if (responseBodyHtml !== undefined)
    out.response_body_html = responseBodyHtml;
  const restrictToContacts = bool(obj["restrictToContacts"]);
  if (restrictToContacts !== undefined)
    out.restrict_to_contacts = restrictToContacts;
  const restrictToDomain = bool(obj["restrictToDomain"]);
  if (restrictToDomain !== undefined)
    out.restrict_to_domain = restrictToDomain;
  const startTime = str(obj["startTime"]);
  if (startTime !== undefined) out.start_time = startTime;
  const endTime = str(obj["endTime"]);
  if (endTime !== undefined) out.end_time = endTime;
  return out;
}

// ---------- IMAP / POP / Language ----------

export type SlimImap = {
  enabled: boolean;
  auto_expunge?: boolean;
  expunge_behavior?: string;
  max_folder_size?: number;
};

export function mapImap(raw: unknown): SlimImap {
  const obj = asObject(raw);
  const out: SlimImap = { enabled: bool(obj["enabled"]) ?? false };
  const autoExpunge = bool(obj["autoExpunge"]);
  if (autoExpunge !== undefined) out.auto_expunge = autoExpunge;
  const expungeBehavior = str(obj["expungeBehavior"]);
  if (expungeBehavior !== undefined) out.expunge_behavior = expungeBehavior;
  const maxFolderSize = num(obj["maxFolderSize"]);
  if (maxFolderSize !== undefined) out.max_folder_size = maxFolderSize;
  return out;
}

export type SlimPop = {
  access_window?: string;
  disposition?: string;
};

export function mapPop(raw: unknown): SlimPop {
  const obj = asObject(raw);
  const out: SlimPop = {};
  const accessWindow = str(obj["accessWindow"]);
  if (accessWindow !== undefined) out.access_window = accessWindow;
  const disposition = str(obj["disposition"]);
  if (disposition !== undefined) out.disposition = disposition;
  return out;
}

export type SlimLanguage = {
  display_language: string;
};

export function mapLanguage(raw: unknown): SlimLanguage {
  const obj = asObject(raw);
  return { display_language: str(obj["displayLanguage"]) ?? "" };
}

// ---------- SendAs ----------

export type SlimSendAs = {
  send_as_email: string;
  display_name?: string;
  reply_to_address?: string;
  signature?: string;
  is_primary?: boolean;
  is_default?: boolean;
  treat_as_alias?: boolean;
  verification_status?: string;
};

export function mapSendAs(raw: unknown): SlimSendAs {
  const obj = asObject(raw);
  const out: SlimSendAs = { send_as_email: str(obj["sendAsEmail"]) ?? "" };
  const displayName = str(obj["displayName"]);
  if (displayName !== undefined) out.display_name = displayName;
  const replyToAddress = str(obj["replyToAddress"]);
  if (replyToAddress !== undefined) out.reply_to_address = replyToAddress;
  const signature = str(obj["signature"]);
  if (signature !== undefined) out.signature = signature;
  const isPrimary = bool(obj["isPrimary"]);
  if (isPrimary !== undefined) out.is_primary = isPrimary;
  const isDefault = bool(obj["isDefault"]);
  if (isDefault !== undefined) out.is_default = isDefault;
  const treatAsAlias = bool(obj["treatAsAlias"]);
  if (treatAsAlias !== undefined) out.treat_as_alias = treatAsAlias;
  const verificationStatus = str(obj["verificationStatus"]);
  if (verificationStatus !== undefined)
    out.verification_status = verificationStatus;
  return out;
}

// ---------- AutoForwarding ----------

export type SlimAutoForwarding = {
  enabled: boolean;
  email_address?: string;
  disposition?: string;
};

export function mapAutoForwarding(raw: unknown): SlimAutoForwarding {
  const obj = asObject(raw);
  const out: SlimAutoForwarding = { enabled: bool(obj["enabled"]) ?? false };
  const emailAddress = str(obj["emailAddress"]);
  if (emailAddress !== undefined) out.email_address = emailAddress;
  const disposition = str(obj["disposition"]);
  if (disposition !== undefined) out.disposition = disposition;
  return out;
}

// ---------- ForwardingAddress ----------

export type SlimForwardingAddress = {
  forwarding_email: string;
  verification_status?: string;
};

export function mapForwardingAddress(raw: unknown): SlimForwardingAddress {
  const obj = asObject(raw);
  const out: SlimForwardingAddress = {
    forwarding_email: str(obj["forwardingEmail"]) ?? "",
  };
  const verificationStatus = str(obj["verificationStatus"]);
  if (verificationStatus !== undefined)
    out.verification_status = verificationStatus;
  return out;
}

// ---------- Delegate ----------

export type SlimDelegate = {
  delegate_email: string;
  verification_status?: string;
};

export function mapDelegate(raw: unknown): SlimDelegate {
  const obj = asObject(raw);
  const out: SlimDelegate = {
    delegate_email: str(obj["delegateEmail"]) ?? "",
  };
  const verificationStatus = str(obj["verificationStatus"]);
  if (verificationStatus !== undefined)
    out.verification_status = verificationStatus;
  return out;
}
