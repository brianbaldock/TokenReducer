#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError, safeFailure, workerConfig } from '../.github/skills/bulk-reader/scripts/lib/config.mjs';
import { pathText, prepareTarget, writeTarget } from '../.github/skills/bulk-reader/scripts/lib/files.mjs';
import { setup } from '../.github/skills/bulk-reader/scripts/lib/setup.mjs';

const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bashQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const powershellQuote = (value) => `'${value.replaceAll("'", "''")}'`;

async function descendants(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name);
    if (item.isSymbolicLink()) throw new InputError('INSTALL', 'Package symlinks are not supported.');
    if (item.isDirectory()) files.push(...await descendants(path.join(directory, item.name), relative));
    else if (item.isFile()) files.push(relative);
  }
  return files;
}

async function ensureDirectories(root, relative) {
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new InputError('INSTALL', 'Installation directories must not use symlinks.');
  }
}

export async function install(args, env = process.env) {
  if (args.includes('--setup')) return setup(args.filter((arg) => arg !== '--setup'), env);
  const { values } = parseArgs({
    args, strict: true, allowPositionals: false,
    options: {
      project: { type: 'string' }, personal: { type: 'boolean' },
      home: { type: 'string' }, overwrite: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    return 'node scripts/install.mjs --project DIR | --personal [--home DIR] [--overwrite]\nnode scripts/install.mjs --setup [--reader MODEL --writer MODEL] [--fallback MODEL] [--alias REQUESTED=REPORTED]\nExisting different files require --overwrite. Native agent models use saved configuration, with environment overrides taking precedence.';
  }
  if (Boolean(values.project) === Boolean(values.personal) || (values.home && !values.personal)) {
    throw new InputError('INSTALL', 'Choose --project DIR or --personal. --home is only valid with --personal.');
  }
  const destination = path.resolve(pathText(values.project ?? values.home ?? env.COPILOT_HOME ?? path.join(homedir(), '.copilot')));
  if (values.personal) await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await realpath(destination);
  const base = values.personal ? '' : '.github';
  const files = new Map();
  for (const skill of ['bulk-reader', 'code-writer']) {
    const source = path.join(product, '.github', 'skills', skill);
    for (const file of await descendants(source)) {
      files.set(path.join(base, 'skills', skill, file), await readFile(path.join(source, file), 'utf8'));
    }
  }
  const models = {};
  for (const name of ['bulk-reader', 'code-writer']) {
    models[name] = workerConfig(name, env).models[0];
    const profile = await readFile(path.join(product, '.github', 'agents', `${name}.agent.md`), 'utf8');
    const yamlModel = models[name].includes(':') ? JSON.stringify(models[name]) : models[name];
    files.set(path.join(base, 'agents', `${name}.agent.md`), profile.replace(/^model: .+$/m, `model: ${yamlModel}`));
  }
  const hook = JSON.parse(await readFile(path.join(product, '.github', 'hooks', 'tokenreducer.json'), 'utf8'));
  if (values.personal) {
    const scripts = path.join(root, 'skills', 'bulk-reader', 'scripts');
    hook.hooks.preToolUse[0].bash = `bash ${bashQuote(path.join(scripts, 'read-gate.sh'))}`;
    hook.hooks.preToolUse[0].powershell = `& ${powershellQuote(path.join(scripts, 'read-gate.ps1'))}`;
  }
  files.set(path.join(base, 'hooks', 'tokenreducer.json'), `${JSON.stringify(hook, null, 2)}\n`);

  const pending = [];
  let unchanged = 0;
  for (const [relative, content] of files) {
    await ensureDirectories(root, path.dirname(relative));
    const target = path.join(root, relative);
    const plan = await prepareTarget(root, target, true);
    if (plan.before) {
      const existing = await readFile(target, 'utf8');
      if (existing === content) {
        unchanged++;
        continue;
      }
      if (!values.overwrite) throw new InputError('EXISTS', `Installation conflict at ${relative}; review it before using --overwrite.`);
    }
    pending.push({ plan, content });
  }
  for (const { plan, content } of pending) {
    await writeTarget(plan, content);
    if (/\.(?:sh|mjs)$/.test(plan.target)) await chmod(plan.target, 0o755);
  }
  return JSON.stringify({ scope: values.personal ? 'personal' : 'project', installed: pending.length, unchanged, models });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${await install(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${safeFailure(error)}\n`);
    process.exitCode = 1;
  }
}
