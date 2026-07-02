const { ipcMain } = require("electron");
const { runClaude } = require("../_claudeRunner");

const LOG_PREFIX = "[CONVERSATION_SUMMARY]";
const MAX_INPUT_CHARS = 16000;
// Long transcripts push `claude -p` past the runner's 30s default (an 11k-char
// summary prompt measured ~34s), which surfaced as "Summarize failed". Give
// assists a ceiling sized to MAX_INPUT_CHARS-length conversations.
const CLAUDE_TIMEOUT_MS = 120000;
const MODES = new Set(["summary", "reply"]);

const HTML_RULE =
  "Return the result as minimal HTML using ONLY these tags: <b>, <i>, <code>, " +
  "<ul>, <ol>, <li>, <br>. Do NOT use markdown, code fences, or any preamble — " +
  "return ONLY the HTML.";

// Safety net for reply mode: strip a leading meta-preamble line the model may
// still emit despite the prompt (e.g. "I'll draft a reply to Chris's latest
// message."). Only removes a first line that is clearly commentary — a short
// sentence starting with a first-person intent phrase and ending in a colon or
// period — so real reply content is never touched.
const REPLY_PREAMBLE =
  /^\s*(?:<[^>]+>\s*)?(?:sure|okay|ok|here(?:'s| is)|i(?:'ll|'m| will| am| can)|let me|of course|certainly|draft(?:ing)?)\b[^\n]{0,120}?[:.](?:\s*<br\s*\/?>)?\s*(?:\r?\n)+/i;

function stripReplyPreamble(text) {
  return text.replace(REPLY_PREAMBLE, "").trim();
}

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
      "conversation below (oldest first) and write the reply the user should " +
      "send to the latest message. Keep it natural, concise, and in the same " +
      "language as the conversation. Output ONLY the reply message itself, " +
      "exactly as it should appear in the chat box — no lead-in, no commentary " +
      "about what you are doing (e.g. do NOT write \"I'll draft a reply...\"), " +
      `and no surrounding quotes. ${HTML_RULE}${steer}\n\nConversation:\n${transcript}`
    );
  }
  return (
    "Summarize the following Microsoft Teams conversation (oldest first). " +
    "Structure the output under these three sections, each introduced by a " +
    "bold header on its own line using the <b> tag: <b>Summary</b> (a concise " +
    "summary of the key points), <b>Decisions</b> (decisions reached, or " +
    "\"None\" if there were none), and <b>Action items / open questions</b> " +
    "(any follow-ups or unanswered questions). Use <br> between sections and " +
    `<ul>/<li> for lists. ${HTML_RULE}${steer}\n\nConversation:\n${transcript}`
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
      const out = await runClaude(buildPrompt(mode, messages, prompt), {
        timeoutMs: CLAUDE_TIMEOUT_MS,
      });
      return mode === "reply" ? stripReplyPreamble(out) : out;
    } catch (err) {
      console.error(`${LOG_PREFIX} claude failed: ${err.message}`);
      throw new Error("Assist failed", { cause: err });
    }
  });
  console.info(`${LOG_PREFIX} Registered conversation-assist handler`);
}

module.exports = {
  registerConversationSummary,
  buildPrompt,
  stripReplyPreamble,
  CLAUDE_TIMEOUT_MS,
};
