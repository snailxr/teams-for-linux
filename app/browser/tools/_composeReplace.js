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

// Decode the handful of entities the model plausibly emits in text, so
// "&amp;" displays as "&". Order matters: "&amp;" is decoded LAST so it cannot
// manufacture a new entity ("&amp;lt;" -> "&lt;", correctly, not "<").
function decodeBasicEntities(s) {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

// Render model-output HTML into `parent` WITHOUT touching a Trusted Types
// sink: Teams enforces `require-trusted-types-for 'script'`, so assigning
// innerHTML (or DOMParser.parseFromString) throws a TypeError. Nodes are built
// programmatically instead — ONLY the bare, attribute-less allowlisted tags
// become elements; everything else (unknown tags, tags carrying attributes)
// lands in text nodes, which the DOM renders inert. Strict allowlist, not a
// blocklist. Uses parent.ownerDocument so unit tests can pass a fake document.
function appendSafeHtml(parent, html) {
  const doc = parent.ownerDocument;
  const token = new RegExp(`<(/?)(${SAFE_TAGS.join("|")})\\s*/?>`, "gi");
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const addText = (s) => {
    if (s) top().appendChild(doc.createTextNode(decodeBasicEntities(s)));
  };
  const src = String(html);
  let last = 0;
  for (const m of src.matchAll(token)) {
    addText(src.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (name === "br") {
      if (!closing) top().appendChild(doc.createElement("br"));
    } else if (closing) {
      // Pop to the matching open element; ignore unmatched closers.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName?.toLowerCase() === name) {
          stack.length = i;
          break;
        }
      }
    } else {
      const el = doc.createElement(name);
      top().appendChild(el);
      stack.push(el);
    }
  }
  addText(src.slice(last));
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

module.exports = { composeReplace, htmlToPlain, appendSafeHtml };
