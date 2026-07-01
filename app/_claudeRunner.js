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
