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

const { composeReplace, htmlToPlain, appendSafeHtml, findSendAnchor } = require("./_composeReplace");

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
    let el;
    try {
      el = item.querySelector?.(sel);
    } catch {
      el = undefined;
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
    const bodyText = pickText(item, BODY_SELECTORS);
    const authorText = pickText(item, AUTHOR_SELECTORS);
    // When no body selector matches (e.g. Teams changed its markup), fall back
    // to the item's raw text rather than dropping the message — but strip the
    // recognised author prefix so the name isn't duplicated into the body.
    let text = bodyText;
    if (!text) {
      const raw = (item.innerText ?? item.textContent ?? "").trim();
      text =
        authorText && raw.startsWith(authorText)
          ? raw.slice(authorText.length).trim()
          : raw;
    }
    if (!text) continue;
    const author = authorText || "Unknown";
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
    const sendBtn = findSendAnchor(SEND_SELECTORS, COMPOSE_SELECTORS);
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
    btn.addEventListener("click", (e) => {
      // In a channel composer these buttons sit in the Post command bar;
      // without this a bubbled click reaches Teams' post handler and sends.
      e.preventDefault();
      e.stopPropagation();
      onClick().catch((err) => console.error(`${LOG_PREFIX} ${err.message}`));
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
    let matchedSelector = "";
    for (const sel of MESSAGE_ITEM_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) {
        items = Array.from(found);
        matchedSelector = sel;
        break;
      }
    }
    const messages = extractMessages(items, MAX_MESSAGES);
    // Shape only — counts and sizes, never message content (PII).
    console.debug(`${LOG_PREFIX} scraped`, {
      matchedSelector,
      itemCount: items.length,
      messageCount: messages.length,
      totalChars: messages.reduce((n, m) => n + m.text.length, 0),
    });
    return messages;
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
      // Name + stack pinpoint the throwing layer (IPC vs popup render); the
      // message never contains chat content.
      console.error(`${LOG_PREFIX} summarize failed: ${err.message}`, err.stack);
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
    // claude output is derived from untrusted chat messages, so it can never be
    // trusted as HTML — and Teams' Trusted Types CSP makes innerHTML assignment
    // throw anyway (the original cause of "Summarize failed" with no panel).
    // appendSafeHtml builds nodes programmatically: only the bare allowlisted
    // tags (<b>, <ul>, <li>, <br>, ...) become elements; everything else stays
    // inert text.
    appendSafeHtml(body, html);

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
      #${POPUP_ID} .tfl-summary-body {
        padding: 14px 18px; line-height: 1.5;
      }
      #${POPUP_ID} .tfl-summary-body b { font-weight: 600; }
      #${POPUP_ID} .tfl-summary-body ul,
      #${POPUP_ID} .tfl-summary-body ol { margin: 4px 0; padding-left: 20px; }
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
