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
      throw new Error("Assist failed", { cause: err });
    }
  });
  console.info(`${LOG_PREFIX} Registered conversation-assist handler`);
}

module.exports = { registerConversationSummary, buildPrompt };
