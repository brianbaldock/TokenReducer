import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVAL_ROOT, FIXTURE_ROOT, FIXTURES } from './fixtures.mjs';

export const ROOT = path.dirname(EVAL_ROOT);
export const ENTRIES = Object.freeze({
  'bulk-reader': path.join(ROOT, '.github/skills/bulk-reader/scripts/bulk-reader.mjs'),
  'code-writer': path.join(ROOT, '.github/skills/code-writer/scripts/code-writer.mjs'),
});
export const UNIX_HOOK = path.join(ROOT, '.github/skills/bulk-reader/scripts/read-gate.sh');
export const POWERSHELL_HOOK = path.join(ROOT, '.github/skills/bulk-reader/scripts/read-gate.ps1');
export const INSTALLER = path.join(ROOT, 'scripts/install.mjs');
export const STUB = path.join(EVAL_ROOT, 'stubs/copilot.mjs');
export const PLAN_FILE = '.eval-stub.json';
export const AUDIT_FILE = '.eval-observations.jsonl';
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export const bashQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
export const powershellQuote = (text) => `'${text.replaceAll("'", "''")}'`;

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relative));
    else result.push(relative.split(path.sep).join('/'));
  }
  return result.sort();
}

export async function assertPrivateCleanup(root) {
  const leftovers = (await listFiles(root)).filter((file) =>
    file.split('/').some((part) => part.startsWith('.tokenreducer-')));
  const directories = (await readdir(root)).filter((name) => name.startsWith('.tokenreducer-'));
  assert.equal(leftovers.length + directories.length, 0, 'Worker private directories and staging files must be removed.');
}

export async function workspace(test, label = 'case') {
  const directory = await mkdtemp(path.join(EVAL_ROOT, `.work-${label}-`));
  const root = path.join(directory, 'root');
  const outside = path.join(directory, 'outside');
  const home = path.join(directory, 'home');
  await Promise.all([mkdir(root), mkdir(outside), mkdir(home)]);
  const cleanup = async () => {
    try {
      await assertPrivateCleanup(root);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  if (test) test.after(cleanup);
  return { directory, root, outside, home, cleanup };
}

export function processEnvironment(directory, overrides = {}) {
  const environment = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'DOTNET_ROOT']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    HOME: directory, USERPROFILE: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, DOTNET_CLI_HOME: directory,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', POWERSHELL_TELEMETRY_OPTOUT: '1',
    LANG: 'C.UTF-8', NO_COLOR: '1', CI: 'true',
    ...overrides,
  };
}

export function runProcess(command, args, {
  cwd = ROOT, env = processEnvironment(EVAL_ROOT), input = '', timeoutMs = 15_000,
  maxCaptureBytes = 2 * 1024 * 1024,
} = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const diagnostics = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let timedOut = false;
    let captureExceeded = false;
    let errorCode;
    let killTimer;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 750);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= maxCaptureBytes) output.push(chunk);
      else if (!captureExceeded) {
        captureExceeded = true;
        stop();
      }
    });
    child.stderr.on('data', (chunk) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes <= maxCaptureBytes) diagnostics.push(chunk);
      else if (!captureExceeded) {
        captureExceeded = true;
        stop();
      }
    });
    child.on('error', (error) => { errorCode = error.code ?? 'SPAWN'; });
    child.stdin.on('error', (error) => {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) errorCode = error.code ?? 'STDIN';
    });
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({
        code, signal, errorCode, timedOut, captureExceeded,
        stdout: Buffer.concat(output).toString('utf8'),
        stderr: Buffer.concat(diagnostics).toString('utf8'),
        outputBytes, diagnosticBytes, elapsedMs: Math.round(performance.now() - started),
      });
    });
  });
}

export async function configureStub(root, plan = {}) {
  await writeFile(path.join(root, PLAN_FILE), JSON.stringify({ mode: 'answer', ...plan }), { mode: 0o600 });
}

