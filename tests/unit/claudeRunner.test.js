'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runClaude, DEFAULT_TIMEOUT_MS } = require('../../app/_claudeRunner');

// Fake `claude` binary: reads stdin to EOF, then prints. If the runner leaves
// stdin open, `cat` never sees EOF and this hangs until the timeout kills it —
// mirroring the real CLI, which waits on a non-TTY stdin pipe before starting.
const FAKE_BIN_ECHO = '#!/bin/sh\ncat > /dev/null\necho "fake output"\n';

describe('runClaude', () => {
  let tmpDir;
  let fakeBin;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfl-claude-runner-'));
    fakeBin = path.join(tmpDir, 'fake-claude');
    fs.writeFileSync(fakeBin, FAKE_BIN_ECHO, { mode: 0o755 });
    process.env.TFL_CLAUDE_BIN = fakeBin;
  });

  after(() => {
    delete process.env.TFL_CLAUDE_BIN;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('closes stdin so the CLI does not wait on an open pipe', async () => {
    // With stdin left open the fake bin blocks in `cat` and the 2s timeout
    // rejects; with stdin closed it resolves immediately.
    const out = await runClaude('hello', { timeoutMs: 2000 });
    assert.strictEqual(out, 'fake output');
  });

  it('defaults to a timeout that accommodates real claude -p latency', () => {
    // Regression guard: a 30s default killed real summarize calls that
    // completed at ~33s (SIGTERM, exit 143).
    assert.ok(
      DEFAULT_TIMEOUT_MS >= 120000,
      `DEFAULT_TIMEOUT_MS is ${DEFAULT_TIMEOUT_MS}, expected >= 120000`,
    );
  });

  it('rejects when the binary exceeds the timeout', async () => {
    const slowBin = path.join(tmpDir, 'slow-claude');
    fs.writeFileSync(slowBin, '#!/bin/sh\nsleep 5\necho too-late\n', {
      mode: 0o755,
    });
    process.env.TFL_CLAUDE_BIN = slowBin;
    try {
      await assert.rejects(runClaude('hello', { timeoutMs: 200 }));
    } finally {
      process.env.TFL_CLAUDE_BIN = fakeBin;
    }
  });

  it('rejects on empty output', async () => {
    const emptyBin = path.join(tmpDir, 'empty-claude');
    fs.writeFileSync(emptyBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.TFL_CLAUDE_BIN = emptyBin;
    try {
      await assert.rejects(runClaude('hello', { timeoutMs: 2000 }), {
        message: 'claude returned empty output',
      });
    } finally {
      process.env.TFL_CLAUDE_BIN = fakeBin;
    }
  });
});
