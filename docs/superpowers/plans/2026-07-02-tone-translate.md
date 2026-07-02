# Tone & Translate — Polish Button Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single `✨` polish button into a split-button group whose `▾` caret opens a menu of rewrite actions (Formal, Friendly, Shorter, Translate→language submenu), all reusing the existing `polish-text` IPC handler.

**Architecture:** All changes are browser-side in `app/browser/tools/polishInput.js` plus one new config option in `app/config/options.js` and its docs. Tone/translate are polishes with a different instruction, passed as the existing `requirement` field — no main-process or IPC changes.

**Tech Stack:** Electron renderer (vanilla JS class, CKEditor DOM injection), Node's built-in `node:test` for unit tests.

## Global Constraints

- **No `var`** — `const` by default, `let` for reassignment.
- **Private fields** — use `#property` syntax for class private members.
- **Arrow functions** for concise callbacks.
- **No new IPC channel** — reuse `polish-text`; do NOT edit `app/security/ipcValidator.js` or run `generate-ipc-docs`.
- **No PII in logs.** Keep the `[POLISH_INPUT]` log prefix.
- **Tests:** `npm run test:unit` runs `node --test 'tests/unit/*.test.js'`.
- **Lint:** `npm run lint` must pass before every commit.
- Default translate languages: `["English", "中文"]`.
- Requirement strings (exact):
  - Formal → `rewrite in a formal, professional tone`
  - Friendly → `rewrite in a warm, friendly tone`
  - Shorter → `make it as concise as possible while keeping the meaning`
  - Translate → `translate into <language>`

---

### Task 1: Pure requirement-string builders (TDD)

Extract the per-action instruction strings into a pure, exported, testable function before touching any DOM. This lets us lock the exact strings with unit tests.

**Files:**
- Modify: `app/browser/tools/polishInput.js` (add `buildActionRequirement`, export it)
- Test: `tests/unit/polishInput.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildActionRequirement(action, language?)` → `string`.
  - `action` ∈ `"polish" | "formal" | "friendly" | "shorter" | "translate"`.
  - For `"translate"`, `language` is required and interpolated.
  - Returns `""` for `"polish"` (plain polish, no extra instruction).
  - Throws `Error("Unknown action: <action>")` for anything else.
  - Throws `Error("translate requires a language")` if `translate` with no/empty language.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/polishInput.test.js`:

```javascript
const { buildActionRequirement } = require('../../app/browser/tools/polishInput');

