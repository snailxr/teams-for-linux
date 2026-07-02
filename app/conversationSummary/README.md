# Conversation Summary Module (custom)

Summarizes the open Teams conversation or drafts a reply to it with the
`claude -p` CLI.

> Custom fork feature — not part of upstream teams-for-linux. See
> [CUSTOM_FEATURES.md](../../CUSTOM_FEATURES.md) for the full list.

## Overview

Two buttons are injected into the Teams compose toolbar:

- 📋 **Summarize** — scrapes the latest 20 rendered messages, sends them to
  `claude -p`, and shows the structured summary (Summary / Decisions / Action
  items) in a dismissable popup with a Copy button. Never touches the draft.
- 💬 **Draft reply** — same scrape, but generates a reply and drops it into the
  compose box.

Any text already in the compose box is passed along as a steering prompt
("focus on the deploy discussion", "decline politely", …).

## Architecture

```
app/conversationSummary/
├── index.js   # conversation-assist IPC handler: validate -> buildPrompt -> claude -p
└── README.md

app/browser/tools/conversationSummary.js  # buttons, DOM scrape, popup, compose fill
app/_claudeRunner.js                      # shared claude -p runner
app/browser/tools/_composeReplace.js      # compose replace + appendSafeHtml renderer
```

Exported for unit tests: `buildPrompt`, `stripReplyPreamble`,
`CLAUDE_TIMEOUT_MS` (main) and `extractMessages` (browser tool).

## Limits & timeouts

| Constant | Value | Where | Why |
|----------|-------|-------|-----|
| `MAX_MESSAGES` | 20 | browser tool | latest rendered messages only |
| `MAX_INPUT_CHARS` | 16000 | handler | rejects oversized transcripts |
| `CLAUDE_TIMEOUT_MS` | 120000 | handler | an 11k-char prompt measured ~34s; 30s killed real calls |

## IPC Channels

| Channel | Type | Description |
|---------|------|-------------|
| `conversation-assist` | handle | `{ mode: "summary"\|"reply", messages, prompt }` → minimal-HTML result |

## How It Works

1. Message items are found with a defensive selector cascade
   (`MESSAGE_ITEM_SELECTORS` / `AUTHOR_SELECTORS` / `BODY_SELECTORS`) — Teams
   changes markup without notice, so these are the first thing to check when
   scraping breaks.
2. The handler validates shape/size, builds a one-shot prompt (minimal-HTML
   output contract), and runs `claude -p` (no shell, stdin closed immediately).
3. Summary mode renders into the popup via `appendSafeHtml`; reply mode strips
   any model lead-in (`stripReplyPreamble`) and pastes into the compose box.

## Gotchas

- **Trusted Types**: Teams enforces `require-trusted-types-for 'script'`, so
  assigning `innerHTML` (or calling `DOMParser.parseFromString`) throws a
  `TypeError`. The popup body is therefore built node-by-node by
  `appendSafeHtml()` (`_composeReplace.js`) against a strict allowlist
  (`<b> <i> <code> <ul> <ol> <li> <br>`, bare tags only) — which is also the
  injection-safety boundary, since summaries derive from untrusted chat text.
- The generic "Summarize failed" toast hides the real error; the terminal
  (main process) logs the request shape, rejection reasons, and
  `[CLAUDE_RUNNER]` success/failure mechanics, and the renderer logs the error
  stack in DevTools (Ctrl+D).
- Logs must stay shape-only (counts/durations/exit codes, never message
  content) per the PII logging rules.

## Related

- [app/polishInput/README.md](../polishInput/README.md) — sibling claude-assist feature
- Design spec: `docs/superpowers/specs/2026-06-30-conversation-summary-design.md`
