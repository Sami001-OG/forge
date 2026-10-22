// Find Playwright wherever it is installed: Forge's tool cache first, then the project, then global.
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { toolsDir } from './util.mjs';

export function loadPlaywright(project) {
  let globalRoot = null;
  const tries = [
    () => createRequire(path.join(toolsDir(project), 'npm', 'playwright', 'package.json'))('playwright'),
    () => createRequire(path.join(project, 'noop.js'))('playwright'),
    () => createRequire(import.meta.url)('playwright'),
    () => { globalRoot ||= execSync('npm root -g', { encoding: 'utf8', timeout: 15000 }).trim(); return createRequire(path.join(globalRoot, 'noop.js'))('playwright'); },
  ];
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  return null;
}

// Containers and CI usually run as root, where Chromium refuses to start without --no-sandbox.
export const launchArgs = () => (process.getuid?.() === 0 ? ['--no-sandbox'] : []);
