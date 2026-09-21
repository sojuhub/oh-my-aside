import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { account, atomic, fail, hash, readRegular, safeDirectory, withLock } from './safety.mjs';
import { executionFiles, packageHash, readPackage, validateExecution, validatePackageFiles } from './packages.mjs';

const DAY = 86_400_000;
const MAX_RECORD = 65_536;
const MAX_STATE = 2_097_152;
const EVIDENCE_KINDS = new Set(['artifact-check', 'readback', 'user-confirmed']);
const TEXT_DANGER = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}|\b(?:authorization|x-api-key)\s*:\s*\S+|\bbearer\s+[A-Za-z0-9._~-]{8,}|\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+|\/(?:Users|home)\/[^/]+\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:bypass|disable|skip)\s+(?:permission|auth|authentication|mfa|captcha|passkey)/i;
let testFault;

export function setTestFault(callback) {
  testFault = callback;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function text(value, max = 500) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function slug(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function taskType(value) {
  return slug(value);
}
function name(value) {
  return typeof value === 'string' && value.startsWith('oma-') && slug(value.slice(4));
}
function eventId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(value);
}
function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function snapshotId(value) {
  return typeof value === 'string' && /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i.test(value);
}
function archiveId(value) {
  return typeof value === 'string' && /^arc-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(value);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function encode(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function checkTextList(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((row) => text(row));
}

export function validateRecord(record) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(record)); } catch { fail('invalid-record'); }
  const keys = Object.hasOwn(record ?? {}, 'execution') ? ['schemaVersion', 'eventId', 'taskType', 'outcome', 'verified', 'reusable', 'privacy', 'incognito', 'evidence', 'learning', 'execution'] : ['schemaVersion', 'eventId', 'taskType', 'outcome', 'verified', 'reusable', 'privacy', 'incognito', 'evidence', 'learning'];
  if (bytes > MAX_RECORD || !exact(record, keys)) fail('invalid-record');
  if (record.schemaVersion !== 1 || !eventId(record.eventId) || !taskType(record.taskType) || record.outcome !== 'success' || record.verified !== true || record.reusable !== true || record.privacy !== 'redacted' || record.incognito !== false) fail('invalid-record');
  if (!exact(record.evidence, ['kind', 'summary']) || !EVIDENCE_KINDS.has(record.evidence.kind) || !text(record.evidence.summary)) fail('invalid-record');
  const learning = record.learning;
  if (!exact(learning, ['name', 'description', 'steps', 'checks', 'pitfalls']) || !slug(learning.name) || !text(learning.description) || !checkTextList(learning.steps) || !checkTextList(learning.checks) || !checkTextList(learning.pitfalls)) fail('invalid-record');
  const combined = [record.taskType, record.evidence.kind, record.evidence.summary, learning.name, learning.description, ...learning.steps, ...learning.checks, ...learning.pitfalls].join('\n');
  if (TEXT_DANGER.test(combined)) fail('unsafe-record');
  if (Object.hasOwn(record, 'execution')) validateExecution(record.execution);
  return record;
}

