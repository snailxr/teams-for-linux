# Conversation Summary & Draft Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two AI buttons to the Teams compose toolbar — 📋 Summarize (latest 20 messages → popup) and 💬 Draft reply (latest 20 messages → compose box) — reading messages from the rendered DOM and calling `claude -p`.

**Architecture:** Mirrors the existing `polishInput` feature. A browser tool scrapes the message list from the DOM and renders UI; a main-process handler runs `claude -p`. polishInput's compose-replace and `claude -p` runner are extracted into shared helpers that both features import.

**Tech Stack:** Electron (main + preload/renderer CommonJS modules), `node:test` for unit tests, `claude` CLI via `execFile`.

## Global Constraints

- No `var`; `const` by default, `let` only for reassignment.
- `async/await`, not promise chains. JS `#private` fields for class privates.
- Browser scripts must be defensive — Teams DOM changes without notice.
- No PII in logs — log only `err.message` and counts, never message text/authors.
- All IPC channels go in the allowlist `app/security/ipcValidator.js`.
- Run `claude` via `execFile` (no shell) so input can't be parsed as shell syntax.
- Test command: `npm run test:unit` (`node --test 'tests/unit/*.test.js'`). Lint: `npm run lint`.
- Commits happen only when the human asks (project rule: never auto-commit). The "Commit" steps below are the intended boundaries; pause for the human at each.

---

### Task 1: Shared `claude -p` runner + refactor polishInput handler

**Files:**
- Create: `app/_claudeRunner.js`
- Modify: `app/polishInput/index.js`
- Test (safety net, unchanged): `tests/unit/polishInput.test.js`

**Interfaces:**
- Produces: `runClaude(prompt: string, opts?: {timeoutMs?: number}) => Promise<string>` from `app/_claudeRunner.js`. Resolves trimmed stdout; rejects on exec error or empty output.

- [ ] **Step 1: Create the shared runner**

`app/_claudeRunner.js`:

```js
const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 1024 * 1024;

// Run `claude -p <prompt>` and resolve with trimmed stdout. Runs the binary
// directly (execFile, no shell) so prompt text can never be parsed as shell
// syntax. Electron's launch env often lacks ~/.local/bin (the common claude CLI
// install location), so prepend it. TFL_CLAUDE_BIN overrides the binary.
function runClaude(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bin = process.env.TFL_CLAUDE_BIN || "claude";
  const localBin = path.join(os.homedir(), ".local", "bin");
  const env = {
    ...process.env,
    PATH: `${localBin}${path.delimiter}${process.env.PATH || ""}`,
  };
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-p", prompt],
      { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const out = String(stdout).trim();
        if (!out) {
          reject(new Error("claude returned empty output"));
          return;
        }
        resolve(out);
      },
    );
  });
}

module.exports = { runClaude };
```

- [ ] **Step 2: Refactor polishInput to use the runner**

Replace the body of `app/polishInput/index.js` (keep `buildPrompt` exactly as-is) with:

```js
const { ipcMain } = require("electron");
const { runClaude } = require("../_claudeRunner");

const LOG_PREFIX = "[POLISH_INPUT]";
const MAX_INPUT_CHARS = 8000;

// Build the one-shot prompt handed to `claude -p`. The optional requirement
// (parsed from a `polish:` line in the draft) becomes an extra instruction.
function buildPrompt(text, requirement) {
  const extra = requirement
    ? ` Extra instruction for this rewrite: ${requirement}.`
    : "";
  return (
    "Polish the following message for a Microsoft Teams chat: fix grammar and " +
    "wording, and make it clear, simple, and easy to understand. Keep it " +
    "concise and natural, and add light structure (emphasis or bullet lists) " +
    "only where it improves readability. Preserve the original language and " +
    "meaning. Return the result as minimal HTML using ONLY these tags: <b>, " +
    "<i>, <code>, <ul>, <ol>, <li>, <br>. Do NOT use markdown, code fences, " +
    `or any preamble — return ONLY the HTML message.${extra}\n\nMessage:\n${text}`
  );
}

// Register the main-process handler that rewrites a compose-box draft via the
// `claude -p` CLI.
function registerPolishInput() {
  ipcMain.handle("polish-text", async (_event, payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    const requirement =
      typeof payload?.requirement === "string"
        ? payload.requirement.trim()
        : "";

    if (!text) throw new Error("Nothing to polish");
    if (text.length > MAX_INPUT_CHARS) throw new Error("Message too long to polish");

    try {
      return await runClaude(buildPrompt(text, requirement));
    } catch (err) {
      console.error(`${LOG_PREFIX} claude failed: ${err.message}`);
      throw new Error("Polish failed");
    }
  });
  console.info(`${LOG_PREFIX} Registered polish-text handler`);
}

module.exports = { registerPolishInput, buildPrompt };
```

