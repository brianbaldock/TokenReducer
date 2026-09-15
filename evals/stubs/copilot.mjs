#!/usr/bin/env node
import { appendFile, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { generatedStubCode } from '../fixtures.mjs';

const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await realpath(process.cwd());
const root = path.dirname(directory);
const relative = path.relative(evalRoot, root);
if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('The deterministic stub only operates inside evals/.');
}
const plan = JSON.parse(await readFile(path.join(root, '.eval-stub.json'), 'utf8'));
const modes = new Set([
  'answer', 'anchors', 'generate', 'sized-answer', 'unavailable-all', 'unavailable-primary',
  'auth-failure', 'generic-failure', 'cli-version-failure', 'session-error', 'timeout',
  'invalid-jsonl', 'null-jsonl', 'tool-call', 'stdout-flood', 'stderr-flood', 'wrong-model',
  'missing-model', 'wrong-then-right-model',
]);
if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !modes.has(plan.mode)
    || (plan.answer !== undefined && typeof plan.answer !== 'string')) {
  throw new Error('Invalid deterministic evaluation plan.');
}
const argv = process.argv.slice(2);
const model = argv[argv.indexOf('--model') + 1];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = Buffer.concat(chunks).toString('utf8');
const request = JSON.parse(payload);
const home = process.env.COPILOT_HOME;
const contractErrors = [];
const requireContract = (condition, description) => {
  if (!condition) contractErrors.push(description);
};
const flagValue = (flag) => argv[argv.indexOf(flag) + 1];
for (const flag of [
  '--model', '--agent', '--silent', '--stream', '--output-format',
  '--no-ask-user', '--disable-builtin-mcps', '--no-custom-instructions',
  '--no-auto-update', '--no-remote-export', '--log-level', '--no-color',
  '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url',
]) requireContract(argv.includes(flag), `Missing required flag ${flag}.`);
for (const argument of argv) {
  requireContract(!/^(?:-p|--prompt|--resume|--continue|--history|--session-id|--share|--share-gist|--allow-all(?:-[a-z-]+)?|--yolo|-y)(?:=|$)/.test(argument),
    'Found a prompt, history, resume, sharing, or broad permission flag.');
}
requireContract(!argv.includes('--deny-tool=*'), 'Wildcard tool rules are not supported by the real CLI parser.');
requireContract(argv.filter((value) => value === '--model').length === 1 && model !== 'auto', 'Select one explicit model.');
requireContract(flagValue('--agent') === 'tokenreducer-worker', 'Use the isolated tool-free worker profile.');
requireContract(flagValue('--stream') === 'off' && flagValue('--output-format') === 'json', 'Use nonstreaming JSONL transport.');
requireContract(flagValue('--log-level') === 'none', 'Disable child logs.');
requireContract(path.dirname(home ?? '') === directory, 'COPILOT_HOME must be private to this invocation.');
requireContract(process.env.GIT_CEILING_DIRECTORIES === root, 'Stop parent repository discovery at the requested root.');
const privateMode = (await lstat(directory)).mode & 0o777;
const homeMode = (await lstat(home)).mode & 0o777;
if (process.platform !== 'win32') {
  requireContract((privateMode & 0o077) === 0 && (homeMode & 0o077) === 0, 'Private directories must exclude group and other users.');
}
const homeEntries = (await readdir(home)).sort();
requireContract(homeEntries.length === 1 && homeEntries[0] === 'config.json', 'Do not seed parent histories, hooks, auth files, or plugins.');
const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
requireContract(config.memory === false && config.continueOnAutoMode === false, 'Disable memory and continuation.');
requireContract(config['customAgents.defaultLocalOnly'] === true, 'Keep custom agent discovery local.');
requireContract(Array.isArray(config.trustedFolders) && config.trustedFolders.length === 1 && config.trustedFolders[0] === directory,
  'Trust only the private invocation directory.');
