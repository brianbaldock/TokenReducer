import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { InputError, lineThreshold } from './config.mjs';
import { isInside, pathText } from './files.mjs';
import { inspectShell } from './shell.mjs';

// Passing the token policy must not grant host tool permissions.
const passThrough = () => ({});
export const deny = (reason) => ({
  permissionDecision: 'deny',
  permissionDecisionReason: `TokenReducer: ${reason} Use the bulk-reader skill's scripted entry point; for exact edits, read a bounded window.`,
});

function readWindow(args) {
  if (args.view_range !== undefined) {
    const range = args.view_range;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)
        || range[0] < 1 || (range[1] !== -1 && range[1] < range[0])) {
      throw new InputError('RANGE', 'Invalid view_range.');
    }
    return { offset: range[0] - 1, limit: range[1] === -1 ? undefined : range[1] - range[0] + 1 };
  }
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit <= 0)) {
    throw new InputError('RANGE', 'limit must be a positive safe integer.');
  }
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
    throw new InputError('RANGE', 'offset must be a nonnegative safe integer.');
  }
  return { offset: args.offset ?? 0, limit: args.limit };
}

function inspectFile(cwd, file, threshold, deadline, { offset = 0, limit, bytes = false, fromEnd = false } = {}) {
  const candidate = path.resolve(cwd, pathText(file));
  let resolved;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!isInside(cwd, resolved)) return 'Large or unbounded reads outside the working root are not classified.';
  const initial = statSync(resolved);
  if (initial.isDirectory()) return null;
  if (!initial.isFile()) return 'Unbounded reads of special files are not supported.';
  const descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (info.isDirectory()) return null;
    if (!info.isFile()) return 'Unbounded reads of special files are not supported.';
    const buffer = Buffer.alloc(64 * 1024);
    let lines = 0;
    let scanned = 0;
    let lastByte = -1;
    const lineOffset = bytes ? 0 : offset;
    let position = bytes ? (fromEnd ? Math.max(info.size - limit, 0) : offset) : null;
    let remaining = bytes ? limit ?? Infinity : Infinity;
    while (remaining > 0) {
      if (Date.now() > deadline || scanned >= 8 * 1024 * 1024) return 'Line counting exceeded the gate scan budget.';
      const size = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), position);
      if (!size) break;
      scanned += size;
      remaining -= size;
      if (position !== null) position += size;
      lastByte = buffer[size - 1];
      for (let index = 0; index < size; index++) {
        if (buffer[index] === 10 && ++lines - lineOffset > threshold) return `Read exceeds ${threshold} lines.`;
      }
    }
    if (lastByte !== -1 && lastByte !== 10) lines++;
    return lines - lineOffset > threshold ? `Read exceeds ${threshold} lines.` : null;
  } finally {
    closeSync(descriptor);
  }
}

export function evaluateHook(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.toolName !== 'string') {
    return deny('Malformed Copilot preToolUse input.');
  }
  if (!['view', 'bash', 'powershell'].includes(input.toolName)) return passThrough();
  let args = input.toolArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (error) {
      if (error instanceof SyntaxError) return deny('Malformed toolArgs JSON.');
      throw error;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return deny('Expected object toolArgs.');
  const threshold = lineThreshold(env);
  const cwd = realpathSync(pathText(input.cwd));
  if (input.toolName === 'view') {
    const file = pathText(args.path);
    const window = readWindow(args);
    if (window.limit !== undefined && window.limit <= threshold) return passThrough();
    const reason = inspectFile(cwd, file, threshold, Date.now() + 1500, window);
    return reason ? deny(reason) : passThrough();
  }
  const inspected = inspectShell(args.command, input.toolName === 'powershell');
  if (inspected.ambiguous) return deny('Ambiguous full-dump command; use explicit paths or a bounded read.');
  const deadline = Date.now() + 1500;
  for (const { path: file, ...window } of inspected.paths) {
    if (window.limit !== undefined && window.limit <= threshold) continue;
    const reason = inspectFile(cwd, file, threshold, deadline, window);
    if (reason) return deny(reason);
  }
  return passThrough();
}
