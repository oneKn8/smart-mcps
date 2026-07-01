# Gmail API v1 — Verified SETTINGS / FILTERS / PERMANENT-DELETE Reference

> Researched 2026-07-01. Every verb, path, field, enum, scope, and quota below is sourced from
> official Google documentation and the official machine-readable Gmail API **discovery document
> `revision 20260622`** (`https://gmail.googleapis.com/$discovery/rest?version=v1`). Nothing is
> guessed. Where a fact is derived rather than stated verbatim, it is labelled.
>
> Scope of this doc: the SETTINGS + FILTERS + permanent-DELETE surface that `email-smart` does NOT
> yet have. The send / read / label / trash side is already built (`email-smart`, scope
> `gmail.modify`). Permanent delete and all settings need a **scope bump** (see §1, §12).

**Service host:** `https://gmail.googleapis.com/` (older docs show `https://www.googleapis.com/gmail/v1`; both resolve). Base path: `gmail/v1`.
**Path root for every call below:** `.../gmail/v1/users/{userId}/...` where `userId` = `me` for the authed user.
**Discovery doc title/rev:** `Gmail API` `v1`, `revision 20260622`.

### Primary sources (official only)
- Scopes page — https://developers.google.com/gmail/api/auth/scopes
- Discovery doc (authoritative schemas + per-method scope lists) — https://gmail.googleapis.com/$discovery/rest?version=v1
- Filters — https://developers.google.com/gmail/api/reference/rest/v1/users.settings.filters (+ `/create`, `/list`, `/get`, `/delete`)
- Vacation — https://developers.google.com/gmail/api/reference/rest/v1/users.settings/getVacation , `/updateVacation`
- Auto-forwarding — https://developers.google.com/gmail/api/reference/rest/v1/users.settings/getAutoForwarding , `/updateAutoForwarding`
- Forwarding addresses — https://developers.google.com/gmail/api/reference/rest/v1/users.settings.forwardingAddresses (+ `/create`)
- Send-as — https://developers.google.com/gmail/api/reference/rest/v1/users.settings.sendAs (+ `/create`, `/update`, `/verify`)
- IMAP / POP / Language — https://developers.google.com/gmail/api/reference/rest/v1/users.settings/getImap , `/updateImap`, `/getPop`, `/updatePop`, `/getLanguage`, `/updateLanguage`
- Delegates — https://developers.google.com/gmail/api/reference/rest/v1/users.settings.delegates (+ `/create`, `/list`)
- Permanent delete — https://developers.google.com/gmail/api/reference/rest/v1/users.messages/delete , `/batchDelete`; https://developers.google.com/gmail/api/reference/rest/v1/users.threads/delete
- Usage limits / quota — https://developers.google.com/workspace/gmail/api/reference/quota

---

## 0. Integration reality for `email-smart` (read before building)

1. **Current scope is `gmail.modify`.** That covers read + trash/untrash + label CRUD, and is
   **insufficient for everything in this doc.** Settings writes need `gmail.settings.basic`;
   sharing-sensitive writes need `gmail.settings.sharing`; permanent delete needs the full
   `https://mail.google.com/`. This is a **re-consent event** on the `~/.santo-agent/` OAuth jar.
2. **`email-smart` uses a single end-user OAuth token, not a Workspace service account with
   domain-wide delegation (DWD).** Several sharing-scope write methods carry an official note:
   *"This method is only available to service account clients that have been delegated domain-wide
   authority."* This may cause `403` on a consumer/end-user token. Affected: `updateAutoForwarding`,
   `sendAs.create` (custom-from), `sendAs.verify`, `forwardingAddresses.create/delete`,
   `delegates.create/delete`. **Treat these as Tier-B: ship behind a live-API smoke test; do not
   assume they work on a personal Gmail token.** (Delegates are genuinely Workspace-only.)
3. Everything else (filters CRUD, vacation, imap/pop/language, sendAs list/get + signature/display
   updates, all reads, permanent delete) works with an end-user token + the right scope. Tier-A.

---

## 1. THE SCOPE MODEL (definitive answer)

**Question: does `https://mail.google.com/` cover the SETTINGS endpoints?**
**Answer: For settings READS yes; for settings WRITES NO.** Proven by the per-method `scopes`
arrays in the discovery doc. A settings *write* accepts ONLY the specific `gmail.settings.*` scope;
`mail.google.com` is not in the accepted list. Verbatim scope descriptions from the discovery `auth`
block:

