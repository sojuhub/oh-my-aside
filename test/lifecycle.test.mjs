import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backfill, learn, maintain, managedPackage, pin, restore, rollback, setTestFault, status, validateRecord, withManagedPackage } from '../skill/scripts/lifecycle.mjs';
import { readPackage, validateExecution } from '../skill/scripts/packages.mjs';

async function fixture(t) { const root = await fs.mkdtemp(path.join(process.env.OMA_TEST_TMP || os.tmpdir(), 'oma-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
function record(id, task = 'compare', skill = 'compare') { return { schemaVersion: 1, eventId: id, taskType: task, outcome: 'success', verified: true, reusable: true, privacy: 'redacted', incognito: false, evidence: { kind: 'artifact-check', summary: 'Checked the generated artifact.' }, learning: { name: skill, description: 'Compare supported options carefully.', steps: ['Collect approved sources.'], checks: ['Check the result.'], pitfalls: ['Do not invent facts.'] } }; }
function executableRecord(id, code = 'if (!input?.ok) throw new Error("check failed"); return { verified: true };') { const value = record(id); value.execution = { schemaVersion: 1, context: 'compare', effect: 'read-only', routes: [{ id: 'run', transport: 'aside-repl', code }] }; return value; }

test('learn creates normalized package', async (t) => { const root = await fixture(t); const result = await learn({ accountRoot: root, record: record('one'), now: 1 }); assert.equal(result.name, 'oma-compare'); assert.match(await fs.readFile(path.join(root, 'skills/user/oma-compare/SKILL.md'), 'utf8'), /name: "oma-compare"/); });
test('event replay is idempotent', async (t) => { const root = await fixture(t); await learn({ accountRoot: root, record: record('one'), now: 1 }); assert.equal((await learn({ accountRoot: root, record: record('one'), now: 2 })).state, 'skipped'); });
test('same event with a different payload refuses', async (t) => { const root = await fixture(t); await learn({ accountRoot: root, record: record('one'), now: 1 }); await assert.rejects(() => learn({ accountRoot: root, record: record('one', 'other'), now: 2 }), { code: 'replay-mismatch' }); });
test('invalid record creates no account state', async (t) => { const root = await fixture(t); const bad = record('bad'); bad.privacy = 'raw'; await assert.rejects(() => learn({ accountRoot: root, record: bad })); await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside'))); });
test('privacy heuristic blocks reconstructed token prefix', () => { const bad = record('secret'); bad.learning.steps = [`${'sk'}-${'abc'}123456789`]; assert.throws(() => validateRecord(bad), { code: 'unsafe-record' }); });
test('privacy heuristic blocks email and absolute path', () => { const bad = record('private'); bad.evidence.summary = 'Contact a@b.ca from /Users/person/file.'; assert.throws(() => validateRecord(bad), { code: 'unsafe-record' }); });
test('canonical task retains existing package name and heading when only proposal changes', async (t) => {
  const root = await fixture(t);
  const first = await learn({ accountRoot: root, record: record('a', 'same', 'old-name'), now: 1 });
  const result = await learn({ accountRoot: root, record: record('b', 'same', 'new-name'), now: 2 });
  assert.equal(first.name, result.name);
  assert.equal(result.state, 'reused');
  assert.match(await fs.readFile(path.join(root, `skills/user/${first.name}/SKILL.md`), 'utf8'), /# oma-old-name/);
});
test('rollback restores prior content and makes reverse snapshot', async (t) => { const root = await fixture(t); const first = await learn({ accountRoot: root, record: record('a'), now: 1 }); const changed = record('b'); changed.learning.steps = ['New step.']; await learn({ accountRoot: root, record: changed, now: 2 }); await rollback({ accountRoot: root, name: first.name, now: 3 }); assert.match(await fs.readFile(path.join(root, 'skills/user/oma-compare/SKILL.md'), 'utf8'), /Collect approved/); });
test('missing snapshot blocks rollback before mutation', async (t) => { const root = await fixture(t); const result = await learn({ accountRoot: root, record: record('a'), now: 1 }); const state = JSON.parse(await fs.readFile(path.join(root, '.oh-my-aside/registry.json'))); state.skills[result.name].lastSnapshot = '11111111-1111-4111-8111-111111111111.json'; await fs.writeFile(path.join(root, '.oh-my-aside/registry.json'), JSON.stringify(state)); await assert.rejects(() => rollback({ accountRoot: root, name: result.name })); });
test('commit failure compensates file and event acknowledgement', async (t) => { const root = await fixture(t); const first = await learn({ accountRoot: root, record: record('a'), now: 1 }); const changed = record('b'); changed.learning.steps = ['Changed.']; setTestFault(() => { throw Object.assign(new Error('x'), { code: 'commit-failed' }); }); await assert.rejects(() => learn({ accountRoot: root, record: changed, now: 2 })); setTestFault(undefined); assert.match(await fs.readFile(path.join(root, `skills/user/${first.name}/SKILL.md`), 'utf8'), /Collect approved/); assert.equal((await status({ accountRoot: root })).skills.length, 1); });
test('pending journal fails closed', async (t) => { const root = await fixture(t); await fs.mkdir(path.join(root, '.oh-my-aside')); await fs.writeFile(path.join(root, '.oh-my-aside/pending.json'), '{}'); await assert.rejects(() => learn({ accountRoot: root, record: record('a') }), { code: 'recovery-needed' }); });
test('backfill over twenty does not create state', async (t) => { const root = await fixture(t); await assert.rejects(() => backfill({ accountRoot: root, records: Array.from({ length: 21 }, (_, i) => record(`e${i}`)) }), { code: 'batch-limit' }); await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside'))); });
test('maintenance preflights every package before move', async (t) => { const root = await fixture(t); const a = await learn({ accountRoot: root, record: record('a', 'one', 'one'), now: 1 }); const b = await learn({ accountRoot: root, record: record('b', 'two', 'two'), now: 1 }); await fs.appendFile(path.join(root, `skills/user/${b.name}/SKILL.md`), 'drift'); await assert.rejects(() => maintain({ accountRoot: root, apply: true, now: 100 * 86400000 })); await fs.stat(path.join(root, `skills/user/${a.name}`)); });
test('maintain archives default unpinned skill', async (t) => { const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 }); await maintain({ accountRoot: root, apply: true, now: 100 * 86400000 }); await assert.rejects(() => fs.stat(path.join(root, `skills/user/${item.name}`))); });
test('pin excludes maintenance', async (t) => { const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 }); await pin({ accountRoot: root, name: item.name }); assert.deepEqual((await maintain({ accountRoot: root, now: 100 * 86400000 })).names, []); });
test('restore refreshes last used', async (t) => { const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 }); await maintain({ accountRoot: root, apply: true, now: 100 * DAY }); await restore({ accountRoot: root, name: item.name, now: 100 * DAY }); assert.deepEqual((await maintain({ accountRoot: root, now: 100 * DAY })).names, []); });
test('restore collision leaves archive intact', async (t) => { const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 }); await maintain({ accountRoot: root, apply: true, now: 100 * 86400000 }); const state = JSON.parse(await fs.readFile(path.join(root, '.oh-my-aside/registry.json'))); await fs.mkdir(path.join(root, `skills/user/${item.name}`)); await assert.rejects(() => restore({ accountRoot: root, name: item.name })); await fs.stat(path.join(root, '.oh-my-aside/archives', state.skills[item.name].archiveId)); });
test('symlink state and package escapes fail', async (t) => { const root = await fixture(t); await fs.mkdir(path.join(root, 'skills')); await fs.symlink(os.tmpdir(), path.join(root, 'skills/user')); await assert.rejects(() => learn({ accountRoot: root, record: record('a') })); });
test('unowned collision is not overwritten', async (t) => { const root = await fixture(t); await fs.mkdir(path.join(root, 'skills/user/oma-compare'), { recursive: true }); await fs.writeFile(path.join(root, 'skills/user/oma-compare/SKILL.md'), 'x'); await assert.rejects(() => learn({ accountRoot: root, record: record('a') }), { code: 'unmanaged-conflict' }); });
test('extra package files block archival', async (t) => { const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 }); await fs.writeFile(path.join(root, `skills/user/${item.name}/extra`), 'x'); await assert.rejects(() => maintain({ accountRoot: root, apply: true, now: 100 * 86400000 }), { code: 'package-not-archivable' }); });
test('archive commit failure restores only packages actually moved', async (t) => {
  const root = await fixture(t);
  const first = await learn({ accountRoot: root, record: record('a', 'one', 'one'), now: 1 });
  const second = await learn({ accountRoot: root, record: record('b', 'two', 'two'), now: 1 });
  const registry = await fs.readFile(path.join(root, '.oh-my-aside/registry.json'), 'utf8');
  let moves = 0;
  setTestFault((stage) => { if (stage === 'after-archive-rename' && ++moves === 2) throw Object.assign(new Error('x'), { code: 'commit-failed' }); });
  t.after(() => setTestFault(undefined));
  await assert.rejects(() => maintain({ accountRoot: root, apply: true, now: 100 * DAY }), { code: 'commit-failed' });
  assert.equal(await fs.readFile(path.join(root, '.oh-my-aside/registry.json'), 'utf8'), registry);
  await fs.stat(path.join(root, `skills/user/${first.name}/SKILL.md`));
  await fs.stat(path.join(root, `skills/user/${second.name}/SKILL.md`));
  await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside/pending.json')));
});

