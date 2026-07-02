'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { appendSafeHtml, htmlToPlain } = require('../../app/browser/tools/_composeReplace');

// Minimal stand-in for the DOM: appendSafeHtml builds nodes via
// parent.ownerDocument, so a fake document with createElement/createTextNode
// is enough to observe the exact tree it constructs.
function fakeRoot() {
  const doc = {
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      children: [],
      appendChild(child) {
        this.children.push(child);
      },
    }),
    createTextNode: (text) => ({ text }),
  };
  return {
    tagName: '#ROOT',
    ownerDocument: doc,
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
  };
}

// Serialize the fake tree back to an HTML-ish string for terse assertions.
// Text nodes serialize verbatim — if markup shows up inside one, it stayed
// inert text (never became an element).
function serialize(node) {
  if (node.text !== undefined) return node.text;
  const inner = node.children.map(serialize).join('');
  const tag = node.tagName.toLowerCase();
  if (tag === '#root') return inner;
  if (tag === 'br') return '<br>';
  return `<${tag}>${inner}</${tag}>`;
}

function render(html) {
  const root = fakeRoot();
  appendSafeHtml(root, html);
  return { root, out: serialize(root) };
}

describe('appendSafeHtml', () => {
  it('renders allowed formatting tags as elements so section headers render bold', () => {
    const { out } = render('<b>Summary</b><br>a point<br><b>Decisions</b><br>None');
    assert.strictEqual(out, '<b>Summary</b><br>a point<br><b>Decisions</b><br>None');
  });

  it('renders allowed list tags as nested elements', () => {
    const { root, out } = render('<ul><li>one</li><li>two</li></ul>');
    assert.strictEqual(out, '<ul><li>one</li><li>two</li></ul>');
    const ul = root.children[0];
    assert.strictEqual(ul.tagName, 'UL');
    assert.strictEqual(ul.children.length, 2);
    assert.strictEqual(ul.children[0].tagName, 'LI');
  });

  it('normalizes self-closing and mixed-case allowed tags', () => {
    assert.strictEqual(render('a<BR/>b').out, 'a<br>b');
    assert.strictEqual(render('<B>hi</B>').out, '<b>hi</b>');
  });

  it('keeps a <script> tag as inert text, never an element', () => {
    const { root, out } = render('<script>alert(1)</script>');
    assert.strictEqual(root.children.length, 1);
    assert.strictEqual(root.children[0].text, '<script>alert(1)</script>');
    assert.strictEqual(out, '<script>alert(1)</script>'); // one text node, no elements
  });

  it('keeps an <img onerror> injection as inert text', () => {
    const { root } = render('<img src=x onerror="alert(1)">');
    assert.strictEqual(root.children.length, 1);
    assert.ok(root.children[0].text.startsWith('<img'));
  });

  it('does not treat a safe tag name that carries attributes as an element', () => {
    // <b onclick=...> must stay text — only the bare <b> becomes an element.
    const { root } = render('<b onclick="steal()">x</b>');
    assert.strictEqual(root.children[0].text, '<b onclick="steal()">x');
    assert.ok(!root.children.some((c) => c.tagName === 'B'));
  });

  it('decodes basic entities in text so &amp; displays as &', () => {
    const { root } = render('Tom &amp; Jerry');
    assert.strictEqual(root.children[0].text, 'Tom & Jerry');
  });

  it('decodes &lt;/&gt; into literal angle brackets as text, not elements', () => {
    const { root } = render('a &lt;b&gt; c');
    assert.strictEqual(root.children.length, 1);
    assert.strictEqual(root.children[0].text, 'a <b> c');
  });

  it('leaves plain text unchanged', () => {
    const { root } = render('just text');
    assert.strictEqual(root.children[0].text, 'just text');
  });

  it('survives an unmatched closing tag without crashing or mis-nesting', () => {
    const { out } = render('</li>hello<b>x</b>');
    assert.strictEqual(out, 'hello<b>x</b>');
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