| Scope (full string) | Official description | Class |
|---|---|---|
| `https://mail.google.com/` | "Read, compose, send, and permanently delete all your email from Gmail" | Restricted |
| `https://www.googleapis.com/auth/gmail.settings.basic` | "See, edit, create, or change your email settings and filters in Gmail" | Restricted |
| `https://www.googleapis.com/auth/gmail.settings.sharing` | "Manage your sensitive mail settings, including who can manage your mail" | Restricted |
| `https://www.googleapis.com/auth/gmail.modify` | "Read, compose, and send emails from your Gmail account" | Restricted |
| `https://www.googleapis.com/auth/gmail.readonly` | "View your email messages and settings" | Restricted |

**Four accepted-scope buckets (from discovery `scopes` arrays):**

| Bucket | Methods | Accepted scopes (ANY one authorizes) |
|---|---|---|
| **Settings READ** | `getImap`, `getPop`, `getVacation`, `getLanguage`, `getAutoForwarding`, `filters.list/get`, `sendAs.list/get`, `forwardingAddresses.list/get`, `delegates.list/get` | `mail.google.com` · `gmail.modify` · `gmail.readonly` · `gmail.settings.basic` |
| **Settings WRITE (basic)** | `updateImap`, `updatePop`, `updateVacation`, `updateLanguage`, `filters.create`, `filters.delete` | `gmail.settings.basic` **ONLY** (not `mail.google.com`, not `modify`) |
| **Settings WRITE (sharing)** | `updateAutoForwarding`, `sendAs.create`, `sendAs.verify`, `sendAs.delete`, `forwardingAddresses.create`, `forwardingAddresses.delete`, `delegates.create`, `delegates.delete` | `gmail.settings.sharing` **ONLY** |
| **Permanent DELETE** | `messages.delete`, `messages.batchDelete`, `threads.delete` | `https://mail.google.com/` **ONLY** (`gmail.modify` is INSUFFICIENT) |

Exceptions (accept either settings scope): `sendAs.update` and `sendAs.patch` → `gmail.settings.basic` **or** `gmail.settings.sharing`.

**Definitive minimal scope set** to cover filters + all settings + permanent delete:
```
https://mail.google.com/                              # permanent delete + all settings READS
https://www.googleapis.com/auth/gmail.settings.basic  # filters, vacation, imap, pop, language, sendAs update/patch
https://www.googleapis.com/auth/gmail.settings.sharing# autoForwarding, sendAs create/verify/delete, forwardingAddresses, delegates
```
`mail.google.com` is a superset of `gmail.modify`, so the existing send/read/label/trash surface
keeps working on the new jar. The two `settings.*` scopes are **not** implied by `mail.google.com`
and MUST be requested explicitly.

---

## 2. FILTERS — `users.settings.filters`

| Method | Verb | Path (`.../gmail/v1/users/{userId}/settings/filters...`) | Scope | Quota |
|---|---|---|---|---|
| list | GET | `/settings/filters` | READ | 1 |
| get | GET | `/settings/filters/{id}` | READ | 1 |
| create | POST | `/settings/filters` | `gmail.settings.basic` | 5 |
| delete | DELETE | `/settings/filters/{id}` | `gmail.settings.basic` | 5 |

`list` → `{ "filter": [ Filter ] }`. `get` → `Filter`. `create` body = `Filter` (no `id`), returns
`Filter` with server-assigned `id`. `delete` → empty `204`.

**Filter resource** (`id` is read-only, server-assigned):
```jsonc
{
  "id": "string",
  "criteria": {                     // FilterCriteria — all optional
    "from": "string",               // sender display name or email
    "to": "string",                 // recipient across to/cc/bcc; local-part allowed
    "subject": "string",            // case-insensitive phrase; whitespace trimmed/collapsed
    "query": "string",              // Gmail search-box syntax, e.g. "has:attachment larger:5M"
    "negatedQuery": "string",       // messages NOT matching this Gmail query
    "hasAttachment": true,          // boolean
    "excludeChats": true,           // boolean
    "size": 1048576,                // int32, size of whole RFC822 message in bytes
    "sizeComparison": "larger"      // enum: "unspecified" | "smaller" | "larger"
  },
  "action": {                       // FilterAction
    "addLabelIds": ["string"],      // label IDs to add (e.g. "IMPORTANT", or a Label_N id)
    "removeLabelIds": ["string"],   // label IDs to remove (use "INBOX" to skip inbox)
    "forward": "string"             // forward to this (must be a verified forwarding address)
  }
}
```

