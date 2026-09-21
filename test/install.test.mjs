import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install, uninstall, status } from '../skill/scripts/install.mjs';

const tempBase = process.env.OMA_TEST_TMP || os.tmpdir();
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tempBase, 'oma-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return fs.realpath(root);
}
async function source(t, label = 'one') {
  const root = path.join(await fixture(t), 'skill');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'SKILL.md'), `# ${label}\n`);
  await fs.writeFile(path.join(root, 'scripts', 'oma.mjs'), `export default '${label}';\n`);
  return root;
}
async function installed(t, label = 'one') {
  const root = await fixture(t);
  const src = await source(t, label);
  await install({ accountRoot: root, sourceRoot: src });
  return { root, src, dest: path.join(root, 'skills', 'user', 'oh-my-aside') };
}
const rejects = (fn, code) => assert.rejects(fn, (error) => error?.code === code);
const markerCount = (body) => (body.match(/<!-- oh-my-aside:start -->/g) || []).length;

test('install is idempotent and preserves existing AGENTS and builtin user skill', async (t) => {
  const root = await fixture(t); const src = await source(t);
  await fs.mkdir(path.join(root, 'skills', 'user', 'mine'), { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'keep this\n');
  await fs.writeFile(path.join(root, 'skills', 'user', 'mine', 'SKILL.md'), 'mine');
  await install({ accountRoot: root, sourceRoot: src });
  const second = await install({ accountRoot: root, sourceRoot: src });
  assert.equal(second.state, 'unchanged');
  assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /keep this/);
  assert.equal(await fs.readFile(path.join(root, 'skills', 'user', 'mine', 'SKILL.md'), 'utf8'), 'mine');
});

test('install copies the distribution scripts into the installed package', async (t) => {
  const { dest } = await installed(t);
  assert.equal(await fs.readFile(path.join(dest, 'scripts', 'oma.mjs'), 'utf8'), "export default 'one';\n");
});

test('source inside the installed package stages before replacement', async (t) => {
  const { root, dest } = await installed(t);
  const result = await install({ accountRoot: root, sourceRoot: dest });
  assert.equal(result.state, 'unchanged');
  assert.ok(await fs.stat(path.join(dest, 'SKILL.md')));
});

test('upgrade keeps one marker, remains healthy, and uninstalls', async (t) => {
  const { root } = await installed(t, 'old'); const newer = await source(t, 'new');
  assert.equal((await install({ accountRoot: root, sourceRoot: newer })).state, 'upgraded');
  const agents = path.join(root, 'AGENTS.md');
  assert.equal(markerCount(await fs.readFile(agents, 'utf8')), 1);
  assert.deepEqual(await status({ accountRoot: root }), { ok: true, installed: true, version: 2 });
  assert.equal((await uninstall({ accountRoot: root })).state, 'uninstalled');
});

test('clean uninstall reports false status, is repeatable, and permits reinstall', async (t) => {
  const { root, src, dest } = await installed(t);
  assert.equal((await uninstall({ accountRoot: root, sourceRoot: src })).state, 'uninstalled');
  assert.deepEqual(await status({ accountRoot: root }), { ok: true, installed: false });
  assert.deepEqual(await uninstall({ accountRoot: root }), { ok: true, state: 'not-installed', changed: false });
  await install({ accountRoot: root, sourceRoot: src });
  assert.ok(await fs.stat(path.join(dest, 'SKILL.md')));
});

test('fresh status is read-only and uninstall reports not-installed', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await status({ accountRoot: root }), { ok: true, installed: false });
  await assert.rejects(fs.lstat(path.join(root, '.oh-my-aside')), { code: 'ENOENT' });
  assert.deepEqual(await uninstall({ accountRoot: root }), { ok: true, state: 'not-installed', changed: false });
});

test('edited owned payload refuses uninstall and preserves the file', async (t) => {
  const { root, dest } = await installed(t);
  const file = path.join(dest, 'SKILL.md'); await fs.appendFile(file, 'edited');
  await rejects(() => uninstall({ accountRoot: root }), 'owned-file-modified');
  assert.match(await fs.readFile(file, 'utf8'), /edited/);
});

test('extra user payload file refuses uninstall and preserves it', async (t) => {
  const { root, dest } = await installed(t);
  const extra = path.join(dest, 'note.txt'); await fs.writeFile(extra, 'user');
  await rejects(() => uninstall({ accountRoot: root }), 'unowned-file-conflict');
  assert.equal(await fs.readFile(extra, 'utf8'), 'user');
});

test('empty user payload directory refuses uninstall and preserves it', async (t) => {
  const { root, dest } = await installed(t);
  const extra = path.join(dest, 'user-empty'); await fs.mkdir(extra);
  await rejects(() => uninstall({ accountRoot: root }), 'unowned-file-conflict');
  assert.ok((await fs.stat(extra)).isDirectory());
});

test('edited marker is retained without wholesale AGENTS reset', async (t) => {
  const { root } = await installed(t);
  const agents = path.join(root, 'AGENTS.md');
  await fs.appendFile(agents, 'unrelated note\n');
  let body = await fs.readFile(agents, 'utf8'); body = body.replace('verified, redacted', 'user-edited'); await fs.writeFile(agents, body);
  const result = await uninstall({ accountRoot: root });
  assert.equal(result.retainedMarker, true);
  body = await fs.readFile(agents, 'utf8');
  assert.match(body, /user-edited/); assert.match(body, /unrelated note/);
});

test('preexisting unowned package is refused with migration-safe conflict', async (t) => {
  const root = await fixture(t); const src = await source(t);
  await fs.mkdir(path.join(root, 'skills', 'user', 'oh-my-aside'), { recursive: true });
  await rejects(() => install({ accountRoot: root, sourceRoot: src }), 'unowned-file-conflict');
  await rejects(() => uninstall({ accountRoot: root }), 'unowned-file-conflict');
});

