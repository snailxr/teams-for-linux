'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { renderSafeHtml, htmlToPlain } = require('../../app/browser/tools/_composeReplace');

describe('renderSafeHtml', () => {
  it('keeps allowed formatting tags so section headers render bold', () => {
    const out = renderSafeHtml('<b>Summary</b><br>a point<br><b>Decisions</b><br>None');
    assert.strictEqual(out, '<b>Summary</b><br>a point<br><b>Decisions</b><br>None');
  });

  it('keeps allowed list tags', () => {
    const out = renderSafeHtml('<ul><li>one</li><li>two</li></ul>');
    assert.strictEqual(out, '<ul><li>one</li><li>two</li></ul>');
  });

  it('normalizes self-closing and mixed-case allowed tags', () => {
    assert.strictEqual(renderSafeHtml('a<BR/>b'), 'a<br>b');
    assert.strictEqual(renderSafeHtml('<B>hi</B>'), '<b>hi</b>');
  });

  it('escapes a <script> tag instead of rendering it', () => {
    const out = renderSafeHtml('<script>alert(1)</script>');
    assert.ok(!/<script>/i.test(out));
    assert.ok(out.includes('&lt;script&gt;'));
  });

  it('escapes an <img onerror> injection', () => {
    const out = renderSafeHtml('<img src=x onerror="alert(1)">');
    assert.ok(!/<img/i.test(out));
    assert.ok(out.startsWith('&lt;img'));
  });

  it('does not re-allow a safe tag name that carries attributes', () => {
    // <b onclick=...> must stay escaped — only the bare <b> is re-permitted.
    const out = renderSafeHtml('<b onclick="steal()">x</b>');
    assert.ok(!/<b onclick/i.test(out));
    assert.ok(out.includes('&lt;b onclick'));
    assert.ok(out.includes('</b>')); // the bare closing tag is fine
  });

  it('escapes a bare ampersand so it cannot start an entity', () => {
    assert.strictEqual(renderSafeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
  });

  it('leaves plain text unchanged', () => {
    assert.strictEqual(renderSafeHtml('just text'), 'just text');
  });
});

describe('htmlToPlain', () => {
  it('flattens list items to bullet lines', () => {
    assert.strictEqual(htmlToPlain('<ul><li>a</li><li>b</li></ul>'), '• a\n• b');
  });

  it('strips tags and collapses excess blank lines', () => {
    assert.strictEqual(htmlToPlain('<b>Summary</b><br><br><br>done'), 'Summary\n\ndone');
  });
});
