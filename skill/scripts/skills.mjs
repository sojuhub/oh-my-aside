import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000;
const MAX_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_DIAGNOSTICS = 100;
const MAX_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4096;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const EXCLUDED_DIRS = new Set([
  'node_modules', 'archive', 'archives', 'backup', 'backups',
  'scripts', 'references', 'assets', 'tests'
]);

export class OmaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const digest = value => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => (left === right ? 0 : left < right ? -1 : 1);
const normalize = value => String(value).normalize('NFKC').toLowerCase();
const tokens = value => normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];

export function defaultRoots() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const skillsDir = path.resolve(moduleDir, '..', '..', '..');
  return [path.join(skillsDir, 'user'), path.join(skillsDir, 'builtin')];
}

function addDiagnostic(state, filePath, reason) {
  if (state.diagnostics.length < MAX_DIAGNOSTICS) {
    state.diagnostics.push({ path: filePath, reason });
  }
}

function excluded(name) {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name.toLowerCase());
}

function excludedWithinRoot(target, state) {
  return [...state.roots].some(root => {
    const relative = path.relative(root, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep).some(excluded);
  });
}

function parseScalar(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"') || value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (!(value.startsWith("'") && value.endsWith("'"))) return null;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(?:[\[{]|[-?:](?:\s|$)|[!&*|>@`])/.test(value)) return null;
  return value;
}

function parseFrontmatter(text) {
  const sample = text.replace(/^\uFEFF/, '').slice(0, MAX_HEADER_BYTES);
  const lines = sample.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { ok: false, reason: 'missing_frontmatter' };

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---' || lines[index].trim() === '...') {
      end = index;
      break;
    }
  }
  if (end < 0) return { ok: false, reason: 'unterminated_frontmatter' };

  const fields = new Map();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line) || /^[ \t]/.test(line)) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(line);
    if (!match) return { ok: false, reason: 'unsupported_frontmatter' };

    const [, key, supplied = ''] = match;
    if (key !== 'name' && key !== 'description') continue;
    if (fields.has(key)) return { ok: false, reason: `duplicate_${key}` };

    let value;
    if (key === 'description' && /^[>|][+-]?$/.test(supplied)) {
      const pieces = [];
      while (index + 1 < end) {
        const next = lines[index + 1];
        if (/^[ \t]+/.test(next)) pieces.push(lines[++index].replace(/^[ \t]+/, ''));
        else if (!next.trim() && /^[ \t]+/.test(lines[index + 2] ?? '')) {
          pieces.push('');
          index += 1;
        } else break;
      }
      if (!pieces.some(Boolean)) return { ok: false, reason: 'invalid_description' };
      value = supplied.startsWith('|')
        ? pieces.join('\n').trim()
        : pieces.join('\n').split(/\n{2,}/).map(part => part.replace(/\s+/g, ' ').trim()).join('\n\n').trim();
    } else {
      value = parseScalar(supplied);
    }
    if (!value) return { ok: false, reason: `invalid_${key}` };
    if (value.length > (key === 'name' ? MAX_NAME_LENGTH : MAX_DESCRIPTION_LENGTH)) {
      return { ok: false, reason: `${key}_too_long` };
    }
    fields.set(key, value);
  }

  if (!fields.has('name')) return { ok: false, reason: 'missing_name' };
  if (!fields.has('description')) return { ok: false, reason: 'missing_description' };
  return { ok: true, name: fields.get('name'), description: fields.get('description') };
}

async function inspectSkill(filePath, state) {
  let canonical;
  try {
    canonical = await realpath(filePath);
    if (state.seenFiles.has(canonical)) return;
    state.seenFiles.add(canonical);

    const info = await stat(canonical);
    if (info.size > MAX_BYTES) {
      addDiagnostic(state, canonical, 'content_too_large');
      return;
    }
    const bytes = await readFile(canonical);
    if (bytes.byteLength > MAX_BYTES) {
      addDiagnostic(state, canonical, 'content_too_large');
      return;
    }
    const sha256 = digest(bytes);
    state.fileHashes.push(`${canonical}\0${sha256}`);

    const parsed = parseFrontmatter(bytes.toString('utf8'));
    if (!parsed.ok) {
      addDiagnostic(state, canonical, parsed.reason);
      return;
    }
    state.items.push({ name: parsed.name, description: parsed.description, path: canonical, sha256 });
  } catch {
    addDiagnostic(state, canonical ?? path.resolve(filePath), 'unreadable_skill');
  }
}

