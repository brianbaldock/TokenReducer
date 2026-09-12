import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertFailure, assertSuccess, configureStub, observations,
  runWorker, seedSmallFiles, workspace, writerArgs,
} from './helpers.mjs';

test('follow-up generation uses the just-written file in a fresh worker', async (t) => {
  const { root } = await workspace(t, 'writer-followup');
  await seedSmallFiles(root);
  await configureStub(root, { answer: 'export const firstGeneration = 1;\n' });
  assertSuccess(await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root }));
  await configureStub(root, { answer: 'export const secondGeneration = 2;\n' });
  assertSuccess(await runWorker('code-writer', [
    '--root', root, '--spec', 'Update the reference.', '--reference', 'generated.mjs',
    '--target', 'generated.mjs', '--overwrite',
  ], { root }));
  const records = await observations(root);
  assert.equal(records[1].files[0].path, 'generated.mjs');
  assert.notEqual(records[0].cwd, records[1].cwd);
  assert.equal(await readFile(path.join(root, 'generated.mjs'), 'utf8'), 'export const secondGeneration = 2;\n');
});

test('the published newline is included in the generation size ceiling', async (t) => {
  const { root } = await workspace(t, 'newline-budget');
  await seedSmallFiles(root);
  await configureStub(root, { mode: 'sized-answer', characters: 1_048_576 });
  assertFailure(await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root }), 'OUTPUT');
});
