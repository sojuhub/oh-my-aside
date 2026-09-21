import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { learn } from '../skill/scripts/lifecycle.mjs';
import { route, begin, record, run } from '../skill/scripts/execution.mjs';

function learning(id = 'one', routes = [{ id: 'saved', transport: 'aside-repl', code: 'return {verified: input.value === 42};' }]) {
  return { schemaVersion: 1, eventId: id, taskType: 'fixture-check', outcome: 'success', verified: true, reusable: true, privacy: 'redacted', incognito: false, evidence: { kind: 'artifact-check', summary: 'Checked expected value.' }, learning: { name: 'fixture-check', description: 'Check a synthetic fixture.', steps: ['Check the expected value.'], checks: ['Value must match.'], pitfalls: ['An exception is not success.'] }, execution: { schemaVersion: 1, context: 'fixture', effect: 'read-only', routes } };
}
async function fixture(t, rec = learning()) {
  const accountRoot = await fs.mkdtemp(path.join(process.env.OMA_TEST_TMP || os.tmpdir(), 'oma-exec-'));
  t.after(() => fs.rm(accountRoot, { recursive: true, force: true }));
  await learn({ accountRoot, record: rec });
  return { accountRoot, name: 'oma-fixture-check', context: 'fixture' };
}
async function observed(options, { success = true, tokens = null, tokenSource = 'unknown', routeId, now = Date.now() } = {}) {
  const attempt = await begin({ ...options, probe: true, routeId, taskId: crypto.randomUUID(), now });
  assert.equal(attempt.state, 'script');
  await record({ accountRoot: options.accountRoot, receipt: { id: attempt.id, outcome: success ? 'success' : 'failed', verified: success, failure: success ? 'none' : 'check-failed', tokens, tokenSource }, now: now + 1 });
  return attempt;
}
const fakeExecutor = (verified, check = () => {}) => async (file, args, options) => {
  assert.equal(file, 'aside'); assert.deepEqual(args.slice(0, 5), ['repl', '--account', 'u0', '--host', 'local']);
  assert.equal(options.timeout, 125_000); assert.equal(options.maxBuffer, 262_144);
  check(args[5]);
  return { stdout: `ignored private page output\n${args[5].match(/OMA_[a-f0-9]+_/)[0]}${JSON.stringify({ verified })}\n` };
};

test('unproven or mismatched scripts fall back; two checked probes enable reuse', async t => {
  const opts = await fixture(t);
  assert.equal((await route(opts)).reason, 'validation-needed');
  assert.equal((await route({ ...opts, context: 'different' })).reason, 'context-mismatch');
  await observed(opts); await observed(opts);
  const selected = await route(opts);
  assert.equal(selected.state, 'script'); assert.equal(selected.samples, 2); assert.equal(selected.measuredTokensPerSuccess, null);
});

test('MD-only skills stay usable without creating execution state', async t => {
  const rec = learning(); delete rec.execution;
  const opts = await fixture(t, rec);
  assert.equal((await route(opts)).reason, 'markdown-only');
  await assert.rejects(fs.stat(path.join(opts.accountRoot, '.oh-my-aside/execution-state.json')), { code: 'ENOENT' });
});

test('reliability precedes measured cost; equal reliability chooses measured lower total cost', async t => {
  const routes = ['cheap', 'reliable'].map(id => ({ id, transport: 'aside-repl', code: 'return {verified: true};' }));
  const opts = await fixture(t, learning('one', routes));
  await observed(opts, { routeId: 'cheap', success: false, tokens: 1, tokenSource: 'measured' });
  for (let i = 0; i < 2; i++) {
    await observed(opts, { routeId: 'cheap', tokens: 1, tokenSource: 'measured' });
    await observed(opts, { routeId: 'reliable', tokens: 100, tokenSource: 'measured' });
  }
  assert.equal((await route(opts)).route, 'reliable');
  const other = await fixture(t, learning('one', routes));
  for (const routeId of ['cheap', 'reliable']) for (let i = 0; i < 2; i++) await observed(other, { routeId, tokens: routeId === 'cheap' ? 10 : 100, tokenSource: 'measured' });
  assert.equal((await route(other)).route, 'cheap');
});

test('a failed run disables default reuse and whole-version changes invalidate previous evidence', async t => {
  const opts = await fixture(t); await observed(opts); await observed(opts);
  await observed(opts, { success: false });
  assert.equal((await route(opts)).reason, 'validation-needed');
  const next = learning('two'); next.execution.routes[0].code = 'return {verified: input.value === 43};';
  await learn({ accountRoot: opts.accountRoot, record: next });
  assert.equal((await route(opts)).reason, 'validation-needed');
});

test('an unfinished or unknown attempt blocks duplicate execution until a readback receipt resolves it', async t => {
  const opts = await fixture(t); const taskId = crypto.randomUUID();
  const started = await begin({ ...opts, probe: true, taskId });
  assert.equal((await begin({ ...opts, probe: true, taskId: crypto.randomUUID() })).reason, 'unresolved-attempt');
  const receipt = { id: started.id, outcome: 'unknown', verified: false, failure: 'timeout', tokens: null, tokenSource: 'unknown' };
  await record({ accountRoot: opts.accountRoot, receipt });
  assert.equal((await route({ ...opts, probe: true })).reason, 'unresolved-attempt');
  await record({ accountRoot: opts.accountRoot, receipt: { ...receipt, outcome: 'failed', failure: 'check-failed' } });
  assert.equal((await route({ ...opts, probe: true })).state, 'script');
});

