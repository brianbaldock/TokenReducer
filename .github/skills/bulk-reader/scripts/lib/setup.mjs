import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { InputError, modelName, modelsConfigPath, safeFailure, validateModelConfig } from './config.mjs';
import { childEnvironment, copilotExecutable, spawnOnce } from './copilot.mjs';

const help = `node scripts/setup.mjs [--reader MODEL --writer MODEL] [--fallback MODEL]
  [--alias REQUESTED=REPORTED ...]

Choose explicit cheap/fast worker IDs from the host that will run them, not auto.
Discovery reads the --model choices, if listed, in the current copilot --help.
CLI choices are suggestions, not a catalog for VS Code, other IDEs or the Copilot app.
TTY setup offers numbered choices or typed IDs. Non-TTY setup requires both flags.
--alias records an exact reported-ID spelling for a requested ID; repeat as needed.
Only record aliases you know identify the same model, never a different tier.
Each run replaces the saved reader, writer, fallback and aliases.
Config: ~/.config/tokenreducer/models.json (or $XDG_CONFIG_HOME/tokenreducer/models.json).
Environment model overrides still win. No inference or model access check is run.
After setup, use install --overwrite to refresh static native agent model fields.`;

export function modelChoices(helpText) {
  const lines = helpText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*--model(?:\s|=)/.test(line));
  if (start < 0) return [];
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line) || /^\s*-/.test(line)) break;
    block.push(line);
  }
  const choices = block.join(' ').match(/\(choices:\s*([^)]*)\)/i)?.[1];
  if (!choices) return [];
  const ids = [...choices.matchAll(/"([^"]+)"|'([^']+)'/g)].map((match) => match[1] ?? match[2]);
  const models = new Map();
  for (const id of ids) {
    if (id.toLowerCase() === 'auto') continue;
    modelName(id);
    models.set(id.toLowerCase(), id);
  }
  return [...models.values()];
}

export async function discoverModels(env = process.env) {
  try {
    const executable = await copilotExecutable(env);
    const output = await spawnOnce(executable, ['--help'], {
      env: childEnvironment(env, env.COPILOT_HOME), timeoutMs: 10_000, input: '',
    });
    const models = modelChoices(output);
    if (models.length) {
      return { models, discoveredFrom: `${env.TOKENREDUCER_COPILOT_BIN || 'copilot'} --help (--model choices)` };
    }
    return { models: [], reason: 'The CLI help does not publish explicit model choices. Copy IDs from your host model picker.' };
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return { models: [], reason: `CLI discovery unavailable (${error.code}). Copy IDs from your host model picker.` };
  }
}

export async function saveModelConfig(config, env = process.env) {
  validateModelConfig(config);
  modelName(config.reader);
  modelName(config.writer);
  const file = modelsConfigPath(env);
  const parent = path.dirname(file);
  let staging;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    staging = await mkdtemp(path.join(parent, '.models-'));
    await chmod(staging, 0o700);
    const pending = path.join(staging, 'models.json');
    await writeFile(pending, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(pending, 0o600);
    await rename(pending, file);
  } catch (error) {
    if (!error.code) throw error;
    throw new InputError('CONFIG', 'Cannot save models.json; check the user configuration path and permissions.');
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
  return file;
}

export async function setup(args, env = process.env, { input = process.stdin, output = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args, strict: true, allowPositionals: false,
      options: {
        reader: { type: 'string' }, writer: { type: 'string' }, fallback: { type: 'string' },
        alias: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    if (!error.code?.startsWith('ERR_PARSE_ARGS')) throw error;
    throw new InputError('SETUP', 'Invalid setup arguments. Run node scripts/setup.mjs --help.');
  }
  if (values.help) return help;
  for (const role of ['reader', 'writer', 'fallback']) {
    if (values[role] !== undefined) modelName(values[role]);
  }
  const aliases = Object.create(null);
  for (const pair of values.alias ?? []) {
    const parts = pair.split('=');
    if (parts.length !== 2) throw new InputError('SETUP', 'Use --alias REQUESTED=REPORTED with two explicit model IDs.');
    const requested = modelName(parts[0]);
    const reported = modelName(parts[1]);
    (aliases[requested] ??= []).push(reported);
  }
  const discovered = await discoverModels(env);
  if (discovered.reason) output.write(`TokenReducer setup: ${discovered.reason}\n`);
  if (!values.reader || !values.writer) {
    if (!input.isTTY || !output.isTTY) {
      throw new InputError('SETUP', 'Non-interactive setup requires --reader MODEL --writer MODEL; optionally --fallback MODEL. Run node scripts/setup.mjs --help.');
    }
    output.write('Choose cheap/fast models explicitly. CLI choices may differ from your host; you may type its ID instead. Never use auto.\n');
    discovered.models.forEach((model, index) => output.write(`${index + 1}. ${model}\n`));
    const terminal = createInterface({ input, output });
    const closed = new AbortController();
    terminal.once('close', () => closed.abort());
    try {
      for (const role of ['reader', 'writer']) {
        if (values[role]) continue;
        const answer = (await terminal.question(`${role} model (number or ID): `, { signal: closed.signal })).trim();
        const selected = /^\d+$/.test(answer) ? discovered.models[Number(answer) - 1] : answer;
        values[role] = modelName(selected);
      }
      if (values.fallback === undefined) {
        const answer = (await terminal.question('Fallback model (number or ID, blank for none): ', { signal: closed.signal })).trim();
        if (answer) values.fallback = modelName(/^\d+$/.test(answer) ? discovered.models[Number(answer) - 1] : answer);
      }
    } catch (error) {
      if (error.code === 'ERR_USE_AFTER_CLOSE' || error.name === 'AbortError') {
        throw new InputError('SETUP', 'Setup input closed before models were selected; no config was saved.');
      }
      throw error;
    } finally {
      terminal.close();
    }
  }
  const config = {
    reader: values.reader, writer: values.writer,
    ...(values.fallback === undefined ? {} : { fallback: values.fallback }),
    ...(Object.keys(aliases).length ? { aliases } : {}),
    ...(discovered.discoveredFrom ? { discoveredFrom: discovered.discoveredFrom } : {}),
    updatedAt: new Date().toISOString(),
  };
  const file = await saveModelConfig(config, env);
  return JSON.stringify({ saved: file, ...config });
}

export async function setupMain() {
  try {
    process.stdout.write(`${await setup(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${safeFailure(error)}\n`);
    process.exitCode = 1;
  }
}
