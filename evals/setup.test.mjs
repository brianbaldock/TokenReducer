import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { modelsConfigPath, readModelConfig, workerConfig } from '../.github/skills/bulk-reader/scripts/lib/config.mjs';
import { discoverModels, modelChoices, saveModelConfig, setup } from '../.github/skills/bulk-reader/scripts/lib/setup.mjs';
import {
  ENTRIES, INSTALLER, ROOT, STUB, assertFailure, assertSuccess, exists, metadata,
  observations, processEnvironment, readerArgs, runProcess, seedSmallFiles, workspace, writerArgs,
} from './helpers.mjs';

const SETUP = path.join(ROOT, 'scripts/setup.mjs');
const choicesHelp = [
  'Usage: copilot [options]',
  '  --model <model>  Model (choices: "auto", "eval-reader-id",',
  '                     "eval-writer-id", "eval-fallback-id")',
  '  --effort <level> Level (choices: "high")',
].join('\n');
const selections = ['--reader', 'eval-reader-id', '--writer', 'eval-writer-id'];

async function discoveryStub(work, help = choicesHelp) {
  const file = path.join(work.root, 'discovery.mjs');
  const audit = path.join(work.root, 'discovery-args.json');
  await writeFile(file, [
    "import assert from 'node:assert/strict';",
    "import { writeFileSync } from 'node:fs';",
    "assert.deepEqual(process.argv.slice(2), ['--help']);",
    `writeFileSync(${JSON.stringify(audit)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(${JSON.stringify(help)});`,
  ].join('\n'));
  return processEnvironment(work.home, { TOKENREDUCER_COPILOT_BIN: file });
}

function runSetup(env, args = selections, options = {}) {
  return runProcess(process.execPath, [SETUP, ...args], { env, ...options });
}

test('setup discovers only documented model choices without inferring models from examples', async (t) => {
  const work = await workspace(t, 'setup-discovery');
  const env = await discoveryStub(work);
  const discovery = await discoverModels(env);
  assert.deepEqual(discovery.models, ['eval-reader-id', 'eval-writer-id', 'eval-fallback-id']);
  assert.match(discovery.discoveredFrom, /discovery\.mjs --help \(--model choices\)$/);
  assert.deepEqual(JSON.parse(await readFile(path.join(work.root, 'discovery-args.json'), 'utf8')), ['--help']);
  assert.deepEqual(modelChoices('Examples:\n  copilot --model example-is-not-a-catalog'), []);
  assert.deepEqual(modelChoices('  --model <id> Set the model\n  --effort <id> (choices: "high")'), []);
  assert.deepEqual(modelChoices('  --model <id> (choices: "auto", "AUTO", "eval-id", "EVAL-ID")'), ['EVAL-ID']);
});

test('setup saves the schema privately, reads it, and environment choices override both roles', async (t) => {
  const work = await workspace(t, 'setup-save');
  const env = await discoveryStub(work);
  const result = await runSetup(env, [...selections, '--fallback', 'eval-fallback-id',
    '--alias', 'eval-writer-id=eval-writer.id', '--alias', 'eval-writer-id=eval-writer/id']);
  assertSuccess(result);
  assert.equal(result.stderr, '');
  const file = modelsConfigPath(env);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.saved, file);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, {
    reader: 'eval-reader-id', writer: 'eval-writer-id', fallback: 'eval-fallback-id',
    aliases: { 'eval-writer-id': ['eval-writer.id', 'eval-writer/id'] },
    discoveredFrom: summary.discoveredFrom, updatedAt: summary.updatedAt,
  });
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.deepEqual(readModelConfig(env), saved);
  assert.deepEqual(workerConfig('bulk-reader', env).models, ['eval-reader-id', 'eval-fallback-id']);
  assert.deepEqual(workerConfig('code-writer', env).models, ['eval-writer-id', 'eval-fallback-id']);
  for (const [kind, key] of [['bulk-reader', 'TOKENREDUCER_BULK_READER_MODEL'], ['code-writer', 'TOKENREDUCER_CODE_WRITER_MODEL']]) {
    assert.deepEqual(workerConfig(kind, { ...env, [key]: 'Host/Small_v2:fast' }).models,
      ['Host/Small_v2:fast', 'eval-fallback-id']);
    assert.deepEqual(workerConfig(kind, { ...env, [key]: 'EVAL-FALLBACK-ID' }).models, ['EVAL-FALLBACK-ID']);
  }
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(file)), ['models.json']);
});