test('task budget is persisted and receipts reject replay changes and false success', async t => {
  const opts = await fixture(t); const taskId = crypto.randomUUID();
  for (let i = 0; i < 2; i++) {
    const started = await begin({ ...opts, probe: true, taskId });
    const receipt = { id: started.id, outcome: 'failed', verified: false, failure: 'check-failed', tokens: null, tokenSource: 'unknown' };
    await assert.rejects(() => record({ accountRoot: opts.accountRoot, receipt: { ...receipt, outcome: 'success' } }), { code: 'invalid-execution-receipt' });
    await record({ accountRoot: opts.accountRoot, receipt });
    assert.equal((await record({ accountRoot: opts.accountRoot, receipt })).replay, true);
    await assert.rejects(() => record({ accountRoot: opts.accountRoot, receipt: { ...receipt, tokens: 2, tokenSource: 'measured' } }), { code: 'receipt-conflict' });
  }
  assert.equal((await begin({ ...opts, probe: true, taskId })).reason, 'repair-budget-exhausted');
});

test('real runner argument contract keeps input out of shell and private output out of receipts', async t => {
  const opts = await fixture(t);
  const result = await run({ ...opts, probe: true, taskId: crypto.randomUUID(), asideAccount: 'u0', input: { value: 42, text: '`$(not-a-command)`' } }, fakeExecutor(true, code => assert.ok(code.includes('`$(not-a-command)`'))));
  assert.equal(result.state, 'success'); assert.equal(result.tokens, null);
  const state = await fs.readFile(path.join(opts.accountRoot, '.oh-my-aside/execution-state.json'), 'utf8');
  assert.doesNotMatch(state, /private page|not-a-command|"value"/);
});

test('missing marker, exceptions, and timeout are unconfirmed; failed verification uses MD recovery', async t => {
  for (const [executor, expected] of [[async () => ({ stdout: '{"verified":true}' }), 'unknown'], [async () => { throw Object.assign(new Error('private diagnostic'), { killed: true }); }, 'unknown'], [fakeExecutor(false), 'failed']]) {
    const opts = await fixture(t);
    const result = await run({ ...opts, probe: true, taskId: crypto.randomUUID(), asideAccount: 'u0', input: {} }, executor);
    assert.equal(result.state, expected); assert.doesNotMatch(JSON.stringify(result), /private diagnostic/);
  }
});

test('stale evidence, script tampering, state corruption and extra receipt fields fail closed', async t => {
  const opts = await fixture(t); const old = Date.now() - 31 * 86_400_000;
  await observed(opts, { now: old }); await observed(opts, { now: old + 2 });
  assert.equal((await route(opts)).reason, 'validation-needed');
  await fs.appendFile(path.join(opts.accountRoot, 'skills/user/oma-fixture-check/scripts/saved.js'), '\n// edit');
  await assert.rejects(() => route(opts), { code: 'manual-drift' });
  const clean = await fixture(t);
  await fs.writeFile(path.join(clean.accountRoot, '.oh-my-aside/execution-state.json'), '{"version":1,"runs":[{}]}');
  await assert.rejects(() => route(clean), { code: 'invalid-execution-state' });
  await assert.rejects(() => record({ accountRoot: clean.accountRoot, receipt: { id: crypto.randomUUID(), privateText: 'not allowed' } }), { code: 'invalid-execution-receipt' });
});

test('spawned CLI supports route and begin from an installed payload, without browser calls', async t => {
  const opts = await fixture(t);
  const cli = (...args) => spawnSync(process.execPath, ['bin/oma.mjs', ...args, '--account-root', opts.accountRoot], { encoding: 'utf8' });
  assert.equal(cli('install').status, 0);
  const payload = path.join(opts.accountRoot, 'skills/user/oh-my-aside/scripts/oma.mjs');
  const result = spawnSync(process.execPath, [payload, 'begin', '--account-root', opts.accountRoot, '--name', opts.name, '--context', opts.context, '--task-id', crypto.randomUUID(), '--probe'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).state, 'script');
  assert.equal(cli('route', '--name', opts.name, '--context', opts.context, '--bogus').status, 1);
});

test('non-object JSON serialization is rejected before reserving an attempt', async t => {
  const opts = await fixture(t);
  for (const value of [undefined, null, [], { toJSON: () => undefined }, { toJSON: () => null }, { toJSON: () => 42 }, { toJSON: () => [] }]) {
    await assert.rejects(() => run({ ...opts, probe: true, taskId: crypto.randomUUID(), asideAccount: 'u0', input: value }, () => assert.fail('must not execute')), { code: 'invalid-input' });
  }
  await assert.rejects(fs.stat(path.join(opts.accountRoot, '.oh-my-aside/execution-state.json')), { code: 'ENOENT' });
});
