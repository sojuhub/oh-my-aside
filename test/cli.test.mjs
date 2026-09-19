import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t) { const root = await fs.mkdtemp(path.join(process.env.OMA_TEST_TMP || os.tmpdir(), 'oma-cli-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
function record(id) { return { schemaVersion: 1, eventId: id, taskType: 'cli-flow', outcome: 'success', verified: true, reusable: true, privacy: 'redacted', incognito: false, evidence: { kind: 'readback', summary: 'Read the output.' }, learning: { name: 'cli-flow', description: 'Use the command line safely.', steps: ['Run the command.'], checks: ['Read JSON.'], pitfalls: ['Do not expose secrets.'] } }; }
function cli(root, ...args) { return spawnSync(process.execPath, ['bin/oma.mjs', ...args, '--account-root', root], { encoding: 'utf8' }); }

test('help is meaningful', () => { const out = spawnSync(process.execPath, ['bin/oma.mjs', '--help'], { encoding: 'utf8' }); assert.equal(out.status, 0); assert.match(out.stdout, /catalog/); });
test('unknown command returns sanitized JSON error', async (t) => { const root = await fixture(t); const out = cli(root, 'unknown'); assert.equal(out.status, 1); assert.deepEqual(JSON.parse(out.stderr), { ok: false, error: 'invalid-request' }); });
test('CLI rejects bounded oversized record before parse', async (t) => { const root = await fixture(t); const file = path.join(root, 'big.json'); await fs.writeFile(file, 'x'.repeat(65_537)); const out = cli(root, 'learn', '--record', file); assert.equal(out.status, 1); assert.equal(JSON.parse(out.stderr).error, 'input-too-large'); });
test('CLI requires account root exactly once', () => { const out = spawnSync(process.execPath, ['bin/oma.mjs', 'status'], { encoding: 'utf8' }); assert.equal(out.status, 1); assert.equal(JSON.parse(out.stderr).error, 'account-root-required'); });
test('spawned lifecycle flow learns updates rolls back archives and restores', async (t) => {
  const root = await fixture(t);
  const one = path.join(root, 'one.json');
  const two = path.join(root, 'two.json');
  await fs.writeFile(one, JSON.stringify(record('one')));
  const changed = record('two');
  changed.learning.steps = ['Run changed command.'];
  await fs.writeFile(two, JSON.stringify(changed));
  assert.equal(cli(root, 'learn', '--record', one).status, 0);
  assert.equal(JSON.parse(cli(root, 'learn', '--record', two).stdout).state, 'updated');
  assert.equal(cli(root, 'rollback', '--name', 'oma-cli-flow').status, 0);
  const registryFile = path.join(root, '.oh-my-aside/registry.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  registry.skills['oma-cli-flow'].lastUsed = 0;
  await fs.writeFile(registryFile, JSON.stringify(registry));
  const archived = cli(root, 'maintain', '--apply');
  assert.equal(archived.status, 0);
  assert.deepEqual(JSON.parse(archived.stdout).names, ['oma-cli-flow']);
  assert.equal(JSON.parse(cli(root, 'restore', '--name', 'oma-cli-flow').stdout).state, 'restored');
});
test('installer and retrieval commands return JSON receipts from an account root with spaces', async (t) => {
  const root = path.join(await fixture(t), 'account root');
  await fs.mkdir(root);
  const installed = cli(root, 'install');
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).state, 'installed');
  const catalog = cli(root, 'catalog');
  assert.equal(catalog.status, 0, catalog.stderr);
  const listed = JSON.parse(catalog.stdout);
  const entry = listed.items.find((skill) => skill.name === 'oh-my-aside');
  assert.ok(entry);
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  const searched = cli(root, 'search', '--query', 'oh-my-aside');
  assert.equal(searched.status, 0, searched.stderr);
  assert.ok(JSON.parse(searched.stdout).items.some((skill) => skill.name === 'oh-my-aside'));
  const loaded = cli(root, 'load', '--name', 'oh-my-aside', '--expected-hash', entry.sha256);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).receipt.hash, entry.sha256);
  const script = path.join(root, 'skills/user/oh-my-aside/scripts/oma.mjs');
  const status = spawnSync(process.execPath, [script, 'status', '--account-root', root], { encoding: 'utf8' });
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).installer.installed, true);
  const removed = cli(root, 'uninstall');
  assert.equal(removed.status, 0);
  assert.equal(JSON.parse(removed.stdout).ok, true);
  assert.equal(JSON.parse(cli(root, 'status').stdout).installer.installed, false);
  assert.equal(cli(root, 'install').status, 0);
});
test('doctor reports manual drift and installer commands reject extra flags', async (t) => {
  const root = await fixture(t);
  assert.equal(cli(root, 'install').status, 0);
  await fs.appendFile(path.join(root, 'skills/user/oh-my-aside/SKILL.md'), 'drift');
  const doctor = cli(root, 'doctor');
  assert.equal(doctor.status, 1);
  assert.equal(JSON.parse(doctor.stdout).installer.ok, false);
  assert.equal(cli(root, 'status', '--apply').status, 1);
  assert.equal(cli(root, 'install', '--apply').status, 1);
});
test('retrieval delegation does not forward account-root', async (t) => { const root = await fixture(t); const out = cli(root, 'catalog'); assert.notEqual(out.status, null); assert.doesNotMatch(out.stderr, /--account-root/); });