const profile = await readFile(path.join(directory, '.github/agents/tokenreducer-worker.agent.md'), 'utf8');
requireContract(/^name: tokenreducer-worker$/m.test(profile) && /^tools:\s*\[\s*\]$/m.test(profile), 'The temporary worker profile must have tools: [].');
requireContract(await readFile(path.join(directory, '.gitignore'), 'utf8') === '*\n', 'Exclude all private work order artifacts.');
requireContract(['bulk-reader', 'code-writer'].includes(request.kind) && typeof request.rules === 'string'
  && Array.isArray(request.files) && request.files.length > 0, 'The full work order must be JSON on stdin.');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const observation = {
  provenance: 'DETERMINISTIC_EVAL_STUB',
  argv, model, cwd: directory, home, homeEntries, privateMode, homeMode,
  config, profileToolFree: /^tools:\s*\[\s*\]$/m.test(profile),
  environmentKeys: Object.keys(process.env).sort(),
  environment: Object.fromEntries([
    'COPILOT_HOME', 'COPILOT_AUTO_UPDATE', 'COPILOT_OTEL_ENABLED', 'COPILOT_ALLOW_ALL',
    'GIT_CEILING_DIRECTORIES', 'NO_COLOR', 'CI',
  ].map((key) => [key, process.env[key]])),
  authPresent: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].filter((key) => Boolean(process.env[key])),
  requestKeys: Object.keys(request).sort(), kind: request.kind,
  instruction: request.question ?? request.spec,
  rulesCharacters: request.rules.length,
  payloadCharacters: payload.length, payloadBytes: Buffer.byteLength(payload),
  payloadHash: hash(payload), contractErrors,
  files: request.files.map((file) => {
    const lines = file.content.split('\n');
    return {
      path: file.path, characters: file.content.length, bytes: Buffer.byteLength(file.content),
      hash: hash(file.content), lines: lines.length,
      firstLine: lines[0], lastLine: lines.at(-1),
      numbered: request.kind !== 'bulk-reader' || lines.every((line, index) => line.startsWith(`${index + 1}: `)),
    };
  }),
};
await appendFile(path.join(root, '.eval-observations.jsonl'), `${JSON.stringify(observation)}\n`, { mode: 0o600 });
if (contractErrors.length) {
  process.stderr.write('STUB_CONTRACT_FAILURE: isolated transport did not meet the deterministic contract.\n');
  process.exitCode = 73;
} else {
  const emit = (type, data) => process.stdout.write(`${JSON.stringify({ type, data })}\n`);
  const answer = (content, reportedModel = model) => {
    if (plan.mode === 'wrong-then-right-model') emit('model.call_start', { model: 'unrequested-eval-model' });
    if (plan.mode !== 'missing-model') emit('assistant.usage', { model: reportedModel });
    emit('assistant.message', { content });
  };
  const unavailable = plan.mode === 'unavailable-all'
    || (plan.mode === 'unavailable-primary' && model !== 'eval-fallback-model');
  if (unavailable) {
    if (plan.channel === 'stderr') {
      process.stderr.write('Unknown model: deterministic unavailable-model fixture; STUB_PRIVATE_DIAGNOSTIC.\n');
      process.exitCode = 1;
    } else {
      emit('session.error', { message: 'Unknown model: deterministic unavailable-model fixture; STUB_PRIVATE_DIAGNOSTIC.' });
    }
  } else if (['auth-failure', 'generic-failure', 'cli-version-failure'].includes(plan.mode)) {
    const prefix = {
      'auth-failure': 'authentication failed',
      'generic-failure': 'deterministic backend failure',
      'cli-version-failure': 'unknown option --fictional-eval-option',
    }[plan.mode];
    answer('STUB_PARTIAL_ANSWER_MUST_NOT_ESCAPE');
    process.stderr.write(`${prefix}; STUB_PRIVATE_DIAGNOSTIC.\n`);
    process.exitCode = 1;
  } else if (plan.mode === 'session-error') {
    answer('STUB_PARTIAL_ANSWER_MUST_NOT_ESCAPE');
    emit('session.error', { message: 'Deterministic session failure; STUB_PRIVATE_DIAGNOSTIC.' });
  } else if (plan.mode === 'timeout') {
    answer('STUB_PARTIAL_ANSWER_MUST_NOT_ESCAPE');
    process.stderr.write('STUB_PRIVATE_DIAGNOSTIC: deterministic timeout fixture.\n');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } else if (plan.mode === 'invalid-jsonl') {
    process.stdout.write('STUB_INVALID_TRANSCRIPT_NOT_JSON\n');
  } else if (plan.mode === 'null-jsonl') {
    process.stdout.write('null\n');
  } else if (plan.mode === 'tool-call') {
    emit('tool.execution_start', { toolName: 'view', arguments: { path: 'STUB_NOT_EXECUTED' } });
    answer('STUB_PARTIAL_ANSWER_MUST_NOT_ESCAPE');
  } else if (plan.mode === 'stdout-flood' || plan.mode === 'stderr-flood') {
    const stream = plan.mode === 'stdout-flood' ? process.stdout : process.stderr;
    const megabytes = plan.mode === 'stdout-flood' ? 33 : 2;
    const block = 'Z'.repeat(64 * 1024);
    for (let index = 0; index < megabytes * 16; index++) {
      if (!stream.write(block)) await once(stream, 'drain');
    }
  } else {
    if (plan.effect) {
      const target = path.resolve(root, plan.effect.path);
      const targetRelative = path.relative(root, target);
      if (targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative) || targetRelative === '..'
          || await realpath(path.dirname(target)) !== path.dirname(target)) {
        throw new Error('Stub race effects must stay inside the contained workspace.');
      }
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Stub race effects require a regular, unlinked target.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeFile(target, plan.effect.content, { mode: 0o600 });
    }
    let content = plan.answer ?? 'STUB: deterministic compact answer.';
    if (plan.mode === 'anchors') {
      content = JSON.stringify({
        provenance: 'STUB',
        files: request.files.map((file) => {
          const lines = file.content.split('\n');
          return {
            path: file.path,
            first: lines[0].match(/TR_[A-Z]+_FIRST_\d+/)?.[0] ?? null,
            last: lines.at(-1).match(/TR_[A-Z]+_LAST_\d+/)?.[0] ?? null,
          };
        }),
      });
    } else if (plan.mode === 'generate') {
      content = generatedStubCode(plan.entries ?? 192);
    } else if (plan.mode === 'sized-answer') {
      if (!Number.isSafeInteger(plan.characters) || plan.characters < 0 || plan.characters > 2 * 1024 * 1024) {
        throw new Error('Invalid deterministic answer size.');
      }
      content = (plan.unit ?? 'x').repeat(plan.characters);
      if (plan.finalNewline) content += '\n';
    }
    if (plan.fence) content = `${plan.fence}\n${content.replace(/\n$/, '')}\n${plan.fence.match(/^[`~]+/)[0]}\n`;
    if (plan.diagnostics) process.stderr.write('STUB_PRIVATE_DIAGNOSTIC: never forward this child stderr.\n');
    answer(content, plan.mode === 'wrong-model' ? 'unrequested-eval-model' : plan.reportedModel ?? model);
  }
}
