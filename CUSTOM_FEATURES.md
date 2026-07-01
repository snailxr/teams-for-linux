# Custom Features

Local customizations layered on top of upstream teams-for-linux. Add an entry
here whenever a new custom feature is added, so the full list stays in one place.

## Polish Input (`claude -p`)

Adds a ✨ button to the Teams compose toolbar that rewrites the current draft
via the `claude -p` CLI (run in the main process) and replaces the box with the
result. A line beginning with `polish:` in the draft is pulled out as an extra
instruction for the rewrite and stripped before sending.

- `app/polishInput/index.js` — `polish-text` IPC handler (runs `claude -p` via `execFile`)
- `app/browser/tools/polishInput.js` — toolbar button + `polish:` parser
- `tests/unit/polishInput.test.js` — parser test
- Wiring: `app/browser/preload.js` (module list + IPC set), `app/security/ipcValidator.js` (allowlist), `app/index.js` (handler registration)
- Env: `TFL_CLAUDE_BIN` overrides the `claude` binary path (default `claude`, with `~/.local/bin` on PATH)

## Conversation Summary & Draft Reply (`claude -p`)

Adds two buttons to the Teams compose toolbar:

- 📋 **Summarize** — reads the latest 20 messages from the open chat/thread
  (scraped from the rendered DOM) and shows a `claude -p` summary in a popup
  with a Copy button. Never touches the draft.
- 💬 **Draft reply** — reads the latest 20 messages and drops a generated reply
  into the compose box.

For both, any text already in the compose box is sent as a steering prompt
(focus the summary / instruct the reply).

- `app/conversationSummary/index.js` — `conversation-assist` IPC handler (prompt builder + `claude -p`)
- `app/browser/tools/conversationSummary.js` — buttons, DOM message scrape, popup, compose fill
- `app/_claudeRunner.js` — shared `claude -p` runner (also used by Polish Input)
- `app/browser/tools/_composeReplace.js` — shared compose-box replace (also used by Polish Input)
- `tests/unit/conversationSummary.test.js` — scrape + prompt-builder tests
- Wiring: `app/browser/preload.js`, `app/index.js`, `app/security/ipcValidator.js`
- Message DOM selectors live in `conversationSummary.js` (`MESSAGE_ITEM_SELECTORS` etc.) and may need updating when Teams changes its markup.