test('archived package name remains occupied by its registry identity', async (t) => {
  const root = await fixture(t);
  const item = await learn({ accountRoot: root, record: record('a', 'old-task', 'shared'), now: 1 });
  await maintain({ accountRoot: root, apply: true, now: 100 * DAY });
  await assert.rejects(() => learn({ accountRoot: root, record: record('b', 'new-task', 'shared'), now: 2 }), { code: 'unmanaged-conflict' });
  assert.equal((await restore({ accountRoot: root, name: item.name, now: 3 })).state, 'restored');
});

test('creation failure removes only its empty transaction directory', async (t) => {
  const root = await fixture(t);
  setTestFault(undefined);
  const originalRename = fs.rename;
  fs.rename = async (...args) => { if (String(args[0]).includes('.tmp-')) throw Object.assign(new Error('x'), { code: 'write-failed' }); return originalRename(...args); };
  t.after(() => { fs.rename = originalRename; });
  await assert.rejects(() => learn({ accountRoot: root, record: record('a') }), { code: 'write-failed' });
  await assert.rejects(() => fs.stat(path.join(root, 'skills/user/oma-compare')));
  await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside/pending.json')));
});

test('archived learning requires an explicit restore, then updates normally', async (t) => {
  const root = await fixture(t);
  const item = await learn({ accountRoot: root, record: record('a'), now: 1 });
  await maintain({ accountRoot: root, apply: true, now: 100 * DAY });
  const registry = await fs.readFile(path.join(root, '.oh-my-aside/registry.json'), 'utf8');
  const archived = JSON.parse(registry).skills[item.name].archiveId;
  const changed = record('b'); changed.learning.steps = ['Changed after restore.'];
  await assert.rejects(() => learn({ accountRoot: root, record: changed, now: 2 }), { code: 'restore-required' });
  assert.equal(await fs.readFile(path.join(root, '.oh-my-aside/registry.json'), 'utf8'), registry);
  await fs.stat(path.join(root, '.oh-my-aside/archives', archived, 'SKILL.md'));
  await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside/pending.json')));
  await restore({ accountRoot: root, name: item.name, now: 3 });
  assert.equal((await learn({ accountRoot: root, record: changed, now: 4 })).state, 'updated');
});