**Concrete create body** — "from `newsletter@x.com` → add label `Label_42`, skip Inbox":
```
POST /gmail/v1/users/me/settings/filters
{
  "criteria": { "from": "newsletter@x.com" },
  "action":   { "addLabelIds": ["Label_42"], "removeLabelIds": ["INBOX"] }
}
```
Notes: label IDs (not names) are required — resolve names via the existing `list_labels`. Setting
`action.forward` requires the target already be a **verified** forwarding address (see §4). Filters
have no update method — to edit, delete + recreate.

---

## 3. VACATION — `users.settings.getVacation` / `updateVacation`

| Method | Verb | Path | Scope | Quota |
|---|---|---|---|---|
| getVacation | GET | `/settings/vacation` | READ | 1 |
| updateVacation | PUT | `/settings/vacation` | `gmail.settings.basic` | 5 |

Body + response = `VacationSettings`. To **disable**, PUT `{ "enableAutoReply": false }`.

**VacationSettings resource:**
```jsonc
{
  "enableAutoReply": true,          // master on/off
  "responseSubject": "string",      // prepended to subject; subject OR body must be nonempty to enable
  "responseBodyPlainText": "string",
  "responseBodyHtml": "string",     // Gmail sanitizes; if both set, HTML wins
  "restrictToContacts": true,       // only reply to people in Contacts
  "restrictToDomain": true,         // only reply within your domain (Workspace only)
  "startTime": "1719792000000",     // string int64, EPOCH MILLISECONDS; reply only to mail after this
  "endTime":   "1720396800000"      // string int64, EPOCH MILLISECONDS; reply only to mail before this
}
```
`startTime`/`endTime` are epoch-ms as **strings**. If both set, `startTime` must be `< endTime`.

---

## 4. AUTO-FORWARDING + FORWARDING ADDRESSES

### 4a. `users.settings.getAutoForwarding` / `updateAutoForwarding`
| Method | Verb | Path | Scope | Quota |
|---|---|---|---|---|
| getAutoForwarding | GET | `/settings/autoForwarding` | READ | 1 |
| updateAutoForwarding | PUT | `/settings/autoForwarding` | **`gmail.settings.sharing`** (Tier-B, DWD-noted) | 5 |

**AutoForwarding resource:**
```jsonc
{
  "enabled": true,
  "emailAddress": "dest@x.com",     // MUST already be a verified forwarding address
  "disposition": "leaveInInbox"     // enum: dispositionUnspecified | leaveInInbox | archive | trash | markRead
}
```

### 4b. `users.settings.forwardingAddresses`
| Method | Verb | Path | Scope | Quota |
|---|---|---|---|---|
| list | GET | `/settings/forwardingAddresses` | READ | 1 |
| get | GET | `/settings/forwardingAddresses/{forwardingEmail}` | READ | 1 |
| create | POST | `/settings/forwardingAddresses` | **`gmail.settings.sharing`** (Tier-B) | 100 |
| delete | DELETE | `/settings/forwardingAddresses/{forwardingEmail}` | **`gmail.settings.sharing`** (Tier-B) | 5 |

**ForwardingAddress resource:**
```jsonc
{
  "forwardingEmail": "dest@x.com",
  "verificationStatus": "accepted"  // read-only enum: verificationStatusUnspecified | accepted | pending
}
```
**Verification requirement:** on `create`, if ownership verification is required Gmail sends a
message to the address and `verificationStatus` becomes `pending`; otherwise it is `accepted`. You
**cannot enable auto-forwarding to it (§4a) until it is `accepted`.** `delete` revokes any
verification. Official note: create/delete are documented "only available to service account clients
with domain-wide authority" — verify on end-user token.

---

## 5. SEND-AS — `users.settings.sendAs` (aliases, signatures, custom from)

| Method | Verb | Path | Scope | Quota |
|---|---|---|---|---|
| list | GET | `/settings/sendAs` | READ | 1 |
| get | GET | `/settings/sendAs/{sendAsEmail}` | READ | 1 |
| create | POST | `/settings/sendAs` | **`gmail.settings.sharing`** (Tier-B, custom-from) | 100 |
| update | PUT | `/settings/sendAs/{sendAsEmail}` | `gmail.settings.basic` **or** `.sharing` | 100 |
| patch | PATCH | `/settings/sendAs/{sendAsEmail}` | `gmail.settings.basic` **or** `.sharing` | (as update) |
| delete | DELETE | `/settings/sendAs/{sendAsEmail}` | **`gmail.settings.sharing`** (Tier-B) | 5 |
| verify | POST | `/settings/sendAs/{sendAsEmail}/verify` | **`gmail.settings.sharing`** (Tier-B) | (n/a) |

