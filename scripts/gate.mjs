// Stop hook: the "prompt thrower". Fails open on any internal error so it can never trap a session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin, forgeDir, posix } from './lib/util.mjs';
import { loadState, saveState, loadArtifacts } from './lib/state.mjs';
import { decide } from './lib/gate-logic.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = `node "${posix(path.join(here, 'forge.mjs'))}"`;

let input = {};
try { input = JSON.parse((await readStdin()) || '{}'); } catch { /* ignore */ }
const project = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());

try {
  const state = loadState(project);
  if (!state || !['running', 'delivering'].includes(state.status)) process.exit(0);
  if (state.session_id && input.session_id && state.session_id !== input.session_id) process.exit(0);
  if (!state.session_id && input.session_id) state.session_id = input.session_id;

  const art = loadArtifacts(project, state.round);
  const res = decide(state, art, Date.now(), { cli });
  saveState(project, res.state);
  if (res.allow) process.exit(0);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: res.reason }));
  process.exit(0);
} catch (e) {
  try {
    fs.mkdirSync(forgeDir(project), { recursive: true });
    fs.appendFileSync(path.join(forgeDir(project), 'gate-errors.log'), `${new Date().toISOString()} ${e?.stack || e}\n`);
  } catch { /* ignore */ }
  process.exit(0);
}
