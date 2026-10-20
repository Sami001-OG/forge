// Maintainer tool: really installs catalog tools (tier 0/1, npm/pip) and runs each verify command.
// usage: node scripts/dev/smoke-catalog.mjs --only npm|pip [--ids a,b,c]   (uses a temp project; needs network)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog } from '../lib/catalog.mjs';
import { spawnSync } from 'node:child_process';
import * as prov from '../lib/provision.mjs';
import { toolsDir, pathKey, toolEnv } from '../lib/util.mjs';

const args = process.argv.slice(2);
const only = args[args.indexOf('--only') + 1];
const ids = args.includes('--ids') ? args[args.indexOf('--ids') + 1].split(',') : null;
process.env.FORGE_CONTAINER = '1'; // tier-1 tools install automatically in a container
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-smoke-'));
fs.mkdirSync(path.join(project, '.forge'), { recursive: true });
process.env.FORGE_TOOLS_DIR = path.join(project, '.forge', 'tools'); // fresh installs, not the shared cache

const list = loadCatalog(project).filter((t) => ['npm', 'pip'].includes(t.install.method) && t.tier <= 1 && (!only || t.install.method === only) && (!ids || ids.includes(t.id)));
const results = [];
for (const t of list) {
  const t0 = Date.now();
  const r = await prov.install(project, t.id, new Set(), { force: true });
  let ok = r.ok, reason = r.ok ? undefined : String(r.reason).slice(0, 300);
  if (ok) {
    // Strict: only Forge's own dirs plus a minimal system PATH, so a globally installed copy cannot hide a broken install.
    const td = toolsDir(project);
    const sep = path.delimiter;
    const strict = { ...toolEnv(project), [pathKey()]: [path.join(td, 'bin'), path.join(td, 'venv', 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(sep) };
    if (t.install.bin && !fs.existsSync(path.join(td, 'bin', t.install.bin))) { ok = false; reason = `no shim for ${t.install.bin} in .forge/tools/bin`; }
    else if (t.verify !== '@exists') { const v = spawnSync(t.verify, { shell: true, env: strict, cwd: project, encoding: 'utf8', timeout: 90000 }); if (v.status !== 0) { ok = false; reason = `strict verify failed: ${(v.stdout + v.stderr).trim().slice(-200)}`; } }
  }
  const row = { id: t.id, method: t.install.method, ok, secs: Math.round((Date.now() - t0) / 1000), reason };
  results.push(row);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.id} (${row.secs}s)${ok ? '' : ' ' + String(reason).replace(/\n/g, ' | ')}`);
}
const bad = results.filter((r) => !r.ok);
console.log(`\nsmoke: ${results.length - bad.length}/${results.length} ok${bad.length ? '; failed: ' + bad.map((b) => b.id).join(', ') : ''}`);
process.exit(bad.length ? 1 : 0);