**SendAs resource:**
```jsonc
{
  "sendAsEmail": "alias@x.com",     // read-only except on create
  "displayName": "string",          // From: display name
  "replyToAddress": "string",       // optional Reply-To
  "signature": "string",            // HTML signature; sanitized; added to NEW emails only
  "isPrimary": true,                // read-only; exactly one; cannot be deleted
  "isDefault": true,                // default From: for new mail / vacation replies
  "treatAsAlias": true,             // custom-from only
  "verificationStatus": "accepted", // read-only enum: verificationStatusUnspecified | accepted | pending
  "smtpMsa": {                      // optional outbound relay for custom-from
    "host": "smtp.x.com",           // required
    "port": 465,                    // required int32
    "username": "string",           // write-only, never returned
    "password": "string",          // write-only, never returned
    "securityMode": "ssl"           // enum: securityModeUnspecified | none | ssl | starttls (required)
  }
}
```
**Scope split:** editing an existing alias's `signature` / `displayName` / `replyToAddress` /
`isDefault` works with `gmail.settings.basic` (via `update`/`patch`). Creating a **custom "from"**
alias, changing the `smtpMsa`, deleting, or (re)sending verification are sharing-scope and carry the
DWD note. On `create`, if verification is required Gmail mails the address and status → `pending`;
else `accepted`. Signature HTML is sanitized server-side.

---

## 6. IMAP / POP / LANGUAGE

| Method | Verb | Path | Scope | Quota |
|---|---|---|---|---|
| getImap | GET | `/settings/imap` | READ | 1 |
| updateImap | PUT | `/settings/imap` | `gmail.settings.basic` | 5 |
| getPop | GET | `/settings/pop` | READ | 1 |
| updatePop | PUT | `/settings/pop` | `gmail.settings.basic` | 5 |
| getLanguage | GET | `/settings/language` | READ | 1 |
| updateLanguage | PUT | `/settings/language` | `gmail.settings.basic` | 5 |

**ImapSettings:**
```jsonc
{
  "enabled": true,
  "autoExpunge": true,              // true = expunge immediately on IMAP delete
  "expungeBehavior": "archive",     // enum: expungeBehaviorUnspecified | archive | trash | deleteForever
  "maxFolderSize": 0                // int32; legal: 0(=no limit),1000,2000,5000,10000
}
```
**PopSettings:**
```jsonc
{
  "accessWindow": "allMail",        // enum: accessWindowUnspecified | disabled | fromNowOn | allMail
  "disposition": "leaveInInbox"     // enum: dispositionUnspecified | leaveInInbox | archive | trash | markRead
}
```
**LanguageSettings:**
```jsonc
{ "displayLanguage": "en-GB" }      // RFC 3066 language tag (e.g. "fr", "ja"). Gmail may store a close variant.
```
Note (imap): `expungeBehavior: "deleteForever"` makes IMAP client deletes permanent — a data-loss
foot-gun worth surfacing in tool copy.

---

## 7. DELEGATES — `users.settings.delegates` (security-sensitive; Workspace-only)

| Method | Verb | Path | Scope | Quota |
|---|---|---|---|---|
| list | GET | `/settings/delegates` | READ | 1 |
| get | GET | `/settings/delegates/{delegateEmail}` | READ | 1 |
| create | POST | `/settings/delegates` | **`gmail.settings.sharing`** (Tier-B, Workspace + DWD only) | 100 |
| delete | DELETE | `/settings/delegates/{delegateEmail}` | **`gmail.settings.sharing`** (Tier-B) | 5 |

**Delegate resource:**
```jsonc
{
  "delegateEmail": "assistant@x.com",
  "verificationStatus": "accepted"  // read-only enum: verificationStatusUnspecified | accepted | pending | rejected | expired
}
```
A delegate can **read, send, and delete mail on the mailbox's behalf** (cannot change password /
account settings). `create`/`delete` are "only available to service account clients with domain-wide
authority"; delegate must be in the **same Workspace org**, referenced by primary address (not
alias). Typical org limits: ~25 delegates per user, ~10 delegators per user. **This is the most
security-sensitive surface in this doc — granting a delegate is granting mailbox control.**

