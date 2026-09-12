import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FIXTURES, anchorQuestion, expectedAnchors } from './fixtures.mjs';
import {
  assertFailure, assertSuccess, configureStub, copyFixtures, metadata, observations,
  readerArgs, runWorker, seedSmallFiles, sha256, workspace, writerArgs,
} from './helpers.mjs';

test('named worker input contracts reject missing, conflicting, and positional arguments before invoking Copilot', async (t) => {
  const cases = [
    ['reader needs a question', 'bulk-reader', ['--path', 'small.txt'], 'ARGUMENTS'],
    ['reader needs a path', 'bulk-reader', ['--question', 'Evidence?'], 'ARGUMENTS'],
    ['reader rejects no arguments', 'bulk-reader', [], 'ARGUMENTS'],
    ['reader rejects positional input', 'bulk-reader', ['small.txt'], 'ARGUMENTS'],
    ['reader rejects unknown flags', 'bulk-reader', ['--question', 'Evidence?', '--path', 'small.txt', '--unknown'], 'ARGUMENTS'],
    ['reader rejects empty named question', 'bulk-reader', ['--question', '', '--path', 'small.txt'], 'ARGUMENTS'],
    ['reader rejects blank named question', 'bulk-reader', ['--question', ' \n ', '--path', 'small.txt'], 'INPUT'],
    ['reader rejects both question modes', 'bulk-reader', ['--question', 'Evidence?', '--question-file', 'small.txt', '--path', 'small.txt'], 'ARGUMENTS'],
    ['reader rejects a missing flag value', 'bulk-reader', ['--question'], 'ARGUMENTS'],
    ['reader rejects too many paths', 'bulk-reader', ['--question', 'Evidence?', ...Array.from({ length: 65 }, () => ['--path', 'small.txt']).flat()], 'ARGUMENTS'],
    ['writer requires a reference', 'code-writer', ['--spec', 'Generate code.'], 'ARGUMENTS'],
    ['writer requires named spec', 'code-writer', ['--reference', 'reference.mjs'], 'ARGUMENTS'],
    ['writer rejects no arguments', 'code-writer', [], 'ARGUMENTS'],
    ['writer rejects positional spec', 'code-writer', ['Generate code.', '--reference', 'reference.mjs'], 'ARGUMENTS'],
    ['writer rejects empty spec', 'code-writer', ['--spec', '', '--reference', 'reference.mjs'], 'ARGUMENTS'],
    ['writer rejects blank spec', 'code-writer', ['--spec', ' \n ', '--reference', 'reference.mjs'], 'INPUT'],
    ['writer rejects both spec modes', 'code-writer', ['--spec', 'Generate.', '--spec-file', 'small.txt', '--reference', 'reference.mjs'], 'ARGUMENTS'],
    ['writer overwrite requires target', 'code-writer', ['--spec', 'Generate.', '--reference', 'reference.mjs', '--overwrite'], 'ARGUMENTS'],
    ['writer rejects unknown flags', 'code-writer', ['--spec', 'Generate.', '--reference', 'reference.mjs', '--unknown'], 'ARGUMENTS'],
    ['writer rejects missing target value', 'code-writer', ['--spec', 'Generate.', '--reference', 'reference.mjs', '--target'], 'ARGUMENTS'],
  ];
  for (const [name, kind, args, error] of cases) {
    await t.test(name, async (subtest) => {
      const { root } = await workspace(subtest, 'arguments');
      await seedSmallFiles(root);
      assertFailure(await runWorker(kind, ['--root', root, ...args], { root }), error);
      assert.equal((await observations(root)).length, 0, 'Invalid arguments must not start a child worker.');
    });
  }
});

