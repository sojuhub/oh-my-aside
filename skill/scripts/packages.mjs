import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, hash, readRegular } from './safety.mjs';

const MAX_FILE = 2_097_152;
const MAX_CODE = 16_384;
const MAX_ROUTES = 3;
const DANGER = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|\b(?:gh[pousr]_|sk-)[A-Za-z0-9_-]{8,}|\b(?:authorization|x-api-key)\s*:\s*\S+|\bbearer\s+[A-Za-z0-9._~-]{8,}|\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+|\/(?:Users|home)\/[^/]+\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:bypass|disable|skip)\s+(?:permission|auth|authentication|mfa|captcha|passkey)/i;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function slug(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
function packageFile(value) {
  return value === 'SKILL.md' || value === 'execution.json' || (typeof value === 'string' && /^scripts\/[a-z0-9]+(?:-[a-z0-9]+)*\.js$/.test(value));
}
function executionMetadata(execution) {
  return {
    schemaVersion: execution.schemaVersion,
    context: execution.context,
    effect: execution.effect,
    routes: execution.routes.map(({ id, transport }) => ({ id, transport })),
  };
}
function compile(code) {
  try { return new AsyncFunction('input', code); } catch { fail('invalid-execution'); }
}

export function validateExecution(value) {
  if (!exact(value, ['schemaVersion', 'context', 'effect', 'routes']) || value.schemaVersion !== 1 || !slug(value.context) || value.effect !== 'read-only' || !Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > MAX_ROUTES) fail('invalid-execution');
  const ids = new Set();
  for (const route of value.routes) {
    if (!exact(route, ['id', 'transport', 'code']) || !slug(route.id) || ids.has(route.id) || route.transport !== 'aside-repl' || !text(route.code, MAX_CODE) || Buffer.byteLength(route.code) > MAX_CODE) fail('invalid-execution');
    if (DANGER.test(route.code)) fail('unsafe-execution');
    compile(route.code);
    ids.add(route.id);
  }
  return value;
}

export function executionFiles(value) {
  validateExecution(value);
  const files = { 'execution.json': `${JSON.stringify(executionMetadata(value), null, 2)}\n` };
  for (const route of value.routes) files[`scripts/${route.id}.js`] = route.code;
  return files;
}

export function packageHash(files) {
  if (!plain(files) || !Object.keys(files).length || !Object.entries(files).every(([file, value]) => packageFile(file) && typeof value === 'string')) fail('invalid-package');
  if (Object.keys(files).length === 1 && Object.hasOwn(files, 'SKILL.md')) return hash(files['SKILL.md']);
  const bytes = Object.keys(files).sort().map((file) => `${file}\u0000${files[file]}\u0000`).join('');
  return hash(bytes);
}

export function validatePackageFiles(files) {
  if (!plain(files) || !Object.hasOwn(files, 'SKILL.md') || !Object.entries(files).every(([file, value]) => packageFile(file) && typeof value === 'string')) fail('invalid-package');
  if (Buffer.byteLength(files['SKILL.md']) > MAX_FILE || Object.hasOwn(files, 'execution.json') && Buffer.byteLength(files['execution.json']) > MAX_FILE) fail('input-too-large');
  const scripts = Object.keys(files).filter((file) => file.startsWith('scripts/'));
  if (scripts.length > MAX_ROUTES) fail('invalid-execution');
  if (!Object.hasOwn(files, 'execution.json')) {
    if (scripts.length) fail('invalid-execution');
    return files;
  }
  let metadata;
  try { metadata = JSON.parse(files['execution.json']); } catch { fail('invalid-execution'); }
  if (!exact(metadata, ['schemaVersion', 'context', 'effect', 'routes']) || metadata.schemaVersion !== 1 || !slug(metadata.context) || metadata.effect !== 'read-only' || !Array.isArray(metadata.routes) || metadata.routes.length === 0 || metadata.routes.length > MAX_ROUTES) fail('invalid-execution');
  const routes = [];
  const expected = new Set(['execution.json']);
  for (const route of metadata.routes) {
    if (!exact(route, ['id', 'transport']) || !slug(route.id) || route.transport !== 'aside-repl') fail('invalid-execution');
    const file = `scripts/${route.id}.js`;
    if (expected.has(file) || !Object.hasOwn(files, file) || Buffer.byteLength(files[file]) > MAX_CODE) fail('invalid-execution');
    routes.push({ id: route.id, transport: route.transport, code: files[file] }); expected.add(file);
  }
  if (scripts.some((file) => !expected.has(file))) fail('invalid-execution');
  validateExecution({ ...metadata, routes });
  return files;
}

async function safeDir(directory, code = 'unsafe-path') {
  let stat;
  try { stat = await fs.lstat(directory); } catch (error) { if (error?.code === 'ENOENT') fail(code); throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(code);
}

async function readFile(file, max = MAX_FILE) {
  return (await readRegular(file, { maxBytes: max })).toString('utf8');
}

export async function readPackage(directory) {
  await safeDir(directory);
  const files = {};
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'SKILL.md' || entry.name === 'execution.json') {
      if (!entry.isFile()) fail('unsafe-path');
      files[entry.name] = await readFile(path.join(directory, entry.name));
      continue;
    }
    if (entry.name !== 'scripts') fail('invalid-package');
    if (!entry.isDirectory()) fail('unsafe-path');
    const scripts = await fs.readdir(path.join(directory, 'scripts'), { withFileTypes: true });
    if (scripts.length === 0 || scripts.length > MAX_ROUTES) fail('invalid-package');
    for (const script of scripts) {
      if (!script.isFile() || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.js$/.test(script.name)) fail('invalid-package');
      files[`scripts/${script.name}`] = await readFile(path.join(directory, 'scripts', script.name), MAX_CODE);
    }
  }
  return validatePackageFiles(files);
}
