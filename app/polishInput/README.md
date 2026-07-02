# Polish Input Module (custom)

Rewrites the compose-box draft with the `claude -p` CLI: polish, tone shifts
(formal / friendly / shorter), and translation into configured languages.

> Custom fork feature — not part of upstream teams-for-linux. See
> [CUSTOM_FEATURES.md](../../CUSTOM_FEATURES.md) for the full list.

## Overview

A ✨ split-button group is injected into the Teams compose toolbar, next to
Send. The primary ✨ click polishes the draft; a ▾ caret opens a dropdown with
tone actions and a Translate submenu. Every action sends the draft plus an
instruction (`requirement`) to the main process, which runs `claude -p` and
replaces the draft with the result via a CKEditor-compatible synthetic paste.

## Features

- **✨ Polish**: fix grammar/wording, keep language and meaning
- **`polish:` directive**: a draft line like `polish: make it two sentences`
  becomes an extra instruction and is stripped from the sent text
- **🍩 Formal / 😊 Friendly / ✂ Shorter**: one-click tone rewrites
- **文 Translate ▸**: submenu of target languages from config

## Architecture

```
app/polishInput/
├── index.js   # polish-text IPC handler -> _claudeRunner (execFile claude -p)
└── README.md

app/browser/tools/polishInput.js   # button group, menu, parser, requirements
app/_claudeRunner.js               # shared claude -p runner (120s default timeout)
app/browser/tools/_composeReplace.js  # shared compose-box replacement
```

Exported for unit tests: `parsePolishDirective`, `buildActionRequirement`,
`combineRequirements` (browser tool) and `buildPrompt` (main process).

## Configuration

```json
{
  "polishTranslateLanguages": ["English", "中文"]
}
```

Languages shown in the Translate submenu (`applyMode: restart`; falls back to
the default when empty). Env: `TFL_CLAUDE_BIN` overrides the `claude` binary.

## IPC Channels

| Channel | Type | Description |
|---------|------|-------------|
| `polish-text` | handle | Rewrite draft text via `claude -p`; payload `{ text, requirement }` |

## How It Works

1. `MutationObserver` re-inserts the button group whenever Teams rebuilds the
   compose toolbar (guarded by the group container id).
2. A click reads the draft (`innerText`), extracts `polish:` directives, and
   merges them with the menu action's requirement (`"; "`-joined).
3. The main process builds a one-shot prompt (minimal-HTML output contract)
   and runs `claude -p` with no shell (`execFile`).
4. The result replaces the draft through a synthetic Ctrl+A + paste — the only
   path that keeps CKEditor's model in sync.

## Gotchas

- The dropdown must stay `position: fixed`, placed at the caret's viewport
  coordinates on open — the Teams toolbar clips `position: absolute` children,
  which presents as "clicking ▾ does nothing".
- Never render model output with `innerHTML`: Teams enforces a Trusted Types
  CSP that makes the assignment throw (see the conversationSummary README).
- Logs must stay shape-only (no draft text) per the PII logging rules.

## Related

- [app/conversationSummary/README.md](../conversationSummary/README.md) — sibling claude-assist feature
- Design spec: `docs/superpowers/specs/2026-07-02-tone-translate-design.md`