async function visit(directory, depth, state) {
  if (depth > MAX_DEPTH) {
    addDiagnostic(state, directory, 'depth_limit');
    return;
  }

  let canonical;
  let entries;
  try {
    canonical = await realpath(directory);
    if (state.seenDirs.has(canonical)) return;
    state.seenDirs.add(canonical);
    state.roots.add(canonical);
    entries = await readdir(canonical, { withFileTypes: true });
  } catch {
    addDiagnostic(state, path.resolve(directory), 'unreadable_directory');
    return;
  }

  entries.sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    state.entries += 1;
    if (state.entries > MAX_ENTRIES) {
      addDiagnostic(state, canonical, 'entry_limit');
      return;
    }
    if (excluded(entry.name)) continue;

    const candidate = path.join(canonical, entry.name);
    if (entry.isDirectory()) {
      await visit(candidate, depth + 1, state);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      await inspectSkill(candidate, state);
    } else if (entry.isSymbolicLink()) {
      try {
        const target = await realpath(candidate);
        if (excludedWithinRoot(target, state)) continue;
        const targetInfo = await stat(target);
        if (targetInfo.isDirectory()) await visit(target, depth + 1, state);
        else if (targetInfo.isFile() && entry.name === 'SKILL.md') await inspectSkill(target, state);
      } catch {
        addDiagnostic(state, candidate, 'unreadable_symlink');
      }
    }
  }
}

async function registerRoot(root, state) {
  try {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) {
      addDiagnostic(state, path.resolve(root), 'root_not_directory');
      return;
    }
    state.roots.add(canonical);
    return canonical;
  } catch {
    addDiagnostic(state, path.resolve(root), 'unreadable_root');
  }
}

export async function buildCatalog({ roots = defaultRoots() } = {}) {
  if (!Array.isArray(roots)) throw new OmaError('invalid_roots', 'roots must be an array');
  const state = {
    entries: 0,
    seenDirs: new Set(),
    seenFiles: new Set(),
    roots: new Set(),
    fileHashes: [],
    items: [],
    diagnostics: []
  };

  const registeredRoots = [];
  for (const root of roots) {
    if (typeof root === 'string' && root) {
      const canonical = await registerRoot(root, state);
      if (canonical) registeredRoots.push(canonical);
    } else addDiagnostic(state, String(root), 'invalid_root');
  }
  for (const root of registeredRoots) await visit(root, 0, state);

  state.items.sort((left, right) => compare(left.name, right.name) || compare(left.path, right.path));
  state.diagnostics.sort((left, right) => compare(left.path, right.path) || compare(left.reason, right.reason));
  state.fileHashes.sort(compare);
  return {
    revision: digest(state.fileHashes.join('\n')),
    items: state.items,
    diagnostics: state.diagnostics
  };
}

export function searchCatalog(catalog, query) {
  const normalizedQuery = normalize(query).trim();
  const queryTokens = tokens(normalizedQuery);
  if (!normalizedQuery || !queryTokens.length) {
    throw new OmaError('invalid_query', 'query must contain lexical text');
  }

  const matches = [];
  for (const item of catalog.items) {
    const name = normalize(item.name);
    const description = normalize(item.description);
    const haystack = `${name}\n${description}`;
    if (!(haystack.includes(normalizedQuery) || queryTokens.every(token => haystack.includes(token)))) continue;

    let score = 0;
    if (name === normalizedQuery) score += 100;
    if (name.includes(normalizedQuery)) score += 50;
    if (description.includes(normalizedQuery)) score += 20;
    for (const token of queryTokens) {
      if (name.includes(token)) score += 10;
      if (description.includes(token)) score += 4;
    }
    matches.push({ item, score });
  }

  matches.sort((left, right) => right.score - left.score || compare(left.item.name, right.item.name) || compare(left.item.path, right.item.path));
  return {
    items: matches.map(match => match.item),
    guidance: matches.length ? undefined : 'No lexical match. Try different task terms or page catalog metadata; search is not semantic.'
  };
}

export async function searchSkills({ roots = defaultRoots(), query } = {}) {
  const catalog = await buildCatalog({ roots });
  return { ...catalog, ...searchCatalog(catalog, query) };
}