test('question/spec files and the default cwd root use the real named entry points', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    await t.test(kind, async (subtest) => {
      const { root } = await workspace(subtest, 'named-file');
      await seedSmallFiles(root);
      const instruction = "Original instruction: retain café, 'quotes', $literal, and a semicolon; do not execute anything.";
      await writeFile(path.join(root, 'instruction.txt'), instruction);
      const args = kind === 'bulk-reader'
        ? ['--question-file', 'instruction.txt', '--path', 'small.txt']
        : ['--spec-file', 'instruction.txt', '--reference', 'reference.mjs'];
      const result = await runWorker(kind, args, { root, cwd: root });
      assertSuccess(result);
      const [record] = await observations(root);
      assert.equal(record.instruction, instruction);
      assert.equal(path.dirname(record.cwd), root);
      assert.deepEqual(record.contractErrors, []);
      assert.equal(record.kind, kind);
      metadata(result, { kind, attempts: 1 });
    });
  }
});

test('input validation rejects missing files, traversal, escaped symlinks, binary data, and directories', async (t) => {
  const cases = [
    ['missing file', 'absent.txt', 'MISSING_FILE'],
    ['relative traversal', '../outside/outside.txt', 'PATH'],
    ['absolute outside path', 'ABSOLUTE_OUTSIDE', 'PATH'],
    ['file symlink escape', 'outside-link.txt', 'PATH'],
    ['directory symlink escape', 'outside-dir/outside.txt', 'PATH'],
    ['input directory', 'directory', 'FILE_TYPE'],
    ['control character path', 'bad\npath', 'PATH'],
    ['invalid UTF-8', 'invalid-utf8.txt', 'ENCODING'],
    ['NUL binary input', 'binary.txt', 'ENCODING'],
  ];
  for (const kind of ['bulk-reader', 'code-writer']) {
    for (const [name, input, code] of cases) {
      await t.test(`${kind}: ${name}`, async (subtest) => {
        const work = await workspace(subtest, 'input-path');
        await seedSmallFiles(work.root);
        await writeFile(path.join(work.outside, 'outside.txt'), 'Original contained outside-root fixture.\n');
        await mkdir(path.join(work.root, 'directory'));
        await symlink(path.join(work.outside, 'outside.txt'), path.join(work.root, 'outside-link.txt'));
        await symlink(work.outside, path.join(work.root, 'outside-dir'), 'dir');
        await writeFile(path.join(work.root, 'invalid-utf8.txt'), Buffer.from([0xc3, 0x28]));
        await writeFile(path.join(work.root, 'binary.txt'), Buffer.from([0x61, 0x00, 0x62]));
        const file = input === 'ABSOLUTE_OUTSIDE' ? path.join(work.outside, 'outside.txt') : input;
        const args = kind === 'bulk-reader'
          ? readerArgs(work.root, [file])
          : ['--root', work.root, '--spec', 'Generate.', '--reference', file];
        assertFailure(await runWorker(kind, args, { root: work.root }), code);
        assert.equal((await observations(work.root)).length, 0);
      });
    }
  }
});

test('instruction file paths obey the same root and encoding constraints', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    for (const [name, input, code] of [
      ['traversal', '../outside/instruction.txt', 'PATH'],
      ['symlink escape', 'instruction-link.txt', 'PATH'],
      ['missing', 'absent.txt', 'MISSING_FILE'],
      ['empty', 'empty.txt', 'INPUT'],
    ]) {
      await t.test(`${kind}: ${name}`, async (subtest) => {
        const work = await workspace(subtest, 'instruction-path');
        await seedSmallFiles(work.root);
        await writeFile(path.join(work.outside, 'instruction.txt'), 'Original outside instruction.');
        await symlink(path.join(work.outside, 'instruction.txt'), path.join(work.root, 'instruction-link.txt'));
        await writeFile(path.join(work.root, 'empty.txt'), '');
        const args = kind === 'bulk-reader'
          ? ['--root', work.root, '--question-file', input, '--path', 'small.txt']
          : ['--root', work.root, '--spec-file', input, '--reference', 'reference.mjs'];
        assertFailure(await runWorker(kind, args, { root: work.root }), code);
        assert.equal((await observations(work.root)).length, 0);
      });
    }
  }
});

