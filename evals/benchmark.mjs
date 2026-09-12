import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVAL_ROOT, FIXTURES, GENERATION_SPEC, anchorQuestion, expectedAnchors,
  generateFixtures, generatedStubCode,
} from './fixtures.mjs';
import {
  ENTRIES, ROOT, assertSuccess, configureStub, copyFixtures, metadata, observations,
  readerArgs, runWorker, sha256, workspace,
} from './helpers.mjs';

export const CHARACTERS_PER_ESTIMATED_TOKEN = 4;
export const FIXED_DELEGATION_CHARACTERS = 1024;

export function estimateTokens(textOrCharacters) {
  const characters = typeof textOrCharacters === 'string' ? textOrCharacters.length : textOrCharacters;
  if (!Number.isSafeInteger(characters) || characters < 0) throw new TypeError('Expected a nonnegative character count.');
  return Math.ceil(characters / CHARACTERS_PER_ESTIMATED_TOKEN);
}

export function parentAccounting({
  invocationCharacters, skillCharacters, corpusCharacters, baselineAnswerCharacters,
  parentReplyCharacters, metadataCharacters, fixedDelegationCharacters = FIXED_DELEGATION_CHARACTERS,
}) {
  for (const value of [invocationCharacters, skillCharacters, corpusCharacters, baselineAnswerCharacters, parentReplyCharacters, metadataCharacters, fixedDelegationCharacters]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Accounting inputs must be nonnegative integer character counts.');
  }
  const commonCharacters = invocationCharacters + skillCharacters + fixedDelegationCharacters;
  const beforeCharacters = commonCharacters + corpusCharacters + baselineAnswerCharacters;
  const afterCharacters = commonCharacters + parentReplyCharacters + metadataCharacters;
  if (!beforeCharacters) throw new TypeError('The accounting baseline must be nonempty.');
  return {
    beforeCharacters, afterCharacters,
    beforeTokens: estimateTokens(beforeCharacters),
    afterTokens: estimateTokens(afterCharacters),
    parentSavingsPercent: (1 - afterCharacters / beforeCharacters) * 100,
    commonCharacters, invocationCharacters, skillCharacters, fixedDelegationCharacters,
    corpusCharacters, afterCorpusCharacters: 0, parentReplyCharacters, metadataCharacters,
  };
}

function invocationText(kind, args, root) {
  return JSON.stringify([
    'node', path.relative(ROOT, ENTRIES[kind]).split(path.sep).join('/'),
    ...args.map((arg) => arg === root ? path.relative(ROOT, root).split(path.sep).join('/') : arg),
  ]);
}

async function skillCharacters(kind) {
  return (await readFile(path.join(ROOT, '.github/skills', kind, 'SKILL.md'), 'utf8')).length;
}

async function readerCase(fixtures, label) {
  const work = await workspace(undefined, `benchmark-${label}`);
  try {
    await copyFixtures(work.root, fixtures);
    await configureStub(work.root, { mode: 'anchors' });
    const args = readerArgs(work.root, fixtures.map((fixture) => fixture.file), anchorQuestion(fixtures));
    const result = await runWorker('bulk-reader', args, { root: work.root });
    assertSuccess(result);
    assert.deepEqual(JSON.parse(result.stdout), { provenance: 'STUB', files: expectedAnchors(fixtures) });
    const summary = metadata(result, { kind: 'bulk-reader', model: 'claude-haiku-4.5', attempts: 1 });
    const records = await observations(work.root);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].contractErrors, []);
    const bodies = await Promise.all(fixtures.map((fixture) => readFile(path.join(work.root, fixture.file), 'utf8')));
    const accounting = parentAccounting({
      invocationCharacters: invocationText('bulk-reader', args, work.root).length,
      skillCharacters: await skillCharacters('bulk-reader'),
      corpusCharacters: bodies.reduce((sum, text) => sum + text.length, 0),
      baselineAnswerCharacters: result.stdout.length,
      parentReplyCharacters: result.stdout.length,
      metadataCharacters: result.stderr.length,
    });
    assert.ok(accounting.parentSavingsPercent >= 80, `${label} parent-context estimate must save at least 80 percent.`);
    assert.equal(accounting.afterCorpusCharacters, 0);
    assert.ok(Buffer.byteLength(result.stdout) <= 4096);
    assert.equal(summary.inputBytes, records[0].payloadBytes);
    return {
      ...accounting,
      workerPayloadCharacters: records[0].payloadCharacters,
      workerPayloadBytes: records[0].payloadBytes,
      workerPayloadTokens: estimateTokens(records[0].payloadCharacters),
      workerAnswerTokens: estimateTokens(result.stdout),
    };
  } finally {
    await work.cleanup();
  }
}