test('setup replacement removes old fallback and aliases and restores private mode', async (t) => {
  const work = await workspace(t, 'setup-replace');
  const env = await discoveryStub(work);
  assertSuccess(await runSetup(env, [...selections, '--fallback', 'old-fallback', '--alias', 'eval-reader-id=old-reader']));
  const file = modelsConfigPath(env);
  await chmod(file, 0o644);
  const result = await runSetup(env);
  assertSuccess(result);
  const saved = readModelConfig(env);
  assert.equal(saved.fallback, undefined);
  assert.equal(saved.aliases, undefined);
  assert.deepEqual(workerConfig('bulk-reader', env).models, ['eval-reader-id']);
  assert.deepEqual(workerConfig('code-writer', env).models, ['eval-writer-id']);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('manual setup works without CLI discovery, including IDs outside a discovered catalog', async (t) => {
  for (const mode of ['missing CLI', 'CLI without choices', 'different host catalog']) {
    await t.test(mode, async (subtest) => {
      const work = await workspace(subtest, 'setup-manual');
      const env = await discoveryStub(work, mode === 'CLI without choices' ? '  --model <id> Use /model interactively.\n' : choicesHelp);
      if (mode === 'missing CLI') env.TOKENREDUCER_COPILOT_BIN = path.join(work.root, 'missing-copilot');
      const result = await runSetup(env, ['--reader', 'IDE/SmallReader', '--writer', 'APP:small-writer']);
      assertSuccess(result);
      assert.equal(readModelConfig(env).reader, 'IDE/SmallReader');
      assert.equal(readModelConfig(env).writer, 'APP:small-writer');
      if (mode === 'different host catalog') assert.equal(result.stderr, '');
      else {
        assert.match(result.stderr, /^TokenReducer setup: .*Copy IDs from your host model picker\.\n$/);
        assert.equal(readModelConfig(env).discoveredFrom, undefined);
      }
    });
  }
});

test('non-TTY setup requires both roles even when discovery succeeds', async (t) => {
  const work = await workspace(t, 'setup-nontty');
  const env = await discoveryStub(work);
  for (const args of [[], ['--reader', 'eval-reader-id'], ['--writer', 'eval-writer-id']]) {
    const result = await runSetup(env, args);
    assertFailure(result, 'SETUP');
    assert.match(result.stderr, /--reader MODEL --writer MODEL/);
    assert.equal(await exists(modelsConfigPath(env)), false);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(work.root, 'discovery-args.json'), 'utf8')), ['--help']);
  const noCatalog = await discoveryStub(work, 'No published choices.\n');
  const result = await runSetup(noCatalog, []);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /TokenReducer SETUP: Non-interactive setup requires/);
  assert.equal(await exists(modelsConfigPath(env)), false);
  assertSuccess(await runSetup(noCatalog));
  assert.equal(readModelConfig(env).reader, 'eval-reader-id');
});

async function interactiveSetup(env, answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  let transcript = '';
  let promptIndex = 0;
  const prompts = ['reader model (number or ID): ', 'writer model (number or ID): ', 'Fallback model (number or ID, blank for none): '];
  output.on('data', (chunk) => {
    transcript += chunk.toString();
    if (promptIndex < prompts.length && transcript.includes(prompts[promptIndex])) {
      const answer = answers[promptIndex++];
      setImmediate(() => answer === null ? input.end() : input.write(`${answer}\n`));
    }
  });
  try {
    return { summary: JSON.parse(await setup([], env, { input, output })), transcript };
  } finally {
    input.destroy();
    output.destroy();
  }
}