describe('buildActionRequirement', () => {
  it('returns empty string for plain polish', () => {
    assert.strictEqual(buildActionRequirement('polish'), '');
  });

  it('returns the formal instruction', () => {
    assert.strictEqual(
      buildActionRequirement('formal'),
      'rewrite in a formal, professional tone',
    );
  });

  it('returns the friendly instruction', () => {
    assert.strictEqual(
      buildActionRequirement('friendly'),
      'rewrite in a warm, friendly tone',
    );
  });

  it('returns the shorter instruction', () => {
    assert.strictEqual(
      buildActionRequirement('shorter'),
      'make it as concise as possible while keeping the meaning',
    );
  });

  it('interpolates the language for translate', () => {
    assert.strictEqual(
      buildActionRequirement('translate', '中文'),
      'translate into 中文',
    );
  });

  it('throws when translate has no language', () => {
    assert.throws(() => buildActionRequirement('translate'), /language/);
  });

  it('throws on an unknown action', () => {
    assert.throws(() => buildActionRequirement('bogus'), /Unknown action/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `buildActionRequirement is not a function`.

- [ ] **Step 3: Implement the builder**

In `app/browser/tools/polishInput.js`, add near `parsePolishDirective` (top-level function, not a class method):

```javascript
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
```

At the bottom, add to exports:

```javascript
module.exports.buildActionRequirement = buildActionRequirement;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS (all `parsePolishDirective` + `buildActionRequirement` tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add app/browser/tools/polishInput.js tests/unit/polishInput.test.js
git commit -m "feat(polish): add buildActionRequirement for tone/translate actions"
```

---

### Task 2: Config option `polishTranslateLanguages`

Register the option and its default so the browser tool can read the language list. Also document it.

**Files:**
- Modify: `app/config/options.js` (add option next to `quickChat`, ~line 880)
- Modify: `docs-site/docs/configuration.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.polishTranslateLanguages` → `string[]`, default `["English", "中文"]`, available in the renderer's `init(config, …)`.

- [ ] **Step 1: Add the option definition**

In `app/config/options.js`, add a sibling option (match the surrounding yargs option style — top-level key, not nested):

```javascript
      polishTranslateLanguages: {
        default: ["English", "中文"],
        describe:
          "Target languages offered in the compose-box Polish menu's Translate submenu.",
        type: "array",
      },
```

- [ ] **Step 2: Verify config loads without error**

Run: `npm run lint`
Expected: PASS (no syntax errors introduced).

- [ ] **Step 3: Document the option**

In `docs-site/docs/configuration.md`, add a row/entry consistent with the existing option table format:

```markdown
| `polishTranslateLanguages` | array | `["English", "中文"]` | Target languages offered in the compose-box Polish menu's Translate submenu. |
```

(Place it alphabetically or near other polish/compose options, following the file's existing ordering convention.)

- [ ] **Step 4: Commit**

```bash
git add app/config/options.js docs-site/docs/configuration.md
git commit -m "feat(config): add polishTranslateLanguages option"
```

---

### Task 3: Read config into the tool + generalize `#polish` to `#rewrite`

Store the configured languages on `init`, and refactor the existing `#polish(btn)` into `#rewrite(btn, requirement)` so every action shares one code path. `✨` calls `#rewrite(btn, "")` — identical behaviour to today.

**Files:**
- Modify: `app/browser/tools/polishInput.js`

**Interfaces:**
- Consumes: `config.polishTranslateLanguages` (Task 2); `buildActionRequirement` (Task 1); `composeReplace`.
- Produces: instance field `#languages` (`string[]`); method `#rewrite(btn, requirement)` replacing `#polish(btn)`.

- [ ] **Step 1: Store languages in `init`**

Add a field and read config in `init` (with the empty/missing fallback from the spec):

```javascript
  #languages = ["English", "中文"];
```

In `init(config, ipcRenderer)`, after the `ipcRenderer` guard and assignment:

```javascript
    const langs = config?.polishTranslateLanguages;
    if (Array.isArray(langs) && langs.length) {
      this.#languages = langs.map((l) => String(l).trim()).filter(Boolean);
    }
    if (!this.#languages.length) this.#languages = ["English", "中文"];
```

- [ ] **Step 2: Generalize `#polish` → `#rewrite`**

Rename `#polish(btn)` to `#rewrite(btn, requirement)` and merge the passed `requirement` with any parsed `polish:` directive. Replace the method body's requirement handling:

```javascript
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
    const combined = [requirement, parsed.requirement]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join("; ");

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
```

- [ ] **Step 3: Update the `✨` click handler**

In `#createButton`, change the click handler to call `#rewrite` with an empty requirement:

```javascript
    btn.addEventListener("click", () => {
      this.#rewrite(btn, "").catch((err) =>
        console.error(`${LOG_PREFIX} Polish failed: ${err.message}`),
      );
    });
```

- [ ] **Step 4: Verify existing behaviour is intact**

Run: `npm run lint && npm run test:unit`
Expected: PASS. (No new tests here — DOM behaviour is verified manually in Task 5; the refactor keeps `parsePolishDirective` unit tests green.)

- [ ] **Step 5: Commit**

```bash
git add app/browser/tools/polishInput.js
git commit -m "refactor(polish): generalize polish into shared #rewrite path"
```

---

### Task 4: Split-button group + dropdown menu

Replace the lone button with a container holding `✨` and a `▾` caret; the caret toggles a menu with Formal / Friendly / Shorter / Translate ▸ (language submenu built from `#languages`). Menu closes on selection, outside-click, and Escape.

**Files:**
- Modify: `app/browser/tools/polishInput.js`

**Interfaces:**
- Consumes: `#rewrite` (Task 3); `buildActionRequirement` (Task 1); `#languages` (Task 3).
- Produces: group container `id="tfl-polish-group"`; menu built by `#buildMenu()`. The MutationObserver guards on the container id.

- [ ] **Step 1: Update IDs and styles**

Add group/menu ids and styles. Change the constants block:

```javascript
const GROUP_ID = "tfl-polish-group";
const CARET_ID = "tfl-polish-caret";
const MENU_ID = "tfl-polish-menu";
```

In `#injectStyles`, extend the `style.textContent` with group + menu styles (keep the existing `#tfl-polish-button` rules):

```javascript
      #${GROUP_ID} { display: inline-flex; align-items: center; position: relative; }
      #${CARET_ID} {
        background: transparent; border: none; cursor: pointer;
        font-size: 12px; padding: 4px 4px; margin: 0 2px 0 -2px;
        color: inherit; border-radius: 4px; line-height: 1;
      }
      #${CARET_ID}:hover { background: rgba(127,127,127,0.18); }
      #${MENU_ID} {
        position: absolute; bottom: 100%; right: 0; margin-bottom: 4px;
        background: #2b2b2b; color: #fff; border: 1px solid rgba(127,127,127,0.35);
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
```

- [ ] **Step 2: Replace `#ensureButton` to build the group**

Rewrite `#ensureButton` to guard on the group id and insert the group before Send:

```javascript
  #ensureButton() {
    const existing = document.getElementById(GROUP_ID);
    if (existing?.isConnected) return;
    const sendBtn = this.#findFirst(SEND_SELECTORS);
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
      e.stopPropagation();
      this.#toggleMenu();
    });
    return caret;
  }
```

- [ ] **Step 3: Build the menu**

Add `#buildMenu`, using `buildActionRequirement` for each item:

```javascript
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
```

- [ ] **Step 4: Menu open/close + dismissal**

Add toggle/close helpers and document-level dismissal wiring. Add fields:

```javascript
  #onDocClick = null;
  #onKeydown = null;
```

Methods:

```javascript
  #toggleMenu() {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    if (menu.hidden) this.#openMenu(menu);
    else this.#closeMenu();
  }

  #openMenu(menu) {
    menu.hidden = false;
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
```

- [ ] **Step 5: Lint + unit tests**

Run: `npm run lint && npm run test:unit`
Expected: PASS (unit tests unchanged and green; no DOM tests).

- [ ] **Step 6: Commit**

```bash
git add app/browser/tools/polishInput.js
git commit -m "feat(polish): split-button group with tone + translate menu"
```

---

### Task 5: Manual verification in the running app

No automated DOM harness exists for the compose toolbar, so verify interactively. This task has no code; it gates the feature as actually working.

**Files:** none.

- [ ] **Step 1: Launch the app**

Run: `npm start`

- [ ] **Step 2: Verify the group renders**

Open a chat. Confirm the `✨ ▾` group appears immediately left of Send. Navigate to another chat and back; confirm the group re-inserts (MutationObserver path).

- [ ] **Step 3: Verify each action**

- Type a rough draft. Click `✨` → draft is polished (unchanged behaviour).
- Click `▾` → menu opens. Click **Formal** → draft rewritten formally.
- Repeat for **Friendly** and **Shorter**.
- Open `▾` → **文 Translate** → click **中文** → draft translated to Chinese; click **English** on another draft → translated to English.

- [ ] **Step 4: Verify dismissal**

- Open the menu, click outside → closes.
- Open the menu, press Escape → closes.

- [ ] **Step 5: Verify config override**

Set `polishTranslateLanguages` to e.g. `["English", "中文", "Español"]` in config, restart, confirm the Translate submenu lists all three. Set it to `[]`, restart, confirm it falls back to English/中文.

- [ ] **Step 6: Final commit (if any doc/log tweaks emerged)**

```bash
git add -A
git commit -m "chore(polish): finalize tone & translate after manual verification"
```

---

## Self-Review

**Spec coverage:**
- Split button (✨ + ▾) → Task 4. ✓
- Formal/Friendly/Shorter/Translate actions → Tasks 1 (strings) + 4 (menu). ✓
- Translate language submenu from config → Tasks 2 (config) + 3 (read) + 4 (submenu). ✓
- Reuse `polish-text` IPC, no main-process change → Task 3 (`invoke("polish-text", …)`), Global Constraints. ✓
- Config option + default + fallback → Task 2 (define) + Task 3 (fallback). ✓
- Docs update → Task 2 Step 3. ✓
- Menu dismissal (selection/outside/Escape) → Task 4 Step 4. ✓
- MutationObserver re-inserts whole group → Task 4 Step 2 (`#ensureButton` guards on `GROUP_ID`). ✓
- Error handling via existing `#flashError` → preserved in Task 3 `#rewrite`. ✓
- Tests → Task 1 (builders), plus preserved `parsePolishDirective` tests. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `buildActionRequirement(action, language?)` defined in Task 1 and called identically in Task 4. `#rewrite(btn, requirement)` defined in Task 3 and called by `✨` (Task 3) and `#runAction` (Task 4). `#languages` set in Task 3, read in Task 4. `BUTTON_ID` reused (still `"tfl-polish-button"`); new `GROUP_ID`/`CARET_ID`/`MENU_ID` consistent across Task 4. ✓