async function generatorCase() {
  const work = await workspace(undefined, 'benchmark-generator');
  try {
    const reference = FIXTURES[2];
    await copyFixtures(work.root, [reference]);
    await configureStub(work.root, { mode: 'generate', fence: '```javascript' });
    const target = 'generated-gauge.mjs';
    const args = ['--root', work.root, '--spec', GENERATION_SPEC, '--reference', reference.file, '--target', target];
    const result = await runWorker('code-writer', args, { root: work.root });
    assertSuccess(result);
    const body = await readFile(path.join(work.root, target), 'utf8');
    assert.equal(sha256(body), sha256(generatedStubCode()), 'The actual target must contain the entire deterministic generated body.');
    assert.ok(Buffer.byteLength(body) > 4096, 'Generation must exercise a real, nontrivial disk body.');
    const confirmation = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(confirmation).sort(), ['bytes', 'model', 'written']);
    assert.equal(confirmation.written, target);
    assert.equal(confirmation.bytes, Buffer.byteLength(body));
    assert.equal(result.stdout.includes('export '), false);
    assert.equal(result.stdout.includes('generatedReadings'), false);
    const summary = metadata(result, { kind: 'code-writer', model: 'gpt-5.4-mini', attempts: 1 });
    const records = await observations(work.root);
    assert.equal(records.length, 1);
    assert.equal(summary.inputBytes, records[0].payloadBytes);
    const source = await readFile(path.join(work.root, reference.file), 'utf8');
    const accounting = parentAccounting({
      invocationCharacters: invocationText('code-writer', args, work.root).length,
      skillCharacters: await skillCharacters('code-writer'),
      corpusCharacters: source.length,
      baselineAnswerCharacters: body.length,
      parentReplyCharacters: result.stdout.length,
      metadataCharacters: result.stderr.length + 2048,
    });
    return {
      ...accounting, parentGeneratedBodyCharacters: 0, parentGeneratedBodyTokens: 0,
      parentReviewAllowanceTokens: 512,
      diskCharacters: body.length, diskBytes: Buffer.byteLength(body),
      workerPayloadCharacters: records[0].payloadCharacters,
      workerPayloadBytes: records[0].payloadBytes,
      workerPayloadTokens: estimateTokens(records[0].payloadCharacters),
      workerAnswerTokens: estimateTokens(body),
    };
  } finally {
    await work.cleanup();
  }
}

function coarseNumbers(single, multi, generator) {
  const numbers = {
    schemaVersion: 1, stub: 1, charactersPerEstimatedToken: CHARACTERS_PER_ESTIMATED_TOKEN,
    fixedDelegationCharacters: FIXED_DELEGATION_CHARACTERS,
  };
  for (const [prefix, result] of Object.entries({ single, multi, generator })) {
    for (const [key, value] of Object.entries(result)) {
      assert.equal(typeof value, 'number');
      assert.ok(Number.isFinite(value));
      numbers[`${prefix}_${key}`] = Math.round(value * 100) / 100;
    }
  }
  return numbers;
}

export async function benchmark() {
  await generateFixtures();
  const single = await readerCase(FIXTURES.slice(0, 1), 'single');
  const multi = await readerCase(FIXTURES.slice(0, 2), 'multi');
  const generator = await generatorCase();
  assert.equal(generator.parentGeneratedBodyTokens, 0);
  const numbers = coarseNumbers(single, multi, generator);
  await mkdir(path.join(EVAL_ROOT, 'results'), { recursive: true });
  await writeFile(path.join(EVAL_ROOT, 'results/benchmark.json'), `${JSON.stringify(numbers, null, 2)}\n`, { mode: 0o600 });

  console.log('STUB accounting estimate, not a live quality result or total billing savings.');
  console.log('Estimated tokens = ceil(characters / 4); no tokenizer or model billing API is used.');
  console.log(`Both sides count the local skill text plus ${FIXED_DELEGATION_CHARACTERS} fixed delegation characters per task.`);
  console.log('Before includes the corpus and returned answer/code body. After includes request paths, compact stdout, and coarse metadata; corpus bytes are not counted in parent after.');
  console.log('Case | Parent before tokens | Parent after tokens | Parent savings');
  for (const [label, result] of [['One large-file question', single], ['Multi-file question', multi], ['Generate to disk', generator]]) {
    console.log(`${label} | ${result.beforeTokens} | ${result.afterTokens} | ${result.parentSavingsPercent.toFixed(2)}%`);
  }
  console.log('Cheap-worker input payload estimates are separate from parent-context savings:');
  console.log(`Single: ${single.workerPayloadTokens} tokens (${single.workerPayloadBytes} UTF-8 bytes).`);
  console.log(`Multi: ${multi.workerPayloadTokens} tokens (${multi.workerPayloadBytes} UTF-8 bytes).`);
  console.log(`Generator: ${generator.workerPayloadTokens} tokens (${generator.workerPayloadBytes} UTF-8 bytes).`);
  console.log(`Generated body in parent: ${generator.parentGeneratedBodyTokens} tokens. Verified disk body: ${generator.diskBytes} bytes.`);
  console.log('Generate-to-disk accounting also reserves 512 parent tokens for bounded review.');
  console.log('Saved numeric-only evidence to evals/results/benchmark.json.');
  return numbers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await benchmark();
  } catch (error) {
    console.error(`STUB accounting failed: ${error.message}`);
    process.exitCode = 1;
  }
}
