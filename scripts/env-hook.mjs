// SessionStart hook: puts project-local Forge tools on PATH for every Bash command in the session
// (including subagents), via CLAUDE_ENV_FILE. Prints nothing (SessionStart stdout becomes model context).
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, toolPathDirs, posix } from './lib/util.mjs';

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const file = process.env.CLAUDE_ENV_FILE;
  if (file) {
    const project = path.resolve(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const dirs = toolPathDirs(project).map(posix).join(':');
    // Idempotent: remove any previous Forge line for this project, then add one.
    const marker = '# forge-tools-path';
    const line = `export PATH="${dirs}:$PATH" ${marker}`;
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
    if (!cur.includes(line)) fs.appendFileSync(file, `${line}\n`);
  }
} catch { /* fail open */ }
process.exit(0);
