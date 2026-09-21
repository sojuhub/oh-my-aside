import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { account, atomic, fail, hash, readRegular, withLock } from './safety.mjs';
import { managedPackage, withManagedPackage } from './lifecycle.mjs';

const exec = promisify(execFile);
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OUTCOMES = ['running', 'success', 'failed', 'unknown', 'blocked'];
const FAILURES = ['none', 'check-failed', 'script-error', 'auth-required', 'timeout', 'interrupted', 'package-changed'];
const SOURCES = ['measured', 'estimated', 'unknown'];
const KEYS = ['id', 'taskId', 'name', 'skillHash', 'context', 'route', 'startedAt', 'finishedAt', 'outcome', 'failure', 'tokens', 'tokenSource'];
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const integer = n => Number.isSafeInteger(n) && n >= 0;
const slug = s => typeof s === 'string' && s.length <= 60 && SLUG.test(s);

async function readState(a) {
  const bytes = await readRegular(path.join(a.state, 'execution-state.json'), { optional: true });
  if (!bytes) return { version: 1, runs: [] };
  let state;
  try { state = JSON.parse(bytes); } catch { fail('invalid-execution-state'); }
  if (!exact(state, ['version', 'runs']) || state.version !== 1 || !Array.isArray(state.runs) || state.runs.length > 5000) fail('invalid-execution-state');
  const seen = new Set();
  for (const r of state.runs) {
    if (!exact(r, KEYS) || !UUID.test(r.id) || seen.has(r.id) || !UUID.test(r.taskId) || typeof r.name !== 'string' || !r.name.startsWith('oma-') || !slug(r.name.slice(4)) || !DIGEST.test(r.skillHash) || !slug(r.context) || !slug(r.route) || !integer(r.startedAt) || !(r.finishedAt === null || integer(r.finishedAt) && r.finishedAt >= r.startedAt) || !OUTCOMES.includes(r.outcome) || !FAILURES.includes(r.failure) || !SOURCES.includes(r.tokenSource) || !(r.tokens === null || integer(r.tokens)) || (r.tokens === null) !== (r.tokenSource === 'unknown') || (r.outcome === 'running') !== (r.finishedAt === null) || (r.outcome === 'success') !== (r.failure === 'none' && r.outcome !== 'running')) fail('invalid-execution-state');
    seen.add(r.id);
  }
  return state;
}

async function saveState(a, state) {
  const bytes = JSON.stringify(state, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 2_097_152 || state.runs.length > 5000) fail('execution-state-full');
  await atomic(path.join(a.state, 'execution-state.json'), bytes);
}

function select(bundle, state, { context, probe = false, routeId, now = Date.now() }) {
  if (!slug(context) || !integer(now)) fail('invalid-request');
  if (routeId !== undefined && (!probe || !slug(routeId))) fail('invalid-request');
  const base = { ok: true, name: bundle.name, skillHash: bundle.hash };
  const fallback = reason => ({ ...base, state: 'fallback', reason });
  if (state.runs.some(r => r.name === bundle.name && ['running', 'unknown'].includes(r.outcome))) return fallback('unresolved-attempt');
  if (!bundle.files['execution.json']) return fallback('markdown-only');
  const manifest = JSON.parse(bundle.files['execution.json']);
  if (manifest.context !== context) return fallback('context-mismatch');
  const ranked = manifest.routes.map(route => {
    const recent = state.runs.filter(r => r.name === bundle.name && r.skillHash === bundle.hash && r.context === context && r.route === route.id && r.startedAt >= now - 30 * DAY).slice(-10);
    const successes = recent.filter(r => r.outcome === 'success').length;
    // ponytail: two recent checks are a pilot gate, not statistical proof; raise after representative live evaluation.
    const eligible = recent.length >= 2 && recent.slice(-2).every(r => r.outcome === 'success');
    const measured = recent.length > 0 && recent.every(r => r.tokenSource === 'measured');
    const cost = measured && successes ? recent.reduce((n, r) => n + r.tokens, 0) / successes : null;
    return { ...route, successes, samples: recent.length, eligible, cost, reliability: recent.length ? successes / recent.length : 0 };
  });
  const candidates = ranked.filter(r => (probe || r.eligible) && (!routeId || r.id === routeId));
  if (!candidates.length) return fallback('validation-needed');
  candidates.sort((a, b) => b.reliability - a.reliability || (a.cost ?? Infinity) - (b.cost ?? Infinity) || a.id.localeCompare(b.id));
  const picked = candidates[0];
  const script = `scripts/${picked.id}.js`;
  return { ...base, state: 'script', route: picked.id, transport: picked.transport, context, probe, samples: picked.samples, successes: picked.successes, measuredTokensPerSuccess: picked.cost, script, scriptHash: hash(bundle.files[script]) };
}