function emptyState() {
  return { version: 1, config: { inactivityDays: 90, protectedNames: [] }, skills: {}, events: {}, audit: [] };
}
function validItem(item, key) {
  const base = ['name', 'taskType', 'hash', 'lastUsed', 'pinned', 'archived', 'lastSnapshot'];
  const keys = item?.archived ? [...base, 'archiveId'] : base;
  return exact(item, keys) && key === item.name && name(item.name) && taskType(item.taskType) && digest(item.hash) && integer(item.lastUsed) && typeof item.pinned === 'boolean' && typeof item.archived === 'boolean' && (item.lastSnapshot === null || snapshotId(item.lastSnapshot)) && (!item.archived || archiveId(item.archiveId));
}
function validAudit(row) {
  return exact(row, ['at', 'state', 'name']) && integer(row.at) && text(row.state, 40) && name(row.name);
}
function validState(state) {
  if (!exact(state, ['version', 'config', 'skills', 'events', 'audit']) || state.version !== 1) return false;
  if (!exact(state.config, ['inactivityDays', 'protectedNames']) || !Number.isInteger(state.config.inactivityDays) || state.config.inactivityDays < 1 || state.config.inactivityDays > 3650 || !Array.isArray(state.config.protectedNames) || state.config.protectedNames.length > 200 || !state.config.protectedNames.every(name)) return false;
  if (!plain(state.skills) || !plain(state.events) || !Array.isArray(state.audit) || state.audit.length > 500) return false;
  const taskTypes = new Set();
  for (const [key, item] of Object.entries(state.skills)) {
    if (!name(key) || !validItem(item, key) || taskTypes.has(item.taskType)) return false;
    taskTypes.add(item.taskType);
  }
  for (const [key, value] of Object.entries(state.events)) if (!digest(key) || !digest(value)) return false;
  return state.audit.every(validAudit);
}
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function nowValue(now) {
  if (!integer(now)) fail('invalid-time');
  return now;
}
async function readJson(file, code, maxBytes = MAX_STATE, optional = false) {
  const bytes = await readRegular(file, { optional, maxBytes });
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(code); }
}
async function readState(a) {
  const value = await readJson(path.join(a.state, 'registry.json'), 'invalid-state', MAX_STATE, true);
  if (value === null) return emptyState();
  if (!validState(value)) fail('invalid-state');
  return value;
}
function serialized(value, code) {
  const bytes = Buffer.from(encode(value));
  if (bytes.length > MAX_STATE) fail(code);
  return bytes;
}
async function saveState(a, state, bytes = undefined) {
  if (!validState(state)) fail('invalid-state');
  await atomic(path.join(a.state, 'registry.json'), bytes ?? serialized(state, 'state-too-large'));
}
async function ensureNoPending(a) {
  const pending = await readRegular(path.join(a.state, 'pending.json'), { optional: true, maxBytes: MAX_STATE });
  if (pending !== null) fail('recovery-needed');
}
function packageDir(a, packageName) {
  if (!name(packageName)) fail('invalid-name');
  return path.join(a.user, packageName);
}
async function exactPackage(a, packageName) {
  const directory = packageDir(a, packageName);
  await readPackage(directory);
  return directory;
}
async function packageFor(a, item, archived = false) {
  const directory = archived ? archivePath(a, item.archiveId) : packageDir(a, item.name);
  let files;
  try { files = await readPackage(directory); } catch (error) { if (error?.code === 'invalid-package') fail('package-not-archivable'); throw error; }
  if (packageHash(files) !== item.hash) fail('manual-drift');
  return files;
}
function sameFiles(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}
function nextFilesFor(oldFiles, record, body) {
  const files = { ...oldFiles, 'SKILL.md': body };
  if (Object.hasOwn(record, 'execution')) {
    for (const file of Object.keys(files)) if (file === 'execution.json' || file.startsWith('scripts/')) delete files[file];
    if (record.execution) Object.assign(files, executionFiles(record.execution));
  }
  return files;
}
async function writePackage(directory, files, before = {}) {
  await safeDirectory(directory, true);
  if (Object.keys(files).some((file) => file.startsWith('scripts/'))) await safeDirectory(path.join(directory, 'scripts'), true);
  for (const file of Object.keys(files).sort()) if (files[file] !== before[file]) await atomic(path.join(directory, file), files[file]);
  for (const file of Object.keys(before).filter((file) => !Object.hasOwn(files, file)).sort()) {
    const target = path.join(directory, file);
    const body = (await readRegular(target, { maxBytes: MAX_STATE })).toString('utf8');
    if (body !== before[file]) fail('recovery-needed');
    await fs.unlink(target);
  }
  if (!Object.keys(files).some((file) => file.startsWith('scripts/'))) await fs.rmdir(path.join(directory, 'scripts')).catch((error) => { if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error; });
}
async function ensureChild(parent, child, create = false) {
  await safeDirectory(parent, false);
  return safeDirectory(path.join(parent, child), create);
}
async function createSnapshot(a, packageName, files) {
  const directory = path.join(a.state, 'snapshots');
  await ensureChild(a.state, 'snapshots', true);
  const id = `${crypto.randomUUID()}.json`;
  const value = Object.keys(files).length === 1 && Object.hasOwn(files, 'SKILL.md') ? { version: 1, name: packageName, body: files['SKILL.md'], hash: hash(files['SKILL.md']) } : { version: 2, name: packageName, files, hash: packageHash(files) };
  await atomic(path.join(directory, id), encode(value));
  return id;
}
async function loadSnapshot(a, id, packageName) {
  if (!snapshotId(id)) fail('no-rollback');
  const directory = path.join(a.state, 'snapshots');
  await ensureChild(a.state, 'snapshots', false);
  const value = await readJson(path.join(directory, id), 'invalid-snapshot');
  if (exact(value, ['version', 'name', 'body', 'hash']) && value.version === 1 && value.name === packageName && typeof value.body === 'string' && digest(value.hash) && hash(value.body) === value.hash) return { files: { 'SKILL.md': value.body }, hash: value.hash };
  if (!exact(value, ['version', 'name', 'files', 'hash']) || value.version !== 2 || value.name !== packageName || !plain(value.files) || !digest(value.hash)) fail('invalid-snapshot');
  try { validatePackageFiles(value.files); } catch { fail('invalid-snapshot'); }
  if (packageHash(value.files) !== value.hash) fail('invalid-snapshot');
  return { files: value.files, hash: value.hash };
}
function archivePath(a, id) {
  if (!archiveId(id)) fail('missing-archive');
  return path.join(a.state, 'archives', id);
}
async function archiveBody(a, id, item) {
  await ensureChild(a.state, 'archives', false);
  return packageFor(a, { ...item, archiveId: id }, true);
}
function render(record, packageName, executionContext) {
  const list = (title, values) => `## ${title}\n\n${values.map((value) => `- ${value}`).join('\n')}\n`;
  const learning = record.learning;
  const coordinator = 'Before following this managed skill, read [the Oh My Aside bootstrap](../oh-my-aside/SKILL.md), resolving that path from this skill directory. This applies even when this skill was selected directly. Reuse a bootstrap already verified current for this task.\n\n';
  const execution = executionContext ? `## Execution\n\nExact route arguments: \`--name ${packageName} --context ${executionContext}\`. Copy them exactly; never add another oma- prefix or invent a context from the task.\n\nUse the bootstrap CLI to \`route\`, then \`begin\` with these same arguments before running the selected script, and \`record\` its verified outcome. Do not copy or execute a recipe without reserving the attempt. Fall back to these Steps when no route is eligible or verification fails.\n\n` : '';
  return `---\nname: ${JSON.stringify(packageName)}\ndescription: ${JSON.stringify(learning.description)}\nmanagedBy: "oh-my-aside"\n---\n\n# ${packageName}\n\n${learning.description}\n\n${coordinator}${execution}${list('Steps', learning.steps)}\n${list('Checks', learning.checks)}\n${list('Pitfalls', learning.pitfalls)}`;
}
function addAudit(state, at, stateName, packageName) {
  state.audit.push({ at, state: stateName, name: packageName });
  if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
}
function addEvent(state, event, payload, at, stateName, packageName) {
  state.events[hash(event)] = payload;
  addAudit(state, at, stateName, packageName);
}
async function writePending(a, before, changes) {
  await atomic(path.join(a.state, 'pending.json'), serialized({ version: 1, registry: before, changes }, 'transaction-too-large'));
}
async function removePending(a) {
  const file = path.join(a.state, 'pending.json');
  const bytes = await readRegular(file, { optional: true, maxBytes: MAX_STATE });
  if (bytes !== null) await fs.unlink(file);
}
async function transaction(a, before, changes, mutate, after) {
  const afterBytes = serialized(after, 'state-too-large');
  await writePending(a, before, changes);
  let saved = false;
  try {
    await mutate();
    await testFault?.('before-registry-save');
    await saveState(a, after, afterBytes);
    saved = true;
    await removePending(a);
  } catch (error) {
    if (!saved) {
      try {
        await compensate(a, changes);
        await removePending(a);
      } catch {
        fail('recovery-needed');
      }
    }
    throw error;
  }
}
async function inspectedPackage(directory, expectedHash) {
  let stat;
  try { stat = await fs.lstat(directory); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('recovery-needed');
  const files = await readPackage(directory);
  if (packageHash(files) !== expectedHash) fail('recovery-needed');
  return true;
}
async function loosePackage(directory) {
  const stat = await fs.lstat(directory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('recovery-needed');
  const files = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'SKILL.md' || entry.name === 'execution.json') {
      if (!entry.isFile()) fail('recovery-needed');
      files[entry.name] = (await readRegular(path.join(directory, entry.name), { maxBytes: MAX_STATE })).toString('utf8');
    } else if (entry.name === 'scripts') {
      if (!entry.isDirectory()) fail('recovery-needed');
      for (const script of await fs.readdir(path.join(directory, 'scripts'), { withFileTypes: true })) {
        if (!script.isFile() || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.js$/.test(script.name)) fail('recovery-needed');
        files[`scripts/${script.name}`] = (await readRegular(path.join(directory, 'scripts', script.name), { maxBytes: MAX_STATE })).toString('utf8');
      }
    } else fail('recovery-needed');
  }
  return files;
}
async function removePackage(directory, expected) {
  const files = await loosePackage(directory);
  if (!files) return;
  for (const [file, body] of Object.entries(files)) if (expected[file] !== body) fail('recovery-needed');
  for (const file of Object.keys(files).sort().reverse()) await fs.unlink(path.join(directory, file));
  await fs.rmdir(path.join(directory, 'scripts')).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  await fs.rmdir(directory);
}
async function ownedRemove(a, change) {
  const directory = packageDir(a, change.name);
  await removePackage(directory, change.afterFiles ?? { 'SKILL.md': change.body ?? '' });
}
async function compensateWrite(a, change) {
  const directory = packageDir(a, change.name);
  const current = await loosePackage(directory);
  if (!current) fail('recovery-needed');
  const allowed = new Set([...Object.keys(change.beforeFiles), ...Object.keys(change.afterFiles)]);
  for (const [file, body] of Object.entries(current)) {
    if (!allowed.has(file) || (body !== change.beforeFiles[file] && body !== change.afterFiles[file])) fail('recovery-needed');
  }
  if (Object.keys(change.beforeFiles).some((file) => file.startsWith('scripts/'))) await safeDirectory(path.join(directory, 'scripts'), true);
  for (const file of Object.keys(change.beforeFiles).sort()) {
    if (current[file] !== change.beforeFiles[file]) await atomic(path.join(directory, file), change.beforeFiles[file]);
  }
  for (const file of Object.keys(current).filter((file) => !Object.hasOwn(change.beforeFiles, file)).sort()) {
    if (current[file] === change.afterFiles[file]) await fs.unlink(path.join(directory, file));
  }
  if (!Object.keys(change.beforeFiles).some((file) => file.startsWith('scripts/'))) await fs.rmdir(path.join(directory, 'scripts')).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  if (packageHash(await readPackage(directory)) !== change.beforeHash) fail('recovery-needed');
}
async function compensate(a, changes) {
  for (const change of [...changes].reverse()) {
    if (change.kind === 'write') {
      await compensateWrite(a, change);
    }
    if (change.kind === 'create') await ownedRemove(a, change);
    if (change.kind === 'archive') {
      const active = await inspectedPackage(packageDir(a, change.name), change.hash);
      const archived = await inspectedPackage(archivePath(a, change.archiveId), change.hash);
      if (active && !archived) continue;
      if (!active && archived) { await fs.rename(archivePath(a, change.archiveId), packageDir(a, change.name)); continue; }
      fail('recovery-needed');
    }
    if (change.kind === 'restore') {
      const active = await inspectedPackage(packageDir(a, change.name), change.hash);
      const archived = await inspectedPackage(archivePath(a, change.archiveId), change.hash);
      if (!active && archived) continue;
      if (active && !archived) { await fs.rename(packageDir(a, change.name), archivePath(a, change.archiveId)); continue; }
      fail('recovery-needed');
    }
  }
}
async function assertVacant(directory, code = 'unmanaged-conflict') {
  try { await fs.lstat(directory); fail(code); } catch (error) { if (error?.code === 'ENOENT') return; if (error?.code === code) throw error; throw error; }
}
function itemForTask(state, type) {
  return Object.values(state.skills).find((item) => item.taskType === type);
}

