import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgeDir, toolsDir, readJson, writeJsonAtomic, toolEnv, toolPathEntries } from './util.mjs';
import { loadCatalog } from './catalog.mjs';
import { pickVersion } from './versions.mjs';

const run = (cmd, o = {}) => spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: o.timeout ?? 600000, maxBuffer: 64 * 1024 * 1024, ...o });
const tail = (r, n = 600) => `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-n);

export const inContainer = () => fs.existsSync('/.dockerenv') || process.env.FORGE_CONTAINER === '1';
const approvalsFile = (p) => path.join(forgeDir(p), 'approvals.json');
const toolsFile = (p) => path.join(forgeDir(p), 'tools.json');
export const isApproved = (p, id) => !!readJson(approvalsFile(p), { approved: {} }).approved?.[id];

export function approve(p, id) {
  const a = readJson(approvalsFile(p), { approved: {} });
  a.approved[id] = new Date().toISOString();
  writeJsonAtomic(approvalsFile(p), a);
}

function record(p, id, info) {
  const t = readJson(toolsFile(p), { installed: {}, log: [] });
  t.installed[id] = { ...info, at: new Date().toISOString() };
  t.log.push({ id, ...info, at: new Date().toISOString() });
  writeJsonAtomic(toolsFile(p), t);
}

export function verify(p, tool) {
  if (!tool.verify) return { ok: true };
  if (tool.verify === '@exists') {
    // For CLIs whose every invocation needs project config (e.g. mutmut): check the shim is present.
    const f = findBin(toolPathEntries(p), tool.install.bin);
    return { ok: !!f, out: f ? '' : `${tool.install.bin} not found` };
  }
  const r = run(tool.verify, { env: toolEnv(p), cwd: p, timeout: 90000 });
  return { ok: r.status === 0, out: tail(r, 300) };
}

// Every CLI tool installs in its own prefix/venv (no cross-tool dependency conflicts) and is exposed
// through one shim directory, .forge/tools/bin, which is the only thing that has to be on PATH.
const binDir = (p) => path.join(toolsDir(p), 'bin');
const npmPrefix = (p, tool) => path.join(toolsDir(p), 'npm', tool.install.bin ? tool.id : '_libs');
const venvDir = (p, tool) => path.join(toolsDir(p), tool.install.bin ? `venv-${tool.id}` : 'venv');

function makeShim(p, name, target) {
  fs.mkdirSync(binDir(p), { recursive: true });
  const shim = path.join(binDir(p), process.platform === 'win32' ? `${name}.cmd` : name);
  fs.rmSync(shim, { force: true });
  if (process.platform === 'win32') fs.writeFileSync(shim, `@echo off\r\n"${target}" %*\r\n`);
  else fs.symlinkSync(path.relative(binDir(p), target), shim);
  return shim;
}

function findBin(dirs, name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) { const f = path.join(d, name + e); if (fs.existsSync(f)) return f; }
  return null;
}

function findPython() {
  for (const c of ['python3', 'python', 'py']) { if (run(`${c} --version`, { timeout: 10000 }).status === 0) return c; }
  return null;
}

async function resolveNpm(pkg) {
  const r = run(`npm view ${pkg} time --json`, { timeout: 60000 });
  if (r.status !== 0) throw new Error(`npm view failed: ${tail(r)}`);
  const times = JSON.parse(r.stdout);
  delete times.created; delete times.modified;
  const v = pickVersion(times, Date.now());
  if (!v) throw new Error(`no stable ${pkg} release older than 14 days`);
  return v;
}

async function resolvePip(pkg, allowPre = false) {
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
  if (!res.ok) throw new Error(`PyPI lookup failed for ${pkg}: ${res.status}`);
  const j = await res.json();
  const times = {};
  for (const [v, files] of Object.entries(j.releases || {})) {
    const ts = files.map((f) => f.upload_time_iso_8601).filter(Boolean).sort();
    if (ts.length) times[v] = ts[0];
  }
  const v = pickVersion(times, Date.now(), 14, allowPre);
  if (!v) throw new Error(`no ${allowPre ? '' : 'stable '}${pkg} release older than 14 days`);
  return v;
}

export function gate(p, tool) {
  if (tool.tier >= 3) {
    const miss = (tool.requires_env || []).filter((e) => !process.env[e]);
    return miss.length ? { ok: false, reason: `needs credentials: set ${miss.join(', ')}` } : { ok: true };
  }
  if (tool.tier === 2 || (tool.tier === 1 && !inContainer())) {
    return isApproved(p, tool.id) ? { ok: true } : { ok: false, needs_approval: true, reason: `tier ${tool.tier} tool: needs the user's approval (${describeInstall(tool)})` };
  }
  return { ok: true };
}

export function describeInstall(tool) {
  const i = tool.install;
  if (i.method === 'npm') return `npm install ${i.pkg} into .forge/tools (project-local)${i.post?.length ? `, then: ${i.post.join('; ')}` : ''}`;
  if (i.method === 'pip') return `pip install ${i.pkg} into a venv in .forge/tools (project-local)`;
  if (i.method === 'system') return `system command: ${i.cmds?.[process.platform] || '(none for this OS)'}`;
  return 'already part of the system';
}