export async function route(options) {
  const a = await account(options.accountRoot, false);
  const bundle = await managedPackage(options);
  const selected = select(bundle, await readState(a), options);
  return { ...selected, skillPath: path.join(a.user, bundle.name, 'SKILL.md'), ...(selected.script ? { scriptPath: path.join(a.user, bundle.name, selected.script) } : {}) };
}

export async function begin(options) {
  if (!UUID.test(options.taskId)) fail('task-id-required');
  return withManagedPackage({ ...options, touch: true }, async (bundle, a) => {
    if (await readRegular(path.join(a.state, 'pending.json'), { optional: true })) fail('recovery-needed');
    const state = await readState(a);
    if (state.runs.filter(r => r.taskId === options.taskId).length >= 2) return { ok: true, state: 'fallback', reason: 'repair-budget-exhausted' };
    const selected = select(bundle, state, options);
    if (selected.state !== 'script') return selected;
    const id = crypto.randomUUID();
    state.runs.push({ id, taskId: options.taskId, name: bundle.name, skillHash: bundle.hash, context: options.context, route: selected.route, startedAt: options.now ?? Date.now(), finishedAt: null, outcome: 'running', failure: 'none', tokens: null, tokenSource: 'unknown' });
    await saveState(a, state);
    return { ...selected, id, taskId: options.taskId, scriptPath: path.join(a.user, bundle.name, selected.script) };
  });
}

export async function record({ accountRoot, receipt, now = Date.now() }) {
  const keys = ['id', 'outcome', 'verified', 'failure', 'tokens', 'tokenSource'];
  if (!exact(receipt, keys) || !UUID.test(receipt.id) || !OUTCOMES.slice(1).includes(receipt.outcome) || typeof receipt.verified !== 'boolean' || (receipt.outcome === 'success') !== receipt.verified || !FAILURES.includes(receipt.failure) || (receipt.outcome === 'success') !== (receipt.failure === 'none') || !SOURCES.includes(receipt.tokenSource) || !(receipt.tokens === null || integer(receipt.tokens)) || (receipt.tokens === null) !== (receipt.tokenSource === 'unknown') || !integer(now)) fail('invalid-execution-receipt');
  const a = await account(accountRoot, true);
  return withLock(a, async () => {
    if (await readRegular(path.join(a.state, 'pending.json'), { optional: true })) fail('recovery-needed');
    const state = await readState(a);
    const run = state.runs.find(r => r.id === receipt.id);
    if (!run || now < run.startedAt) fail('unknown-attempt');
    const values = ['outcome', 'failure', 'tokens', 'tokenSource'];
    if (!['running', 'unknown'].includes(run.outcome)) {
      if (values.every(k => run[k] === receipt[k])) return { ok: true, state: 'recorded', id: run.id, replay: true };
      fail('receipt-conflict');
    }
    for (const key of values) run[key] = receipt[key];
    run.finishedAt = now;
    await saveState(a, state);
    return { ok: true, state: 'recorded', id: run.id, outcome: run.outcome, callerAttested: true };
  });
}

function checkedInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-input');
  let json;
  try { json = JSON.stringify(value); } catch { fail('invalid-input'); }
  if (typeof json !== 'string') fail('invalid-input');
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid-input');
  if (Buffer.byteLength(json) > 16_384) fail('input-too-large');
  return json;
}

