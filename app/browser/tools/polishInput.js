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

const { composeReplace, findSendAnchor } = require("./_composeReplace");

const LOG_PREFIX = "[POLISH_INPUT]";
const BUTTON_ID = "tfl-polish-button";
const STYLES_ID = "tfl-polish-styles";
const GROUP_ID = "tfl-polish-group";
const CARET_ID = "tfl-polish-caret";
const MENU_ID = "tfl-polish-menu";

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

// Merge an action requirement (from a menu click) with any `polish:` directive
// requirement parsed from the draft, dropping empties and joining with "; ".
// Exported for unit testing. An empty action requirement yields exactly the
// directive requirement, so the plain-polish (✨) path is unchanged.
function combineRequirements(actionRequirement, directiveRequirement) {
  return [actionRequirement, directiveRequirement]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join("; ");
}

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
  #languages = ["English", "中文"];
  #onDocClick = null;
  #onKeydown = null;

  init(config, ipcRenderer) {
    if (!ipcRenderer) {
      console.warn(`${LOG_PREFIX} ipcRenderer missing; tool disabled`);
      return;
    }
    this.#ipcRenderer = ipcRenderer;
    const langs = config?.polishTranslateLanguages;
    if (Array.isArray(langs) && langs.length) {
      this.#languages = langs.map((l) => String(l).trim()).filter(Boolean);
    }
    if (!this.#languages.length) this.#languages = ["English", "中文"];
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
      #${GROUP_ID} { display: inline-flex; align-items: center; position: relative; }
      #${CARET_ID} {
        background: transparent; border: none; cursor: pointer;
        font-size: 12px; padding: 4px 4px; margin: 0 2px 0 -2px;
        color: inherit; border-radius: 4px; line-height: 1;
      }
      #${CARET_ID}:hover { background: rgba(127,127,127,0.18); }
      #${MENU_ID} {
        position: fixed; background: #2b2b2b; color: #fff;
        border: 1px solid rgba(127,127,127,0.35);
        border-radius: 6px; padding: 4px; min-width: 160px; z-index: 2147483647;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      }
      #${MENU_ID}[hidden] { display: none; }
      #${MENU_ID} .tfl-polish-item {
        display: flex; align-items: center; gap: 8px; width: 100%;
        background: transparent; border: none; color: inherit; cursor: pointer;
        font-size: 13px; text-align: left; padding: 6px 8px; border-radius: 4px;
      }
      #${MENU_ID} .tfl-polish-item:hover { background: rgba(127,127,127,0.25); }
      #${MENU_ID} .tfl-polish-submenu { position: relative; }
      #${MENU_ID} .tfl-polish-sublist { padding-left: 12px; }
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
    const existing = document.getElementById(GROUP_ID);
    if (existing?.isConnected) return;
    const sendBtn = findSendAnchor(SEND_SELECTORS, COMPOSE_SELECTORS);
    if (!sendBtn?.parentElement) return;
    const group = this.#createGroup();
    sendBtn.parentElement.insertBefore(group, sendBtn);
  }

  #createGroup() {
    const group = document.createElement("div");
    group.id = GROUP_ID;
    const btn = this.#createButton();
    const caret = this.#createCaret();
    const menu = this.#buildMenu();
    group.append(btn, caret, menu);
    return group;
  }

  #createCaret() {
    const caret = document.createElement("button");
    caret.id = CARET_ID;
    caret.type = "button";
    caret.title = "More rewrite options";
    caret.setAttribute("aria-label", "More rewrite options");
    caret.setAttribute("aria-haspopup", "true");
    caret.textContent = "▾";
    caret.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#toggleMenu();
    });
    return caret;
  }

  #buildMenu() {
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const actions = [
      { label: "🍩 Formal", action: "formal" },
      { label: "😊 Friendly", action: "friendly" },
      { label: "✂ Shorter", action: "shorter" },
    ];
    for (const a of actions) {
      menu.appendChild(
        this.#menuItem(a.label, () =>
          this.#runAction(buildActionRequirement(a.action)),
        ),
      );
    }

    const sub = document.createElement("div");
    sub.className = "tfl-polish-submenu";
    const subLabel = document.createElement("div");
    subLabel.className = "tfl-polish-item";
    subLabel.textContent = "文 Translate";
    sub.appendChild(subLabel);
    const subList = document.createElement("div");
    subList.className = "tfl-polish-sublist";
    for (const lang of this.#languages) {
      subList.appendChild(
        this.#menuItem(lang, () =>
          this.#runAction(buildActionRequirement("translate", lang)),
        ),
      );
    }
    sub.appendChild(subList);
    menu.appendChild(sub);
    return menu;
  }

  #menuItem(label, onClick) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tfl-polish-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#closeMenu();
      onClick();
    });
    return item;
  }

  #runAction(requirement) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    this.#rewrite(btn, requirement).catch((err) =>
      console.error(`${LOG_PREFIX} Rewrite failed: ${err.message}`),
    );
  }

  #toggleMenu() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    if (menu.hidden) this.#openMenu(menu);
    else this.#closeMenu();
  }

  #openMenu(menu) {
    menu.hidden = false;
    this.#positionMenu(menu);
    this.#onDocClick = (e) => {
      if (!document.getElementById(GROUP_ID)?.contains(e.target)) {
        this.#closeMenu();
      }
    };
    this.#onKeydown = (e) => {
      if (e.key === "Escape") this.#closeMenu();
    };
    document.addEventListener("click", this.#onDocClick, true);
    document.addEventListener("keydown", this.#onKeydown, true);
  }

  // Place the (now-visible) fixed-position menu just above the caret, aligned to
  // its right edge — the same anchor the old `bottom:100%; right:0` produced, but
  // as viewport coordinates so no ancestor `overflow: hidden` on the Teams
  // compose toolbar can clip it. Flips below the caret if there isn't room above,
  // and clamps into the viewport so it never renders off-screen.
  #positionMenu(menu) {
    const caret = document.getElementById(CARET_ID);
    if (!caret) return;
    const c = caret.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const gap = 4;
    let top = c.top - m.height - gap; // above the caret
    if (top < 0) top = c.bottom + gap; // not enough room above -> below
    let left = c.right - m.width; // right-align to the caret
    if (left < 0) left = 0;
    const maxLeft = window.innerWidth - m.width;
    if (left > maxLeft) left = Math.max(0, maxLeft);
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  #closeMenu() {
    const menu = document.getElementById(MENU_ID);
    if (menu) menu.hidden = true;
    if (this.#onDocClick) {
      document.removeEventListener("click", this.#onDocClick, true);
      this.#onDocClick = null;
    }
    if (this.#onKeydown) {
      document.removeEventListener("keydown", this.#onKeydown, true);
      this.#onKeydown = null;
    }
  }

  #createButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.title = "Polish with Claude";
    btn.setAttribute("aria-label", "Polish message with Claude");
    btn.textContent = "✨"; // ✨
    btn.addEventListener("click", (e) => {
      // In a channel composer the button sits in the Post command bar; without
      // this a bubbled click reaches Teams' post handler and sends the message.
      e.preventDefault();
      e.stopPropagation();
      this.#rewrite(btn, "").catch((err) =>
        console.error(`${LOG_PREFIX} Polish failed: ${err.message}`),
      );
    });
    return btn;
  }

  async #rewrite(btn, requirement) {
    if (btn.disabled) return;
    const compose = this.#findFirst(COMPOSE_SELECTORS);
    if (!compose) {
      this.#flashError(btn);
      return;
    }
    const raw = compose.innerText ?? compose.textContent ?? "";
    const parsed = parsePolishDirective(raw);
    if (!parsed.text) {
      this.#flashError(btn);
      return;
    }
    const combined = combineRequirements(requirement, parsed.requirement);

    this.#setBusy(btn, true);
    let polished;
    try {
      polished = await this.#ipcRenderer.invoke("polish-text", {
        text: parsed.text,
        requirement: combined,
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
module.exports.combineRequirements = combineRequirements;