export async function learn({ accountRoot, record, now = Date.now() }) {
  validateRecord(record);
  now = nowValue(now);
  const payload = hash(canonical(record));
  const a = await account(accountRoot, true);
  return withLock(a, async () => {
    await ensureNoPending(a);
    const before = await readState(a);
    const seen = before.events[hash(record.eventId)];
    if (seen) {
      if (seen !== payload) fail('replay-mismatch');
      const prior = itemForTask(before, record.taskType);
      return { ok: true, state: 'skipped', name: prior?.name };
    }
    const state = clone(before);
    let item = itemForTask(state, record.taskType);
    if (item) {
      const oldItem = itemForTask(before, record.taskType);
      if (item.archived) fail('restore-required');
      const oldFiles = await packageFor(a, oldItem);
      const next = render(record, item.name, record.execution?.context ?? (oldFiles['execution.json'] ? JSON.parse(oldFiles['execution.json']).context : undefined));
      const nextFiles = nextFilesFor(oldFiles, record, next);
      const snap = sameFiles(oldFiles, nextFiles) ? null : await createSnapshot(a, item.name, oldFiles);
      item.lastUsed = now;
      if (sameFiles(oldFiles, nextFiles)) {
        addEvent(state, record.eventId, payload, now, 'reused', item.name);
        await transaction(a, before, [], async () => {}, state);
        return { ok: true, state: 'reused', name: item.name };
      }
      item.hash = packageHash(nextFiles); item.lastSnapshot = snap;
      addEvent(state, record.eventId, payload, now, 'updated', item.name);
      await transaction(a, before, [{ kind: 'write', name: item.name, beforeFiles: oldFiles, afterFiles: nextFiles, beforeHash: packageHash(oldFiles), afterHash: packageHash(nextFiles) }], async () => writePackage(packageDir(a, item.name), nextFiles, oldFiles), state);
      return { ok: true, state: 'updated', name: item.name };
    }
    const packageName = `oma-${record.learning.name}`;
    if (before.skills[packageName]) fail('unmanaged-conflict');
    await assertVacant(packageDir(a, packageName));
    const body = render(record, packageName, record.execution?.context);
    const files = nextFilesFor({}, record, body);
    state.skills[packageName] = { name: packageName, taskType: record.taskType, hash: packageHash(files), lastUsed: now, pinned: false, archived: false, lastSnapshot: null };
    addEvent(state, record.eventId, payload, now, 'learned', packageName);
    await transaction(a, before, [{ kind: 'create', name: packageName, hash: packageHash(files), afterFiles: files }], async () => writePackage(packageDir(a, packageName), files), state);
    return { ok: true, state: 'learned', name: packageName };
  });
}