test('second archive rename failure restores both packages and registry', async (t) => {
  const root = await fixture(t);
  const first = await learn({ accountRoot: root, record: record('a', 'one', 'one'), now: 1 });
  const second = await learn({ accountRoot: root, record: record('b', 'two', 'two'), now: 1 });
  const registry = await fs.readFile(path.join(root, '.oh-my-aside/registry.json'), 'utf8');
  const rename = fs.rename; let moves = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (String(from).includes('/skills/user/oma-') && String(to).includes('/archives/arc-') && ++moves === 2) throw Object.assign(new Error('x'), { code: 'rename-failed' });
    return rename(from, to);
  });
  await assert.rejects(() => maintain({ accountRoot: root, apply: true, now: 100 * DAY }), { code: 'rename-failed' });
  assert.equal(await fs.readFile(path.join(root, '.oh-my-aside/registry.json'), 'utf8'), registry);
  await fs.stat(path.join(root, `skills/user/${first.name}/SKILL.md`));
  await fs.stat(path.join(root, `skills/user/${second.name}/SKILL.md`));
});

test('protected names suppress archive', async (t) => {
  const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 });
  const file = path.join(root, '.oh-my-aside/registry.json'); const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.config.protectedNames.push(item.name); await fs.writeFile(file, JSON.stringify(state));
  assert.deepEqual((await maintain({ accountRoot: root, now: 100 * DAY })).names, []);
  await fs.stat(path.join(root, `skills/user/${item.name}/SKILL.md`));
});

