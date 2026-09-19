import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CODE = /^[a-z][a-z0-9-]{0,79}$/;

export function fail(code) {
  const value = typeof code === 'string' && CODE.test(code) ? code : 'invalid-request';
  const error = new Error(value);
  error.code = value;
  throw error;
}

export function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function safeDirectory(directory, create = false) {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-path');
    return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) return false;
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      return safeDirectory(directory, false);
    }
    return true;
  }
}

export async function account(root, create = false) {
  if (typeof root !== 'string' || root.length === 0) fail('account-root-required');
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('invalid-account-root');
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('invalid-account-root');

  const base = await fs.realpath(root);
  const skills = path.join(base, 'skills');
  const user = path.join(skills, 'user');
  const state = path.join(base, '.oh-my-aside');
  await safeDirectory(skills, create);
  await safeDirectory(user, create);
  await safeDirectory(state, create);
  return { base, skills, user, state };
}

export async function readRegular(file, { optional = false, maxBytes = 2097152 } = {}) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe-path');
  if (stat.size > maxBytes) fail('input-too-large');
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) fail('input-too-large');
  return bytes;
}

export async function atomic(file, bytes) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe-path');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export async function withLock(a, asyncFn) {
  const lock = path.join(a.state, 'lock');
  let handle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('busy');
    throw error;
  }
  const mine = await handle.stat();
  try {
    return await asyncFn();
  } finally {
    await handle.close().catch(() => {});
    try {
      const current = await fs.lstat(lock);
      if (current.dev === mine.dev && current.ino === mine.ino && current.isFile() && !current.isSymbolicLink()) {
        await fs.unlink(lock);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}
