import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as installer from './install.mjs';
import { main as lifecycle, status as lifecycleStatus } from './lifecycle.mjs';
import { main as retrieval } from './skills.mjs';
import { account, fail } from './safety.mjs';

function rootFrom(argv) {
  const positions = argv.reduce((all, value, index) => value === '--account-root' ? [...all, index] : all, []);
  if (positions.length !== 1 || positions[0] === argv.length - 1 || argv[positions[0] + 1].startsWith('--')) fail('account-root-required');
  return argv[positions[0] + 1];
}
function withoutAccountRoot(argv) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--account-root') { index += 1; continue; }
    output.push(argv[index]);
  }
  return output;
}
function write(io, value) {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}
export function invokedDirectly(meta = import.meta) {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(meta.url));
}

export async function run(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const command = argv[0];
  if (!command || argv.includes('--help')) {
    io.stdout.write('oma install|uninstall|status|doctor|catalog|search|load|learn|backfill|maintain|restore|rollback|pin --account-root DIR\n');
    return 0;
  }
  const root = rootFrom(argv);
  if (['install', 'uninstall', 'status', 'doctor'].includes(command) && withoutAccountRoot(argv).length !== 1) fail('invalid-request');
  if (['catalog', 'search', 'load'].includes(command)) {
    const a = await account(root, false);
    const delegated = [...withoutAccountRoot(argv), '--root', a.user, '--root', path.join(a.skills, 'builtin')];
    return retrieval(delegated, { stdout: io.stdout, stderr: io.stderr });
  }
  if (command === 'status' || command === 'doctor') {
    const installResult = await installer[command]({ accountRoot: root });
    const lifecycleResult = command === 'doctor'
      ? await (await import('./lifecycle.mjs')).doctor({ accountRoot: root })
      : await lifecycleStatus({ accountRoot: root });
    const ok = installResult?.ok !== false && lifecycleResult?.ok !== false;
    write(io, { ok, installer: installResult, lifecycle: lifecycleResult });
    return ok ? 0 : 1;
  }
  if (command === 'install' || command === 'uninstall') {
    const result = await installer[command]({ accountRoot: root });
    write(io, result);
    return result?.ok === false ? 1 : 0;
  }
  return lifecycle(argv, io);
}

if (invokedDirectly()) {
  try { process.exitCode = await run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code ?? 'invalid-request' })}\n`); process.exitCode = 1; }
}
