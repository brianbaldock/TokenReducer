import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseResponse } from '../.github/skills/bulk-reader/scripts/lib/copilot.mjs';
import { FIXTURES, anchorQuestion } from './fixtures.mjs';
import {
  assertFailure, assertSuccess, configureStub, copyFixtures, exists, metadata, observations,
  readerArgs, runWorker, seedSmallFiles, workspace, writerArgs,
} from './helpers.mjs';

test('actual process transport is one-shot stdin JSON with an ephemeral tool-free agent and no inherited history', async (t) => {
  const work = await workspace(t, 'isolation');
  await seedSmallFiles(work.root);
  const parentHome = path.join(work.home, 'seeded-copilot');
  const historyDirectory = path.join(parentHome, 'session-state', 'parent-session');
  await mkdir(historyDirectory, { recursive: true });
  const marker = 'EVAL_PARENT_ONLY_MEMORY_DO_NOT_INHERIT';
  const parentConfig = JSON.stringify({ memory: true, model: 'parent-coordinator', history: marker });
  await writeFile(path.join(parentHome, 'config.json'), parentConfig);
  await writeFile(path.join(historyDirectory, 'events.jsonl'), `${JSON.stringify({ type: 'user.message', data: { content: marker } })}\n`);
  await mkdir(path.join(work.root, '.github/agents'), { recursive: true });
  await writeFile(path.join(work.root, '.github/agents/parent-eval.agent.md'), `---\nname: parent-eval\ntools: ['*']\n---\n${marker}\n`);
  const blocked = {
    COPILOT_MODEL: 'parent-coordinator',
    COPILOT_PROVIDER: 'parent-provider',
    COPILOT_SESSION_ID: 'parent-session',
    COPILOT_HISTORY: marker,
    COPILOT_HOOKS: marker,
    COPILOT_CUSTOM_INSTRUCTIONS: marker,
    COPILOT_MCP_CONFIG: marker,
    TOKENREDUCER_WORKER_HISTORY: marker,
    OPENAI_API_KEY: 'eval-placeholder-not-a-real-key',
    ANTHROPIC_API_KEY: 'eval-placeholder-not-a-real-key',
    AZURE_OPENAI_API_KEY: 'eval-placeholder-not-a-real-key',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/eval-unused',
    COPILOT_OTEL_ENDPOINT: 'http://127.0.0.1:9/eval-unused',
    BASH_ENV: path.join(work.home, 'not-a-shell-script'),
    ENV: path.join(work.home, 'not-a-shell-profile'),
    NODE_OPTIONS: '--no-warnings',
    NODE_PATH: work.outside,
  };
  const result = await runWorker('bulk-reader', readerArgs(work.root), {
    root: work.root,
    env: {
      ...blocked,
      COPILOT_HOME: parentHome,
      COPILOT_ALLOW_ALL: 'true',
      COPILOT_OTEL_ENABLED: 'true',
      COPILOT_GITHUB_TOKEN: 'eval-placeholder-not-a-live-token',
      GH_TOKEN: 'eval-placeholder-not-a-live-token',
      GITHUB_TOKEN: 'eval-placeholder-not-a-live-token',
    },
  });
  assertSuccess(result);
  const [record] = await observations(work.root);
  assert.deepEqual(record.contractErrors, []);
  assert.equal(record.kind, 'bulk-reader');
  assert.deepEqual(record.requestKeys, ['files', 'kind', 'question', 'rules']);
  assert.ok(record.payloadBytes > 0);
  assert.equal(record.argv.includes('--prompt'), false, '-p/--prompt would discard piped stdin in the real CLI.');
  assert.equal(record.argv.includes('-p'), false);
  assert.equal(record.argv.some((value) => /^(?:--resume|--continue|--history|--session-id|--allow-all(?:-[a-z-]+)?|-y)(?:=|$)/.test(value)), false);
  assert.equal(record.argv.includes('--deny-tool=*'), false, 'The real CLI rejects wildcard deny rules.');
  assert.deepEqual(record.argv.filter((flag) => flag.startsWith('--deny-tool=')),
    ['--deny-tool=shell', '--deny-tool=write', '--deny-tool=url']);
  for (const flag of ['--agent', '--no-custom-instructions']) {
    assert.ok(record.argv.includes(flag));
  }
  assert.equal(record.argv[record.argv.indexOf('--agent') + 1], 'tokenreducer-worker');
  assert.equal(record.profileToolFree, true);
  assert.deepEqual(record.homeEntries, ['config.json']);
  assert.equal(record.environment.GIT_CEILING_DIRECTORIES, work.root);
  assert.equal(record.environment.COPILOT_HOME, record.home);
  assert.equal(record.environment.COPILOT_ALLOW_ALL, 'false');
  assert.equal(record.environment.COPILOT_OTEL_ENABLED, 'false');
  assert.equal(record.environment.COPILOT_AUTO_UPDATE, 'false');
  for (const key of Object.keys(blocked)) assert.equal(record.environmentKeys.includes(key), false, `${key} must not reach the child.`);
  assert.equal(record.environmentKeys.some((key) => key.startsWith('TOKENREDUCER_')), false);
  assert.deepEqual(record.authPresent, ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
  assert.equal(JSON.stringify(record).includes(marker), false, 'No parent history or seed text may be attached.');
  assert.equal(await readFile(path.join(parentHome, 'config.json'), 'utf8'), parentConfig);
  assert.equal(await exists(record.cwd), false, 'The private agent, config, and work order must be removed after completion.');
  assert.equal(await exists(record.home), false);
  metadata(result, { kind: 'bulk-reader', model: 'claude-haiku-4.5', attempts: 1 });
});

test('JSONL answers require explicit matching model evidence throughout the response', async (t) => {
  const model = 'gpt-5-mini';
  const answer = { type: 'assistant.message', data: { content: 'Exact compact answer.' } };
  const usage = (value) => ({ type: 'assistant.usage', data: { model: value } });
  const start = (value) => ({ type: 'model.call_start', data: { model: value } });
  const cases = [
    ['matching usage', [usage(model), answer], true],
    ['matching call start', [start(model), answer], true],
    ['model evidence after answer', [answer, usage(model)], true],
    ['multiple matching reports', [start(model), answer, usage(model)], true],
    ['no model event', [answer], false],
    ['unrelated event with a model field', [{ type: 'session.start', data: { model } }, answer], false],
    ['missing model field', [{ type: 'assistant.usage', data: {} }, answer], false],
    ['null model', [usage(null), answer], false],
    ['numeric model', [start(12), answer], false],
    ['empty model', [usage(''), answer], false],
    ['mismatched usage', [usage('unrequested-model'), answer], false],
    ['mismatched call start', [start('unrequested-model'), answer], false],
    ['mismatch before a matching report', [start('unrequested-model'), answer, usage(model)], false],
    ['mismatch after a matching report', [start(model), answer, usage('unrequested-model')], false],
  ];
  for (const [name, events, accepted] of cases) {
    await t.test(name, () => {
      const response = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
      if (accepted) assert.equal(parseResponse(response, model), answer.data.content);
      else assert.throws(() => parseResponse(response, model), { code: 'MODEL' });
    });
  }
});

test('model mismatch diagnostics identify the observed and requested IDs without transcript content', async (t) => {
  const requested = 'gpt-5-mini';
  const transcript = (observed) => [
    JSON.stringify({ type: 'assistant.usage', data: { model: observed } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'PRIVATE_ANSWER_MUST_NOT_ESCAPE' } }),
  ].join('\n');
  assert.throws(() => parseResponse(transcript('unrequested-model'), requested), {
    code: 'MODEL',
    message: 'Copilot reported worker model unrequested-model; requested gpt-5-mini. Output was withheld.',
  });
  for (const observed of ['bad\nPRIVATE_DIAGNOSTIC', 'bad\u001b[31m', 'x'.repeat(81), 'bad model ID']) {
    await t.test(`malformed model of length ${observed.length}`, () => {
      assert.throws(() => parseResponse(transcript(observed), requested), (error) => {
        assert.equal(error.code, 'MODEL');
        assert.equal(error.message.includes(observed), false);
        assert.equal(error.message.includes('PRIVATE_ANSWER'), false);
        return true;
      });
    });
  }
});

