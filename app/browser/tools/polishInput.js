/**
 * Polish Input Browser Tool
 *
 * Adds a ✨ button to the Teams compose toolbar that rewrites the current
 * draft via the `claude -p` CLI (run in the main process) and replaces the
 * compose box with the polished text.
 *
 * A line beginning with `polish:` in the draft is treated as an extra
 * instruction for the rewrite and is stripped before sending.
 *
 * The button is (re)inserted with a MutationObserver because Teams re-renders
 * the compose toolbar on navigation. Text is replaced via a synthetic paste —
 * the same CKEditor-compatible path used by customStickers (setting innerHTML
 * would not sync CKEditor's model).
 */

const { composeReplace } = require("./_composeReplace");

const LOG_PREFIX = "[POLISH_INPUT]";
const BUTTON_ID = "tfl-polish-button";
const STYLES_ID = "tfl-polish-styles";

// Most-specific first; mirrors the customStickers compose cascade.
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

// Pull `polish:` directive lines out of the draft. The text after `polish:`
// (on any such line) becomes the extra requirement; those lines are removed
// and the remaining text is the message to polish. Exported for unit testing.
function parsePolishDirective(raw) {
  const reqs = [];
  const kept = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const m = /^\s*polish:\s*(.*)$/i.exec(line);
    if (m) {
      const req = m[1].trim();
      if (req) reqs.push(req);
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n").trim(), requirement: reqs.join("; ") };
}

// Map a menu action to the `requirement` string passed to the polish-text IPC
// handler (which appends it as an extra rewrite instruction). Exported for
// unit testing. "polish" yields "" (plain polish, no extra instruction).
const ACTION_REQUIREMENTS = {
  polish: "",
  formal: "rewrite in a formal, professional tone",
  friendly: "rewrite in a warm, friendly tone",
  shorter: "make it as concise as possible while keeping the meaning",
};

function buildActionRequirement(action, language) {
  if (action === "translate") {
    const lang = String(language || "").trim();
    if (!lang) throw new Error("translate requires a language");
    return `translate into ${lang}`;
  }
  if (!(action in ACTION_REQUIREMENTS)) {
    throw new Error(`Unknown action: ${action}`);
  }
  return ACTION_REQUIREMENTS[action];
}

class PolishInput {
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
      this.#ensureButton();
      // Teams rebuilds the compose toolbar on navigation; re-insert when gone.
      // ponytail: body-wide observer, cheap because ensureButton short-circuits when the button is present
      this.#observer = new MutationObserver(() => this.#ensureButton());
      this.#observer.observe(document.body, { childList: true, subtree: true });
      console.info(`${LOG_PREFIX} Initialized`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to initialize: ${err.message}`);
    }
  }

  #injectStyles() {
    if (document.getElementById(STYLES_ID)) return;
    const style = document.createElement("style");
    style.id = STYLES_ID;
    style.textContent = `
      #${BUTTON_ID} {
        background: transparent;
        border: none;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        padding: 4px 6px;
        margin: 0 2px;
        color: inherit;
        border-radius: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${BUTTON_ID}:hover { background: rgba(127, 127, 127, 0.18); }
      #${BUTTON_ID}:disabled { opacity: 0.6; cursor: wait; }
      #${BUTTON_ID}.tfl-polish-error { color: #c44; }
    `;
    document.head.appendChild(style);
  }

  #findFirst(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  #ensureButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing?.isConnected) return;
    const sendBtn = this.#findFirst(SEND_SELECTORS);
    if (!sendBtn?.parentElement) return;
    const btn = this.#createButton();
    sendBtn.parentElement.insertBefore(btn, sendBtn);
  }

  #createButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.title = "Polish with Claude";
    btn.setAttribute("aria-label", "Polish message with Claude");
    btn.textContent = "✨"; // ✨
    btn.addEventListener("click", () => {
      this.#polish(btn).catch((err) =>
        console.error(`${LOG_PREFIX} Polish failed: ${err.message}`),
      );
    });
    return btn;
  }

  async #polish(btn) {
    if (btn.disabled) return;
    const compose = this.#findFirst(COMPOSE_SELECTORS);
    if (!compose) {
      this.#flashError(btn);
      return;
    }
    const raw = compose.innerText ?? compose.textContent ?? "";
    const { text, requirement } = parsePolishDirective(raw);
    if (!text) {
      this.#flashError(btn);
      return;
    }

    this.#setBusy(btn, true);
    let polished;
    try {
      polished = await this.#ipcRenderer.invoke("polish-text", {
        text,
        requirement,
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} polish-text IPC failed: ${err.message}`);
      this.#setBusy(btn, false);
      this.#flashError(btn);
      return;
    }
    this.#setBusy(btn, false);
    await composeReplace(compose, polished);
  }

  #setBusy(btn, busy) {
    btn.disabled = busy;
    btn.textContent = busy ? "⋯" : "✨"; // ⋯ / ✨
  }

  #flashError(btn) {
    btn.classList.add("tfl-polish-error");
    setTimeout(() => btn.classList.remove("tfl-polish-error"), 1500);
  }
}

module.exports = new PolishInput();
module.exports.parsePolishDirective = parsePolishDirective;
module.exports.buildActionRequirement = buildActionRequirement;
