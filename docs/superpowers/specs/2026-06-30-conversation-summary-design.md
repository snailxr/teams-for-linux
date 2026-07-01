# Conversation Summary & Draft Reply — Design

Date: 2026-06-30

## Goal

Two custom AI features layered on teams-for-linux, mirroring the existing
`polishInput` pattern:

1. **Summarize** the open conversation (chat thread or 1:1/group), defaulting to
   the latest 20 messages. Output shown in a dismissable popup with a Copy button.
2. **Draft reply** — read the conversation and generate a reply, dropping it into
   the compose box.

For **both**, any text already in the compose box is used as a steering prompt
(focuses the summary / instructs the reply).

## Decisions

- **Message source:** read the rendered DOM — the same mechanism `polishInput`
  uses to read the draft (`compose.innerText`). No Graph API, no config, no
  scopes. Only rendered messages are reachable; the latest ~20 normally are.
- **Count:** latest 20, a constant. Not configurable yet (YAGNI).
- **Triggers:** two toolbar buttons inserted before Send, next to ✨ Polish.
  - 📋 Summarize → popup overlay, never touches the draft.
  - 💬 Draft reply → fills the compose box, replacing current content.
- **Code reuse:** extract polishInput's compose-replace and `claude -p` runner
  into shared helpers; both tools import them.

## Files

| File | Role |
|------|------|
| `app/browser/tools/conversationSummary.js` | 2 buttons, DOM scrape, popup, compose fill |
| `app/conversationSummary/index.js` | main-process IPC handler → `claude -p` |
| `app/browser/tools/_composeReplace.js` | shared: select-all + synthetic paste into the compose box |
| `app/_claudeRunner.js` | shared: bin/env/execFile runner for `claude -p` |
| `tests/unit/conversationSummary.test.js` | message scrape + prompt builder tests |

Refactor: `polishInput.js` and `app/polishInput/index.js` switch to the shared
helpers (no behavior change).

Wiring (same 3 points as polishInput):
- `app/browser/preload.js` — add `conversationSummary` to the module list and to
  the `modulesRequiringIpc` set.
- `app/index.js` — require and register the handler.
- `app/security/ipcValidator.js` — allowlist `conversation-assist`.
- `CUSTOM_FEATURES.md` — add an entry.

## Browser tool (`conversationSummary.js`)

- MutationObserver re-inserts both buttons when Teams rebuilds the toolbar
  (same as polishInput's `#ensureButton`).
- **Message scrape** — `scrapeMessages(limit = 20)`:
  - Find message items via a defensive selector cascade (candidates, most
    specific first), e.g. `[data-tid="chat-pane-item"]`, `div[role="listitem"]`
    within the message region, message-content `data-tid` hooks.
  - For each item, best-effort `{ author, text }`: author from a known
    author-name hook if present, text from the message body / item `innerText`.
  - Take the last `limit` items, oldest-first.
  - `ponytail:` selectors are a starting cascade; **must be verified against the
    live Teams DOM** — Teams changes markup without notice.
  - Exported pure-ish parser (operates on a passed-in NodeList/array) so it's
    unit-testable without a real DOM.
- **Summarize click:** scrape → read compose-box text as optional focus →
  `ipcRenderer.invoke("conversation-assist", { mode: "summary", messages, prompt })`
  → render returned HTML in a popup overlay (injected styles, Copy + Close).
  Copy uses `navigator.clipboard.writeText` on the plain-text form.
- **Draft reply click:** scrape → read compose-box text as the instruction →
  `invoke("conversation-assist", { mode: "reply", messages, prompt })` →
  `composeReplace(compose, html)` (shared helper).
- Busy/error states on the buttons, same as polishInput (`⋯`, red flash).

## Main process (`conversationSummary/index.js`)

- One IPC handler `conversation-assist`, payload `{ mode, messages, prompt }`.
- Validate: `messages` non-empty array of `{ author, text }`; total serialized
  length capped (~16k chars); `mode` in `{summary, reply}`.
- Build the prompt per mode:
  - **summary:** "Summarize this Microsoft Teams conversation (oldest first).
    Key points, decisions, action items / open questions. Minimal HTML only
    (`<b> <i> <ul> <ol> <li> <br>`), no preamble." + optional focus from `prompt`.
  - **reply:** "Draft a reply to the latest message in this Teams conversation.
    Natural, concise, matches the conversation's language. Minimal HTML only…"
    + the user's `prompt` as the primary instruction.
- Run via the shared `claude -p` runner (timeout, `~/.local/bin` on PATH,
  execFile — never a shell, so message text can't be parsed as shell syntax).
- Reject with a generic error message on failure / empty output (no PII in logs;
  log only `err.message` / counts).

## Shared helpers

- `app/_claudeRunner.js` — `runClaude(promptString) => Promise<string>`: resolves
  `TFL_CLAUDE_BIN || "claude"`, prepends `~/.local/bin` to PATH, `execFile` with
  `timeout` + `maxBuffer`, trims stdout, rejects on error/empty. Lifted verbatim
  from polishInput.
- `app/browser/tools/_composeReplace.js` — `composeReplace(compose, html)`:
  focus → synthetic Ctrl+A (CKEditor select-all) → synthetic paste of
  `text/html` + `text/plain`. Lifted verbatim from polishInput, including the
  `htmlToPlain` helper.

## Testing

`tests/unit/conversationSummary.test.js`:
- Message scrape parser: given a fake list of message nodes, returns the last N
  as `{author, text}`, oldest-first, skipping empties.
- Prompt builder: summary vs reply mode produce the right instruction; the
  compose-box `prompt` is woven in; messages are serialized in order.

No E2E/selector test — live-DOM selectors are verified manually when running the
app (`npm start`), per the defensive-browser-script note in CLAUDE.md.

## Out of scope

- Graph API message fetch (off-screen messages).
- Configurable / directive-driven message count.
- Channel-specific handling beyond what the DOM scrape naturally covers.
