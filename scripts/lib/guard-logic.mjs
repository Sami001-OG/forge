import path from 'node:path';

const PROTECTED = /^(state\.json|checks-\d+\.json|verdict-\d+-(supervisor|critic)\.json|signoff-\d+\.json|approvals\.json|tools\.json)$/;

export function isProtectedPath(project, file) {
  if (!file) return false;
  const abs = path.resolve(project, file);
  const dir = path.join(project, '.forge');
  const rel = path.relative(dir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return PROTECTED.test(rel.replace(/\\/g, '/'));
}

const WRITEISH = /(>|\btee\b|\bsed\s+-i|\bmv\b|\bcp\b|\brm\b|\btruncate\b|\bperl\s+-i|\bdd\b|Out-File|Set-Content|Add-Content|writeFile|open\([^)]*['"]w)/;
const NAMES = /\.forge[\\/]+(state\.json|checks-|verdict-|signoff-|approvals\.json|tools\.json)/;

export function bashTouchesProtected(cmd) {
  if (!NAMES.test(cmd)) return false;
  // Commands that go through the forge CLI are the sanctioned writers.
  if (/forge\.mjs["']?\s+(verdict|signoff|checks|tool|start|plan-set|init|abort)\b/.test(cmd)) return false;
  return WRITEISH.test(cmd);
}
