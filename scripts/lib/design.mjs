// The UI/UX design stack: skills Forge installs from their own repos (never vendored) and reads by path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listFiles, DEFAULT_IGNORE } from './fingerprint.mjs';

export const DESIGN_TOOLS = ['design-emil', 'design-taste', 'design-impeccable', 'design-uiuxpro'];
export const DESIGN_SKILLS = {
  'design-emil': ['emil-design-eng', 'review-animations', 'animation-performance', 'break-ui'],
  'design-taste': ['design-taste-frontend'],
  'design-impeccable': ['impeccable'],
  'design-uiuxpro': ['ui-ux-pro-max'],
};
export const ROLE = {
  'emil-design-eng': 'motion and the unseen details (Emil Kowalski)',
  'review-animations': 'animation review lens (Emil Kowalski)',
  'animation-performance': 'animation performance (Emil Kowalski)',
  'break-ui': 'break the UI with worst-case data (Emil Kowalski)',
  'design-taste-frontend': 'art direction, anti-slop, pre-flight (Taste Skill)',
  impeccable: 'shape, craft, audit, critique, polish (Impeccable)',
  'ui-ux-pro-max': 'design-system generation: style, palette, fonts, pattern (UI UX Pro Max)',
};

export const skillRoots = (project) => [path.join(os.homedir(), '.claude', 'skills'), path.join(project, '.claude', 'skills')];

export function findSkills(project) {
  const out = {};
  for (const [tool, names] of Object.entries(DESIGN_SKILLS)) {
    out[tool] = [];
    for (const name of names) {
      for (const root of skillRoots(project)) {
        const file = path.join(root, name, 'SKILL.md');
        if (fs.existsSync(file)) { out[tool].push({ name, path: file }); break; }
      }
    }
  }
  return out;
}

export function findPython() {
  for (const c of ['python3', 'python', 'py']) { if (spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0) return c; }
  return null;
}

export const searchScript = (project) => (findSkills(project)['design-uiuxpro'][0] ? path.join(path.dirname(findSkills(project)['design-uiuxpro'][0].path), 'scripts', 'search.py') : null);

// Reads the markdown that UI UX Pro Max's `--design-system -f markdown` prints.
export function parseDesignSystem(md) {
  const colors = [];
  for (const m of md.matchAll(/^\|\s*([^|]+?)\s*\|\s*`?(#[0-9a-fA-F]{3,8})`?\s*\|\s*`?([^|`]*?)`?\s*\|\s*$/gm)) colors.push({ role: m[1].trim(), hex: m[2].toLowerCase(), variable: m[3].trim() });
  const grab = (re) => (md.match(re) || [])[1]?.trim();
  return { colors, fonts: { heading: grab(/\*\*Heading:\*\*\s*(.+)/), body: grab(/\*\*Body:\*\*\s*(.+)/) } };
}

const CORE = /^(primary|secondary|accent|accent\/cta|background|foreground)$/i;
const SRC = /\.(css|scss|sass|less|html?|jsx?|tsx?|mjs|cjs|vue|svelte|astro|mdx)$/i;

// Does the code actually use the generated palette and fonts? Core palette roles and both fonts are errors.
export function checkConformance(project, parsed, ignore = DEFAULT_IGNORE) {
  let corpus = '';
  for (const f of listFiles(project, ignore)) {
    if (!SRC.test(f)) continue;
    try { const st = fs.statSync(path.join(project, f)); if (st.size < 1.5e6) corpus += fs.readFileSync(path.join(project, f), 'utf8').toLowerCase() + '\n'; } catch { /* skip unreadable */ }
  }
  const findings = [];
  for (const c of parsed.colors) {
    const ok = corpus.includes(c.hex);
    findings.push({ kind: 'color', name: `${c.role} ${c.hex}${c.variable ? ` (${c.variable})` : ''}`, ok, severity: ok ? 'ok' : CORE.test(c.role) ? 'error' : 'warning' });
  }
  for (const [role, name] of Object.entries(parsed.fonts)) {
    if (!name) continue;
    const ok = corpus.includes(name.toLowerCase());
    findings.push({ kind: 'font', name: `${role} font ${name}`, ok, severity: ok ? 'ok' : 'error' });
  }
  return { findings, errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length };
}