- [ ] **Step 3: Run the safety-net test + lint**

Run: `npm run test:unit && npm run lint`
Expected: PASS. `polishInput.test.js` still passes (`buildPrompt` and `parsePolishDirective` unchanged). No lint errors.

Note: `runClaude` is thin execFile wiring with no new branching logic — no unit test, matching polishInput's prior state. It's exercised at runtime and in Task 7's manual run.

- [ ] **Step 4: Commit** (only if the human asks)

```bash
git add app/_claudeRunner.js app/polishInput/index.js
git commit -m "refactor: extract shared claude -p runner from polishInput"
```

---

### Task 2: Shared compose-replace helper + refactor polishInput browser tool

**Files:**
- Create: `app/browser/tools/_composeReplace.js`
- Modify: `app/browser/tools/polishInput.js`
- Test (safety net, unchanged): `tests/unit/polishInput.test.js`

**Interfaces:**
- Produces: `composeReplace(compose: Element, html: string) => Promise<void>` and `htmlToPlain(html: string) => string` from `app/browser/tools/_composeReplace.js`.

- [ ] **Step 1: Create the shared compose-replace helper**

`app/browser/tools/_composeReplace.js`:

```js
// Shared: replace the entire Teams compose-box draft with minimal HTML.
// Lifted from polishInput so other tools can reuse it. Uses CKEditor's own
// select-all + a synthetic paste (the CKEditor-5-compatible path customStickers
// uses); setting innerHTML would not sync CKEditor's model.

function htmlToPlain(html) {
  return String(html)
    .replace(/<li>/gi, "• ")
    .replace(/<\/(p|li|ul|ol|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function composeReplace(compose, html) {
  compose.focus();
  // Brief delay lets the focus event flush before we drive the editor.
  await new Promise((r) => setTimeout(r, 30));

  // A native DOM Range does NOT update CKEditor 5's model selection, so a paste
  // would append at the caret. A synthetic Ctrl+A triggers CKEditor's SelectAll
  // command, which sets the model selection synchronously, so the paste replaces
  // the whole draft.
  // ponytail: assumes Teams uses CKEditor 5; revisit if Teams swaps editors
  compose.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      which: 65,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await new Promise((r) => setTimeout(r, 10));

  const dt = new DataTransfer();
  dt.setData("text/html", html);
  dt.setData("text/plain", htmlToPlain(html));
  const event = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  compose.dispatchEvent(event);
}

module.exports = { composeReplace, htmlToPlain };
```

- [ ] **Step 2: Point polishInput at the shared helper**

In `app/browser/tools/polishInput.js`:

