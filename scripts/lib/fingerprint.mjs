// Content fingerprints so verification can be incremental: a criterion or check that depends only on
// files that have not changed since it last passed is carried forward instead of re-verified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { forgeDir, readJson, writeJsonAtomic, posix } from './util.mjs';

export const DEFAULT_IGNORE = ['.forge/**', '.git/**', '**/node_modules/**', 'dist/**', 'build/**', 'out/**', '.next/**', '.nuxt/**', 'coverage/**', '**/__pycache__/**', '**/*.pyc', '**/*.log', '.venv/**', 'venv/**', 'target/**', '**/.DS_Store'];
// Changing any of these can affect everything, so it invalidates every carried result.
export const DEFAULT_SHARED = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements*.txt', 'pyproject.toml', 'poetry.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum', 'tsconfig*.json', '*.config.*', 'Dockerfile', 'docker-compose*.yml', 'Makefile', 'CMakeLists.txt', '.env*'];

export function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/');
  if (!g.includes('/')) g = '**/' + g; // bare names match at any depth, like .gitignore
  let re = '';
  for (let i = 0; i < g.length;) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i++;
  }
  return new RegExp(`^${re}$`);
}

export const matcher = (globs) => {
  const res = (globs || []).map(globToRegExp);
  return (f) => res.some((r) => r.test(f));
};

const SKIP_DIRS = new Set(['node_modules', '.git', '.forge', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target', '.next', 'coverage']);
function walk(root, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, path.join(rel, e.name), out); }
    else if (e.isFile()) out.push(posix(path.join(rel, e.name)));
  }
  return out;
}

export function listFiles(project, ignore = DEFAULT_IGNORE) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: project, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const files = r.status === 0 ? r.stdout.split('\0').filter(Boolean).map(posix) : walk(project);
  const ign = matcher(ignore);
  return [...new Set(files)].filter((f) => {
    if (ign(f)) return false;
    try { return fs.statSync(path.join(project, f)).isFile(); } catch { return false; }
  });
}

// path -> content hash, with a size+mtime cache so repeated snapshots are cheap.
export function takeSnapshot(project, ignore = DEFAULT_IGNORE) {
  const cacheFile = path.join(forgeDir(project), 'hashcache.json');
  const cache = readJson(cacheFile, {});
  const next = {};
  const snap = new Map();
  let dirty = false;
  for (const f of listFiles(project, ignore)) {
    const st = fs.statSync(path.join(project, f));
    const c = cache[f];
    let hash;
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) hash = c.hash;
    else {
      hash = st.size > 20e6 ? `big:${st.size}:${st.mtimeMs}` : crypto.createHash('sha1').update(fs.readFileSync(path.join(project, f))).digest('hex');
      dirty = true;
    }
    next[f] = { size: st.size, mtimeMs: st.mtimeMs, hash };
    snap.set(f, hash);
  }
  if (dirty || Object.keys(cache).length !== Object.keys(next).length) {
    try { writeJsonAtomic(cacheFile, next); } catch { /* cache is optional */ }
  }
  return snap;
}

// Fingerprint of the files a scope depends on (plus shared files that affect everything).
export function scopeFp(snap, scope, shared = DEFAULT_SHARED) {
  const inScope = matcher([...(scope && scope.length ? scope : ['**']), ...shared]);
  const h = crypto.createHash('sha1');
  for (const f of [...snap.keys()].sort()) if (inScope(f)) h.update(`${f}\0${snap.get(f)}\n`);
  return h.digest('hex').slice(0, 12);
}

export function changedFiles(prev, snap) {
  const out = new Set();
  for (const [f, h] of snap) if (prev[f] !== h) out.add(f);
  for (const f of Object.keys(prev)) if (!snap.has(f)) out.add(f);
  return [...out].sort();
}

export const hitsShared = (files, shared = DEFAULT_SHARED) => { const m = matcher(shared); return files.some(m); };
export const snapshotObject = (snap) => Object.fromEntries(snap);
