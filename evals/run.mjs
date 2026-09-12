#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVAL_ROOT } from './fixtures.mjs';
import { ROOT } from './helpers.mjs';

const { values } = parseArgs({
  options: { 'tests-only': { type: 'boolean' } }, strict: true, allowPositionals: false,
});
const tests = (await readdir(EVAL_ROOT)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(EVAL_ROOT, name));
if (Number(process.versions.node.split('.')[0]) < 20 || tests.length === 0) {
  console.error('Evaluation requires Node.js 20+ and at least one evals/*.test.mjs file.');
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) process.stderr.write(`Evaluation process failed: ${result.error.code ?? 'PROCESS'}\n`);
    process.exitCode = 1;
  } else {
    const totals = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
    console.log(`Contract tests: ${totals.pass}/${totals.tests} passed; ${totals.fail} failed; ${totals.skipped} skipped.`);
    if (!values['tests-only']) {
      const { benchmark } = await import('./benchmark.mjs');
      await benchmark();
    }
  }
}