test('TTY picker uses explicit numbers or typed host IDs and blank fallback means none', { timeout: 10_000 }, async (t) => {
  const work = await workspace(t, 'setup-tty');
  const env = await discoveryStub(work);
  const { summary, transcript } = await interactiveSetup(env, ['2', 'IDE/Writer_v3', '']);
  assert.equal(summary.reader, 'eval-writer-id');
  assert.equal(summary.writer, 'IDE/Writer_v3');
  assert.equal(summary.fallback, undefined);
  assert.match(transcript, /1\. eval-reader-id/);
  assert.match(transcript, /2\. eval-writer-id/);
  assert.match(transcript, /cheap\/fast/);
  const withFallback = await interactiveSetup(env, ['1', '2', '3']);
  assert.equal(withFallback.summary.fallback, 'eval-fallback-id');
  const manualEnv = await discoveryStub(work, 'No catalog.\n');
  const manual = await interactiveSetup(manualEnv, ['host-reader', 'host-writer', '']);
  assert.equal(manual.summary.reader, 'host-reader');
  assert.equal(manual.summary.writer, 'host-writer');
});

test('invalid, blank, or closed TTY selection never chooses an automatic default', { timeout: 10_000 }, async (t) => {
  for (const [answer, code] of [['', 'MODEL'], ['99', 'MODEL'], ['AUTO', 'MODEL'], [null, 'SETUP']]) {
    await t.test(String(answer), async (subtest) => {
      const work = await workspace(subtest, 'setup-tty-invalid');
      const env = await discoveryStub(work);
      await assert.rejects(interactiveSetup(env, [answer]), { code });
      assert.equal(await exists(modelsConfigPath(env)), false);
    });
  }
});

test('invalid setup arguments preserve existing choices without running discovery', async (t) => {
  const cases = [
    [['--reader', 'auto'], 'MODEL'], [['--writer', 'AUTO'], 'MODEL'],
    [['--fallback', 'auto'], 'MODEL'], [['--reader', 'model;command'], 'MODEL'],
    [['--alias', 'eval-reader-id=auto'], 'MODEL'], [['--alias', 'auto=eval-reader-id'], 'MODEL'],
    [['--alias', 'missing-equals'], 'SETUP'], [['--unknown'], 'SETUP'], [['--reader'], 'SETUP'],
  ];
  for (const [args, code] of cases) {
    await t.test(args.join(' '), async (subtest) => {
      const work = await workspace(subtest, 'setup-invalid');
      const env = await discoveryStub(work);
      await saveModelConfig({ reader: 'original-reader', writer: 'original-writer' }, env);
      const file = modelsConfigPath(env);
      const before = await readFile(file, 'utf8');
      assertFailure(await runSetup(env, [...selections, ...args]), code);
      assert.equal(await readFile(file, 'utf8'), before);
      assert.equal(await exists(path.join(work.root, 'discovery-args.json')), false);
    });
  }
});

test('malformed saved configuration fails closed instead of inventing models or aliases', async (t) => {
  const work = await workspace(t, 'setup-config-invalid');
  const env = processEnvironment(work.home);
  const file = modelsConfigPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  for (const content of ['{', 'null', '[]', '{"reader":"auto"}', '{"aliases":[]}',
    '{"aliases":{"eval-reader-id":"other"}}', '{"aliases":{"eval-reader-id":["AUTO"]}}']) {
    await writeFile(file, content);
    assert.throws(() => workerConfig('bulk-reader', env), (error) => ['CONFIG', 'MODEL'].includes(error.code));
  }
  assert.throws(() => modelsConfigPath({ ...env, XDG_CONFIG_HOME: 'relative-config' }), { code: 'CONFIG' });
  assert.equal(modelsConfigPath({ ...env, XDG_CONFIG_HOME: undefined }), path.join(work.home, '.config/tokenreducer/models.json'));
  assert.equal(file, path.join(work.home, 'tokenreducer/models.json'));
});

