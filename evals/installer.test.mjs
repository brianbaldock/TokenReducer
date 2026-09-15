import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  INSTALLER, ROOT, assertDecision, assertFailure, assertSuccess, exists, hookPayload,
  listFiles, powershellAvailable, processEnvironment, runHook, runProcess, sha256, workspace,
} from './helpers.mjs';

function runInstall(work, args, env = {}) {
  return runProcess(process.execPath, [INSTALLER, ...args], {
    env: processEnvironment(work.home, {
      TOKENREDUCER_BULK_READER_MODEL: 'eval-reader-model',
      TOKENREDUCER_CODE_WRITER_MODEL: 'eval-writer-model',
      ...env,
    }),
  });
}

async function expectedFiles(base) {
  const files = [];
  for (const skill of ['bulk-reader', 'code-writer']) {
    const relative = `.github/skills/${skill}`;
    for (const file of await listFiles(path.join(ROOT, relative))) files.push(`${base}skills/${skill}/${file}`);
  }
  return [
    ...files,
    `${base}agents/bulk-reader.agent.md`,
    `${base}agents/code-writer.agent.md`,
    `${base}hooks/tokenreducer.json`,
  ].sort();
}

async function verifyInstalledSkills(destination, base) {
  for (const skill of ['bulk-reader', 'code-writer']) {
    const source = path.join(ROOT, '.github/skills', skill);
    for (const file of await listFiles(source)) {
      assert.equal(sha256(await readFile(path.join(destination, base, 'skills', skill, file))),
        sha256(await readFile(path.join(source, file))), 'Installed skill/runtime bytes must match the owned source.');
    }
  }
}

async function exerciseInstalledHooks(t, root, config) {
  await writeFile(path.join(root, 'large.txt'), Array.from({ length: 351 }, (_, index) => `Original install test row ${index + 1}\n`).join(''));
  await writeFile(path.join(root, 'small.txt'), 'Original small installer input.\n');
  const hook = config.hooks.preToolUse[0];
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks), ['preToolUse']);
  for (const [launcher, command] of [['bash', hook.bash], ['powershell', hook.powershell]]) {
    await t.test(`installed ${launcher} hook`, async (subtest) => {
      if (launcher === 'powershell' && !await powershellAvailable(root)) {
        subtest.skip('pwsh is not installed.');
        return;
      }
      for (const [file, decision] of [['large.txt', 'deny'], ['small.txt', 'pass']]) {
        assertDecision(await runHook(root, hookPayload(root, 'view', { path: file }), {
          launcher, configuredCommand: command, cwd: root,
        }), decision);
      }
    });
  }
}

test('project installation copies only owned assets and its real hooks work', async (t) => {
  const work = await workspace(t, 'install-project');
  const result = await runInstall(work, ['--project', work.root]);
  assertSuccess(result);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  const expected = await expectedFiles('.github/');
  assert.deepEqual(await listFiles(work.root), expected);
  assert.equal(summary.scope, 'project');
  assert.equal(summary.installed, expected.length);
  assert.equal(summary.unchanged, 0);
  assert.deepEqual(summary.models, { 'bulk-reader': 'eval-reader-model', 'code-writer': 'eval-writer-model' });
  await verifyInstalledSkills(work.root, '.github');
  const config = JSON.parse(await readFile(path.join(work.root, '.github/hooks/tokenreducer.json'), 'utf8'));
  await exerciseInstalledHooks(t, work.root, config);
});

