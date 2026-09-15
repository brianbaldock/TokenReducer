import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class InputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

export function integerSetting(env, name, fallback, maximum) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
    throw new InputError('CONFIG', `${name} must be an integer from 1 to ${maximum}.`);
  }
  return Number(raw);
}

export function modelName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._:/+-]{0,79}$/i.test(value) || value.toLowerCase() === 'auto') {
    throw new InputError('MODEL', 'Use an explicit Copilot model ID, not auto or a command.');
  }
  return value;
}

export function modelsConfigPath(env = process.env) {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  const directory = env.XDG_CONFIG_HOME || path.join(home, '.config');
  if (!path.isAbsolute(directory)) {
    throw new InputError('CONFIG', 'The user home and XDG_CONFIG_HOME must resolve to an absolute configuration directory.');
  }
  return path.join(directory, 'tokenreducer', 'models.json');
}

export function validateModelConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new InputError('CONFIG', 'models.json must contain a model configuration object.');
  }
  for (const role of ['reader', 'writer', 'fallback']) {
    if (config[role] !== undefined) modelName(config[role]);
  }
  if (config.aliases !== undefined) {
    if (!config.aliases || typeof config.aliases !== 'object' || Array.isArray(config.aliases)) {
      throw new InputError('CONFIG', 'Model aliases must map requested IDs to arrays of reported IDs.');
    }
    for (const [requested, reported] of Object.entries(config.aliases)) {
      modelName(requested);
      if (!Array.isArray(reported) || reported.length === 0) {
        throw new InputError('CONFIG', 'Each model alias must list one or more explicit reported IDs.');
      }
      reported.forEach(modelName);
    }
  }
  for (const field of ['discoveredFrom', 'updatedAt']) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new InputError('CONFIG', `${field} must be a string.`);
    }
  }
  return config;
}

export function readModelConfig(env = process.env) {
  const file = modelsConfigPath(env);
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new InputError('CONFIG', 'Cannot read models.json; check the user configuration path and permissions.');
  }
  let config;
  try {
    config = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InputError('CONFIG', 'models.json is not valid JSON; repair it or rerun setup.');
  }
  return validateModelConfig(config);
}

export function modelMatches(observed, requested, aliases = {}) {
  const actual = modelName(observed).toLowerCase();
  const expected = modelName(requested).toLowerCase();
  return actual === expected || Object.entries(aliases).some(([id, reports]) =>
    id.toLowerCase() === expected && reports.some((report) => report.toLowerCase() === actual));
}

export function workerConfig(kind, env = process.env) {
  const saved = readModelConfig(env);
  const key = kind === 'bulk-reader' ? 'TOKENREDUCER_BULK_READER_MODEL' : 'TOKENREDUCER_CODE_WRITER_MODEL';
  const selected = env[key] ?? saved[kind === 'bulk-reader' ? 'reader' : 'writer'];
  if (selected === undefined) {
    const setup = fileURLToPath(new URL('../setup.mjs', import.meta.url));
    throw new InputError('SETUP', `No ${kind} model is configured. Run node scripts/setup.mjs in the TokenReducer checkout, or node "${setup}" from any directory; alternatively set ${key}.`);
  }
  const primary = modelName(selected);
  const models = [primary];
  if (saved.fallback !== undefined && saved.fallback.toLowerCase() !== primary.toLowerCase()) {
    models.push(saved.fallback);
  }
  return {
    maxPayloadBytes: integerSetting(env, 'TOKENREDUCER_MAX_PAYLOAD_BYTES', 1_048_576, 16_777_216),
    timeoutMs: integerSetting(env, 'TOKENREDUCER_TIMEOUT_SECONDS', 120, 3600) * 1000,
    models,
    aliases: saved.aliases ?? {},
  };
}

export function lineThreshold(env = process.env) {
  return integerSetting(env, 'TOKENREDUCER_LINE_THRESHOLD', 350, 100_000);
}

export const MAX_ANSWER_BYTES = 4096;
export const MAX_CODE_BYTES = 1_048_576;

export function safeFailure(error) {
  return error instanceof InputError
    ? `TokenReducer ${error.code}: ${error.message}`
    : 'TokenReducer INTERNAL: operation failed; no worker content was returned.';
}