test('missing setup blocks both workers before transport, then env or saved IDs enable actual stub responses', async (t) => {
  const work = await workspace(t, 'setup-first-worker');
  await seedSmallFiles(work.root);
  const env = processEnvironment(work.home, { TOKENREDUCER_COPILOT_BIN: STUB });
  for (const kind of ['bulk-reader', 'code-writer']) {
    const args = kind === 'bulk-reader' ? readerArgs(work.root) : writerArgs(work.root);
    const result = await runProcess(process.execPath, [ENTRIES[kind], ...args], { env, cwd: work.outside });
    assertFailure(result, 'SETUP');
    assert.match(result.stderr, /node scripts\/setup\.mjs/);
    assert.match(result.stderr, /scripts\/setup\.mjs" from any directory/);
    assert.deepEqual(await observations(work.root), []);
  }
  for (const [kind, key] of [['bulk-reader', 'TOKENREDUCER_BULK_READER_MODEL'], ['code-writer', 'TOKENREDUCER_CODE_WRITER_MODEL']]) {
    const args = kind === 'bulk-reader' ? readerArgs(work.root) : writerArgs(work.root);
    const result = await runProcess(process.execPath, [ENTRIES[kind], ...args], {
      env: { ...env, [key]: 'env-only-model' }, cwd: work.outside,
    });
    assertSuccess(result);
    assert.equal(result.stdout, 'STUB: deterministic compact answer.\n');
    metadata(result, { kind, model: 'env-only-model', attempts: 1 });
  }
  const setupEnv = await discoveryStub(work);
  assertSuccess(await runSetup(setupEnv, selections, { cwd: work.outside }));
  for (const cwd of [work.root, work.outside]) {
    const result = await runProcess(process.execPath, [ENTRIES['bulk-reader'], ...readerArgs(work.root)], { env, cwd });
    assertSuccess(result);
    assert.equal(result.stdout, 'STUB: deterministic compact answer.\n');
    metadata(result, { model: 'eval-reader-id', attempts: 1 });
  }
});

test('installer setup alias and installed setup refresh static native models from the saved file', async (t) => {
  const work = await workspace(t, 'setup-installed');
  const env = await discoveryStub(work);
  const aliased = await runProcess(process.execPath, [INSTALLER, '--setup', ...selections], { env, cwd: work.outside });
  assertSuccess(aliased);
  assert.equal(JSON.parse(aliased.stdout).saved, modelsConfigPath(env));
  const install = (extra = [], overrides = {}) => runProcess(process.execPath, [INSTALLER, '--project', work.root, ...extra], { env: { ...env, ...overrides } });
  assertSuccess(await install());
  const installedSetup = path.join(work.root, '.github/skills/bulk-reader/scripts/setup.mjs');
  const update = await runProcess(process.execPath, [installedSetup, '--reader', 'new-reader', '--writer', 'new-writer'], { env, cwd: work.outside });
  assertSuccess(update);
  assert.equal(readModelConfig(env).reader, 'new-reader');
  assertFailure(await install(), 'EXISTS');
  const result = await install(['--overwrite'], { TOKENREDUCER_CODE_WRITER_MODEL: 'env-writer:' });
  assertSuccess(result);
  assert.deepEqual(JSON.parse(result.stdout).models, { 'bulk-reader': 'new-reader', 'code-writer': 'env-writer:' });
  const agents = path.join(work.root, '.github/agents');
  assert.match(await readFile(path.join(agents, 'bulk-reader.agent.md'), 'utf8'), /^model: new-reader$/m);
  assert.match(await readFile(path.join(agents, 'code-writer.agent.md'), 'utf8'), /^model: "env-writer:"$/m);
});

test('setup help neither probes the CLI nor saves choices', async (t) => {
  const work = await workspace(t, 'setup-help');
  const env = await discoveryStub(work);
  const result = await runSetup(env, ['--help']);
  assertSuccess(result);
  assert.match(result.stdout, /--reader MODEL --writer MODEL/);
  assert.match(result.stdout, /--alias REQUESTED=REPORTED/);
  assert.equal(await exists(modelsConfigPath(env)), false);
  assert.equal(await exists(path.join(work.root, 'discovery-args.json')), false);
});
