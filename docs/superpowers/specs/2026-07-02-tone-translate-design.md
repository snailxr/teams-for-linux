# Tone & Translate — Polish Button Group — Design

Date: 2026-07-02

## Goal

Extend the existing `polishInput` compose-box feature so a single button becomes
a small **split-button group**. The primary `✨` click still polishes the draft;
a `▾` caret opens a menu of additional rewrite actions:

- **🍩 Formal** — rewrite the draft in a formal tone
- **😊 Friendly** — rewrite in a warmer, friendlier tone
- **✂ Shorter** — make the draft more concise
- **文 Translate ▸** — submenu of configured target languages (default
  `English`, `中文`); translate the draft into the chosen language

All actions are just a polish with a different instruction, so they reuse the
existing `polish-text` IPC handler by varying the `requirement` string.

## Decisions

- **UI model:** split button. `✨` = primary Polish (unchanged behaviour); a
  `▾` caret toggles a dropdown menu with the four actions above. Chosen over an
  inline button row to keep the Teams compose toolbar uncluttered and match
  native Teams overflow-menu conventions.
- **Translate target:** a configurable language list rendered as a submenu under
  **Translate ▸**. Pick per-message; no typing. Default `["English", "中文"]`.
- **IPC:** reuse the existing `polish-text` channel. Tone/translate pass their
  instruction as the `requirement` field, which the main-process prompt already
  appends as "Extra instruction for this rewrite". **No new IPC channel**, so no
  additions to `app/security/ipcValidator.js` and no `generate-ipc-docs` run
  required.
- **Main process:** `app/polishInput/index.js` is **unchanged** — the existing
  `requirement` param carries the tone/language instruction.
- **Requirement strings** (built browser-side):
  - Formal → `rewrite in a formal, professional tone`
  - Friendly → `rewrite in a warm, friendly tone`
  - Shorter → `make it as concise as possible while keeping the meaning`
  - Translate → `translate into <language>` (e.g. `translate into 中文`)
- **Config:** new option `polishTranslateLanguages: string[]`, default
  `["English", "中文"]`, read in `init(config, ipcRenderer)`. Documented in
  `docs-site/docs/configuration.md`.

## Files

- `app/browser/tools/polishInput.js` — main changes (button group, menu,
  submenu, generalized `#rewrite`).
- `app/config/options.js` — register the `polishTranslateLanguages` option and
  its default, following the existing option definitions (e.g. `quickChat`).
- `docs-site/docs/configuration.md` — document the new option.
- `tests/unit/polishInput.test.js` (or existing polish test file) — unit tests
  for requirement-string construction and directive parsing.

## Component detail: `polishInput.js`

- **Group container:** replace the lone `<button id="tfl-polish-button">` with a
  container (`id="tfl-polish-group"`) holding the `✨` button and a `▾` caret
  button, styled as one grouped control. The MutationObserver guards on the
  **container** id and re-inserts the whole group when Teams rebuilds the
  toolbar.
- **Menu:** the caret toggles an absolutely-positioned menu `div`. Items call a
  shared `#rewrite(requirement)` method — the current `#polish` logic
  generalized to take a requirement string. `✨` calls `#rewrite("")` (plain
  polish, identical to today). `#rewrite` still respects any `polish:` directive
  lines in the draft, joining them with the action requirement.
- **Translate submenu:** built from `config.polishTranslateLanguages`. Each entry
  yields requirement `translate into <language>`.
- **Menu dismissal:** closes on selection, outside-click, and `Escape`.
- **Busy / error:** reuse existing `#setBusy` / `#flashError` on the `✨` button
  so all actions share one visible busy/error affordance.

## Error handling

- Empty draft, missing compose box, or IPC failure → existing `#flashError`
  path (brief red flash), unchanged.
- Missing/empty `polishTranslateLanguages` config → fall back to the default
  `["English", "中文"]` so Translate is never empty.

## Testing

- Unit: requirement-string builders for each action; `parsePolishDirective`
  combined with an action requirement; language-submenu construction from
  config (including the empty-config fallback).
- Manual: verify the group re-inserts after Teams navigation, menu opens/closes
  correctly, each action rewrites the draft, and translate honours the chosen
  language.

## Out of scope (YAGNI)

- Per-action busy indicators (one shared busy state is enough).
- Free-text "translate into arbitrary language" input (config list covers it).
- Keyboard shortcuts for individual actions.
- Changes to `conversationSummary` or the main-process prompt.
