import path from 'node:path';
import { workerArguments, usage } from './arguments.mjs';
import { InputError, MAX_ANSWER_BYTES, MAX_CODE_BYTES, safeFailure, workerConfig } from './config.mjs';
import { writeTarget } from './files.mjs';
import { prepareRequest, stripFences } from './prompts.mjs';
import { invokeCopilot } from './copilot.mjs';

export async function runWorker(kind, args, { env = process.env, invoke = invokeCopilot } = {}) {
  const values = workerArguments(kind, args);
  if (values.help) return { stdout: `${usage(kind)}\n`, stderr: '' };
  const config = workerConfig(kind, env);
  const prepared = await prepareRequest(kind, values, config);
  const result = await invoke(prepared, config, env);
  if (typeof result.answer !== 'string' || !result.answer.trim()) throw new InputError('EMPTY_ANSWER', 'Worker returned an empty answer.');
  let answer = kind === 'code-writer' ? stripFences(result.answer) : result.answer.trim();
  if (!answer.trim()) throw new InputError('EMPTY_ANSWER', 'Worker returned empty code.');
  if (prepared.target && !answer.endsWith('\n')) answer += '\n';
  const outputBytes = Buffer.byteLength(answer);
  const limit = kind === 'code-writer' && prepared.target ? MAX_CODE_BYTES : MAX_ANSWER_BYTES;
  if (outputBytes > limit) {
    throw new InputError('OUTPUT', kind === 'code-writer' && !prepared.target
      ? 'Code exceeds 4096 bytes; use --target so the body stays out of the parent context.'
      : `Worker answer exceeds the ${limit}-byte output limit; narrow the task.`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(answer)
      || Buffer.from(answer, 'utf8').toString('utf8') !== answer) {
    throw new InputError('OUTPUT', 'Worker output contains invalid Unicode or unsafe control characters.');
  }
  if (prepared.target) {
    await writeTarget(prepared.target, answer);
    answer = JSON.stringify({
      written: path.relative(prepared.root, prepared.target.target).split(path.sep).join('/'),
      bytes: Buffer.byteLength(answer), model: result.model,
    });
  }
  return {
    stdout: answer.endsWith('\n') ? answer : `${answer}\n`,
    stderr: `TokenReducer worker=${kind} model=${result.model} attempts=${result.attempts} input_bytes=${Buffer.byteLength(prepared.payload)} output_bytes=${outputBytes}\n`,
  };
}

export async function workerMain(kind) {
  try {
    const result = await runWorker(kind, process.argv.slice(2));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    process.stderr.write(`${safeFailure(error)}\n`);
    process.exitCode = 1;
  }
}