export async function loadSkill({ roots = defaultRoots(), name, path: requestedPath, expectedHash } = {}) {
  if (Boolean(name) === Boolean(requestedPath)) {
    throw new OmaError('load_selector_required', 'provide exactly one of name or path');
  }
  if (expectedHash && !/^[a-fA-F0-9]{64}$/.test(expectedHash)) {
    throw new OmaError('invalid_expected_hash', 'expected hash must be a SHA-256 hex value');
  }

  const catalog = await buildCatalog({ roots });
  const matches = name
    ? catalog.items.filter(item => item.name === name)
    : catalog.items.filter(item => item.path === path.resolve(requestedPath));
  if (!matches.length) throw new OmaError('skill_not_found', 'selected skill is not in the current catalog');
  if (matches.length !== 1) throw new OmaError('ambiguous_skill_name', 'name is not unique; load by exact catalog path');

  const item = matches[0];
  if (expectedHash && item.sha256 !== expectedHash.toLowerCase()) {
    throw new OmaError('expected_hash_mismatch', 'current catalog hash does not match expected hash');
  }

  let bytes;
  try {
    const info = await stat(item.path);
    if (info.size > MAX_BYTES) throw new OmaError('content_too_large', 'skill content exceeds load limit');
    bytes = await readFile(item.path);
    if (bytes.byteLength > MAX_BYTES) throw new OmaError('content_too_large', 'skill content exceeds load limit');
  } catch (error) {
    if (error instanceof OmaError) throw error;
    throw new OmaError('unreadable_skill', 'selected skill could not be read');
  }

  const actualHash = digest(bytes);
  if (actualHash !== item.sha256) {
    throw new OmaError('content_changed', 'skill changed during guarded load; catalog again before use');
  }
  return {
    body: bytes.toString('utf8'),
    receipt: { stage: 'loaded', name: item.name, hash: actualHash, path: item.path, revision: catalog.revision }
  };
}

function usage() {
  return 'Usage: skills.mjs catalog|search --query TEXT|load (--name NAME|--path PATH) [--root DIR] [--expected-hash HEX] [--limit N] [--offset N]';
}

function valueFor(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new OmaError('missing_option_value', `missing value for ${flag}`);
  return value;
}

function integer(value, flag, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new OmaError('invalid_option_value', `${flag} is outside its allowed range`);
  }
  return parsed;
}

export function parseCli(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!['catalog', 'search', 'load'].includes(command)) throw new OmaError('unknown_command', usage());

  const options = { command, roots: [], limit: DEFAULT_LIMIT, offset: 0 };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--root') options.roots.push(valueFor(args, flag));
    else if (flag === '--query') options.query = valueFor(args, flag);
    else if (flag === '--name') options.name = valueFor(args, flag);
    else if (flag === '--path') options.path = valueFor(args, flag);
    else if (flag === '--expected-hash') options.expectedHash = valueFor(args, flag);
    else if (flag === '--limit') options.limit = integer(valueFor(args, flag), flag, 1, MAX_LIMIT);
    else if (flag === '--offset') options.offset = integer(valueFor(args, flag), flag, 0, Number.MAX_SAFE_INTEGER);
    else throw new OmaError('unknown_option', `unknown option: ${flag}`);
  }

  if (command === 'search' && !options.query) throw new OmaError('query_required', 'search requires --query TEXT');
  if (command === 'load' && Boolean(options.name) === Boolean(options.path)) {
    throw new OmaError('load_selector_required', 'load requires exactly one of --name or --path');
  }
  return options;
}

function page(items, offset, limit) {
  return items.slice(offset, offset + limit);
}

function writeEnvelope(stream, envelope) {
  stream.write(`${JSON.stringify(envelope)}\n`);
}

export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const options = parseCli(argv);
    if (options.help) {
      writeEnvelope(io.stdout, { ok: true, stage: 'help', usage: usage() });
      return 0;
    }

    const roots = options.roots.length ? options.roots : defaultRoots();
    if (options.command === 'load') {
      const loaded = await loadSkill({ roots, name: options.name, path: options.path, expectedHash: options.expectedHash });
      writeEnvelope(io.stdout, { ok: true, stage: 'loaded', ...loaded });
      return 0;
    }

    const catalog = await buildCatalog({ roots });
    const search = options.command === 'search' ? searchCatalog(catalog, options.query) : null;
    const items = search ? search.items : catalog.items;
    writeEnvelope(io.stdout, {
      ok: true,
      stage: search ? 'searched' : 'cataloged',
      revision: catalog.revision,
      total: items.length,
      offset: options.offset,
      limit: options.limit,
      items: page(items, options.offset, options.limit),
      diagnostics: catalog.diagnostics.slice(0, MAX_DIAGNOSTICS),
      ...(search?.guidance ? { guidance: search.guidance } : {})
    });
    return 0;
  } catch (error) {
    const known = error instanceof OmaError;
    writeEnvelope(io.stderr, {
      ok: false,
      stage: 'error',
      error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'skill retrieval failed safely' }
    });
    return 1;
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exitCode = await main();
