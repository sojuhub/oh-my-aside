import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCatalog, loadSkill, searchCatalog } from '../skill/scripts/skills.mjs';

async function fixture(t) {
  const base = process.env.OMA_TEST_TMP || os.tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'oma-test-'));
  t.after(async () => {
    if (path.basename(root).startsWith('oma-test-')) await rm(root, { recursive: true, force: true });
  });
  return root;
}

function skillDocument(name, description, body = 'body') {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
}

async function writeSkill(root, relative, name, description, body = 'body') {
  const file = path.join(root, relative, 'SKILL.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, skillDocument(name, description, body));
  return file;
}

test('discovers Korean metadata without leaking a body', async t => {
  const root = await fixture(t);
  await writeSkill(root, 'automation', 'korean-helper', '한국 업무 자동화', 'private body must not appear');
  const catalog = await buildCatalog({ roots: [root] });
  const row = catalog.items.find(item => item.name === 'korean-helper');
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), ['description', 'name', 'path', 'sha256']);
  assert.equal(JSON.stringify(row).includes('private body'), false);
  assert.ok(searchCatalog(catalog, '한국 자동화').items.some(item => item.name === 'korean-helper'));
});

test('a current inventory revision changes after an edit without restart', async t => {
  const root = await fixture(t);
  const file = await writeSkill(root, 'one', 'revision-skill', 'revision check', 'first');
  const first = await buildCatalog({ roots: [root] });
  const oldHash = first.items[0].sha256;
  await writeFile(file, skillDocument('revision-skill', 'revision check', 'second'));
  await writeSkill(root, 'two', 'new-search-skill', 'discoverable task category');
  const second = await buildCatalog({ roots: [root] });
  assert.notEqual(first.revision, second.revision);
  assert.ok(searchCatalog(second, 'task category').items.some(item => item.name === 'new-search-skill'));
  await assert.rejects(
    loadSkill({ roots: [root], name: 'revision-skill', expectedHash: oldHash }),
    error => error.code === 'expected_hash_mismatch'
  );
});

test('duplicate names refuse name load while exact catalog paths work', async t => {
  const root = await fixture(t);
  await writeSkill(root, 'one', 'duplicate', 'first duplicate', 'first body');
  await writeSkill(root, 'two', 'duplicate', 'second duplicate', 'second body');
  const catalog = await buildCatalog({ roots: [root] });
  await assert.rejects(loadSkill({ roots: [root], name: 'duplicate' }), error => error.code === 'ambiguous_skill_name');
  const loaded = await loadSkill({ roots: [root], path: catalog.items[0].path });
  assert.equal(loaded.receipt.stage, 'loaded');
  assert.ok(loaded.body.includes('body'));
});

test('guarded load rejects a mismatched hash and returns a successful receipt', async t => {
  const root = await fixture(t);
  await writeSkill(root, 'hash', 'hash-skill', 'hash check', 'loaded instructions');
  const catalog = await buildCatalog({ roots: [root] });
  const item = catalog.items[0];
  await assert.rejects(
    loadSkill({ roots: [root], name: 'hash-skill', expectedHash: '0'.repeat(64) }),
    error => error.code === 'expected_hash_mismatch'
  );
  const loaded = await loadSkill({ roots: [root], name: 'hash-skill', expectedHash: item.sha256 });
  assert.deepEqual(loaded.receipt, {
    stage: 'loaded',
    name: 'hash-skill',
    hash: item.sha256,
    path: item.path,
    revision: catalog.revision
  });
});

test('excludes archives and reports invalid, missing, and duplicate metadata', async t => {
  const root = await fixture(t);
  await writeSkill(root, 'archives/old', 'archived-skill', 'must be skipped');
  await writeSkill(root, 'scripts/ignored', 'script-skill', 'must be skipped');
  await mkdir(path.join(root, 'invalid'), { recursive: true });
  await writeFile(path.join(root, 'invalid', 'SKILL.md'), 'not frontmatter\nsecret body\n');
  await mkdir(path.join(root, 'missing'), { recursive: true });
  await writeFile(path.join(root, 'missing', 'SKILL.md'), `---\nname: ${JSON.stringify('missing-description')}\n---\n`);
  await mkdir(path.join(root, 'duplicate'), { recursive: true });
  await writeFile(path.join(root, 'duplicate', 'SKILL.md'), `---\nname: ${JSON.stringify('twice')}\nname: ${JSON.stringify('again')}\ndescription: ${JSON.stringify('duplicate field')}\n---\n`);

  const catalog = await buildCatalog({ roots: [root] });
  assert.equal(catalog.items.some(item => item.name === 'archived-skill' || item.name === 'script-skill'), false);
  const reasons = new Set(catalog.diagnostics.map(item => item.reason));
  assert.ok(reasons.has('missing_frontmatter'));
  assert.ok(reasons.has('missing_description'));
  assert.ok(reasons.has('duplicate_name'));
});