export async function observations(root) {
  try {
    return (await readFile(path.join(root, AUDIT_FILE), 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function runWorker(kind, args, { root, cwd = root, env = {}, timeoutMs = 15_000 } = {}) {
  assert.ok(ENTRIES[kind], 'Use an actual named worker entry point.');
  assert.ok(root, 'A contained evaluation workspace root is required.');
  const result = await runProcess(process.execPath, [ENTRIES[kind], ...args], {
    cwd, timeoutMs,
    env: processEnvironment(root, { ...env, TOKENREDUCER_COPILOT_BIN: STUB }),
  });
  return { ...result, stubContractErrors: (await observations(root)).at(-1)?.contractErrors ?? [] };
}

export function readerArgs(root, files = ['small.txt'], question = 'Return the requested evidence.') {
  return ['--root', root, '--question', question, ...files.flatMap((file) => ['--path', file])];
}

export function writerArgs(root, extra = [], spec = 'Write the requested original module.') {
  return ['--root', root, '--spec', spec, '--reference', 'reference.mjs', ...extra];
}

export function assertSuccess(result) {
  assert.equal(result.errorCode, undefined, 'The process must start successfully.');
  assert.equal(result.timedOut, false, 'The evaluation process watchdog expired.');
  assert.equal(result.captureExceeded, false, 'The process exceeded the evaluation capture limit.');
  assert.equal(result.code, 0, `Expected success; coarse diagnostics: ${result.stderr.slice(0, 400)}${result.stubContractErrors?.join(' ') ?? ''}`);
  assert.equal(result.signal, null, 'The process must exit normally.');
}

export function assertFailure(result, code) {
  assert.equal(result.errorCode, undefined, 'The process must start successfully.');
  assert.equal(result.timedOut, false, 'The runtime must reject the request before the evaluation watchdog.');
  assert.equal(result.captureExceeded, false, 'Failure must not forward an oversized transcript.');
  assert.notEqual(result.code, 0, 'The process must fail closed.');
  assert.equal(result.stdout.length, 0, 'Failed requests must return no stdout or partial body.');
  assert.match(result.stderr, code ? new RegExp(`^TokenReducer ${code}: [^\\r\\n]+\\n$`) : /^TokenReducer [A-Z_]+: [^\r\n]+\n$/);
}

export function metadata(result, { kind, model, attempts } = {}) {
  const match = result.stderr.match(/^TokenReducer worker=(bulk-reader|code-writer) model=([a-z0-9.-]+) attempts=(\d+) input_bytes=(\d+) output_bytes=(\d+)\n$/);
  assert.ok(match, 'Successful stderr must be exactly one coarse worker metadata line.');
  const parsed = { kind: match[1], model: match[2], attempts: Number(match[3]), inputBytes: Number(match[4]), outputBytes: Number(match[5]) };
  if (kind !== undefined) assert.equal(parsed.kind, kind);
  if (model !== undefined) assert.equal(parsed.model, model);
  if (attempts !== undefined) assert.equal(parsed.attempts, attempts);
  return parsed;
}

export async function seedSmallFiles(root) {
  await Promise.all([
    writeFile(path.join(root, 'small.txt'), 'Original small input.\nThe requested value is cedar.\n'),
    writeFile(path.join(root, 'reference.mjs'), "export function describe(value) {\n  return String(value);\n}\n"),
  ]);
  await configureStub(root);
}

export async function copyFixtures(root, fixtures = FIXTURES) {
  for (const fixture of fixtures) await copyFile(path.join(FIXTURE_ROOT, fixture.file), path.join(root, fixture.file));
}

export function hookPayload(root, toolName, toolArgs, extra = {}) {
  return {
    sessionId: 'tokenreducer-deterministic-eval',
    timestamp: Date.parse('2026-09-11T00:00:00.000Z'),
    cwd: root, toolName, toolArgs, ...extra,
  };
}

export function runHook(root, payload, { launcher = 'bash', env = {}, script, configuredCommand, cwd = ROOT } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const command = launcher === 'powershell' ? 'pwsh' : 'bash';
  const args = launcher === 'powershell'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', ...(configuredCommand ? ['-Command', configuredCommand] : ['-File', script ?? POWERSHELL_HOOK])]
    : configuredCommand ? ['-c', configuredCommand] : [script ?? UNIX_HOOK];
  return runProcess(command, args, { cwd, env: processEnvironment(root, env), input });
}

export function assertDecision(result, expected) {
  assertSuccess(result);
  assert.equal(result.stderr, '', 'The hook protocol must not contain stderr diagnostics.');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'The hook must emit exactly one JSON response.');
  const response = JSON.parse(result.stdout);
  assert.ok(['pass', 'deny'].includes(expected), 'Use a token-policy outcome, not a host approval.');
  if (expected === 'pass') {
    assert.deepEqual(response, {}, 'Passing the token gate must leave normal host authorization unchanged.');
  } else {
    assert.equal(response.permissionDecision, 'deny');
    assert.deepEqual(Object.keys(response).sort(), ['permissionDecision', 'permissionDecisionReason']);
    assert.match(response.permissionDecisionReason, /bulk-reader/);
  }
  for (const legacy of ['decision', 'reason', 'hookSpecificOutput', 'continue', 'suppressOutput']) {
    assert.equal(Object.hasOwn(response, legacy), false, `Do not emit the Claude ${legacy} response schema.`);
  }
  return response;
}

export async function powershellAvailable(root) {
  const result = await runProcess('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    env: processEnvironment(root),
  });
  if (result.errorCode === 'ENOENT') return false;
  assertSuccess(result);
  assert.match(result.stdout.trim(), /^\d+$/);
  return true;
}
