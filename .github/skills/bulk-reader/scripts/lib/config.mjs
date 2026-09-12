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
  if (typeof value !== 'string' || !/^[a-z][a-z0-9.-]{0,79}$/.test(value) || value === 'auto') {
    throw new InputError('MODEL', 'Use an explicit Copilot model ID, not auto or a command.');
  }
  return value;
}

export const DEFAULT_MODELS = Object.freeze({
  'bulk-reader': 'claude-haiku-4.5',
  'code-writer': 'gpt-5.4-mini',
});

export function workerConfig(kind, env = process.env) {
  const key = kind === 'bulk-reader' ? 'TOKENREDUCER_BULK_READER_MODEL' : 'TOKENREDUCER_CODE_WRITER_MODEL';
  const primary = modelName(env[key] ?? DEFAULT_MODELS[kind]);
  return {
    maxPayloadBytes: integerSetting(env, 'TOKENREDUCER_MAX_PAYLOAD_BYTES', 1_048_576, 16_777_216),
    timeoutMs: integerSetting(env, 'TOKENREDUCER_TIMEOUT_SECONDS', 120, 3600) * 1000,
    models: [...new Set([primary, 'gpt-5-mini'])],
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