---

## 8. PERMANENT DELETE (IRREVERSIBLE) — contrast with trash

`email-smart` already has trash (reversible, `gmail.modify`). These bypass Trash and are **permanent,
cannot be undone**, and require the FULL `https://mail.google.com/` scope (`gmail.modify` is rejected).

| Method | Verb | Path | Scope | Quota | Official description |
|---|---|---|---|---|---|
| messages.delete | DELETE | `/messages/{id}` | `https://mail.google.com/` | 10 | "Immediately and permanently deletes the specified message. This operation cannot be undone. Prefer `messages.trash` instead." |
| messages.batchDelete | POST | `/messages/batchDelete` | `https://mail.google.com/` | 50 | "Deletes many messages by message ID. Provides no guarantees that messages were not already deleted or even existed at all." |
| threads.delete | DELETE | `/threads/{id}` | `https://mail.google.com/` | 20 | "Immediately and permanently deletes the specified thread. Any messages that belong to the thread are also deleted. This operation cannot be undone. Prefer `threads.trash` instead." |

`messages.delete` / `threads.delete`: no body, empty `204` on success.
`messages.batchDelete` body:
```jsonc
{ "ids": ["msgId1", "msgId2", "..."] }   // returns empty 204
```
**Batch id limit:** the batchDelete reference does not state a per-request cap; the sibling
`messages.batchModify` explicitly documents *"a limit of 1000 ids per request."* **Derived guidance:
chunk batchDelete to ≤1000 ids/call** (verify empirically). batchDelete is silent on already-deleted
/ nonexistent ids (no error), so it is not a reliable existence check.

Trash-vs-delete contrast: trash → recoverable, auto-purged after ~30 days; `delete`/`batchDelete`/
`threads.delete` → gone immediately, unrecoverable, no API undo.

---

## 9. Rate limits / quotas (2026)

From `https://developers.google.com/workspace/gmail/api/reference/quota` (raw-HTML verified):

| Limit | Value (verbatim) |
|---|---|
| Per day per project | **80,000,000 quota units** |
| Per minute per project | **1,200,000 quota units** |
| Per minute per user per project | **6,000 quota units** (≈100 units/user/sec) |