Add this require near the top (after the file's opening doc comment, before `const LOG_PREFIX`):

```js
const { composeReplace } = require("./_composeReplace");
```

Delete the two methods `#replaceCompose(compose, html)` and `#htmlToPlain(html)` entirely.

In `#polish`, replace the final line `await this.#replaceCompose(compose, polished);` with:

```js
    await composeReplace(compose, polished);
```

- [ ] **Step 3: Run the safety-net test + lint**

Run: `npm run test:unit && npm run lint`
Expected: PASS. `parsePolishDirective` tests unchanged; no unused-variable lint errors (confirm `#replaceCompose`/`#htmlToPlain` are fully removed).

- [ ] **Step 4: Commit** (only if the human asks)

```bash
git add app/browser/tools/_composeReplace.js app/browser/tools/polishInput.js
git commit -m "refactor: extract shared composeReplace helper from polishInput"
```

---

### Task 3: conversation-assist main handler (TDD on buildPrompt)

**Files:**
- Create: `app/conversationSummary/index.js`
- Test: `tests/unit/conversationSummary.test.js` (new — buildPrompt section)

**Interfaces:**
- Consumes: `runClaude` (Task 1).
- Produces: `registerConversationSummary() => void` and `buildPrompt(mode: "summary"|"reply", messages: {author,text}[], prompt: string) => string` from `app/conversationSummary/index.js`. IPC channel `conversation-assist` with payload `{ mode, messages, prompt }` resolving to an HTML string.

- [ ] **Step 1: Write the failing buildPrompt tests**

`tests/unit/conversationSummary.test.js`:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { buildPrompt } = require('../../app/conversationSummary');

describe('buildPrompt', () => {
  const msgs = [
    { author: 'Alice', text: 'when is the release?' },
    { author: 'Bob', text: 'friday' },
  ];

  it('summary mode summarizes, transcript oldest-first, no steer when prompt empty', () => {
    const p = buildPrompt('summary', msgs, '');
    assert.ok(/summarize/i.test(p));
    assert.ok(p.indexOf('Alice: when is the release?') < p.indexOf('Bob: friday'));
    assert.ok(!p.includes('User instruction'));
  });

  it('reply mode asks for a reply and weaves in the steer prompt', () => {
    const p = buildPrompt('reply', msgs, 'decline politely');
    assert.ok(/draft a reply/i.test(p));
    assert.ok(p.includes('User instruction: decline politely'));
  });

  it('falls back to Unknown author label', () => {
    const p = buildPrompt('summary', [{ author: '', text: 'hi' }], '');
    assert.ok(p.includes('Unknown: hi'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/conversationSummary.test.js`
Expected: FAIL — `Cannot find module '../../app/conversationSummary'`.

- [ ] **Step 3: Implement the handler**

`app/conversationSummary/index.js`:

```js
const { ipcMain } = require("electron");
const { runClaude } = require("../_claudeRunner");

const LOG_PREFIX = "[CONVERSATION_SUMMARY]";
const MAX_INPUT_CHARS = 16000;
const MODES = new Set(["summary", "reply"]);

const HTML_RULE =
  "Return the result as minimal HTML using ONLY these tags: <b>, <i>, <code>, " +
  "<ul>, <ol>, <li>, <br>. Do NOT use markdown, code fences, or any preamble — " +
  "return ONLY the HTML.";

// Build the one-shot prompt for `claude -p`. `messages` is [{author,text}]
// oldest-first; `prompt` is optional steering text typed in the compose box.
function buildPrompt(mode, messages, prompt) {
  const transcript = messages
    .map((m) => `${m.author || "Unknown"}: ${m.text}`)
    .join("\n");
  const steer = prompt ? `\n\nUser instruction: ${prompt}` : "";
  if (mode === "reply") {
    return (
      "You are helping the user reply in a Microsoft Teams chat. Read the " +
      "conversation below (oldest first) and draft a reply to the latest " +
      "message. Keep it natural, concise, and in the same language as the " +
      `conversation. ${HTML_RULE}${steer}\n\nConversation:\n${transcript}`
    );
  }
  return (
    "Summarize the following Microsoft Teams conversation (oldest first). Give " +
    "a concise summary of the key points, decisions, and any action items or " +
    `open questions. ${HTML_RULE}${steer}\n\nConversation:\n${transcript}`
  );
}

// Register the main-process handler: conversation messages -> claude -p ->
// summary or drafted reply (minimal HTML).
function registerConversationSummary() {
  ipcMain.handle("conversation-assist", async (_event, payload) => {
    const mode = payload?.mode;
    if (!MODES.has(mode)) throw new Error("Invalid mode");

    const raw = Array.isArray(payload?.messages) ? payload.messages : [];
    const prompt =
      typeof payload?.prompt === "string" ? payload.prompt.trim() : "";

    const messages = raw
      .map((m) => ({
        author: String(m?.author || "").trim(),
        text: String(m?.text || "").trim(),
      }))
      .filter((m) => m.text);

    if (!messages.length) throw new Error("No messages to process");

    const totalChars = messages.reduce((n, m) => n + m.text.length, 0);
    if (totalChars > MAX_INPUT_CHARS) throw new Error("Conversation too long");

    try {
      return await runClaude(buildPrompt(mode, messages, prompt));
    } catch (err) {
      console.error(`${LOG_PREFIX} claude failed: ${err.message}`);
      throw new Error("Assist failed");
    }
  });
  console.info(`${LOG_PREFIX} Registered conversation-assist handler`);
}

module.exports = { registerConversationSummary, buildPrompt };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/conversationSummary.test.js`
Expected: PASS (3 buildPrompt tests).

- [ ] **Step 5: Commit** (only if the human asks)

```bash
git add app/conversationSummary/index.js tests/unit/conversationSummary.test.js
git commit -m "feat: add conversation-assist handler (summarize / draft reply)"
```

---

### Task 4: conversationSummary browser tool (TDD on extractMessages)

**Files:**
- Create: `app/browser/tools/conversationSummary.js`
- Test: `tests/unit/conversationSummary.test.js` (extend with extractMessages section)

**Interfaces:**
- Consumes: `composeReplace`, `htmlToPlain` (Task 2); IPC `conversation-assist` (Task 3).
- Produces: a `ConversationSummary` instance with `init(config, ipcRenderer)`, plus `extractMessages(items, limit=20) => {author,text}[]` attached to the export for testing.

- [ ] **Step 1: Write the failing extractMessages tests**

Append to `tests/unit/conversationSummary.test.js`:

```js
const { extractMessages } = require('../../app/browser/tools/conversationSummary');

function fakeItem(author, body) {
  return {
    innerText: `${author}\n${body}`,
    querySelector(sel) {
      if (sel === '[data-tid="message-author-name"]') {
        return author ? { innerText: author } : null;
      }
      if (sel === '[data-tid="message-body-content"]') {
        return body ? { innerText: body } : null;
      }
      return null;
    },
  };
}

describe('extractMessages', () => {
  it('extracts author/text from items, oldest-first', () => {
    const r = extractMessages([fakeItem('Alice', 'hi'), fakeItem('Bob', 'hey')], 20);
    assert.deepStrictEqual(r, [
      { author: 'Alice', text: 'hi' },
      { author: 'Bob', text: 'hey' },
    ]);
  });

  it('keeps only the latest `limit` messages', () => {
    const items = [fakeItem('A', '1'), fakeItem('B', '2'), fakeItem('C', '3')];
    assert.deepStrictEqual(extractMessages(items, 2), [
      { author: 'B', text: '2' },
      { author: 'C', text: '3' },
    ]);
  });

  it('drops items with no text', () => {
    const r = extractMessages([fakeItem('A', ''), fakeItem('B', 'real')], 20);
    assert.deepStrictEqual(r, [{ author: 'B', text: 'real' }]);
  });

  it('falls back to Unknown author and item innerText body', () => {
    const bodyless = { innerText: 'just text', querySelector: () => null };
    assert.deepStrictEqual(extractMessages([bodyless], 20), [
      { author: 'Unknown', text: 'just text' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/conversationSummary.test.js`
Expected: FAIL — `Cannot find module '../../app/browser/tools/conversationSummary'`.

- [ ] **Step 3: Implement the browser tool**

`app/browser/tools/conversationSummary.js`:

```js
/**
 * Conversation Summary & Draft Reply Browser Tool
 *
 * Adds two buttons to the Teams compose toolbar:
 *  - 📋 Summarize: reads the latest messages in the open conversation and shows
 *    a summary (from `claude -p`) in a dismissable popup with a Copy button.
 *  - 💬 Draft reply: reads the latest messages and drops a generated reply into
 *    the compose box.
 *
 * For both, any text already in the compose box is sent as a steering prompt.
 *
 * Messages are read from the rendered DOM — the same approach polishInput uses
 * to read the draft. Buttons are (re)inserted with a MutationObserver because
 * Teams re-renders the compose toolbar on navigation.
 */

const { composeReplace, htmlToPlain } = require("./_composeReplace");

const LOG_PREFIX = "[CONVERSATION_SUMMARY]";
const SUMMARIZE_BTN_ID = "tfl-summarize-button";
const REPLY_BTN_ID = "tfl-reply-button";
const STYLES_ID = "tfl-assist-styles";
const POPUP_ID = "tfl-summary-popup";
const TOAST_ID = "tfl-assist-toast";
const MAX_MESSAGES = 20;

// Mirrors polishInput's compose cascade.
const COMPOSE_SELECTORS = [
  'div[id^="new-message-"]',
  'div[contenteditable="true"][role="textbox"][aria-label*="message" i]',
  'div[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[data-tid*="ckeditor"]',
  ".ck-editor__editable",
];

const SEND_SELECTORS = [
  'button[data-tid="newMessageCommandBar-send"]',
  'button[name="send"]',
  'button[data-tid="sendMessageCommandButton"]',
  'button[aria-label*="Send" i]',
  'button[title*="Send" i]',
];

// Defensive cascade for message items / authors / bodies.
// ponytail: starting guess — VERIFY against the live Teams DOM (Task 7); Teams
// changes markup without notice. Upgrade path: adjust these three lists.
const MESSAGE_ITEM_SELECTORS = [
  '[data-tid="chat-pane-item"]',
  'div[data-tid="chat-pane-message"]',
  'div[role="listitem"]',
  'div[data-tid^="message-"]',
];
const AUTHOR_SELECTORS = [
  '[data-tid="message-author-name"]',
  '[data-tid="messageAuthorName"]',
  'span[itemprop="name"]',
];
const BODY_SELECTORS = [
  '[data-tid="message-body-content"]',
  '[id^="content-"]',
  ".message-body-content",
  'div[dir="auto"]',
];

function pickText(item, selectors) {
  for (const sel of selectors) {
    let el = null;
    try {
      el = item.querySelector?.(sel);
    } catch {
      el = null;
    }
    const t = (el?.innerText ?? el?.textContent ?? "").trim();
    if (t) return t;
  }
  return "";
}

// Given an array of message-item elements (each exposing querySelector and
// innerText/textContent), return the latest `limit` as {author,text},
// oldest-first, dropping empties. Exported for unit testing.
function extractMessages(items, limit = MAX_MESSAGES) {
  const out = [];
  for (const item of items) {
    const text =
      pickText(item, BODY_SELECTORS) ||
      (item.innerText ?? item.textContent ?? "").trim();
    if (!text) continue;
    const author = pickText(item, AUTHOR_SELECTORS) || "Unknown";
    out.push({ author, text });
  }
  return out.slice(-limit);
}

class ConversationSummary {
  #ipcRenderer = null;
  #observer = null;

  init(config, ipcRenderer) {
    if (!ipcRenderer) {
      console.warn(`${LOG_PREFIX} ipcRenderer missing; tool disabled`);
      return;
    }
    this.#ipcRenderer = ipcRenderer;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.#mount(), {
        once: true,
      });
    } else {
      this.#mount();
    }
  }

  #mount() {
    try {
      this.#injectStyles();
      this.#ensureButtons();
      // ponytail: body-wide observer, cheap because ensureButtons short-circuits
      this.#observer = new MutationObserver(() => this.#ensureButtons());
      this.#observer.observe(document.body, { childList: true, subtree: true });
      console.info(`${LOG_PREFIX} Initialized`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to initialize: ${err.message}`);
    }
  }

  #findFirst(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  #ensureButtons() {
    const sendBtn = this.#findFirst(SEND_SELECTORS);
    if (!sendBtn?.parentElement) return;
    if (!document.getElementById(SUMMARIZE_BTN_ID)?.isConnected) {
      const b = this.#createButton(SUMMARIZE_BTN_ID, "📋", "Summarize conversation", () => this.#summarize());
      sendBtn.parentElement.insertBefore(b, sendBtn);
    }
    if (!document.getElementById(REPLY_BTN_ID)?.isConnected) {
      const b = this.#createButton(REPLY_BTN_ID, "💬", "Draft a reply with Claude", () => this.#reply());
      sendBtn.parentElement.insertBefore(b, sendBtn);
    }
  }

  #createButton(id, label, title, onClick) {
    const btn = document.createElement("button");
    btn.id = id;
    btn.type = "button";
    btn.className = "tfl-assist-button";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.textContent = label;
    btn.dataset.label = label;
    btn.addEventListener("click", () => {
      onClick().catch((e) => console.error(`${LOG_PREFIX} ${e.message}`));
    });
    return btn;
  }

  #composeBox() {
    const compose = this.#findFirst(COMPOSE_SELECTORS);
    const text = compose ? (compose.innerText ?? compose.textContent ?? "").trim() : "";
    return { compose, text };
  }

  #scrape() {
    let items = [];
    for (const sel of MESSAGE_ITEM_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) {
        items = Array.from(found);
        break;
      }
    }
    return extractMessages(items, MAX_MESSAGES);
  }

  async #summarize() {
    const messages = this.#scrape();
    if (!messages.length) {
      this.#toast("No messages found to summarize");
      return;
    }
    const { text: prompt } = this.#composeBox();
    const btn = document.getElementById(SUMMARIZE_BTN_ID);
    this.#setBusy(btn, true);
    try {
      const html = await this.#ipcRenderer.invoke("conversation-assist", {
        mode: "summary",
        messages,
        prompt,
      });
      this.#showPopup(html);
    } catch (err) {
      console.error(`${LOG_PREFIX} summarize failed: ${err.message}`);
      this.#toast("Summarize failed");
    } finally {
      this.#setBusy(btn, false);
    }
  }

  async #reply() {
    const messages = this.#scrape();
    if (!messages.length) {
      this.#toast("No messages found");
      return;
    }
    const { compose, text: prompt } = this.#composeBox();
    if (!compose) {
      this.#toast("Compose box not found");
      return;
    }
    const btn = document.getElementById(REPLY_BTN_ID);
    this.#setBusy(btn, true);
    try {
      const html = await this.#ipcRenderer.invoke("conversation-assist", {
        mode: "reply",
        messages,
        prompt,
      });
      await composeReplace(compose, html);
    } catch (err) {
      console.error(`${LOG_PREFIX} reply failed: ${err.message}`);
      this.#toast("Draft reply failed");
    } finally {
      this.#setBusy(btn, false);
    }
  }

  #setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? "⋯" : btn.dataset.label;
  }

  #showPopup(html) {
    this.#closePopup();
    const overlay = document.createElement("div");
    overlay.id = POPUP_ID;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.#closePopup();
    });

    const panel = document.createElement("div");
    panel.className = "tfl-summary-panel";

    const header = document.createElement("div");
    header.className = "tfl-summary-header";
    header.textContent = "Summary";

    const body = document.createElement("div");
    body.className = "tfl-summary-body";
    body.innerHTML = html; // our own claude output, minimal HTML

    const footer = document.createElement("div");
    footer.className = "tfl-summary-footer";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "tfl-summary-action";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(htmlToPlain(html));
        copyBtn.textContent = "Copied";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => {
        copyBtn.textContent = "Copy";
      }, 1500);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tfl-summary-action";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => this.#closePopup());

    footer.append(copyBtn, closeBtn);
    panel.append(header, body, footer);
    overlay.append(panel);
    document.body.appendChild(overlay);
  }

  #closePopup() {
    document.getElementById(POPUP_ID)?.remove();
  }

  #toast(message) {
    console.warn(`${LOG_PREFIX} ${message}`);
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = "tfl-assist-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }

  #injectStyles() {
    if (document.getElementById(STYLES_ID)) return;
    const style = document.createElement("style");
    style.id = STYLES_ID;
    style.textContent = `
      .tfl-assist-button {
        background: transparent; border: none; cursor: pointer;
        font-size: 18px; line-height: 1; padding: 4px 6px; margin: 0 2px;
        color: inherit; border-radius: 4px; display: inline-flex;
        align-items: center; justify-content: center;
      }
      .tfl-assist-button:hover { background: rgba(127, 127, 127, 0.18); }
      .tfl-assist-button:disabled { opacity: 0.6; cursor: wait; }
      #${POPUP_ID} {
        position: fixed; inset: 0; z-index: 2147483000;
        background: rgba(0, 0, 0, 0.35);
        display: flex; align-items: center; justify-content: center;
      }
      #${POPUP_ID} .tfl-summary-panel {
        background: var(--colorNeutralBackground1, #fff);
        color: var(--colorNeutralForeground1, #1b1b1b);
        max-width: 560px; width: 90%; max-height: 70vh; overflow: auto;
        border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        display: flex; flex-direction: column;
      }
      #${POPUP_ID} .tfl-summary-header {
        font-weight: 600; font-size: 15px; padding: 14px 18px;
        border-bottom: 1px solid rgba(127, 127, 127, 0.25);
      }
      #${POPUP_ID} .tfl-summary-body { padding: 14px 18px; line-height: 1.5; }
      #${POPUP_ID} .tfl-summary-body ul,
      #${POPUP_ID} .tfl-summary-body ol { padding-left: 20px; }
      #${POPUP_ID} .tfl-summary-footer {
        display: flex; gap: 8px; justify-content: flex-end;
        padding: 12px 18px; border-top: 1px solid rgba(127, 127, 127, 0.25);
      }
      #${POPUP_ID} .tfl-summary-action {
        cursor: pointer; border: 1px solid rgba(127, 127, 127, 0.4);
        background: transparent; color: inherit;
        border-radius: 4px; padding: 6px 14px; font-size: 13px;
      }
      #${POPUP_ID} .tfl-summary-action:hover { background: rgba(127, 127, 127, 0.18); }
      .tfl-assist-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        z-index: 2147483000; background: rgba(20, 20, 20, 0.92); color: #fff;
        padding: 8px 16px; border-radius: 6px; font-size: 13px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      }
    `;
    document.head.appendChild(style);
  }
}

module.exports = new ConversationSummary();
module.exports.extractMessages = extractMessages;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/conversationSummary.test.js`
Expected: PASS (3 buildPrompt + 4 extractMessages tests).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit** (only if the human asks)

```bash
git add app/browser/tools/conversationSummary.js tests/unit/conversationSummary.test.js
git commit -m "feat: add conversationSummary browser tool (summarize + draft reply buttons)"
```

---

### Task 5: Wire the feature into the app

**Files:**
- Modify: `app/browser/preload.js:458` (module list) and `:462` (modulesRequiringIpc)
- Modify: `app/index.js` (require near `:11`, register near `:257`)
- Modify: `app/security/ipcValidator.js` (allowlist near `:78`)

**Interfaces:**
- Consumes: `registerConversationSummary` (Task 3), the `conversationSummary` browser tool (Task 4).

- [ ] **Step 1: Register the browser tool in preload.js**

In the `modules` array, change the polishInput line to add a trailing comma and append the new module:

```js
      { name: "polishInput", path: "./tools/polishInput" },
      { name: "conversationSummary", path: "./tools/conversationSummary" }
```

In the `modulesRequiringIpc` Set, add `"conversationSummary"`:

```js
    const modulesRequiringIpc = new Set(["settings", "theme", "trayIconRenderer", "mqttStatusMonitor", "webauthnOverride", "speakingIndicator", "customStickers", "dockIconRenderer", "polishInput", "conversationSummary"]);
```

- [ ] **Step 2: Register the handler in index.js**

Add the require next to the polishInput require (near line 11):

```js
const { registerConversationSummary } = require("./conversationSummary");
```

Add the registration call right after `registerPolishInput();` (near line 257):

```js
  // Register the conversation-assist handler (summarize / draft reply via claude -p)
  registerConversationSummary();
```

- [ ] **Step 3: Allowlist the IPC channel in ipcValidator.js**

Right after the `'polish-text',` entry, add:

```js

  // Conversation summary / draft reply (claude -p)
  'conversation-assist',
```

- [ ] **Step 4: Sanity-check wiring + full test + lint**

Run:
```bash
node -e "require('./app/conversationSummary'); console.log('main module OK')"
node -e "require('./app/browser/tools/conversationSummary'); console.log('browser module OK')"
npm run test:unit && npm run lint
```
Expected: both "OK" lines print; all unit tests pass; no lint errors.

- [ ] **Step 5: Commit** (only if the human asks)

```bash
git add app/browser/preload.js app/index.js app/security/ipcValidator.js
git commit -m "feat: wire conversation-assist handler and conversationSummary tool"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CUSTOM_FEATURES.md`

- [ ] **Step 1: Add the feature entry**

Append to `CUSTOM_FEATURES.md`:

```markdown
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
```

- [ ] **Step 2: Commit** (only if the human asks)

```bash
git add CUSTOM_FEATURES.md
git commit -m "docs: record Conversation Summary & Draft Reply custom feature"
```

---

### Task 7: Verify selectors against the live Teams DOM (manual)

Not a code-by-test task — the DOM selectors in `conversationSummary.js` are a best guess and almost certainly need adjustment against real Teams markup.

- [ ] **Step 1: Run the app**

Run: `npm start`
Sign in and open a chat/thread with several messages.

- [ ] **Step 2: Check the message scrape in DevTools console**

In the app's DevTools console, test the cascade:
```js
['[data-tid="chat-pane-item"]','div[data-tid="chat-pane-message"]','div[role="listitem"]','div[data-tid^="message-"]']
  .map(s => [s, document.querySelectorAll(s).length])
```
Identify which selector actually matches message rows. Inspect one row to find the real author-name and message-body selectors. Update `MESSAGE_ITEM_SELECTORS`, `AUTHOR_SELECTORS`, `BODY_SELECTORS` accordingly (keep the cascade defensive — leave the guesses as fallbacks).

- [ ] **Step 3: Exercise both buttons**

- Click 📋 — confirm the popup shows a sensible summary of the recent messages; Copy works.
- Type a short instruction, click 💬 — confirm a reply lands in the compose box.
- Confirm the ✨ Polish button still works (regression check on the shared-helper refactor).

- [ ] **Step 4: Commit any selector fixes** (only if the human asks)

```bash
git add app/browser/tools/conversationSummary.js
git commit -m "fix: align conversationSummary selectors with live Teams DOM"
```

---

## Self-Review

**Spec coverage:**
- Summarize latest 20 (DOM) → Tasks 4 (`#scrape`/`extractMessages`, `MAX_MESSAGES=20`) + 3 (summary prompt). ✓
- Draft reply into compose box → Task 4 (`#reply` + `composeReplace`) + 3 (reply prompt). ✓
- Compose-box text as steering prompt for both → Task 4 (`#composeBox`) + 3 (`steer`). ✓
- Two toolbar buttons → Task 4 (`#ensureButtons`). ✓
- Summary in popup with Copy → Task 4 (`#showPopup`). ✓
- DOM read, same mechanism as polishInput → Task 4 (selector cascades). ✓
- Shared-helper refactor → Tasks 1 & 2. ✓
- Wiring (preload/index/ipcValidator) + CUSTOM_FEATURES → Tasks 5 & 6. ✓
- Unit tests (scrape + prompt builder) → Tasks 3 & 4. ✓
- Live-DOM selector verification → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `runClaude(prompt, opts)`, `composeReplace(compose, html)`, `htmlToPlain(html)`, `buildPrompt(mode, messages, prompt)`, `extractMessages(items, limit)`, `registerConversationSummary()` — names/signatures consistent across tasks and the IPC payload `{ mode, messages, prompt }` matches between Task 3 (handler) and Task 4 (caller). ✓
