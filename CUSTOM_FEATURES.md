# Custom Features

Local customizations layered on top of upstream teams-for-linux. Add an entry
here whenever a new custom feature is added, so the full list stays in one place.

Each feature also has a module README with full details:

- [app/polishInput/README.md](app/polishInput/README.md)
- [app/conversationSummary/README.md](app/conversationSummary/README.md)

## Polish Input — Tone & Translate (`claude -p`)

Adds a ✨ split-button group to the Teams compose toolbar:

- ✨ **Polish** — rewrites the current draft via the `claude -p` CLI (run in
  the main process) and replaces the box with the result. A line beginning with
  `polish:` in the draft is pulled out as an extra instruction for the rewrite
  and stripped before sending.
- ▾ **Menu** — 🍩 Formal / 😊 Friendly / ✂ Shorter tone rewrites, plus a
  文 **Translate** submenu listing the languages from the
  `polishTranslateLanguages` config option (default `["English", "中文"]`).
  All actions reuse the same `polish-text` IPC handler, passing the action as
  the `requirement` instruction.

- `app/polishInput/index.js` — `polish-text` IPC handler (runs `claude -p` via `execFile`)
- `app/browser/tools/polishInput.js` — button group, dropdown menu, `polish:` parser, action requirements
- `tests/unit/polishInput.test.js` — parser, action-requirement, and requirement-combining tests
- Config: `polishTranslateLanguages` (array, `applyMode: restart`) in `app/config/options.js`
- Wiring: `app/browser/preload.js` (module list + IPC set), `app/security/ipcValidator.js` (allowlist), `app/index.js` (handler registration)
- Env: `TFL_CLAUDE_BIN` overrides the `claude` binary path (default `claude`, with `~/.local/bin` on PATH)

> [!NOTE]
> The dropdown menu must be `position: fixed` (placed at the caret's viewport
> coordinates) — the Teams compose toolbar clips absolutely-positioned
> children, so a `position: absolute` dropdown silently never shows.

## Conversation Summary & Draft Reply (`claude -p`)

Adds two buttons to the Teams compose toolbar:

- 📋 **Summarize** — reads the latest 20 messages from the open chat/thread
  (scraped from the rendered DOM) and shows a `claude -p` summary in a popup
  with a Copy button. Never touches the draft.
- 💬 **Draft reply** — reads the latest 20 messages and drops a generated reply
  into the compose box.

For both, any text already in the compose box is sent as a steering prompt
(focus the summary / instruct the reply).

- `app/conversationSummary/index.js` — `conversation-assist` IPC handler (prompt builder + `claude -p`, 120s timeout)
- `app/browser/tools/conversationSummary.js` — buttons, DOM message scrape, popup, compose fill
- `app/_claudeRunner.js` — shared `claude -p` runner (also used by Polish Input); logs PII-safe failure mechanics (duration, exit code/signal)
- `app/browser/tools/_composeReplace.js` — shared compose-box replace + `appendSafeHtml` popup renderer (also used by Polish Input)
- `tests/unit/conversationSummary.test.js`, `tests/unit/conversationSummaryTimeout.test.js`, `tests/unit/composeReplace.test.js`
- Wiring: `app/browser/preload.js`, `app/index.js`, `app/security/ipcValidator.js`
- Message DOM selectors live in `conversationSummary.js` (`MESSAGE_ITEM_SELECTORS` etc.) and may need updating when Teams changes its markup.

> [!IMPORTANT]
> Teams enforces a **Trusted Types** CSP (`require-trusted-types-for 'script'`):
> any `innerHTML` assignment (and `DOMParser.parseFromString`) throws a
> `TypeError` in the Teams page. Never render with `innerHTML` in browser
> tools — build nodes programmatically. `appendSafeHtml()` in
> `_composeReplace.js` does this against a strict tag allowlist and is the
> shared way to render model output.

## Shared conventions

- Both features shell out to `claude -p` one-shot (no session, no tools) via
  `app/_claudeRunner.js`; the model must return minimal HTML using only
  `<b> <i> <code> <ul> <ol> <li> <br>`.
- Diagnostics are shape-only (counts, durations, exit codes) — never message
  content, per the project's PII logging rules.
- Toolbar buttons are re-inserted by body-wide `MutationObserver`s because
  Teams rebuilds the compose toolbar on navigation.
