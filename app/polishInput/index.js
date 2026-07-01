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
      throw new Error("Polish failed", { cause: err });
    }
  });
  console.info(`${LOG_PREFIX} Registered polish-text handler`);
}

module.exports = { registerPolishInput, buildPrompt };