export async function backfill({ accountRoot, records, now = Date.now() }) {
  if (!Array.isArray(records) || records.length > 20) fail('batch-limit');
  records.forEach(validateRecord);
  now = nowValue(now);
  const a = await account(accountRoot, true);
  await ensureNoPending(a);
  const results = [];
  for (const record of records) results.push(await learn({ accountRoot, record, now }));
  return { ok: true, results };
}

export async function pin({ accountRoot, name: packageName, off = false, now = Date.now() }) {
  now = nowValue(now);
  const a = await account(accountRoot, true);
  return withLock(a, async () => {
    await ensureNoPending(a);
    const before = await readState(a); const item = before.skills[packageName];
    if (!item || item.archived) fail('missing-skill');
    await packageFor(a, item);
    const state = clone(before); state.skills[packageName].pinned = !off; addAudit(state, now, off ? 'unpinned' : 'pinned', packageName);
    await transaction(a, before, [], async () => {}, state);
    return { ok: true, name: packageName, pinned: !off };
  });
}
function eligible(state, now) {
  const cutoff = now - state.config.inactivityDays * DAY;
  return Object.values(state.skills).filter((item) => !item.archived && !item.pinned && !state.config.protectedNames.includes(item.name) && item.lastUsed <= cutoff).map((item) => item.name).sort();
}
export async function maintain({ accountRoot, apply = false, now = Date.now() }) {
  now = nowValue(now);
  const a = await account(accountRoot, apply);
  if (!apply) { await ensureNoPending(a); const state = await readState(a); return { ok: true, state: 'preview', names: eligible(state, now) }; }
  return withLock(a, async () => {
    await ensureNoPending(a);
    const before = await readState(a); const names = eligible(before, now); const prepared = [];
    await ensureChild(a.state, 'archives', true);
    for (const packageName of names) {
      const item = before.skills[packageName]; const files = await packageFor(a, item); await exactPackage(a, packageName);
      const archive = `arc-${crypto.randomUUID()}`; await assertVacant(archivePath(a, archive), 'archive-conflict');
      prepared.push({ name: packageName, files, archive, snapshot: await createSnapshot(a, packageName, files) });
    }
    const state = clone(before); const changes = prepared.map((row) => ({ kind: 'archive', name: row.name, archiveId: row.archive, hash: packageHash(row.files) }));
    for (const row of prepared) { const item = state.skills[row.name]; item.archived = true; item.archiveId = row.archive; item.lastSnapshot = row.snapshot; addAudit(state, now, 'archived', row.name); }
    await transaction(a, before, changes, async () => { for (const row of prepared) { await fs.rename(packageDir(a, row.name), archivePath(a, row.archive)); await testFault?.('after-archive-rename'); } }, state);
    return { ok: true, state: 'archived', names };
  });
}

