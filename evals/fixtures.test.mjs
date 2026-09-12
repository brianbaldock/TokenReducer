import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES, FIXTURE_ROOT, fixtureContents, generateFixtures, generatedStubCode } from './fixtures.mjs';
import { sha256, workspace } from './helpers.mjs';

test('original fixture files are deterministic, complete, and at least 700 lines each', async (t) => {
  const work = await workspace(t, 'fixtures');
  const generated = path.join(work.root, 'generated');
  await generateFixtures(generated);
  const expected = fixtureContents();
  for (const fixture of FIXTURES) {
    await t.test(fixture.file, async () => {
      const committed = await readFile(path.join(FIXTURE_ROOT, fixture.file), 'utf8');
      const regenerated = await readFile(path.join(generated, fixture.file), 'utf8');
      assert.equal(sha256(committed), sha256(expected.get(fixture.file)), 'On-disk fixtures must match their original generator.');
      assert.equal(sha256(regenerated), sha256(committed), 'Regeneration must be deterministic.');
      assert.ok(committed.endsWith('\n'));
      const lines = committed.trimEnd().split('\n');
      assert.equal(lines.length, fixture.lines);
      assert.ok(lines.length >= 700);
      assert.ok(lines[0].includes(fixture.first));
      assert.ok(lines.at(-1).includes(fixture.last));
      assert.equal(committed.split(fixture.first).length - 1, 1, 'First anchor must be unique.');
      assert.equal(committed.split(fixture.last).length - 1, 1, 'Last anchor must be unique.');
    });
  }
  await generateFixtures(generated);
  assert.equal(sha256(await readFile(path.join(generated, FIXTURES[0].file))), sha256(expected.get(FIXTURES[0].file)));
});

test('the original reference is executable ESM with meaningful validation', async () => {
  const reference = await import(pathToFileURL(path.join(FIXTURE_ROOT, 'reference-validator.mjs')));
  assert.ok(reference.allowedSignals.length > 700);
  const signal = reference.allowedSignals[0];
  assert.deepEqual(reference.validateSignal({ name: signal.name, count: 1 }), { name: signal.name, count: 1, unit: 'events' });
  assert.throws(() => reference.validateSignal(null), TypeError);
  assert.throws(() => reference.validateSignal({ name: 'unknown', count: 1 }), RangeError);
  assert.throws(() => reference.validateSignal({ name: signal.name, count: -1 }), RangeError);
});

test('deterministic generated stub code is clearly labeled and nontrivial', () => {
  const code = generatedStubCode();
  assert.match(code, /^\/\/ STUB:/);
  assert.ok(Buffer.byteLength(code) > 4096);
  assert.ok(code.split('\n').length > 190);
  assert.equal(sha256(code), sha256(generatedStubCode()));
});