test('upgrade refuses a new source file colliding with a preexisting user file', async (t) => {
  const { root, dest } = await installed(t, 'old'); const newer = await source(t, 'new');
  await fs.writeFile(path.join(newer, 'userfile.txt'), 'new owned file\n');
  const userFile = path.join(dest, 'userfile.txt'); await fs.writeFile(userFile, 'user data\n');
  await rejects(() => install({ accountRoot: root, sourceRoot: newer }), 'unowned-file-conflict');
  assert.equal(await fs.readFile(userFile, 'utf8'), 'user data\n');
});

test('destination root symlink is rejected', async (t) => {
  const root = await fixture(t); const src = await source(t); const outside = await fixture(t);
  await fs.mkdir(path.join(root, 'skills', 'user'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'skills', 'user', 'oh-my-aside'));
  await rejects(() => install({ accountRoot: root, sourceRoot: src }), 'unsafe-path');
});

test('nested source scripts symlink is rejected even when its target is regular', async (t) => {
  const root = await fixture(t); const src = await source(t); const target = path.join(src, 'SKILL.md');
  await fs.symlink(target, path.join(src, 'scripts', 'linked.mjs'));
  await rejects(() => install({ accountRoot: root, sourceRoot: src }), 'unsafe-path');
});

test('nested destination scripts symlink refuses uninstall', async (t) => {
  const { root, dest } = await installed(t);
  const scripts = path.join(dest, 'scripts'); const moved = path.join(root, 'moved-scripts');
  await fs.rename(scripts, moved); await fs.symlink(moved, scripts);
  await rejects(() => uninstall({ accountRoot: root }), 'unsafe-path');
  assert.ok((await fs.lstat(scripts)).isSymbolicLink());
});

test('manifest traversal is rejected before uninstall mutation', async (t) => {
  const { root, dest } = await installed(t); const manifest = path.join(root, '.oh-my-aside', 'install.json');
  const value = JSON.parse(await fs.readFile(manifest, 'utf8')); value.files = { '../outside': '0'.repeat(64) };
  await fs.writeFile(manifest, JSON.stringify(value));
  await rejects(() => uninstall({ accountRoot: root }), 'manifest-invalid');
  assert.ok(await fs.stat(path.join(dest, 'SKILL.md')));
});

test('manifest symlink is rejected', async (t) => {
  const { root } = await installed(t); const manifest = path.join(root, '.oh-my-aside', 'install.json'); const target = path.join(root, 'target.json');
  await fs.rename(manifest, target); await fs.symlink(target, manifest);
  await rejects(() => uninstall({ accountRoot: root }), 'unsafe-path');
});

test('AGENTS symlink is rejected without touching its target', async (t) => {
  const root = await fixture(t); const src = await source(t); const target = path.join(root, 'target-agents');
  await fs.writeFile(target, 'target'); await fs.symlink(target, path.join(root, 'AGENTS.md'));
  await rejects(() => install({ accountRoot: root, sourceRoot: src }), 'unsafe-path');
  assert.equal(await fs.readFile(target, 'utf8'), 'target');
});

test('unreadable AGENTS fails when this platform enforces EACCES', async (t) => {
  const root = await fixture(t); const src = await source(t); const agents = path.join(root, 'AGENTS.md');
  await fs.writeFile(agents, 'protected'); await fs.chmod(agents, 0o000);
  t.after(() => fs.chmod(agents, 0o600).catch(() => {}));
  try {
    await fs.readFile(agents);
  } catch (error) {
    if (error?.code === 'EACCES') { await assert.rejects(() => install({ accountRoot: root, sourceRoot: src }), (e) => e?.code === 'EACCES'); return; }
  }
  t.skip('platform user can read mode 000 files');
});

test('unavailable private backup blocks upgrade before payload or AGENTS mutation', async (t) => {
  const { root, src, dest } = await installed(t, 'old'); const newer = await source(t, 'new');
  const backups = path.join(root, '.oh-my-aside', 'backups');
  await fs.rename(backups, path.join(root, 'fixture-backups'));
  await fs.writeFile(backups, 'not a directory');
  const beforeAgents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
  await rejects(() => install({ accountRoot: root, sourceRoot: newer }), 'unsafe-path');
  assert.equal(await fs.readFile(path.join(dest, 'scripts', 'oma.mjs'), 'utf8'), "export default 'old';\n");
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), beforeAgents);
});

test('failed first old-payload rename restores healthy old installation and clears pending', async (t) => {
  const { root, dest } = await installed(t, 'old'); const newer = await source(t, 'new');
  const agents = path.join(root, 'AGENTS.md'); const beforeAgents = await fs.readFile(agents, 'utf8');
  const realRename = fs.rename;
  let rejected = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!rejected && from === dest && path.basename(to) === 'payload') {
      rejected = true;
      const error = new Error('permission denied'); error.code = 'EACCES'; throw error;
    }
    return realRename(from, to);
  });
  t.after(() => t.mock.restoreAll());
  await assert.rejects(() => install({ accountRoot: root, sourceRoot: newer }), (error) => error?.code === 'EACCES');
  assert.equal(await fs.readFile(path.join(dest, 'scripts', 'oma.mjs'), 'utf8'), "export default 'old';\n");
  assert.equal(await fs.readFile(agents, 'utf8'), beforeAgents);
  assert.deepEqual(await status({ accountRoot: root }), { ok: true, installed: true, version: 2 });
  await assert.rejects(fs.lstat(path.join(root, '.oh-my-aside', 'pending.json')), { code: 'ENOENT' });
});
