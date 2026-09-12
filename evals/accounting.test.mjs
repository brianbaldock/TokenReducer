import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXED_DELEGATION_CHARACTERS, estimateTokens, parentAccounting } from './benchmark.mjs';

test('accounting uses a labeled characters/4 estimate rather than claiming tokenizer precision', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('four'), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens('éééé'), 1);
  assert.throws(() => estimateTokens(-1), TypeError);
  assert.throws(() => estimateTokens(0.5), TypeError);
});

test('both accounting sides include skill and fixed delegation overhead without parent-after corpus', () => {
  const result = parentAccounting({
    invocationCharacters: 100, skillCharacters: 400, corpusCharacters: 20_000,
    baselineAnswerCharacters: 200, parentReplyCharacters: 200, metadataCharacters: 100,
  });
  const common = 100 + 400 + FIXED_DELEGATION_CHARACTERS;
  assert.equal(result.commonCharacters, common);
  assert.equal(result.beforeCharacters, common + 20_000 + 200);
  assert.equal(result.afterCharacters, common + 200 + 100);
  assert.equal(result.afterCorpusCharacters, 0);
  assert.equal(result.beforeTokens, Math.ceil(result.beforeCharacters / 4));
  assert.equal(result.afterTokens, Math.ceil(result.afterCharacters / 4));
  assert.equal(result.parentSavingsPercent, (1 - result.afterCharacters / result.beforeCharacters) * 100);
});

test('accounting does not hide overhead that makes a small case larger', () => {
  const result = parentAccounting({
    invocationCharacters: 100, skillCharacters: 400, corpusCharacters: 5,
    baselineAnswerCharacters: 10, parentReplyCharacters: 10, metadataCharacters: 100,
  });
  assert.ok(result.parentSavingsPercent < 0);
  assert.ok(result.afterTokens > result.beforeTokens);
});
