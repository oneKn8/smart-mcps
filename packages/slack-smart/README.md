# slack-smart

Smart MCP for Slack: read/search/post across channels, DMs and threads, with confirm-gated writes and catch-up shortcuts.

Tools are added incrementally per build task.

## Required credentials

Add to `~/.config/smart-mcps/.env` (chmod 600):

```
SLACK_USER_TOKEN=xoxp-...
# Optional — required only for tools that act as a bot:
SLACK_BOT_TOKEN=xoxb-...
```
