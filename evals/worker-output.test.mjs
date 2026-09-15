import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { generatedStubCode } from './fixtures.mjs';
import {
  assertFailure, assertSuccess, configureStub, exists, metadata, observations, readerArgs,
  runWorker, seedSmallFiles, sha256, workspace, writerArgs,
} from './helpers.mjs';

test('empty answers and empty fenced code fail without returning a body', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    for (const [label, answer] of [['empty', ''], ['whitespace', ' \n\t ']]) {
      await t.test(`${kind}: ${label}`, async (subtest) => {
        const { root } = await workspace(subtest, 'empty-answer');
        await seedSmallFiles(root);
        await configureStub(root, { answer });
        const args = kind === 'bulk-reader' ? readerArgs(root) : writerArgs(root, ['--target', 'generated.mjs']);
        assertFailure(await runWorker(kind, args, { root }), 'EMPTY_ANSWER');
        assert.equal((await observations(root)).length, 1);
        assert.equal(await exists(path.join(root, 'generated.mjs')), false);
      });
    }
  }
  await t.test('empty fence body', async (subtest) => {
    const { root } = await workspace(subtest, 'empty-fence');
    await seedSmallFiles(root);
    await configureStub(root, { answer: '```js\n\n```' });
    assertFailure(await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root }), 'EMPTY_ANSWER');
    assert.equal(await exists(path.join(root, 'generated.mjs')), false);
  });
});

test('writer strips whole-response fences without forwarding explanations or changing raw indentation', async (t) => {
  const code = "export const original = 'cedar';\n";
  const cases = [
    ['raw code', { answer: code }, code],
    ['raw indentation', { answer: `  ${code}` }, `  ${code}`],
    ['backtick fence', { answer: code, fence: '```js' }, code],
    ['tilde fence', { answer: code, fence: '~~~javascript' }, code],
    ['long fence', { answer: code, fence: '````mjs' }, code],
    ['CRLF fence', { answer: "```js\r\nexport const original = 'cedar';\r\n```\r\n" }, code],
  ];
  for (const [name, plan, expected] of cases) {
    await t.test(name, async (subtest) => {
      const { root } = await workspace(subtest, 'fences');
      await seedSmallFiles(root);
      await configureStub(root, plan);
      const result = await runWorker('code-writer', writerArgs(root), { root });
      assertSuccess(result);
      assert.equal(result.stdout, expected);
      metadata(result, { kind: 'code-writer', model: 'eval-writer-model', attempts: 1 });
    });
  }
  for (const answer of ['```js\nexport const value = 1;\n~~~', '```js\nexport const value = 1;', '```js\nexport const value = 1;\n```\nUnexpected explanation.']) {
    await t.test('malformed or trailing fence content is refused', async (subtest) => {
      const { root } = await workspace(subtest, 'bad-fence');
      await seedSmallFiles(root);
      await configureStub(root, { answer });
      assertFailure(await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root }), 'OUTPUT');
      assert.equal(await exists(path.join(root, 'generated.mjs')), false);
    });
  }
});

test('stdout answer bodies enforce a 4096-byte ceiling including UTF-8', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    for (const [name, plan, success] of [
      ['ASCII boundary', { mode: 'sized-answer', characters: 4096 }, true],
      ['ASCII overflow', { mode: 'sized-answer', characters: 4097 }, false],
      ['UTF-8 boundary', { mode: 'sized-answer', characters: 2048, unit: 'é' }, true],
      ['UTF-8 overflow', { mode: 'sized-answer', characters: 2049, unit: 'é' }, false],
    ]) {
      await t.test(`${kind}: ${name}`, async (subtest) => {
        const { root } = await workspace(subtest, 'output-size');
        await seedSmallFiles(root);
        await configureStub(root, plan);
        const args = kind === 'bulk-reader' ? readerArgs(root) : writerArgs(root);
        const result = await runWorker(kind, args, { root });
        if (success) {
          assertSuccess(result);
          assert.equal(Buffer.byteLength(result.stdout.trimEnd()), 4096);
          assert.equal(metadata(result).outputBytes, 4096);
        } else {
          assertFailure(result, 'OUTPUT');
          if (kind === 'code-writer') assert.match(result.stderr, /--target/);
        }
      });
    }
  }
});

