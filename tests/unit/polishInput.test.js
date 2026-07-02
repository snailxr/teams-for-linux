'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parsePolishDirective, buildActionRequirement, combineRequirements } = require('../../app/browser/tools/polishInput');

describe('parsePolishDirective', () => {
  it('returns the whole text and empty requirement when there is no directive', () => {
    const r = parsePolishDirective('hello there\nsecond line');
    assert.strictEqual(r.text, 'hello there\nsecond line');
    assert.strictEqual(r.requirement, '');
  });

  it('extracts a polish: line as the requirement and strips it', () => {
    const r = parsePolishDirective('hey can u send the report asap\npolish: make it formal');
    assert.strictEqual(r.text, 'hey can u send the report asap');
    assert.strictEqual(r.requirement, 'make it formal');
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    const r = parsePolishDirective('  Polish:   keep it short  \ndraft');
    assert.strictEqual(r.text, 'draft');
    assert.strictEqual(r.requirement, 'keep it short');
  });

  it('joins multiple directives and yields empty text when only directives are present', () => {
    const r = parsePolishDirective('polish: a\npolish: b');
    assert.strictEqual(r.text, '');
    assert.strictEqual(r.requirement, 'a; b');
  });
});

describe('buildActionRequirement', () => {
  it('returns empty string for plain polish', () => {
    assert.strictEqual(buildActionRequirement('polish'), '');
  });

  it('returns the formal instruction', () => {
    assert.strictEqual(
      buildActionRequirement('formal'),
      'rewrite in a formal, professional tone',
    );
  });

  it('returns the friendly instruction', () => {
    assert.strictEqual(
      buildActionRequirement('friendly'),
      'rewrite in a warm, friendly tone',
    );
  });

  it('returns the shorter instruction', () => {
    assert.strictEqual(
      buildActionRequirement('shorter'),
      'make it as concise as possible while keeping the meaning',
    );
  });

  it('interpolates the language for translate', () => {
    assert.strictEqual(
      buildActionRequirement('translate', '中文'),
      'translate into 中文',
    );
  });

  it('throws when translate has no language', () => {
    assert.throws(() => buildActionRequirement('translate'), /language/);
  });

  it('throws on an unknown action', () => {
    assert.throws(() => buildActionRequirement('bogus'), /Unknown action/);
  });
});

describe('combineRequirements', () => {
  it('returns the directive requirement unchanged when the action requirement is empty (plain polish)', () => {
    assert.strictEqual(combineRequirements('', 'make it formal'), 'make it formal');
  });

  it('returns the action requirement alone when there is no directive', () => {
    assert.strictEqual(combineRequirements('translate into 中文', ''), 'translate into 中文');
  });

  it('joins action and directive requirements with "; " in that order', () => {
    assert.strictEqual(
      combineRequirements('translate into 中文', 'keep it short'),
      'translate into 中文; keep it short',
    );
  });

  it('yields an empty string when both are empty', () => {
    assert.strictEqual(combineRequirements('', ''), '');
  });

  it('trims each part and drops blank ones', () => {
    assert.strictEqual(combineRequirements('  formal  ', '   '), 'formal');
  });
});
