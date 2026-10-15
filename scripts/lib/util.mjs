import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const projectDir = (hint) => path.resolve(hint || process.env.CLAUDE_PROJECT_DIR || process.cwd());
export const forgeDir = (p) => path.join(p, '.forge');
export const statePath = (p) => path.join(forgeDir(p), 'state.json');
export const toolsDir = (p) => path.join(forgeDir(p), 'tools');
export const posix = (p) => String(p).replace(/\\/g, '/');

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
    process.stdin.on('error', () => resolve(d));
  });
}

export function toolPathEntries(p) {
  const t = toolsDir(p);
  return [
    path.join(t, 'npm', 'node_modules', '.bin'),
    path.join(t, 'venv', 'bin'),
    path.join(t, 'venv', 'Scripts'),
    path.join(t, 'bin'),
  ].filter((d) => fs.existsSync(d));
}

export function toolEnv(p, extra = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const PATH = [...toolPathEntries(p), process.env.PATH || ''].join(sep);
  return { ...process.env, PATH, ...extra };
}
