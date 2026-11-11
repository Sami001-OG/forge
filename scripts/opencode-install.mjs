#!/usr/bin/env node
// Installs Forge into OpenCode.
//   node scripts/opencode-install.mjs [--global | --project [dir]] [--verifier-model provider/model] [--dry-run] [--uninstall]
// Writes plugin/, agent/ and command/ files plus a private copy of the Forge runtime into OpenCode's config directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAgent, adaptCommand } from './lib/opencode-adapt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
const posix = (p) => p.replace(/\\/g, '/');
const dry = flag('dry-run');

const base = flag('project')
  ? path.join(path.resolve(val('project') || '.'), '.opencode')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
const runtime = path.join(base, 'forge');
const manifestFile = path.join(runtime, 'INSTALLED.json');
const say = (m) => console.log(m);

function uninstall() {
  let m = null;
  try { m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* none */ }
  if (!m) { say(`forge: nothing installed in ${base}`); return; }
  for (const f of m.files) { say(`${dry ? 'would remove' : 'remove'} ${f}`); if (!dry) fs.rmSync(f, { force: true }); }
  if (!dry) fs.rmSync(runtime, { recursive: true, force: true });
  say('forge: uninstalled from OpenCode. Restart OpenCode.');
}

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip); else fs.copyFileSync(s, d);
  }
}

function install() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const verifierModel = val('verifier-model');
  if (verifierModel && !/^[A-Za-z0-9._:/-]+$/.test(verifierModel)) { console.error('forge: --verifier-model must look like provider/model'); process.exit(2); }
  const runtimeDir = posix(runtime);
  const files = [];
  const write = (file, content) => { files.push(file); say(`${dry ? 'would write' : 'write'} ${file}`); if (!dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); } };

  if (!dry) {
    fs.rmSync(runtime, { recursive: true, force: true });
    copyDir(path.join(root, 'scripts'), path.join(runtime, 'scripts'), (n) => n === 'dev');
    copyDir(path.join(root, 'catalog'), path.join(runtime, 'catalog'), (n) => n === 'build.mjs');
    fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'forge-runtime', version: pkg.version, private: true, type: 'module' }, null, 2) + '\n');
  }
  say(`${dry ? 'would copy' : 'copy'} runtime -> ${runtime}`);

  write(path.join(base, 'plugin', 'forge.js'), fs.readFileSync(path.join(root, 'opencode', 'forge-plugin.js'), 'utf8'));

  for (const f of fs.readdirSync(path.join(root, 'agents')).filter((x) => x.endsWith('.md'))) {
    write(path.join(base, 'agent', `forge-${f}`), adaptAgent(fs.readFileSync(path.join(root, 'agents', f), 'utf8'), { runtimeDir, verifierModel }));
  }
  for (const f of fs.readdirSync(path.join(root, 'commands')).filter((x) => x.endsWith('.md') && x !== 'ui.md')) {
    write(path.join(base, 'command', `forge-${f}`), adaptCommand(fs.readFileSync(path.join(root, 'commands', f), 'utf8'), { runtimeDir }));
  }
  // /forge-ui is /forge-build with --ui always on.
  write(path.join(base, 'command', 'forge-ui.md'), adaptCommand(fs.readFileSync(path.join(root, 'commands', 'build.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, `---\ndescription: ${JSON.stringify('Forge: UI/UX build loop. Same autonomous loop with the design stack (Emil Kowalski, Taste Skill, Impeccable, UI UX Pro Max, Hallmark, Hue, Interface Design, Better Typography) and Playwright UI audits.')}\n---\n`), { runtimeDir, args: '--ui $ARGUMENTS' }));

  if (!dry) { fs.mkdirSync(runtime, { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify({ version: pkg.version, installed: new Date().toISOString(), files }, null, 2) + '\n'); }
  say('');
  say(`forge ${pkg.version} installed for OpenCode (${flag('project') ? 'project' : 'global'}): ${base}`);
  say('Restart OpenCode, then use /forge-build, /forge-ui, /forge-tweak, /forge-status, /forge-abort, /forge-doctor.');
}

if (flag('uninstall')) uninstall(); else install();
