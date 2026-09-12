#!/usr/bin/env node
import { evaluateHook, deny } from './lib/gate.mjs';
import { InputError } from './lib/config.mjs';

let response;
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1_048_576) throw new InputError('INPUT', 'Hook input exceeds 1 MiB.');
    chunks.push(chunk);
  }
  response = evaluateHook(JSON.parse(Buffer.concat(chunks).toString('utf8')));
} catch (error) {
  response = deny(error instanceof InputError ? error.message : 'Gate input or filesystem inspection failed.');
}
process.stdout.write(`${JSON.stringify(response)}\n`);