export async function restore({ accountRoot, name: packageName, now = Date.now() }) {
  now = nowValue(now);
  const a = await account(accountRoot, true);
  return withLock(a, async () => {
    await ensureNoPending(a);
    const before = await readState(a); const item = before.skills[packageName];
    if (!item || !item.archived) fail('missing-archive');
    await assertVacant(packageDir(a, packageName), 'restore-collision');
    await archiveBody(a, item.archiveId, item);
    const state = clone(before); const next = state.skills[packageName]; const archive = next.archiveId;
    next.archived = false; delete next.archiveId; next.lastUsed = now; addAudit(state, now, 'restored', packageName);
    await transaction(a, before, [{ kind: 'restore', name: packageName, archiveId: archive, hash: item.hash }], async () => fs.rename(archivePath(a, archive), packageDir(a, packageName)), state);
    return { ok: true, state: 'restored', name: packageName };
  });
}

export async function rollback({ accountRoot, name: packageName, now = Date.now() }) {
  now = nowValue(now);
  const a = await account(accountRoot, true);
  return withLock(a, async () => {
    await ensureNoPending(a);
    const before = await readState(a); const item = before.skills[packageName];
    if (!item || item.archived || !item.lastSnapshot) fail('no-rollback');
    const current = await packageFor(a, item); const prior = await loadSnapshot(a, item.lastSnapshot, packageName); const reverse = await createSnapshot(a, packageName, current);
    const state = clone(before); state.skills[packageName].hash = prior.hash; state.skills[packageName].lastSnapshot = reverse; state.skills[packageName].lastUsed = now; addAudit(state, now, 'rolled-back', packageName);
    await transaction(a, before, [{ kind: 'write', name: packageName, beforeFiles: current, afterFiles: prior.files, beforeHash: packageHash(current), afterHash: prior.hash }], async () => writePackage(packageDir(a, packageName), prior.files, current), state);
    return { ok: true, state: 'rolled-back', name: packageName };
  });
}