Per-method quota-unit cost (this doc's surface): `messages.delete` 10 · `messages.batchDelete` 50 ·
`threads.delete` 20 · `filters.list/get` 1 · `filters.create/delete` 5 · `getVacation` 1 ·
`updateVacation` 5 · `updateImap/updatePop/updateLanguage/updateAutoForwarding` 5 ·
`sendAs.create/update` 100 · `forwardingAddresses.create` 100 · `delegates.create` 100 ·
`*.delete` (sendAs/forwardingAddresses/delegates) 5 · all `get`/`list` 1.

**2025-2026 change (flag):** Gmail API states *"Exceeding the quota request limits is planned to
incur charges to your Google Cloud billing account later in 2026."* Today all standard use is free;
Google promises full billing details with ≥90 days notice. Discovery doc revision at time of
research: **20260622**. `403 rateLimitExceeded` / `429` are retryable with backoff (already handled
by core `fetchJson` 429 retry).

---

## 10. Safety flags — which ops must be confirm-gated

| Op | Risk | Gate |
|---|---|---|
| `messages.delete`, `threads.delete` | Irreversible permanent delete | `guardDestructive` confirm |
| `messages.batchDelete` | Bulk irreversible; no per-id error | `dry_run: true` default + confirm; chunk ≤1000 |
| `delegates.create` | Grants another account read/send/delete over the mailbox | Confirm + explicit warning; Workspace-only |
| `delegates.delete` | Revokes access (less risky but account-control) | Confirm |
| `updateAutoForwarding` (enabled=true) | Silently exfiltrates all mail to an external address | Confirm + surface destination |
| `forwardingAddresses.create` | First step of exfiltration path | Confirm |
| `sendAs.create` / `sendAs.update` w/ smtpMsa | Sends mail as another identity / stores SMTP creds | Confirm |
| `updateImap` w/ `expungeBehavior: deleteForever` | Turns IMAP deletes permanent (data loss) | Confirm/warn |
| `updateVacation` (enable) | Low risk; auto-replies leak presence/contacts | Preview only |
| `filters.create` with `action.forward` | Redirects matching mail externally | Confirm |
| `filters.delete` | Removes automation (recoverable by recreate) | Preview/confirm-lite |

Reads (`get*`, `list*`) are non-destructive — no gate. Follow the repo's `guardDestructive({confirm,
preview})` pattern; for batch delete use `dry_run` default (surfaces candidate list), `dry_run` wins
over `confirm` when both set, per `kill_idle_pods`.

---

## 11. RECOMMENDED tool set for `email-smart` (18 tools)

Prefix `email-smart`'s existing `snake_case` convention. Tier-A = works on end-user OAuth; Tier-B =
DWD-noted, ship behind a live smoke test (§0.2). All destructive tools carry `confirm`
(and `dry_run` where noted).

**Filters (4, Tier-A, `gmail.settings.basic`)**
1. `list_filters` — GET filters → slim `{id, criteria, action}[]`
2. `get_filter` — GET filters/{id}
3. `create_filter` — POST filters (resolves label names→ids; supports from/to/subject/query/size + add/remove label + forward)
4. `delete_filter` — DELETE filters/{id} (confirm-lite; recoverable by recreate)

**Vacation (2, Tier-A, `gmail.settings.basic`)**
5. `get_vacation` — GET vacation
6. `set_vacation` — PUT vacation (enable with subject/body/date-range; `enabled:false` clears)

**Send-as (3, mostly Tier-A, `gmail.settings.basic` for updates)**
7. `list_send_as` — GET sendAs (aliases + signatures + verification status)
8. `get_send_as` — GET sendAs/{email}
9. `update_send_as` — PATCH sendAs/{email} (signature / displayName / replyTo / isDefault) — basic scope, no DWD

**IMAP / POP / Language (3, Tier-A, `gmail.settings.basic`)**
10. `get_mail_client_settings` — fan-out GET imap+pop+language (one tool, combined read)
11. `update_imap` — PUT imap (warn on `deleteForever`)
12. `update_pop` — PUT pop

**Permanent delete (3, Tier-A on `mail.google.com`, all confirm-gated)**
13. `delete_message_forever` — DELETE messages/{id} (confirm; irreversible)
14. `batch_delete_messages_forever` — POST messages/batchDelete (dry_run default, confirm, chunk ≤1000). Pairs with existing `search_emails` to build the id list; good `empty_spam_forever` / purge-old-trash shortcut base.
15. `delete_thread_forever` — DELETE threads/{id} (confirm)

**Forwarding + delegates (3, Tier-B, `gmail.settings.sharing`, live-smoke first)**
16. `get_forwarding` — GET autoForwarding + list forwardingAddresses (combined read; Tier-A read)
17. `set_auto_forwarding` — PUT autoForwarding (confirm + destination warning; Tier-B)
18. `list_delegates` (Tier-A read) — GET delegates; keep `add_delegate`/`remove_delegate` as documented-but-gated Tier-B follow-ups (Workspace-only, heavy confirm).

Deferred (build only if a real need + Workspace account appears): `create_forwarding_address`,
`create_send_as` (custom-from + smtpMsa), `verify_send_as`, `add_delegate`/`remove_delegate`,
`update_language`. All Tier-B / sharing-scope / DWD-noted.

---

## 12. Definitive scope statement (for the OAuth re-consent)

- **`mail.google.com` does NOT cover settings writes.** Settings reads accept it; settings writes
  accept only `gmail.settings.basic` (or `gmail.settings.sharing`). Permanent delete accepts only
  `mail.google.com` (not `gmail.modify`). Source: per-method `scopes` arrays, discovery rev 20260622.
- **Minimal set for filters + all settings + permanent delete:**
  `https://mail.google.com/` **+** `https://www.googleapis.com/auth/gmail.settings.basic` **+**
  `https://www.googleapis.com/auth/gmail.settings.sharing`.
- Dropping `gmail.settings.sharing` still yields a strong Tier-A build (filters, vacation, imap/pop/
  language, sendAs signature updates, all reads, permanent delete) and avoids the DWD/consumer-token
  risk on the sharing surface. Add `sharing` only when auto-forwarding / custom-from / delegates are
  actually needed and a live smoke confirms they work on the token in use.
- All three are Google **Restricted** scopes → the OAuth app needs verification (and possibly a
  CASA security assessment) before external users; fine for Santo's own single-user jar.
