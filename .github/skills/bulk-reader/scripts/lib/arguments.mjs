import { parseArgs } from 'node:util';
import { InputError } from './config.mjs';

export function workerArguments(kind, args) {
  const options = {
    root: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    ...(kind === 'bulk-reader'
      ? {
          question: { type: 'string' },
          'question-file': { type: 'string' },
          path: { type: 'string', multiple: true },
        }
      : {
          spec: { type: 'string' },
          'spec-file': { type: 'string' },
          reference: { type: 'string' },
          target: { type: 'string' },
          overwrite: { type: 'boolean' },
        }),
  };
  let values;
  try {
    ({ values } = parseArgs({ args, options, strict: true, allowPositionals: false }));
  } catch (error) {
    if (String(error.code).startsWith('ERR_PARSE_ARGS_')) {
      throw new InputError('ARGUMENTS', 'Invalid arguments; use --help for the named input contract.');
    }
    throw error;
  }
  if (values.help) return values;
  const textKey = kind === 'bulk-reader' ? 'question' : 'spec';
  if (Boolean(values[textKey]) === Boolean(values[`${textKey}-file`])) {
    throw new InputError('ARGUMENTS', `Supply exactly one of --${textKey} or --${textKey}-file.`);
  }
  if (kind === 'bulk-reader' && !values.path?.length) throw new InputError('ARGUMENTS', 'At least one --path is required.');
  if (kind === 'bulk-reader' && values.path.length > 64) throw new InputError('ARGUMENTS', 'At most 64 explicit paths are supported.');
  if (kind === 'code-writer' && !values.reference) throw new InputError('ARGUMENTS', '--reference is mandatory; context-free generation is refused.');
  if (values.overwrite && !values.target) throw new InputError('ARGUMENTS', '--overwrite requires --target.');
  return values;
}

export function usage(kind) {
  const file = `.github/skills/${kind}/scripts/${kind}.mjs`;
  return kind === 'bulk-reader'
    ? `node ${file} --question TEXT --path FILE [--path FILE ...] [--root DIR]\nUse --question-file FILE instead of --question for a long question.`
    : `node ${file} --spec TEXT --reference FILE [--target FILE] [--overwrite] [--root DIR]\nUse --spec-file FILE instead of --spec for a long specification.`;
}
