import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail, hash, safeDirectory, account, readRegular, atomic, withLock } from './safety.mjs';

const PACKAGE = 'oh-my-aside';
const VERSION = 2;
const MAX_FILES = 4096;
const sourceDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const absent = async (file) => readRegular(file, { optional: true });
const text = (value) => value === null ? null : value.toString('utf8');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function relative(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || /[\0-\x1f\x7f]/.test(value)) fail('manifest-invalid');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('manifest-invalid');
  return parts;
}

function inside(base, rel) {
  return path.join(base, ...relative(rel));
}

function markerFor(skillFile) {
  return `<!-- oh-my-aside:start -->\nLoad the local Oh My Aside bootstrap before repeated or nontrivial workflows: ${esc(skillFile)}\nUse only verified, redacted aftercare in the managed skill namespace; this block grants no additional authority.\n<!-- oh-my-aside:end -->\n`;
}

async function lstat(file, optional = false) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function directory(file, optional = false) {
  const stat = await lstat(file, optional);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-path');
  return true;
}

async function privateDirectory(file) {
  if (await directory(file, true)) return;
  await fs.mkdir(file, { mode: 0o700 });
  if (!await directory(file)) fail('unsafe-path');
}

async function makeParents(base, rel) {
  const parts = relative(rel);
  let current = base;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    await safeDirectory(current, true);
  }
}

async function listTree(base, rel = '', directories = []) {
  if (!await directory(base)) fail('unsafe-path');
  const entries = await fs.readdir(base, { withFileTypes: true });
  const out = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (/[/\\\0-\x1f\x7f]/.test(entry.name)) fail('unsafe-path');
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const child = path.join(base, entry.name);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) fail('unsafe-path');
    if (stat.isDirectory()) {
      directories.push(childRel);
      out.push(...await listTree(child, childRel, directories));
    } else if (stat.isFile()) out.push(childRel);
    else fail('unsafe-path');
    if (out.length > MAX_FILES) fail('payload-too-large');
  }
  return out;
}

function expectedDirectories(files) {
  const dirs = new Set();
  for (const file of files) {
    const parts = relative(file);
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort();
}

async function checkedPayload(base) {
  const directories = [];
  const names = await listTree(base, '', directories);
  const files = {};
  for (const name of names) files[name] = hash(await readRegular(inside(base, name)));
  return { files, directories: directories.sort() };
}

async function checkedFiles(base) {
  return (await checkedPayload(base)).files;
}

function validateManifest(value, expectedMarker) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest-invalid');
  const keys = Object.keys(value).sort();
  if (!same(keys, ['files', 'marker', 'markerHash', 'package', 'version'])) fail('manifest-invalid');
  if (value.version !== VERSION || value.package !== PACKAGE || typeof value.marker !== 'string' || typeof value.markerHash !== 'string') fail('manifest-invalid');
  if (value.marker !== expectedMarker || value.markerHash !== hash(value.marker)) fail('manifest-invalid');
  if (!value.files || typeof value.files !== 'object' || Array.isArray(value.files) || !Object.keys(value.files).length) fail('manifest-invalid');
  for (const [name, digest] of Object.entries(value.files)) {
    relative(name);
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) fail('manifest-invalid');
  }
  return value;
}

async function loadManifest(file, expectedMarker) {
  const body = await absent(file);
  if (body === null) return { value: null, bytes: null };
  let parsed;
  try {
    parsed = JSON.parse(text(body));
  } catch {
    fail('manifest-invalid');
  }
  return { value: validateManifest(parsed, expectedMarker), bytes: body };
}

async function checkPayload(root, files) {
  if (!await directory(root, true)) fail('owned-file-modified');
  const actual = await checkedPayload(root);
  if (!same(actual.files, files)) {
    const expected = new Set(Object.keys(files));
    const extra = Object.keys(actual.files).find((name) => !expected.has(name));
    fail(extra ? 'unowned-file-conflict' : 'owned-file-modified');
  }
  const expectedDirs = expectedDirectories(Object.keys(files));
  if (!same(actual.directories, expectedDirs)) {
    const expected = new Set(expectedDirs);
    const extra = actual.directories.find((name) => !expected.has(name));
    fail(extra ? 'unowned-file-conflict' : 'owned-file-modified');
  }
}