test('inside-root input symlinks canonicalize safely and quoted filenames remain data', async (t) => {
  const { root } = await workspace(t, 'input-literal');
  await seedSmallFiles(root);
  const file = "original user's; input.txt";
  const source = 'Original café input.\nLast original line.\n';
  await writeFile(path.join(root, file), source);
  await symlink(path.join(root, file), path.join(root, 'inside-link.txt'));
  const result = await runWorker('bulk-reader', readerArgs(root, ['inside-link.txt']), { root });
  assertSuccess(result);
  const [record] = await observations(root);
  assert.equal(record.files[0].path, file);
  assert.equal(record.files[0].hash, sha256('1: Original café input.\n2: Last original line.'));
});

test('two large inputs reach the child intact with first/last anchors and line numbering', async (t) => {
  const { root } = await workspace(t, 'attachments');
  const fixtures = FIXTURES.slice(0, 2);
  await copyFixtures(root, fixtures);
  await configureStub(root, { mode: 'anchors' });
  const result = await runWorker('bulk-reader', readerArgs(root, fixtures.map((fixture) => fixture.file), anchorQuestion(fixtures)), { root });
  assertSuccess(result);
  assert.deepEqual(JSON.parse(result.stdout), { provenance: 'STUB', files: expectedAnchors(fixtures) });
  const [record] = await observations(root);
  assert.equal(record.files.length, 2);
  for (const [index, fixture] of fixtures.entries()) {
    const raw = await readFile(path.join(root, fixture.file), 'utf8');
    const lines = raw.split('\n');
    lines.pop();
    const expected = lines.map((line, lineIndex) => `${lineIndex + 1}: ${line}`).join('\n');
    assert.equal(record.files[index].hash, sha256(expected), 'Entire numbered content must be resent, not truncated.');
    assert.equal(record.files[index].lines, fixture.lines);
    assert.equal(record.files[index].numbered, true);
    assert.ok(record.files[index].firstLine.includes(fixture.first));
    assert.ok(record.files[index].lastLine.includes(fixture.last));
  }
  assert.equal(metadata(result).inputBytes, record.payloadBytes);
});

test('code references reach the child raw rather than line-numbered', async (t) => {
  const { root } = await workspace(t, 'reference-transport');
  const fixture = FIXTURES[2];
  await copyFixtures(root, [fixture]);
  await configureStub(root, { answer: 'export const original = true;\n' });
  const result = await runWorker('code-writer', [
    '--root', root, '--spec', 'Generate an original module.', '--reference', fixture.file,
  ], { root });
  assertSuccess(result);
  const [record] = await observations(root);
  assert.equal(record.files[0].hash, sha256(await readFile(path.join(root, fixture.file))));
  assert.ok(record.files[0].firstLine.includes(fixture.first));
  assert.equal(record.requestKeys.includes('question'), false);
});

test('reader numbering preserves the final real line without adding a phantom trailing line', async (t) => {
  const content = 'FIRST_ORIGINAL_EVAL_LINE\nLAST_ORIGINAL_EVAL_LINE';
  const expected = '1: FIRST_ORIGINAL_EVAL_LINE\n2: LAST_ORIGINAL_EVAL_LINE';
  for (const [label, suffix] of [['terminated', '\n'], ['unterminated', '']]) {
    await t.test(label, async (subtest) => {
      const { root } = await workspace(subtest, 'numbered-ending');
      await seedSmallFiles(root);
      await writeFile(path.join(root, 'small.txt'), content + suffix);
      assertSuccess(await runWorker('bulk-reader', readerArgs(root), { root }));
      const [record] = await observations(root);
      assert.equal(record.files[0].lines, 2);
      assert.equal(record.files[0].hash, sha256(expected));
      assert.equal(record.files[0].lastLine, '2: LAST_ORIGINAL_EVAL_LINE');
    });
  }
});