test('initial package mkdir failure leaves no pending or managed package directory', async (t) => {
  const root = await fixture(t); const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (directory, options) => {
    if (String(directory).endsWith('/skills/user/oma-compare')) throw Object.assign(new Error('x'), { code: 'mkdir-failed' });
    return mkdir(directory, options);
  });
  await assert.rejects(() => learn({ accountRoot: root, record: record('a') }), { code: 'mkdir-failed' });
  await assert.rejects(() => fs.stat(path.join(root, 'skills/user/oma-compare')));
  await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside/pending.json')));
});

test('state size limit rejects an update before body registry or pending changes', async (t) => {
  const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('a'), now: 1 });
  const registryFile = path.join(root, '.oh-my-aside/registry.json'); const state = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const size = () => Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`); const limit = 2_097_152;
  let index = 0; const key = () => crypto.createHash('sha256').update(`key-${index}`).digest('hex'); const value = () => crypto.createHash('sha256').update(`value-${index++}`).digest('hex');
  const before = size(); state.events[key()] = value(); const growth = size() - before; delete state.events[crypto.createHash('sha256').update('key-0').digest('hex')]; index = 0;
  for (let count = Math.floor((limit - 219 - before) / growth); count > 0; count -= 1) state.events[key()] = value();
  while (limit - size() >= 220) state.events[key()] = value();
  assert.ok(limit - size() < 220); await fs.writeFile(registryFile, JSON.stringify(state, null, 2) + '\n');
  const body = await fs.readFile(path.join(root, `skills/user/${item.name}/SKILL.md`), 'utf8'); const registry = await fs.readFile(registryFile, 'utf8');
  const changed = record('b'); changed.learning.steps = ['Would exceed the state limit.'];
  await assert.rejects(() => learn({ accountRoot: root, record: changed, now: 2 }), { code: 'state-too-large' });
  assert.equal(await fs.readFile(path.join(root, `skills/user/${item.name}/SKILL.md`), 'utf8'), body);
  assert.equal(await fs.readFile(registryFile, 'utf8'), registry);
  await assert.rejects(() => fs.stat(path.join(root, '.oh-my-aside/pending.json')));
});

const DAY = 86_400_000;

test('managed executable package updates, rolls back, archives, and restores as one version', async (t) => {
  const root = await fixture(t);
  const item = await learn({ accountRoot: root, record: record('md'), now: 1 });
  const first = executableRecord('exec');
  await learn({ accountRoot: root, record: first, now: 2 });
  const packageDir = path.join(root, 'skills/user', item.name);
  assert.match(await fs.readFile(path.join(packageDir, 'execution.json'), 'utf8'), /"run"/);
  assert.equal((await managedPackage({ accountRoot: root, name: item.name })).files['scripts/run.js'], first.execution.routes[0].code);
  await learn({ accountRoot: root, record: executableRecord('changed', 'return { verified: true };'), now: 3 });
  await rollback({ accountRoot: root, name: item.name, now: 4 });
  assert.match(await fs.readFile(path.join(packageDir, 'scripts/run.js'), 'utf8'), /input\?\.ok/);
  await maintain({ accountRoot: root, apply: true, now: 100 * DAY });
  const state = JSON.parse(await fs.readFile(path.join(root, '.oh-my-aside/registry.json')));
  assert.match(await fs.readFile(path.join(root, '.oh-my-aside/archives', state.skills[item.name].archiveId, 'scripts/run.js'), 'utf8'), /input\?\.ok/);
  await restore({ accountRoot: root, name: item.name, now: 100 * DAY });
  assert.match(await fs.readFile(path.join(packageDir, 'scripts/run.js'), 'utf8'), /input\?\.ok/);
});

test('script tamper refuses managed package access', async (t) => {
  const root = await fixture(t); const item = await learn({ accountRoot: root, record: executableRecord('a'), now: 1 });
  await fs.appendFile(path.join(root, 'skills/user', item.name, 'scripts/run.js'), '\n');
  await assert.rejects(() => managedPackage({ accountRoot: root, name: item.name }), { code: 'manual-drift' });
});

test('invalid execution and extra package files are rejected', async (t) => {
  const root = await fixture(t); const bad = executableRecord('bad', 'if (');
  await assert.rejects(() => learn({ accountRoot: root, record: bad }), { code: 'invalid-execution' });
  assert.throws(() => validateExecution({ schemaVersion: 1, context: 'compare', effect: 'read-only', routes: [{ id: 'run', transport: 'aside-repl', code: 'return { verified: true };', extra: true }] }), { code: 'invalid-execution' });
  const item = await learn({ accountRoot: root, record: executableRecord('good'), now: 1 });
  await fs.writeFile(path.join(root, 'skills/user', item.name, 'extra'), 'x');
  await assert.rejects(() => readPackage(path.join(root, 'skills/user', item.name)), { code: 'invalid-package' });
});

test('multi-file commit failure restores the whole executable package', async (t) => {
  const root = await fixture(t); const item = await learn({ accountRoot: root, record: executableRecord('a'), now: 1 });
  const packageDir = path.join(root, 'skills/user', item.name); const before = await readPackage(packageDir);
  setTestFault((stage) => { if (stage === 'before-registry-save') throw Object.assign(new Error('x'), { code: 'commit-failed' }); });
  t.after(() => setTestFault(undefined));
  await assert.rejects(() => learn({ accountRoot: root, record: executableRecord('b', 'return { verified: true };'), now: 2 }), { code: 'commit-failed' });
  assert.deepEqual(await readPackage(packageDir), before);
});

test('rollback failure restores scripts after an executable package is stripped to its MD snapshot', async (t) => {
  const root = await fixture(t); const item = await learn({ accountRoot: root, record: record('md'), now: 1 });
  await learn({ accountRoot: root, record: executableRecord('exec'), now: 2 });
  const packageDir = path.join(root, 'skills/user', item.name); const before = await readPackage(packageDir);
  setTestFault((stage) => { if (stage === 'before-registry-save') throw Object.assign(new Error('x'), { code: 'commit-failed' }); });
  t.after(() => setTestFault(undefined));
  await assert.rejects(() => rollback({ accountRoot: root, name: item.name, now: 3 }), { code: 'commit-failed' });
  assert.deepEqual(await readPackage(packageDir), before);
});

test('managed package reads stay read-only while touch refreshes inactivity', async (t) => {
  const root = await fixture(t); const item = await learn({ accountRoot: root, record: executableRecord('a'), now: 1 });
  const registryFile = path.join(root, '.oh-my-aside/registry.json'); const before = await fs.readFile(registryFile, 'utf8');
  await managedPackage({ accountRoot: root, name: item.name });
  assert.equal(await fs.readFile(registryFile, 'utf8'), before);
  await withManagedPackage({ accountRoot: root, name: item.name, touch: true, now: 100 * DAY }, (bundle) => bundle);
  await withManagedPackage({ accountRoot: root, name: item.name, touch: true, now: 1 }, (bundle) => bundle);
  const state = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  assert.equal(state.skills[item.name].lastUsed, 100 * DAY);
  assert.deepEqual((await maintain({ accountRoot: root, now: 100 * DAY })).names, []);
});
