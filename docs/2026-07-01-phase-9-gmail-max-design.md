# Phase 9 design: gmail-max (email-smart filters + settings + permanent delete)

Date: 2026-07-01
Status: approved (Santo: "true max" + "go ahead use subagent"), build in progress

Extends the existing `email-smart` package (30 tools) with Gmail's settings surface:
filters (auto-routing), vacation, forwarding, send-as/signatures, imap/pop,
language, delegates, and PERMANENT delete. Santo chose TRUE-MAX (full
`mail.google.com`), with permanent delete and all security-sensitive ops
hard-gated.

Verified reference: `docs/research/2026-07-01-gmail-settings-filters-delete-reference.md`.
Conventions: extend email-smart in place (its `client.ts` + `tools/*.ts` pattern).

## 1. Scope model (definitive, from the reference)

The new `.json` email token must carry THREE scopes (mail.google.com does NOT
imply the settings scopes):

```
https://mail.google.com/                                # permanent delete + settings READS; superset of gmail.modify (send/read/label/trash keep working)
https://www.googleapis.com/auth/gmail.settings.basic    # filters, vacation, imap, pop, language, sendAs update/patch (signatures)
https://www.googleapis.com/auth/gmail.settings.sharing  # autoForwarding, forwardingAddresses, sendAs create/verify/delete, delegates
```

All three are RESTRICTED scopes. Since the consent screen is in PRODUCTION, each
must be registered on the OAuth consent screen (console.cloud.google.com/auth/scopes)
BEFORE re-auth, or Google drops/blocks them (the exact issue hit with run_function).
Front-load this in the handoff. Bump `APPS_..`→ `email` auth CLI scope constant.

email-smart is MULTI-ACCOUNT: `EmailClient(home?)`, methods take `account` first.
New client methods follow that. API base `https://gmail.googleapis.com/gmail/v1`,
settings under `/users/{account}/settings/...`.

## 2. Tools to add (~22) — snake_case, <=15-token descriptions

Filters (basic): `create_filter`, `list_filters`, `delete_filter`
Vacation (basic): `get_vacation`, `update_vacation`
IMAP/POP (basic): `get_imap`, `update_imap`, `get_pop`, `update_pop`
Language (basic): `update_language`
Send-as (basic/sharing): `list_send_as`, `update_send_as` (signature/display name)
Auto-forwarding (sharing, GATED): `get_auto_forwarding`, `update_auto_forwarding`
Forwarding addresses (sharing, GATED): `list_forwarding_addresses`,
  `create_forwarding_address`, `delete_forwarding_address`
Delegates (sharing, GATED): `list_delegates`, `create_delegate`, `delete_delegate`
Permanent delete (mail.google.com, HARD-GATED): `delete_message_permanent`,
  `batch_delete_messages` (dry_run default true), `delete_thread_permanent`

Split for the build (SEQUENTIAL — email-smart is one compiled package):
- **A: basic scope** — filters, vacation, imap, pop, language, send-as. ~12 tools.
- **B: sharing + delete** — auto-forwarding, forwarding addresses, delegates,
  permanent delete/batch. ~10 tools. Appends to tools/index.ts.

## 3. Safety model

- HARD-GATED (`guardDestructive`, confirm, explicit preview):
  - `delete_message_permanent` / `delete_thread_permanent` — irreversible, bypasses
    trash. Preview: "permanently deleted, NOT trash, cannot be recovered".
  - `batch_delete_messages` — `dry_run` default true (lists matched ids first);
    only dry_run=false AND confirm=true executes. Preview states the count.
  - `update_auto_forwarding` (enabling) / `create_forwarding_address` — exfiltration
    risk (sends your mail to another address). Preview names the destination +
    "your incoming mail will be forwarded OUTSIDE this account".
  - `create_delegate` — grants ANOTHER account full read/send access to this
    mailbox. Preview: "grants <email> full access to your mailbox".
  - `delete_forwarding_address` / `delete_delegate` — confirm (removing access).
- NORMAL (reversible-enough, ungated): create/list/delete_filter (a filter is
  reversible by deleting it), vacation, imap/pop, language, list_*, send-as
  signature update.
  (Note: `create_filter` is not gated — worst case it mislabels/archives, fully
  reversible; but its preview-free. `delete_filter` likewise.)
- Multi-account: every tool takes `account` (defaults to the email default
  identity), same as existing email-smart tools.

## 4. Filter ergonomics (the flagship — Santo's "auto-route to Critical")

`create_filter` input: `{ account?, criteria: {from?, to?, subject?, query?,
has_attachment?, exclude_chats?, negated_query?, size?, size_comparison?},
action: {add_label_ids?, remove_label_ids?, forward?} }`. Support label NAME
resolution: accept label names in add/remove and resolve to ids via the existing
label listing (so "route to Critical, skip inbox" = add "Critical", remove
"INBOX"). Return the created filter id.

## 5. Build + done

Subagent-driven (A then B, sequential). Adversarial cross-verify (gating on
delete/forwarding/delegates, filter label resolution, scope error mapping).
LIVE E2E (SAFE, self-cleaning): create_filter -> list -> delete_filter;
get_vacation; list_send_as; get_imap. Permanent delete + forwarding + delegates
are NOT live-tested (irreversible / security side effects) — unit + gating
verified only, stated honestly. Then bump the email auth CLI scope, register
(already registered — just rebuild), and hand off the re-auth (needs the 3 scopes
registered on the consent screen first).

Done = code + integrated + unit/typecheck/boot verified + adversarially
cross-verified + the reversible paths live-verified; irreversible paths honestly
labeled unit-only.