export async function withManagedPackage({ accountRoot, name: packageName, touch = false, now = Date.now() }, callback) {
  if (!name(packageName)) fail('invalid-name');
  if (typeof touch !== 'boolean' || typeof callback !== 'function') fail('invalid-request');
  now = nowValue(now);
  const a = await account(accountRoot, false);
  return withLock(a, async () => {
    await ensureNoPending(a);
    const state = await readState(a);
    const item = state.skills[packageName];
    if (!item || item.archived) fail('missing-skill');
    const files = await packageFor(a, item);
    const bundle = { name: item.name, taskType: item.taskType, hash: item.hash, files };
    const result = await callback(bundle, a);
    if (touch) {
      const next = clone(state);
      next.skills[packageName].lastUsed = Math.max(item.lastUsed, now);
      await transaction(a, state, [], async () => {}, next);
    }
    return result;
  });
}

export async function managedPackage(options) {
  return withManagedPackage(options, (bundle) => bundle);
}

export async function status({ accountRoot }) {
  const a = await account(accountRoot, false);
  await ensureNoPending(a);
  const state = await readState(a);
  return { ok: true, version: state.version, skills: Object.values(state.skills).map(({ name: packageName, taskType: type, pinned, archived }) => ({ name: packageName, taskType: type, pinned, archived })) };
}