test('personal installation quotes absolute paths containing spaces, apostrophes, dollars, and semicolons', async (t) => {
  const work = await workspace(t, 'install-personal');
  const home = path.join(work.root, "personal user's; $profile");
  const result = await runInstall(work, ['--personal', '--home', home]);
  assertSuccess(result);
  assert.equal(JSON.parse(result.stdout).scope, 'personal');
  assert.deepEqual(await listFiles(home), await expectedFiles(''));
  await verifyInstalledSkills(home, '');
  const config = JSON.parse(await readFile(path.join(home, 'hooks/tokenreducer.json'), 'utf8'));
  const hook = config.hooks.preToolUse[0];
  assert.ok(hook.bash.includes(home.replaceAll("'", "'\\''")));
  assert.ok(hook.powershell.includes(home.replaceAll("'", "''")));
  assert.match(hook.bash, /^bash '/);
  assert.match(hook.powershell, /^& '/);
  await exerciseInstalledHooks(t, work.root, config);
});

test('installation is idempotent and preserves unrelated original sentinel files', async (t) => {
  const work = await workspace(t, 'install-idempotent');
  await mkdir(path.join(work.root, '.github/hooks'), { recursive: true });
  const unrelated = path.join(work.root, '.github/hooks/unrelated-eval.json');
  const sentinel = '{"originalEvaluationSentinel":true}\n';
  await writeFile(unrelated, sentinel);
  const first = await runInstall(work, ['--project', work.root]);
  assertSuccess(first);
  const second = await runInstall(work, ['--project', work.root]);
  assertSuccess(second);
  const firstSummary = JSON.parse(first.stdout);
  const secondSummary = JSON.parse(second.stdout);
  assert.equal(secondSummary.installed, 0);
  assert.equal(secondSummary.unchanged, firstSummary.installed);
  assert.equal(await readFile(unrelated, 'utf8'), sentinel);
});

test('installer preflights conflicts and requires explicit overwrite', async (t) => {
  const work = await workspace(t, 'install-overwrite');
  assertSuccess(await runInstall(work, ['--project', work.root]));
  const missing = path.join(work.root, '.github/skills/bulk-reader/scripts/bulk-reader.mjs');
  const conflict = path.join(work.root, '.github/hooks/tokenreducer.json');
  await rm(missing);
  await writeFile(conflict, 'Original local customization must not be overwritten silently.\n');
  const result = await runInstall(work, ['--project', work.root]);
  assertFailure(result, 'EXISTS');
  assert.equal(await exists(missing), false, 'A later conflict must not partially publish earlier pending files.');
  assert.equal(await readFile(conflict, 'utf8'), 'Original local customization must not be overwritten silently.\n');
  const overwrite = await runInstall(work, ['--project', work.root, '--overwrite']);
  assertSuccess(overwrite);
  assert.equal(JSON.parse(overwrite.stdout).installed, 2);
  assert.equal(await exists(missing), true);
  assert.equal(JSON.parse(await readFile(conflict, 'utf8')).version, 1);
});

test('installer renders explicit native model overrides and honors a contained COPILOT_HOME', async (t) => {
  const work = await workspace(t, 'install-models');
  const destination = path.join(work.root, 'profile');
  const result = await runInstall(work, ['--personal'], {
    COPILOT_HOME: destination,
    TOKENREDUCER_BULK_READER_MODEL: 'eval-reader-small',
    TOKENREDUCER_CODE_WRITER_MODEL: 'eval-writer-small',
  });
  assertSuccess(result);
  const models = JSON.parse(result.stdout).models;
  assert.deepEqual(models, { 'bulk-reader': 'eval-reader-small', 'code-writer': 'eval-writer-small' });
  for (const [kind, model] of Object.entries(models)) {
    const profile = await readFile(path.join(destination, 'agents', `${kind}.agent.md`), 'utf8');
    assert.ok(profile.split('\n').includes(`model: ${model}`));
  }
});

test('installer rejects invalid arguments and configuration without using the real home', async (t) => {
  const work = await workspace(t, 'install-invalid');
  const cases = [
    ['missing mode', []],
    ['both modes', ['--personal', '--project', work.root]],
    ['home without personal', ['--home', work.home]],
    ['unknown option', ['--project', work.root, '--unknown']],
    ['positional destination', [work.root]],
    ['missing project directory', ['--project', path.join(work.root, 'absent')]],
  ];
  for (const [name, args] of cases) {
    await t.test(name, async () => assertFailure(await runInstall(work, args)));
  }
  await t.test('automatic native model is rejected', async () => {
    assertFailure(await runInstall(work, ['--project', work.root], { TOKENREDUCER_BULK_READER_MODEL: 'auto' }), 'MODEL');
  });
  await t.test('help installs nothing', async () => {
    const result = await runInstall(work, ['--help']);
    assertSuccess(result);
    assert.match(result.stdout, /--project DIR/);
    assert.match(result.stdout, /--personal/);
    assert.equal(await exists(path.join(work.root, '.github')), false);
  });
});

test('installer refuses symlinked installation directories and files', async (t) => {
  await t.test('symlinked .github directory', async (subtest) => {
    const work = await workspace(subtest, 'install-link-dir');
    await writeFile(path.join(work.outside, 'sentinel.txt'), 'Original outside sentinel.\n');
    await symlink(work.outside, path.join(work.root, '.github'), 'dir');
    assertFailure(await runInstall(work, ['--project', work.root]), 'INSTALL');
    assert.deepEqual(await listFiles(work.outside), ['sentinel.txt']);
  });
  await t.test('symlinked owned file even with overwrite', async (subtest) => {
    const work = await workspace(subtest, 'install-link-file');
    assertSuccess(await runInstall(work, ['--project', work.root]));
    const target = path.join(work.root, '.github/skills/bulk-reader/SKILL.md');
    const sentinel = path.join(work.outside, 'sentinel.txt');
    await writeFile(sentinel, 'Original outside sentinel.\n');
    await rm(target);
    await symlink(sentinel, target);
    assertFailure(await runInstall(work, ['--project', work.root, '--overwrite']), 'TARGET');
    assert.equal(await readFile(sentinel, 'utf8'), 'Original outside sentinel.\n');
  });
});
