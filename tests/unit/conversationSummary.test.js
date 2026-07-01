'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { buildPrompt } = require('../../app/conversationSummary');

describe('buildPrompt', () => {
  const msgs = [
    { author: 'Alice', text: 'when is the release?' },
    { author: 'Bob', text: 'friday' },
  ];

  it('summary mode summarizes, transcript oldest-first, no steer when prompt empty', () => {
    const p = buildPrompt('summary', msgs, '');
    assert.ok(/summarize/i.test(p));
    assert.ok(p.indexOf('Alice: when is the release?') < p.indexOf('Bob: friday'));
    assert.ok(!p.includes('User instruction'));
  });

  it('reply mode asks for a reply and weaves in the steer prompt', () => {
    const p = buildPrompt('reply', msgs, 'decline politely');
    assert.ok(/draft a reply/i.test(p));
    assert.ok(p.includes('User instruction: decline politely'));
  });

  it('falls back to Unknown author label', () => {
    const p = buildPrompt('summary', [{ author: '', text: 'hi' }], '');
    assert.ok(p.includes('Unknown: hi'));
  });
});

const { extractMessages } = require('../../app/browser/tools/conversationSummary');

function fakeItem(author, body) {
  return {
    innerText: `${author}\n${body}`,
    querySelector(sel) {
      if (sel === '[data-tid="message-author-name"]') {
        return author ? { innerText: author } : null;
      }
      if (sel === '[data-tid="message-body-content"]') {
        return body ? { innerText: body } : null;
      }
      return null;
    },
  };
}

describe('extractMessages', () => {
  it('extracts author/text from items, oldest-first', () => {
    const r = extractMessages([fakeItem('Alice', 'hi'), fakeItem('Bob', 'hey')], 20);
    assert.deepStrictEqual(r, [
      { author: 'Alice', text: 'hi' },
      { author: 'Bob', text: 'hey' },
    ]);
  });

  it('keeps only the latest `limit` messages', () => {
    const items = [fakeItem('A', '1'), fakeItem('B', '2'), fakeItem('C', '3')];
    assert.deepStrictEqual(extractMessages(items, 2), [
      { author: 'B', text: '2' },
      { author: 'C', text: '3' },
    ]);
  });

  it('drops items with no text', () => {
    const r = extractMessages([fakeItem('A', ''), fakeItem('B', 'real')], 20);
    assert.deepStrictEqual(r, [{ author: 'B', text: 'real' }]);
  });

  it('falls back to Unknown author and item innerText body', () => {
    const bodyless = { innerText: 'just text', querySelector: () => null };
    assert.deepStrictEqual(extractMessages([bodyless], 20), [
      { author: 'Unknown', text: 'just text' },
    ]);
  });

  it('keeps a message when the author matches but the body selector misses', () => {
    const item = {
      innerText: 'Carol\nhello world',
      querySelector(sel) {
        if (sel === '[data-tid="message-author-name"]') return { innerText: 'Carol' };
        return null; // no body selector matches -> must NOT drop the message
      },
    };
    assert.deepStrictEqual(extractMessages([item], 20), [
      { author: 'Carol', text: 'hello world' },
    ]);
  });
});