test('follows intended symlinked originals once and stops cycles', async t => {
  const parent = await fixture(t);
  const root = path.join(parent, 'library');
  const outside = path.join(parent, 'linked-original');
  await mkdir(root, { recursive: true });
  const original = await writeSkill(outside, 'skill', 'linked-skill', 'linked original');
  await symlink(outside, path.join(root, 'link-one'), 'dir');
  await symlink(outside, path.join(root, 'link-two'), 'dir');
  await symlink(root, path.join(outside, 'back-to-library'), 'dir');
  await writeSkill(root, 'archives/old', 'archived-alias', 'must stay excluded');
  await symlink(path.join(root, 'archives'), path.join(root, 'archive-alias'), 'dir');

  const catalog = await buildCatalog({ roots: [root] });
  const paths = catalog.items.map(item => item.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes(await realpath(original)));
  assert.equal(catalog.items.some(item => item.name === 'archived-alias'), false);
});

test('pre-registers roots and protects linked originals from archive aliases', async t => {
  const parent = await fixture(t);
  const rootA = path.join(parent, 'root-a');
  const rootB = path.join(parent, 'root-b');
  const external = path.join(parent, 'external-original');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeSkill(rootB, 'archives/old', 'second-root-archive', 'must stay excluded');
  await writeSkill(external, 'archives/old', 'external-archive', 'must stay excluded');
  const ordinary = await writeSkill(external, 'ordinary', 'external-ordinary', 'intended linked skill');
  await symlink(path.join(rootB, 'archives'), path.join(rootA, 'root-b-archive-alias'), 'dir');
  await symlink(external, path.join(rootA, 'external-original'), 'dir');
  await symlink(path.join(external, 'archives'), path.join(external, 'archive-alias'), 'dir');

  const catalog = await buildCatalog({ roots: [rootA, rootB] });
  assert.equal(catalog.items.some(item => item.name === 'second-root-archive' || item.name === 'external-archive'), false);
  const ordinaryCanonical = await realpath(ordinary);
  assert.ok(catalog.items.some(item => item.name === 'external-ordinary' && item.path === ordinaryCanonical));
});

test('parses top-level metadata while ignoring nested fields and supports folded descriptions', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'nested', 'SKILL.md'), `---
name: "nested-skill"
description: >-
  first line

  second line
autoInject:
  keywords: [workflow]
  metadata:
    name: ignored-name
settingsGate:
  description: ignored-description
siteSpecific:
  name: ignored-again
---
body
`);
  const catalog = await buildCatalog({ roots: [root] });
  assert.deepEqual(catalog.items.map(item => [item.name, item.description]), [['nested-skill', 'first line\n\nsecond line']]);
});

test('rejects malformed quotes and overlong metadata without cataloging bodies', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'broken'), { recursive: true });
  await writeFile(path.join(root, 'broken', 'SKILL.md'), '---\nname: "broken\ndescription: "valid"\n---\nprivate body\n');
  await writeSkill(root, 'long', 'x'.repeat(257), 'valid description', 'private body');
  const catalog = await buildCatalog({ roots: [root] });
  assert.deepEqual(catalog.items, []);
  assert.ok(catalog.diagnostics.some(item => item.reason === 'invalid_name'));
  assert.ok(catalog.diagnostics.some(item => item.reason === 'name_too_long'));
});

test('no match gives lexical fallback guidance', async t => {
  const root = await fixture(t);
  await writeSkill(root, 'known', 'known-skill', 'known workflow');
  const catalog = await buildCatalog({ roots: [root] });
  const result = searchCatalog(catalog, '없는검색어');
  assert.deepEqual(result.items, []);
  assert.match(result.guidance, /not semantic/);
});