export async function install(p, id, seen = new Set(), opts = {}) {
  const tool = loadCatalog(p).find((t) => t.id === id);
  if (!tool) return { id, ok: false, reason: 'not in catalog' };
  if (seen.has(id)) return { id, ok: true };
  seen.add(id);
  if (!opts.force && verify(p, tool).ok) return { id, ok: true, already: true };

  for (const dep of tool.requires || []) {
    const d = await install(p, dep, seen);
    if (!d.ok) return { id, ok: false, reason: `dependency ${dep}: ${d.reason}`, needs_approval: d.needs_approval, dep };
  }
  const g = gate(p, tool);
  if (!g.ok) return { id, ...g };

  const i = tool.install;
  try {
    if (i.method === 'builtin') return { id, ok: false, reason: `${i.bin} is not installed on this system; install it with your package manager` };

    if (i.method === 'npm') {
      const dir = npmPrefix(p, tool);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true}\n');
      const ver = await resolveNpm(i.pkg);
      const base = `npm install --no-audit --no-fund --ignore-scripts --save-exact ${i.pkg}@${ver}`;
      let r = run(base, { cwd: dir });
      if (r.status !== 0) {
        // npm's resolver occasionally trips on peer ranges or a stale lockfile; retry cleanly once.
        fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
        fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
        r = run(`${base} --legacy-peer-deps`, { cwd: dir });
      }
      if (r.status !== 0) return { id, ok: false, reason: `npm install failed: ${tail(r)}` };
      if (i.bin) {
        const target = findBin([path.join(dir, 'node_modules', '.bin')], i.bin);
        if (!target) return { id, ok: false, reason: `installed ${i.pkg}@${ver} but it provides no "${i.bin}" command` };
        makeShim(p, i.bin, target);
      }
      for (const post of i.post || []) {
        const pr = run(post, { cwd: dir, env: toolEnv(p) });
        if (pr.status !== 0) return { id, ok: false, reason: `post-install "${post}" failed: ${tail(pr)}${tool.notes ? ` (${tool.notes})` : ''}` };
      }
      record(p, id, { method: 'npm', pkg: i.pkg, version: ver });
    } else if (i.method === 'pip') {
      const py = findPython();
      if (!py) return { id, ok: false, reason: 'python 3 not found; install Python 3 first' };
      const venv = venvDir(p, tool);
      if (!fs.existsSync(venv)) {
        fs.mkdirSync(path.dirname(venv), { recursive: true });
        const r = run(`${py} -m venv "${venv}"`, { timeout: 120000 });
        if (r.status !== 0) return { id, ok: false, reason: `venv creation failed: ${tail(r)}` };
      }
      const ver = await resolvePip(i.pkg, !!i.prerelease);
      const pipBin = findBin([path.join(venv, 'bin'), path.join(venv, 'Scripts')], 'pip');
      if (!pipBin) return { id, ok: false, reason: `venv at ${venv} has no pip` };
      const r = run(`"${pipBin}" install --prefer-binary --disable-pip-version-check ${i.pkg}==${ver} ${(i.extra || []).map((x) => `"${x}"`).join(' ')}`);
      if (r.status !== 0) return { id, ok: false, reason: `pip install failed: ${tail(r)}` };
      if (i.bin) {
        const target = findBin([path.join(venv, 'bin'), path.join(venv, 'Scripts')], i.bin);
        if (!target) return { id, ok: false, reason: `installed ${i.pkg}==${ver} but it provides no "${i.bin}" command` };
        makeShim(p, i.bin, target);
      }
      record(p, id, { method: 'pip', pkg: i.pkg, version: ver });
    } else if (i.method === 'system') {
      const cmd = i.cmds?.[process.platform];
      if (!cmd) return { id, ok: false, reason: `no automatic install for ${process.platform}${i.manual ? `; see ${i.manual}` : ''}` };
      if (/\bsudo\b/.test(cmd) && process.getuid?.() !== 0 && run('sudo -n true', { timeout: 10000 }).status !== 0) {
        return { id, ok: false, reason: `needs sudo. Ask the user to run this in a terminal, then re-run verification: ${cmd}` };
      }
      const r = run(cmd, { timeout: 1800000 });
      if (r.status !== 0) return { id, ok: false, reason: `command failed: ${cmd}\n${tail(r)}${i.manual ? `\nManual install: ${i.manual}` : ''}` };
      record(p, id, { method: 'system', cmd });
    }
    const v = verify(p, tool);
    if (!v.ok) return { id, ok: false, reason: `installed but verification failed (${tool.verify}): ${v.out}` };
    return { id, ok: true };
  } catch (e) {
    return { id, ok: false, reason: String(e.message || e) };
  }
}

export function binFor(tool) {
  if (tool.install.bin) return tool.install.bin;
  return null;
}

export async function runTool(p, id, args) {
  const tool = loadCatalog(p).find((t) => t.id === id);
  if (!tool) return { code: 2, err: `unknown tool ${id}` };
  const bin = binFor(tool);
  if (!bin) return { code: 2, err: `${id} is a library, not a command; import it from code run with the forge tool PATH` };
  if (!verify(p, tool).ok) {
    const r = await install(p, id);
    if (!r.ok) return { code: 3, err: `${id} unavailable: ${r.reason}${r.needs_approval ? ' [NEEDS_APPROVAL]' : ''}` };
  }
  const r = spawnSync(bin, args, { stdio: 'inherit', env: toolEnv(p), shell: process.platform === 'win32' });
  return { code: r.status ?? 1 };
}