test('unsafe control characters and malformed Unicode are withheld', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    for (const [label, answer] of [
      ['terminal control', 'Original output \u001b[31m forbidden'],
      ['NUL', 'Original output \u0000 forbidden'],
      ['unpaired surrogate', `Original output ${String.fromCharCode(0xd800)}`],
    ]) {
      await t.test(`${kind}: ${label}`, async (subtest) => {
        const { root } = await workspace(subtest, 'output-encoding');
        await seedSmallFiles(root);
        await configureStub(root, { answer });
        const args = kind === 'bulk-reader' ? readerArgs(root) : writerArgs(root, ['--target', 'generated.mjs']);
        assertFailure(await runWorker(kind, args, { root }), 'OUTPUT');
        assert.equal(await exists(path.join(root, 'generated.mjs')), false);
      });
    }
  }
});

test('generate-to-disk writes nontrivial code and returns only a compact confirmation', async (t) => {
  const { root } = await workspace(t, 'target-success');
  await seedSmallFiles(root);
  await mkdir(path.join(root, 'output'));
  const target = "output/original user's; module.mjs";
  await configureStub(root, { mode: 'generate', fence: '```javascript', diagnostics: true });
  const result = await runWorker('code-writer', writerArgs(root, ['--target', target]), { root });
  assertSuccess(result);
  const actual = await readFile(path.join(root, target), 'utf8');
  const expected = generatedStubCode();
  assert.equal(sha256(actual), sha256(expected), 'The complete unfenced body must be written to disk.');
  assert.ok(Buffer.byteLength(actual) > 4096);
  const confirmation = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(confirmation).sort(), ['bytes', 'model', 'written']);
  assert.equal(confirmation.written, target);
  assert.equal(confirmation.bytes, Buffer.byteLength(actual));
  assert.equal(confirmation.model, 'eval-writer-model');
  assert.ok(Buffer.byteLength(result.stdout) < 1024);
  assert.equal(result.stdout.includes('export '), false, 'Generated code bodies must not enter parent stdout.');
  assert.equal(result.stderr.includes('STUB_PRIVATE_DIAGNOSTIC'), false);
  metadata(result, { kind: 'code-writer', model: 'eval-writer-model', attempts: 1 });
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, target))).mode & 0o777, 0o600);
});

test('generation-to-disk enforces the one-MiB body limit', async (t) => {
  for (const [label, characters, expected] of [
    ['boundary', 1_048_575, 'success'],
    ['overflow', 1_048_576, 'failure'],
  ]) {
    await t.test(label, async (subtest) => {
      const { root } = await workspace(subtest, 'target-size');
      await seedSmallFiles(root);
      await configureStub(root, { mode: 'sized-answer', characters, finalNewline: true });
      const result = await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root });
      if (expected === 'success') {
        assertSuccess(result);
        assert.equal((await stat(path.join(root, 'generated.mjs'))).size, 1_048_576);
        assert.equal(JSON.parse(result.stdout).bytes, 1_048_576);
        assert.equal(metadata(result).outputBytes, 1_048_576);
      } else {
        assertFailure(result, 'OUTPUT');
        assert.equal(await exists(path.join(root, 'generated.mjs')), false);
      }
    });
  }
});