test('combined payload limits count serialized UTF-8, labels, rules, and line numbers', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    await t.test(kind, async (subtest) => {
      const { root } = await workspace(subtest, 'payload');
      await seedSmallFiles(root);
      const input = `${'é'.repeat(400)}\n${'ç'.repeat(400)}\n`;
      await writeFile(path.join(root, 'évidence.txt'), input);
      await writeFile(path.join(root, 'reference.mjs'), input);
      const instruction = 'Répondre seulement avec les éléments demandés.';
      const args = kind === 'bulk-reader'
        ? readerArgs(root, ['évidence.txt'], instruction)
        : writerArgs(root, [], instruction);
      const baseline = await runWorker(kind, args, { root });
      assertSuccess(baseline);
      const [record] = await observations(root);
      const sourceBytes = Buffer.byteLength(input) + Buffer.byteLength(instruction);
      assert.ok(record.payloadBytes > sourceBytes, 'Serialized rules, file labels, and numbering require budget.');
      assert.ok(record.payloadBytes > record.payloadCharacters, 'The UTF-8 fixture must distinguish bytes from characters.');
      const exact = await runWorker(kind, args, {
        root, env: { TOKENREDUCER_MAX_PAYLOAD_BYTES: String(record.payloadBytes) },
      });
      assertSuccess(exact);
      for (const ceiling of [record.payloadBytes - 1, Math.max(record.payloadCharacters, sourceBytes), sourceBytes]) {
        assert.ok(ceiling < record.payloadBytes);
        assertFailure(await runWorker(kind, args, {
          root, env: { TOKENREDUCER_MAX_PAYLOAD_BYTES: String(ceiling) },
        }), 'PAYLOAD');
      }
      assert.equal((await observations(root)).length, 2, 'Rejected payloads must not invoke a model.');
    });
  }
});

test('combined files and oversized named instructions are rejected before model invocation', async (t) => {
  const { root } = await workspace(t, 'combined-budget');
  await seedSmallFiles(root);
  await writeFile(path.join(root, 'first.txt'), 'a'.repeat(2000));
  await writeFile(path.join(root, 'second.txt'), 'b'.repeat(2000));
  for (const file of ['first.txt', 'second.txt']) {
    assertSuccess(await runWorker('bulk-reader', readerArgs(root, [file]), {
      root, env: { TOKENREDUCER_MAX_PAYLOAD_BYTES: '4096' },
    }));
  }
  assertFailure(await runWorker('bulk-reader', readerArgs(root, ['first.txt', 'second.txt']), {
    root, env: { TOKENREDUCER_MAX_PAYLOAD_BYTES: '4096' },
  }), 'PAYLOAD');
  for (const kind of ['bulk-reader', 'code-writer']) {
    const args = kind === 'bulk-reader' ? readerArgs(root, ['small.txt'], 'x'.repeat(1025)) : writerArgs(root, [], 'x'.repeat(1025));
    assertFailure(await runWorker(kind, args, { root, env: { TOKENREDUCER_MAX_PAYLOAD_BYTES: '1024' } }), 'PAYLOAD');
  }
  await writeFile(path.join(root, 'too-large.txt'), 'z'.repeat(1_048_577));
  assertFailure(await runWorker('bulk-reader', readerArgs(root, ['too-large.txt']), { root }), 'PAYLOAD');
  assert.equal((await observations(root)).length, 2, 'Only the two individually valid inputs may invoke a worker.');
});

test('malformed worker configuration fails before any process transport', async (t) => {
  const { root } = await workspace(t, 'worker-config');
  await seedSmallFiles(root);
  const settings = [
    ['TOKENREDUCER_MAX_PAYLOAD_BYTES', '0', 'CONFIG'],
    ['TOKENREDUCER_MAX_PAYLOAD_BYTES', '16777217', 'CONFIG'],
    ['TOKENREDUCER_TIMEOUT_SECONDS', '0', 'CONFIG'],
    ['TOKENREDUCER_TIMEOUT_SECONDS', '1.5', 'CONFIG'],
    ['TOKENREDUCER_BULK_READER_MODEL', 'auto', 'MODEL'],
    ['TOKENREDUCER_BULK_READER_MODEL', 'model;not-a-command', 'MODEL'],
  ];
  for (const [key, value, code] of settings) {
    await t.test(`${key}=${value}`, async () => {
      assertFailure(await runWorker('bulk-reader', readerArgs(root), { root, env: { [key]: value } }), code);
    });
  }
  assert.equal((await observations(root)).length, 0);
});
