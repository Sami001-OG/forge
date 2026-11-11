// OpenCode has no Stop hook. The loop is driven by the plugin instead: when the main session goes idle, run the gate and,
// if it says "block", send its instruction as the next prompt. Fails open: an error here never traps a session.
import fs from 'node:fs';
import path from 'node:path';
import { forgeDir, statePath, toolPathDirs, posix } from './util.mjs';
import { loadState, saveState, loadArtifacts, ACTIVE } from './state.mjs';
import { decide } from './gate-logic.mjs';
import { isProtectedPath, bashTouchesProtected } from './guard-logic.mjs';

const EDIT_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch']);
const MIN_GAP_MS = 1500; // an idle event right after we sent a prompt is the same turn, not a new one

export function createHooks({ client, directory, runtimeDir, now = () => Date.now() }) {
  const project = path.resolve(directory);
  const cli = `node "${posix(path.join(runtimeDir, 'scripts', 'forge.mjs'))}"`;
  const childCache = new Map();
  const lastSent = new Map();

  const logError = (e) => {
    try { fs.mkdirSync(forgeDir(project), { recursive: true }); fs.appendFileSync(path.join(forgeDir(project), 'gate-errors.log'), `${new Date().toISOString()} ${e?.stack || e}\n`); } catch { /* ignore */ }
  };

  // Subagents run in child sessions and go idle too; only the main session is driven.
  async function isChild(id) {
    if (childCache.has(id)) return childCache.get(id);
    let child = false;
    try { const r = await client.session.get({ path: { id } }); child = !!(r?.data?.parentID ?? r?.parentID); } catch { /* treat as main */ }
    childCache.set(id, child);
    return child;
  }

  return {
    event: async ({ event }) => {
      if (event?.type !== 'session.idle') return;
      const id = event.properties?.sessionID;
      if (!id) return;
      try {
        const state = loadState(project);
        if (!state || !ACTIVE.has(state.status)) return;
        if (state.session_id && state.session_id !== id) return;
        if (await isChild(id)) return;
        if (now() - (lastSent.get(id) || 0) < MIN_GAP_MS) return;
        if (!state.session_id) state.session_id = id;
        const res = decide(state, loadArtifacts(project, state.round), now(), { cli, host: 'opencode' });
        saveState(project, res.state);
        if (res.allow) return;
        lastSent.set(id, now());
        const body = { parts: [{ type: 'text', text: res.reason }] };
        if (typeof client.session.promptAsync === 'function') await client.session.promptAsync({ path: { id }, body });
        else await client.session.prompt({ path: { id }, body });
      } catch (e) { logError(e); }
    },

    // Keep the loop's own state, verdicts and check results out of the agent's hands.
    'tool.execute.before': async (input, output) => {
      let blocked = false;
      try {
        if (!fs.existsSync(statePath(project))) return;
        const a = output?.args || {};
        if (EDIT_TOOLS.has(input.tool)) blocked = isProtectedPath(project, a.filePath || a.path || a.file_path || '');
        else if (input.tool === 'bash') blocked = bashTouchesProtected(String(a.command || ''));
      } catch (e) { logError(e); return; }
      if (blocked) throw new Error('forge: .forge/state.json, checks-*, verdict-*, signoff-*, scope-*, approvals.json and tools.json are written only by the forge CLI. Use the forge CLI instead of editing them directly.');
    },

    // Project tools installed by Forge are on PATH for every shell command, subagents included.
    'shell.env': async (input, output) => {
      try {
        const sep = process.platform === 'win32' ? ';' : ':';
        const dirs = toolPathDirs(project).map(posix);
        output.env.PATH = [...dirs, output.env.PATH || process.env.PATH || ''].join(sep);
        output.env.FORGE_HOST = 'opencode';
      } catch (e) { logError(e); }
    },
  };
}
