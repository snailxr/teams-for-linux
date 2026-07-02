'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Stub _claudeRunner and electron in the require cache BEFORE requiring the
// module under test, so the conversation-assist handler's runClaude call can
// be observed. (node --test runs each file in its own process, so this cannot
// leak into other test files.)
const claudeRunnerPath = require.resolve('../../app/_claudeRunner');
const runClaudeCalls = [];
require.cache[claudeRunnerPath] = {
  id: claudeRunnerPath,
  filename: claudeRunnerPath,
  loaded: true,
  exports: {
    runClaude: (prompt, opts) => {
      runClaudeCalls.push({ prompt, opts });
      return Promise.resolve('<b>ok</b>');
    },
  },
};

const electronPath = require.resolve('electron');
const handlers = new Map();
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  },
};

const {
  registerConversationSummary,
  CLAUDE_TIMEOUT_MS,
} = require('../../app/conversationSummary');

describe('conversation-assist timeout', () => {
  it('passes an extended timeoutMs to runClaude — long transcripts exceed the 30s default', async () => {
    // Keep test output pristine: silence the registration info log.
    const origInfo = console.info;
    console.info = () => {};
    try {
      registerConversationSummary();
    } finally {
      console.info = origInfo;
    }

    const handler = handlers.get('conversation-assist');
    assert.ok(handler, 'conversation-assist handler should be registered');

    await handler(null, {
      mode: 'summary',
      messages: [{ author: 'Alice', text: 'hi' }],
      prompt: '',
    });

    assert.strictEqual(runClaudeCalls.length, 1);
    const { opts } = runClaudeCalls[0];
    assert.ok(opts, 'runClaude must be called with an options object');
    assert.strictEqual(opts.timeoutMs, CLAUDE_TIMEOUT_MS);
    // Measured: an 11k-char summary prompt took ~34s; 16k-char transcripts are
    // allowed, so the ceiling must be comfortably above the 30s default.
    assert.ok(
      CLAUDE_TIMEOUT_MS >= 120000,
      `CLAUDE_TIMEOUT_MS (${CLAUDE_TIMEOUT_MS}) must be >= 120000`,
    );
  });
});