test('second questions resend identical complete paths into a new isolated process without first-question history', async (t) => {
  const { root } = await workspace(t, 'resend');
  const fixtures = FIXTURES.slice(0, 2);
  await copyFixtures(root, fixtures);
  await configureStub(root, { mode: 'anchors' });
  const paths = fixtures.map((fixture) => fixture.file);
  const firstQuestion = `FIRST_QUESTION_ONLY_EVAL. ${anchorQuestion(fixtures)}`;
  const secondQuestion = `SECOND_QUESTION_ONLY_EVAL. ${anchorQuestion(fixtures)}`;
  assertSuccess(await runWorker('bulk-reader', readerArgs(root, paths, firstQuestion), { root }));
  assertSuccess(await runWorker('bulk-reader', readerArgs(root, paths, secondQuestion), { root }));
  const [first, second] = await observations(root);
  assert.notEqual(first.cwd, second.cwd);
  assert.notEqual(first.home, second.home);
  assert.notEqual(first.payloadHash, second.payloadHash);
  assert.equal(first.instruction, firstQuestion);
  assert.equal(second.instruction, secondQuestion);
  assert.equal(JSON.stringify(second).includes('FIRST_QUESTION_ONLY_EVAL'), false);
  assert.deepEqual(first.files, second.files, 'Every path and full content hash must be resent for the second question.');
  assert.equal(first.payloadBytes, second.payloadBytes - 1);
  for (const record of [first, second]) {
    assert.deepEqual(record.requestKeys, ['files', 'kind', 'question', 'rules']);
    assert.deepEqual(record.homeEntries, ['config.json']);
    assert.equal(await exists(record.cwd), false);
  }
});

