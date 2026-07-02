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

// The only tags the summary/reply prompt is allowed to emit (see HTML_RULE in
// conversationSummary/index.js). Everything else must be neutralised because the
// text is ultimately derived from untrusted chat messages.
const SAFE_TAGS = ["b", "i", "code", "ul", "ol", "li", "br"];

// Sanitise model output for rendering as innerHTML: escape EVERYTHING first
// (so any crafted markup — <img onerror>, <script>, attributes, event handlers —
// becomes inert text), then re-permit only the bare, attribute-less safe tags
// from the allowlist. This is a strict allowlist, not a blocklist: anything not
// explicitly re-allowed stays escaped.
function renderSafeHtml(html) {
  const escaped = String(html)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Re-allow ONLY exact opening/closing tags with no attributes, e.g. &lt;b&gt;
  // -> <b>, &lt;/li&gt; -> </li>, &lt;br&gt; / &lt;br/&gt; -> <br>.
  const tag = SAFE_TAGS.join("|");
  return escaped.replace(
    new RegExp(`&lt;(/?)(${tag})\\s*/?&gt;`, "gi"),
    (_m, slash, name) => `<${slash}${name.toLowerCase()}>`,
  );
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

module.exports = { composeReplace, htmlToPlain, renderSafeHtml };