export async function doctor({ accountRoot }) {
  try {
    const a = await account(accountRoot, false);
    await ensureNoPending(a);
    const state = await readState(a);
    let active = 0; let archived = 0;
    for (const item of Object.values(state.skills)) {
      if (item.archived) { await archiveBody(a, item.archiveId, item); archived += 1; }
      else { await packageFor(a, item); active += 1; }
    }
    return { ok: true, pending: false, active, archived };
  } catch (error) {
    return { ok: false, error: error?.code ?? 'invalid-state' };
  }
}

function parse(args) {
  const command = args[0]; const values = new Map(); const flags = new Set();
  const valueOptions = new Set(['--account-root', '--record', '--records', '--name']); const flagOptions = new Set(['--apply', '--off']);
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (flagOptions.has(option)) { if (flags.has(option)) fail('invalid-request'); flags.add(option); continue; }
    if (!valueOptions.has(option) || values.has(option) || index + 1 >= args.length || args[index + 1].startsWith('--')) fail('invalid-request');
    values.set(option, args[++index]);
  }
  return { command, values, flags };
}
async function input(file, max) {
  if (typeof file !== 'string') fail('invalid-request');
  const bytes = await readRegular(file, { maxBytes: max });
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('invalid-request'); }
}
export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (argv.length === 0 || argv.includes('--help')) { io.stdout.write('oma learn|backfill|maintain|restore|rollback|pin|status --account-root DIR\n'); return 0; }
  const { command, values, flags } = parse(argv); const root = values.get('--account-root'); if (!root) fail('account-root-required');
  let result;
  if (command === 'learn' && values.size === 2 && flags.size === 0) result = await learn({ accountRoot: root, record: await input(values.get('--record'), 65_536) });
  else if (command === 'backfill' && values.size === 2 && flags.size === 0) result = await backfill({ accountRoot: root, records: await input(values.get('--records'), 1_048_576) });
  else if (command === 'maintain' && values.size === 1 && [...flags].every((flag) => flag === '--apply')) result = await maintain({ accountRoot: root, apply: flags.has('--apply') });
  else if (command === 'restore' && values.size === 2 && flags.size === 0) result = await restore({ accountRoot: root, name: values.get('--name') });
  else if (command === 'rollback' && values.size === 2 && flags.size === 0) result = await rollback({ accountRoot: root, name: values.get('--name') });
  else if (command === 'pin' && values.size === 2 && [...flags].every((flag) => flag === '--off')) result = await pin({ accountRoot: root, name: values.get('--name'), off: flags.has('--off') });
  else if (command === 'status' && values.size === 1 && flags.size === 0) result = await status({ accountRoot: root });
  else fail('invalid-request');
  io.stdout.write(`${JSON.stringify(result)}\n`); return 0;
}
