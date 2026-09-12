#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVAL_ROOT, FIXTURES, GENERATION_MARKER, GENERATION_SPEC, anchorQuestion, expectedAnchors, generateFixtures,
} from './fixtures.mjs';
import { ENTRIES, copyFixtures, metadata, readerArgs, runProcess, workspace } from './helpers.mjs';
import { stripFences } from '../.github/skills/bulk-reader/scripts/lib/prompts.mjs';

class LiveFailure extends Error {
  constructor(stage, code) {
    super(`${stage} failed (${code}).`);
    this.stage = stage;
    this.code = code;
  }
}

async function invokeLive(kind, args, root) {
  const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
  delete env.TOKENREDUCER_COPILOT_BIN;
  const configuredSeconds = Number(env.TOKENREDUCER_TIMEOUT_SECONDS ?? 120);
  const timeoutMs = (Number.isSafeInteger(configuredSeconds) && configuredSeconds > 0 && configuredSeconds <= 3600
    ? configuredSeconds : 120) * 1000 + 10_000;
  const result = await runProcess(process.execPath, [ENTRIES[kind], ...args], {
    cwd: root, env, timeoutMs, maxCaptureBytes: 64 * 1024,
  });
  if (result.code !== 0 || result.errorCode || result.timedOut || result.captureExceeded) {
    const code = result.timedOut ? 'PROCESS_TIMEOUT'
      : result.stderr.match(/^TokenReducer ([A-Z_]+):/)?.[1] ?? 'PROCESS_FAILURE';
    throw new LiveFailure(kind, code);
  }
  try {
    return { result, model: metadata(result, { kind }).model };
  } catch {
    throw new LiveFailure(kind, 'INVALID_METADATA');
  }
}

export async function live() {
  console.log('LIVE validation uses real Copilot and original fixtures. No stub, broad permission flags, or billing-savings claims.');
  await generateFixtures();
  const work = await workspace(undefined, 'live');
  try {
    await copyFixtures(work.root);
    const models = new Set();
    let anchorRequests = 0;
    for (const fixtures of [FIXTURES.slice(0, 1), FIXTURES.slice(0, 2)]) {
      const { result, model } = await invokeLive('bulk-reader',
        readerArgs(work.root, fixtures.map((fixture) => fixture.file), anchorQuestion(fixtures)), work.root);
      try {
        const answer = JSON.parse(stripFences(result.stdout));
        assert.deepEqual(Object.keys(answer), ['files']);
        assert.deepEqual(answer.files, expectedAnchors(fixtures));
      } catch {
        throw new LiveFailure('bulk-reader', 'ANCHOR_MISMATCH');
      }
      models.add(model);
      anchorRequests++;
    }
    const target = 'live-generated-gauge.mjs';
    const { result, model } = await invokeLive('code-writer', [
      '--root', work.root, '--spec', GENERATION_SPEC,
      '--reference', FIXTURES[2].file, '--target', target,
    ], work.root);
    let bytes;
    try {
      const confirmation = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(confirmation).sort(), ['bytes', 'model', 'written']);
      assert.equal(confirmation.written, target);
      const body = await readFile(path.join(work.root, target), 'utf8');
      bytes = Buffer.byteLength(body);
      assert.equal(confirmation.bytes, bytes);
      assert.ok(bytes > 4096 && bytes <= 1_048_576);
      assert.ok(body.includes(GENERATION_MARKER) && /\bvalidateGauge\b/.test(body));
      assert.ok(body.includes('harbor_0001') && body.includes('harbor_0192'));
      assert.equal(result.stdout.includes('export '), false);
      const syntax = await runProcess(process.execPath, ['--check', path.join(work.root, target)], {
        cwd: work.root, env: { ...process.env, TMPDIR: work.root, TMP: work.root, TEMP: work.root },
      });
      assert.equal(syntax.code, 0);
    } catch {
      throw new LiveFailure('code-writer', 'TARGET_VALIDATION');
    }
    models.add(model);
    await mkdir(path.join(EVAL_ROOT, 'results'), { recursive: true });
    await writeFile(path.join(EVAL_ROOT, 'results/live.json'), `${JSON.stringify({
      live: true, exactAnchorRequests: anchorRequests, models: [...models].sort(),
      generatedBytes: bytes, parentGeneratedBodyTokens: null,
      parentGeneratedBodyTokensStatus: 'not-measured',
    }, null, 2)}\n`, { mode: 0o600 });
    console.log(`LIVE verified: ${anchorRequests} exact first/last-anchor requests; ${bytes}-byte generated ES module written and syntax-checked.`);
    console.log(`Selected successful models: ${[...models].sort().join(', ')}. Parent generated-body tokens were not measured.`);
    console.log('This verifies supplied file evidence and output contracts, not general code quality. Accounting evidence was not changed.');
  } finally {
    await work.cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await live();
  } catch (error) {
    const description = error instanceof LiveFailure ? error.message : 'Evaluation setup or cleanup failed (LOCAL_FAILURE).';
    console.error(`LIVE NOT VERIFIED: ${description} No live success or savings claim was recorded.`);
    process.exitCode = 1;
  }
}