async function copyTree(source, destination, files) {
  if (await directory(destination, true)) fail('unsafe-path');
  await fs.mkdir(destination, { mode: 0o700 });
  for (const name of Object.keys(files).sort()) {
    const from = inside(source, name);
    const bytes = await readRegular(from);
    if (hash(bytes) !== files[name]) fail('source-changed');
    await makeParents(destination, name);
    await atomic(inside(destination, name), bytes);
  }
  await checkPayload(destination, files);
}

function blocks(body) {
  return [...body.matchAll(/<!-- oh-my-aside:start -->[\s\S]*?<!-- oh-my-aside:end -->\n?/g)].map((match) => match[0]);
}

function appendMarker(body, marker) {
  if (body === null || body === '') return marker;
  return `${body}${body.endsWith('\n') ? '' : '\n'}${marker}`;
}

function checkMarker(body, marker, old) {
  const found = blocks(body ?? '');
  if (!old) {
    if (found.length) fail('marker-conflict');
    return;
  }
  if (found.length !== 1 || found[0] !== marker) fail('owned-marker-modified');
}

async function removeRegular(file) {
  const stat = await lstat(file, true);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe-path');
  await fs.unlink(file);
}

async function newTransaction(state) {
  const backups = path.join(state, 'backups');
  const transactions = path.join(state, 'transactions');
  try {
    await privateDirectory(backups);
    await privateDirectory(transactions);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTDIR') fail('backup-unavailable');
    throw error;
  }
  const id = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const root = path.join(transactions, id);
  const backup = path.join(backups, id);
  try {
    await fs.mkdir(root, { mode: 0o700 });
    await fs.mkdir(backup, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOTDIR') fail('backup-unavailable');
    throw error;
  }
  return { id, root, backup, stage: path.join(root, 'stage'), payload: path.join(backup, 'payload') };
}

async function saveBackup(transaction, name, bytes) {
  if (bytes !== null) await atomic(path.join(transaction.backup, name), bytes);
}

async function pending(state, value) {
  await atomic(path.join(state, 'pending.json'), Buffer.from(`${JSON.stringify(value)}\n`));
}

async function noPending(state) {
  if (await absent(path.join(state, 'pending.json')) !== null) fail('pending-transaction');
}

async function restore(file, bytes) {
  if (bytes === null) return removeRegular(file);
  return atomic(file, bytes);
}

async function rollback({ destination, manifestFile, agentsFile, transaction, oldManifest, oldAgents, oldManifestBytes, wanted, oldMoved, newInstalled }) {
  if (newInstalled) {
    const current = await lstat(destination, true);
    if (!current || current.isSymbolicLink() || !current.isDirectory()) fail('rollback-required');
    await checkPayload(destination, wanted);
    await fs.rename(destination, path.join(transaction.backup, 'failed-new'));
  }
  if (oldMoved && oldManifest) {
    if (!await directory(transaction.payload, true)) fail('rollback-required');
    await fs.rename(transaction.payload, destination);
  }
  await restore(agentsFile, oldAgents);
  await restore(manifestFile, oldManifestBytes);
}

async function operate({ accountRoot, sourceRoot = sourceDefault }, action) {
  const a = await account(accountRoot, action === 'install');
  const destination = path.join(a.user, PACKAGE);
  const marker = markerFor(path.join(destination, 'SKILL.md'));
  const manifestFile = path.join(a.state, 'install.json');
  const agentsFile = path.join(a.base, 'AGENTS.md');

  if (action === 'status' || action === 'doctor') {
    await noPending(a.state);
    const oldInfo = await loadManifest(manifestFile, marker);
    if (!oldInfo.value) return { ok: true, installed: false };
    await checkPayload(destination, oldInfo.value.files);
    checkMarker(text(await absent(agentsFile)), marker, true);
    return { ok: true, installed: true, version: oldInfo.value.version };
  }

  if (action === 'uninstall') {
    const initialInfo = await loadManifest(manifestFile, marker);
    const initialDestination = await lstat(destination, true);
    if (!initialInfo.value && !initialDestination) return { ok: true, state: 'not-installed', changed: false };
    if (!initialInfo.value) {
      if (initialDestination.isSymbolicLink() || !initialDestination.isDirectory()) fail('unsafe-path');
      fail('unowned-file-conflict');
    }
  }

  return withLock(a, async () => {
    await noPending(a.state);
    const oldInfo = await loadManifest(manifestFile, marker);
    const old = oldInfo.value;
    const agentsBytes = await absent(agentsFile);
    const agents = text(agentsBytes);
    const destinationStat = await lstat(destination, true);

    if (destinationStat && (destinationStat.isSymbolicLink() || !destinationStat.isDirectory())) fail('unsafe-path');
    if (!old && destinationStat) fail('unowned-file-conflict');

    if (action === 'uninstall') {
      if (!old) return { ok: true, state: 'not-installed', changed: false };
      if (!destinationStat) fail('owned-file-modified');
      await checkPayload(destination, old.files);
      const transaction = await newTransaction(a.state);
      await saveBackup(transaction, 'AGENTS.md', agentsBytes);
      await saveBackup(transaction, 'install.json', oldInfo.bytes);
      await pending(a.state, { version: VERSION, action, id: transaction.id, backup: transaction.backup });
      try {
        await fs.rename(destination, transaction.payload);
        const retainedMarker = !agents?.includes(marker);
        if (!retainedMarker) await restore(agentsFile, Buffer.from(agents.replace(marker, '')));
        await removeRegular(manifestFile);
        await removeRegular(path.join(a.state, 'pending.json'));
        return { ok: true, state: 'uninstalled', retainedMarker };
      } catch (error) {
        try {
          if (await directory(transaction.payload, true)) await fs.rename(transaction.payload, destination);
          await restore(agentsFile, agentsBytes);
          await restore(manifestFile, oldInfo.bytes);
          await removeRegular(path.join(a.state, 'pending.json'));
        } catch {
          fail('rollback-required');
        }
        throw error;
      }
    }

    const source = path.resolve(sourceRoot);
    if (!await directory(source, true)) fail('source-missing');
    const wanted = await checkedFiles(source);
    if (!Object.keys(wanted).length) fail('source-empty');
    if (old) {
      if (!destinationStat) fail('owned-file-modified');
      await checkPayload(destination, old.files);
      checkMarker(agents, marker, true);
      if (same(old.files, wanted)) return { ok: true, state: 'unchanged', changed: false };
    } else checkMarker(agents, marker, false);

    const nextAgents = old ? agents : appendMarker(agents, marker);
    const transaction = await newTransaction(a.state);
    await copyTree(source, transaction.stage, wanted);
    await saveBackup(transaction, 'AGENTS.md', agentsBytes);
    await saveBackup(transaction, 'install.json', oldInfo.bytes);
    await pending(a.state, { version: VERSION, action, id: transaction.id, backup: transaction.backup });
    let oldMoved = false;
    let newInstalled = false;
    try {
      if (old) {
        await fs.rename(destination, transaction.payload);
        oldMoved = true;
      }
      await fs.rename(transaction.stage, destination);
      newInstalled = true;
      if (nextAgents !== agents) await restore(agentsFile, Buffer.from(nextAgents));
      const nextManifest = { version: VERSION, package: PACKAGE, files: wanted, marker, markerHash: hash(marker) };
      await atomic(manifestFile, Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`));
      await removeRegular(path.join(a.state, 'pending.json'));
      return { ok: true, state: old ? 'upgraded' : 'installed', changed: true };
    } catch (error) {
      try {
        await rollback({ destination, manifestFile, agentsFile, transaction, oldManifest: old, oldAgents: agentsBytes, oldManifestBytes: oldInfo.bytes, wanted, oldMoved, newInstalled });
        await removeRegular(path.join(a.state, 'pending.json'));
      } catch {
        fail('rollback-required');
      }
      throw error;
    }
  });
}

export function sourcePath() { return sourceDefault; }
export async function install(options) { return operate(options, 'install'); }
export async function uninstall(options) { return operate(options, 'uninstall'); }

export async function status(options) {
  try {
    return await operate(options, 'status');
  } catch (error) {
    return { ok: false, installed: false, reason: error?.code || 'invalid-state' };
  }
}

export async function doctor(options) {
  const result = await status(options);
  return { ...result, checks: ['bootstrap-dependent', 'session-execution-not-checked'] };
}

export async function main(args, io = { out: console.log }) {
  const command = args[0];
  const index = args.indexOf('--account-root');
  const accountRoot = index < 0 ? undefined : args[index + 1];
  if (!['install', 'uninstall', 'status', 'doctor'].includes(command) || !accountRoot) fail('invalid-request');
  io.out(JSON.stringify(await ({ install, uninstall, status, doctor })[command]({ accountRoot })));
}
