import { constants } from 'node:fs';
import { open, realpath, stat, lstat, link, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError } from './config.mjs';

export function pathText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new InputError('PATH', 'Paths must be nonempty and contain no control characters.');
  }
  return value;
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function workspaceRoot(value = process.cwd()) {
  const root = await realpath(path.resolve(pathText(value)));
  if (!(await stat(root)).isDirectory()) throw new InputError('ROOT', 'The workspace root must be a directory.');
  return root;
}

export async function inputPath(root, value) {
  const candidate = path.resolve(root, pathText(value));
  if (!isInside(root, candidate)) throw new InputError('PATH', 'Input paths must stay inside --root.');
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new InputError('MISSING_FILE', 'A requested input file does not exist.');
    }
    throw error;
  }
  if (!isInside(root, resolved)) throw new InputError('PATH', 'Input symlinks must not escape --root.');
  return resolved;
}

export async function readText(root, value, maxBytes) {
  const resolved = await inputPath(root, value);
  if (!(await stat(resolved)).isFile()) throw new InputError('FILE_TYPE', 'Only regular UTF-8 text files are supported.');
  // Nonblocking open prevents a FIFO from hanging before fstat can reject it.
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new InputError('FILE_TYPE', 'Only regular UTF-8 text files are supported.');
    if (info.size > maxBytes) throw new InputError('PAYLOAD', 'Input exceeds TOKENREDUCER_MAX_PAYLOAD_BYTES; split the task.');
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > info.size || size > maxBytes) {
      throw new InputError('PAYLOAD', 'Input grew while being read; retry with a stable, smaller file.');
    }
    const bytes = buffer.subarray(0, size);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof TypeError) throw new InputError('ENCODING', 'Input must be valid UTF-8.');
      throw error;
    }
    if (text.includes('\0')) throw new InputError('ENCODING', 'Binary input is not supported.');
    return { path: path.relative(root, resolved).split(path.sep).join('/'), text, bytes: size };
  } finally {
    await handle.close();
  }
}

function fingerprint(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function targetState(target) {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new InputError('TARGET', 'The target must be a regular, non-symlink, non-hardlinked file.');
    }
    return { fingerprint: fingerprint(info), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function prepareTarget(root, value, overwrite) {
  const target = path.resolve(root, pathText(value));
  if (!isInside(root, target) || target === root) throw new InputError('TARGET', 'The target must stay inside --root.');
  const parent = await realpath(path.dirname(target));
  if (!isInside(root, parent) || parent !== path.dirname(target)) {
    throw new InputError('TARGET', 'Target directories must exist and must not use symlinks.');
  }
  const before = await targetState(target);
  if (before && !overwrite) throw new InputError('EXISTS', 'Target exists; pass --overwrite to replace it explicitly.');
  return { target, root, before, parent };
}

export async function writeTarget(plan, code) {
  if (await realpath(plan.parent) !== plan.parent) throw new InputError('TARGET', 'Target directory changed during generation.');
  const current = await targetState(plan.target);
  if (current?.fingerprint !== plan.before?.fingerprint) {
    throw new InputError('CONFLICT', 'Target changed during generation; nothing was overwritten.');
  }
  const temporary = path.join(plan.parent, `.tokenreducer-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', plan.before?.mode ?? 0o600);
  try {
    try {
      await handle.writeFile(code, 'utf8');
      if (plan.before) await handle.chmod(plan.before.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await realpath(plan.parent) !== plan.parent
        || (await targetState(plan.target))?.fingerprint !== plan.before?.fingerprint) {
      throw new InputError('CONFLICT', 'Target changed before publication; nothing was overwritten.');
    }
    if (plan.before) {
      await rename(temporary, plan.target);
    } else {
      // A hard link publishes a complete new file atomically without clobbering.
      await link(temporary, plan.target);
    }
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
