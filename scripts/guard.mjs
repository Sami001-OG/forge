// PreToolUse guard: keeps the loop's own state/verdicts/check results from being hand-edited.
// Best-effort integrity, not a security boundary. Fails open.
import path from 'node:path';
import { readStdin, statePath } from './lib/util.mjs';
import fs from 'node:fs';
import { isProtectedPath, bashTouchesProtected } from './lib/guard-logic.mjs';

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const project = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!fs.existsSync(statePath(project))) process.exit(0);
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  let blocked = false;
  if (['Write', 'Edit', 'MultiEdit'].includes(tool)) blocked = isProtectedPath(project, ti.file_path || ti.path || '');
  else if (tool === 'Bash') blocked = bashTouchesProtected(String(ti.command || ''));
  if (blocked) {
    process.stderr.write('forge: .forge/state.json, checks-*, verdict-*, signoff-*, approvals.json and tools.json are written only by the forge CLI. Use the forge CLI instead of editing them directly.');
    process.exit(2);
  }
} catch { /* fail open */ }
process.exit(0);