test('existing target requires overwrite and explicit overwrite preserves mode', async (t) => {
  const { root } = await workspace(t, 'target-overwrite');
  await seedSmallFiles(root);
  const target = path.join(root, 'generated.mjs');
  const original = 'Original target must not be silently replaced.\n';
  await writeFile(target, original);
  await chmod(target, 0o640);
  assertFailure(await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root }), 'EXISTS');
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await observations(root)).length, 0);
  const replacement = 'export const explicitlyReplaced = true;\n';
  await configureStub(root, { answer: replacement });
  const result = await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs', '--overwrite']), { root });
  assertSuccess(result);
  assert.equal(await readFile(target, 'utf8'), replacement);
  if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o640);
  assert.equal((await observations(root)).length, 1);
});

test('concurrent target creation and modification are detected without overwriting the newer content', async (t) => {
  for (const existed of [false, true]) {
    await t.test(existed ? 'existing file changed' : 'new target appeared', async (subtest) => {
      const { root } = await workspace(subtest, 'target-race');
      await seedSmallFiles(root);
      const target = path.join(root, 'generated.mjs');
      if (existed) await writeFile(target, 'Original target.\n');
      const concurrent = 'Original deterministic concurrent edit must survive generation.\n';
      await configureStub(root, {
        answer: 'export const mustNotOverwrite = true;\n',
        effect: { path: 'generated.mjs', content: concurrent },
      });
      const args = writerArgs(root, ['--target', 'generated.mjs', ...(existed ? ['--overwrite'] : [])]);
      assertFailure(await runWorker('code-writer', args, { root }), 'CONFLICT');
      assert.equal(await readFile(target, 'utf8'), concurrent);
      assert.equal((await observations(root)).length, 1);
    });
  }
});

test('writer refuses traversal, symlinks, hardlinks, directories, and missing target parents', async (t) => {
  const cases = [
    ['relative traversal', '../outside/generated.mjs', 'TARGET'],
    ['absolute outside path', 'ABSOLUTE_OUTSIDE', 'TARGET'],
    ['target is root', '.', 'TARGET'],
    ['symlink target inside root', 'inside-link.mjs', 'TARGET'],
    ['symlink target outside root', 'outside-link.mjs', 'TARGET'],
    ['hardlinked target', 'hardlink.mjs', 'TARGET'],
    ['inside symlink parent', 'inside-directory/generated.mjs', 'TARGET'],
    ['outside symlink parent', 'outside-directory/generated.mjs', 'TARGET'],
    ['directory target', 'directory', 'TARGET'],
    ['missing parent', 'missing/generated.mjs', undefined],
  ];
  for (const [name, requested, code] of cases) {
    await t.test(name, async (subtest) => {
      const work = await workspace(subtest, 'unsafe-target');
      await seedSmallFiles(work.root);
      const original = 'Original target sentinel.\n';
      await writeFile(path.join(work.root, 'original.mjs'), original);
      await writeFile(path.join(work.outside, 'original.mjs'), original);
      await mkdir(path.join(work.root, 'directory'));
      await symlink(path.join(work.root, 'original.mjs'), path.join(work.root, 'inside-link.mjs'));
      await symlink(path.join(work.outside, 'original.mjs'), path.join(work.root, 'outside-link.mjs'));
      await link(path.join(work.root, 'original.mjs'), path.join(work.root, 'hardlink.mjs'));
      await symlink(path.join(work.root, 'directory'), path.join(work.root, 'inside-directory'), 'dir');
      await symlink(work.outside, path.join(work.root, 'outside-directory'), 'dir');
      const target = requested === 'ABSOLUTE_OUTSIDE' ? path.join(work.outside, 'generated.mjs') : requested;
      const result = await runWorker('code-writer', writerArgs(work.root, ['--target', target, '--overwrite']), { root: work.root });
      assertFailure(result, code);
      assert.equal((await observations(work.root)).length, 0);
      assert.equal(await readFile(path.join(work.root, 'original.mjs'), 'utf8'), original);
      assert.equal(await readFile(path.join(work.outside, 'original.mjs'), 'utf8'), original);
      assert.equal(await exists(path.join(work.outside, 'generated.mjs')), false);
    });
  }
});