export async function run(options, executor = exec) {
  if (typeof options.asideAccount !== 'string' || !/^u[0-9]+$/.test(options.asideAccount)) fail('aside-account-required');
  const input = checkedInput(options.input);
  const started = await begin(options);
  if (started.state !== 'script') return started;
  let bundle;
  try {
    bundle = await managedPackage(options);
    if (bundle.hash !== started.skillHash) fail('manual-drift');
  } catch {
    await record({ accountRoot: options.accountRoot, receipt: { id: started.id, outcome: 'blocked', verified: false, failure: 'package-changed', tokens: null, tokenSource: 'unknown' } });
    return { ok: false, state: 'blocked', id: started.id, failure: 'package-changed', next: 'inspect-package' };
  }
  let outcome = 'unknown', failure = 'script-error';
  try {
    const marker = `OMA_${crypto.randomUUID().replaceAll('-', '')}_`;
    // No shell, no input/output persistence. The existing Aside host owns browser permissions.
    const code = `await (async () => { try { const r = await (async (input) => {\n${bundle.files[started.script]}\n})(${input}); console.log(${JSON.stringify(marker)} + JSON.stringify({verified:r?.verified === true})); } catch { console.log(${JSON.stringify(marker)} + JSON.stringify({verified:false,error:true})); } })();`;
    const result = await executor('aside', ['repl', '--account', options.asideAccount, '--host', 'local', code], { encoding: 'utf8', timeout: 125_000, maxBuffer: 262_144, windowsHide: true });
    const line = result.stdout.split('\n').find(s => s.startsWith(marker));
    if (line) {
      const value = JSON.parse(line.slice(marker.length));
      outcome = value.error ? 'unknown' : value.verified === true ? 'success' : 'failed';
      failure = value.error ? 'script-error' : value.verified === true ? 'none' : 'check-failed';
    }
  } catch (error) {
    failure = error?.killed ? 'timeout' : 'script-error';
  }
  await record({ accountRoot: options.accountRoot, receipt: { id: started.id, outcome, verified: outcome === 'success', failure, tokens: null, tokenSource: 'unknown' } });
  return { ok: outcome === 'success', state: outcome, id: started.id, taskId: started.taskId, name: started.name, route: started.route, failure, tokens: null, next: outcome === 'success' ? 'done' : outcome === 'unknown' ? 'readback-before-retry' : 'markdown-recovery' };
}

export async function main(argv, io = { stdout: process.stdout }) {
  const [command, ...args] = argv;
  const options = {};
  const names = { '--account-root': 'accountRoot', '--name': 'name', '--context': 'context', '--task-id': 'taskId', '--aside-account': 'asideAccount', '--input': 'inputFile', '--receipt': 'receiptFile', '--route-id': 'routeId' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--probe' && options.probe === undefined) { options.probe = true; continue; }
    const key = names[args[i]];
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid-request');
    options[key] = args[++i];
  }
  const allowed = { route: ['accountRoot', 'name', 'context', 'probe', 'routeId'], begin: ['accountRoot', 'name', 'context', 'probe', 'routeId', 'taskId'], run: ['accountRoot', 'name', 'context', 'probe', 'routeId', 'taskId', 'asideAccount', 'inputFile'], record: ['accountRoot', 'receiptFile'] };
  if (!allowed[command] || Object.keys(options).some(k => !allowed[command].includes(k))) fail('invalid-request');
  const jsonFile = async file => { if (!file) fail('invalid-request'); let value; const bytes = await readRegular(file, { maxBytes: 16_384 }); try { value = JSON.parse(bytes); } catch { fail('invalid-request'); } return value; };
  let result;
  if (command === 'record') result = await record({ accountRoot: options.accountRoot, receipt: await jsonFile(options.receiptFile) });
  else if (command === 'run') result = await run({ ...options, input: await jsonFile(options.inputFile) });
  else result = await ({ route, begin })[command](options);
  io.stdout.write(JSON.stringify(result) + '\n');
  return result.ok === false ? 1 : 0;
}
