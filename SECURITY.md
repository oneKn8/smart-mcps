# Security

These servers handle real credentials: OAuth tokens for Gmail and Google Workspace, and API keys for cloud providers. Reports are taken seriously.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the Security tab of this repository, then "Report a vulnerability". Do not open a public issue for anything exploitable.

This project is maintained by one person; expect acknowledgment within a few days.

## Scope notes

- All servers run locally over MCP stdio. No credential ever leaves your machine except to the upstream API it belongs to.
- Credentials resolve from process env and `~/.config/smart-mcps/.env` (mode 600). Client configs never carry env values.
- Destructive operations are gated behind explicit `confirm` flags server-side; reports of gate bypasses are especially welcome.