test('explicit default and override models are recorded as the actual successful model', async (t) => {
  const cases = [
    ['reader default', 'bulk-reader', {}, 'claude-haiku-4.5'],
    ['writer default', 'code-writer', {}, 'gpt-5.4-mini'],
    ['reader override', 'bulk-reader', { TOKENREDUCER_BULK_READER_MODEL: 'eval-reader-small' }, 'eval-reader-small'],
    ['writer override', 'code-writer', { TOKENREDUCER_CODE_WRITER_MODEL: 'eval-writer-small' }, 'eval-writer-small'],
    ['fallback selected explicitly', 'bulk-reader', { TOKENREDUCER_BULK_READER_MODEL: 'gpt-5-mini' }, 'gpt-5-mini'],
  ];
  for (const [name, kind, env, expectedModel] of cases) {
    await t.test(name, async (subtest) => {
      const { root } = await workspace(subtest, 'models');
      await seedSmallFiles(root);
      const result = await runWorker(kind, kind === 'bulk-reader' ? readerArgs(root) : writerArgs(root), { root, env });
      assertSuccess(result);
      const [record] = await observations(root);
      assert.equal(record.model, expectedModel);
      assert.equal(record.argv[record.argv.indexOf('--model') + 1], expectedModel);
      metadata(result, { kind, model: expectedModel, attempts: 1 });
    });
  }
});

test('only model-unavailable failures retry once on the explicit cheap fallback', async (t) => {
  for (const [kind, primary] of [['bulk-reader', 'claude-haiku-4.5'], ['code-writer', 'gpt-5.4-mini']]) {
    for (const channel of ['event', 'stderr']) {
      await t.test(`${kind}: ${channel}`, async (subtest) => {
        const { root } = await workspace(subtest, 'fallback');
        await seedSmallFiles(root);
        await configureStub(root, { mode: 'unavailable-primary', channel });
        const args = kind === 'bulk-reader' ? readerArgs(root) : writerArgs(root, ['--target', 'generated.mjs']);
        const result = await runWorker(kind, args, { root });
        assertSuccess(result);
        const records = await observations(root);
        assert.deepEqual(records.map((record) => record.model), [primary, 'gpt-5-mini']);
        assert.equal(records[0].payloadHash, records[1].payloadHash);
        metadata(result, { kind, model: 'gpt-5-mini', attempts: 2 });
        assert.equal(result.stderr.includes('STUB_PRIVATE_DIAGNOSTIC'), false);
        if (kind === 'code-writer') {
          assert.equal(JSON.parse(result.stdout).model, 'gpt-5-mini');
          assert.equal(await exists(path.join(root, 'generated.mjs')), true);
        }
      });
    }
  }
  await t.test('override unavailable then cheap fallback', async (subtest) => {
    const { root } = await workspace(subtest, 'override-fallback');
    await seedSmallFiles(root);
    await configureStub(root, { mode: 'unavailable-primary' });
    const result = await runWorker('bulk-reader', readerArgs(root), {
      root, env: { TOKENREDUCER_BULK_READER_MODEL: 'eval-reader-small' },
    });
    assertSuccess(result);
    assert.deepEqual((await observations(root)).map((record) => record.model), ['eval-reader-small', 'gpt-5-mini']);
    metadata(result, { model: 'gpt-5-mini', attempts: 2 });
  });
});

