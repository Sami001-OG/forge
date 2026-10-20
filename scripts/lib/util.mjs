import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const projectDir = (hint) => path.resolve(hint || process.env.CLAUDE_PROJECT_DIR || process.cwd());
export const forgeDir = (p) => path.join(p, '.forge');
export const statePath = (p) => path.join(forgeDir(p), 'state.json');
// Shared across projects (each tool is version-pinned and isolated), so a tool downloads once per machine.
export const toolsDir = (p) => (process.env.FORGE_TOOLS_DIR ? path.resolve(process.env.FORGE_TOOLS_DIR) : path.join(os.homedir(), '.forge', 'tools'));
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
  return [path.join(t, 'bin'), path.join(t, 'venv', 'bin'), path.join(t, 'venv', 'Scripts')].filter((d) => fs.existsSync(d));
}

export function pathKey(env = process.env) {
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
}

export function toolEnv(p, extra = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const key = pathKey();
  const PATH = [...toolPathEntries(p), process.env[key] || ''].join(sep);
  // Shared npm *libraries* (no CLI) live in one dir that node can resolve from.
  const libs = path.join(toolsDir(p), 'npm', '_libs', 'node_modules');
  const NODE_PATH = [libs, process.env.NODE_PATH || ''].filter(Boolean).join(sep);
  // Keep tool startup quick and quiet: no update/telemetry network calls during verification.
  return { ...process.env, [key]: PATH, NODE_PATH, SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_SEND_METRICS: 'off', PIP_DISABLE_PIP_VERSION_CHECK: '1', ...extra };
}

// Project-local tool dirs whether or not they exist yet (they appear after the first install).
export function toolPathDirs(p) {
  const t = toolsDir(p);
  return [path.join(t, 'bin'), path.join(t, 'venv', 'bin'), path.join(t, 'venv', 'Scripts')];
}