test('unavailable fallback is terminal and duplicate fallback model IDs do not cause retries', async (t) => {
  for (const [label, env, expectedModels] of [
    ['both unavailable', {}, ['claude-haiku-4.5', 'gpt-5-mini']],
    ['primary already fallback', { TOKENREDUCER_BULK_READER_MODEL: 'gpt-5-mini' }, ['gpt-5-mini']],
  ]) {
    await t.test(label, async (subtest) => {
      const { root } = await workspace(subtest, 'all-unavailable');
      await seedSmallFiles(root);
      await configureStub(root, { mode: 'unavailable-all' });
      assertFailure(await runWorker('bulk-reader', readerArgs(root), { root, env }), 'MODEL_UNAVAILABLE');
      assert.deepEqual((await observations(root)).map((record) => record.model), expectedModels);
    });
  }
});

test('auth, generic, CLI-version, protocol, and model-integrity failures never fall back or leak transcripts', async (t) => {
  const cases = [
    ['auth-failure', 'AUTH'],
    ['generic-failure', 'CLI_FAILURE'],
    ['cli-version-failure', 'CLI_VERSION'],
    ['session-error', 'CLI_FAILURE'],
    ['invalid-jsonl', 'PROTOCOL'],
    ['null-jsonl', 'PROTOCOL'],
    ['tool-call', 'PROTOCOL'],
    ['wrong-model', 'MODEL'],
    ['missing-model', 'MODEL'],
    ['wrong-then-right-model', 'MODEL'],
    ['stdout-flood', 'OUTPUT'],
    ['stderr-flood', 'OUTPUT'],
  ];
  for (const [mode, code] of cases) {
    await t.test(mode, async (subtest) => {
      const { root } = await workspace(subtest, 'transport-failure');
      await seedSmallFiles(root);
      await configureStub(root, { mode });
      const result = await runWorker('code-writer', writerArgs(root, ['--target', 'generated.mjs']), { root });
      assertFailure(result, code);
      assert.equal((await observations(root)).length, 1, 'Only explicit model unavailability may retry.');
      assert.equal(await exists(path.join(root, 'generated.mjs')), false);
      if (mode === 'wrong-model' || mode === 'wrong-then-right-model') {
        assert.match(result.stderr, /reported worker model unrequested-eval-model; requested gpt-5\.4-mini/);
      }
      for (const sentinel of ['STUB_PRIVATE_DIAGNOSTIC', 'STUB_PARTIAL_ANSWER_MUST_NOT_ESCAPE', 'STUB_INVALID_TRANSCRIPT_NOT_JSON']) {
        assert.equal(result.stderr.includes(sentinel), false);
      }
    });
  }
});

test('child stderr is isolated from successful answers and replaced with coarse metadata', async (t) => {
  const { root } = await workspace(t, 'stderr');
  await seedSmallFiles(root);
  const answer = 'STUB: requested exact evidence only.';
  await configureStub(root, { answer, diagnostics: true });
  const result = await runWorker('bulk-reader', readerArgs(root), { root });
  assertSuccess(result);
  assert.equal(result.stdout, `${answer}\n`);
  const summary = metadata(result, { kind: 'bulk-reader', model: 'claude-haiku-4.5', attempts: 1 });
  assert.equal(summary.outputBytes, Buffer.byteLength(answer));
  assert.equal(result.stderr.includes('STUB_PRIVATE_DIAGNOSTIC'), false);
  assert.equal(result.stderr.includes('requested exact evidence'), false);
});

test('one-second timeouts withhold partial answers, never retry, and remove private files', async (t) => {
  for (const kind of ['bulk-reader', 'code-writer']) {
    await t.test(kind, async (subtest) => {
      const { root } = await workspace(subtest, 'timeout');
      await seedSmallFiles(root);
      await configureStub(root, { mode: 'timeout' });
      const args = kind === 'bulk-reader' ? readerArgs(root) : writerArgs(root, ['--target', 'generated.mjs']);
      const result = await runWorker(kind, args, {
        root, env: { TOKENREDUCER_TIMEOUT_SECONDS: '1' }, timeoutMs: 10_000,
      });
      assertFailure(result, 'TIMEOUT');
      assert.ok(result.elapsedMs >= 850 && result.elapsedMs < 8000, 'The configured deadline must terminate a still-running child.');
      const records = await observations(root);
      assert.equal(records.length, 1);
      assert.equal(await exists(records[0].cwd), false);
      assert.equal(await exists(path.join(root, 'generated.mjs')), false);
      assert.equal(result.stderr.includes('STUB_PARTIAL_ANSWER_MUST_NOT_ESCAPE'), false);
    });
  }
});
