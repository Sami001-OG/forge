// The UI/UX design stack: skills Forge installs from their own repos (never vendored) and reads by path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listFiles, DEFAULT_IGNORE } from './fingerprint.mjs';

export const DESIGN_TOOLS = ['design-emil', 'design-taste', 'design-impeccable', 'design-uiuxpro', 'design-hallmark', 'design-hue', 'design-interface', 'design-typography'];
export const DESIGN_SKILLS = {
  'design-emil': ['emil-design-eng', 'review-animations', 'animation-performance', 'break-ui'],
  'design-taste': ['design-taste-frontend'],
  'design-impeccable': ['impeccable'],
  'design-uiuxpro': ['ui-ux-pro-max'],
  'design-hallmark': ['hallmark'],
  'design-hue': ['hue'],
  'design-interface': ['interface-design'],
  'design-typography': ['better-typography'],
};
export const ROLE = {
  'emil-design-eng': 'motion and the unseen details (Emil Kowalski)',
  'review-animations': 'animation review lens (Emil Kowalski)',
  'animation-performance': 'animation performance (Emil Kowalski)',
  'break-ui': 'break the UI with worst-case data (Emil Kowalski)',
  'design-taste-frontend': 'art direction, anti-slop, pre-flight (Taste Skill)',
  impeccable: 'shape, craft, audit, critique, polish (Impeccable)',
  'ui-ux-pro-max': 'design-system generation: style, palette, fonts, pattern (UI UX Pro Max)',
  hallmark: 'sites and pages that look designed, plus the sloplint linter (Hallmark)',
  hue: 'learns a brand from a URL or screenshot and generates a design-language skill (Hue)',
  'interface-design': 'dashboards, apps and tools; keeps decisions in .interface-design/system.md (Interface Design)',
  'better-typography': 'type scale, spacing, wrapping, OpenType, truncation (Better Typography, Jakub Krehel)',
};

// Claude Code reads ~/.claude/skills; OpenCode reads that too, plus its own and ~/.agents/skills.
export const skillRoots = (project) => [
  path.join(os.homedir(), '.claude', 'skills'), path.join(project, '.claude', 'skills'),
  path.join(os.homedir(), '.config', 'opencode', 'skills'), path.join(os.homedir(), '.config', 'opencode', 'skill'),
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(project, '.opencode', 'skills'), path.join(project, '.opencode', 'skill'), path.join(project, '.agents', 'skills'),
];

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
function readCorpus(project, ignore) {
  let corpus = '';
  for (const f of listFiles(project, ignore)) {
    if (!SRC.test(f)) continue;
    try { const st = fs.statSync(path.join(project, f)); if (st.size < 1.5e6) corpus += fs.readFileSync(path.join(project, f), 'utf8').toLowerCase() + '\n'; } catch { /* skip unreadable */ }
  }
  return corpus;
}

export function checkConformance(project, parsed, ignore = DEFAULT_IGNORE) {
  const corpus = readCorpus(project, ignore);
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

// Hue writes a design-language skill whose design-model.yaml holds `tokens: colors:` and `typography: family:`.
export function parseHueModel(text) {
  const colors = [];
  const fonts = [];
  let inTokens = false;
  for (const line of text.split('\n')) {
    if (/^tokens:\s*$/.test(line)) { inTokens = true; continue; }
    if (inTokens && /^[A-Za-z_]+:/.test(line)) inTokens = false;
    if (!inTokens) continue;
    const c = line.match(/^\s*([A-Za-z0-9_-]+):\s*["']?(#[0-9a-fA-F]{6})\b/);
    if (c) colors.push({ role: c[1], hex: c[2].toLowerCase() });
    const f = line.match(/family:\s*["']([^"']+)["']/);
    if (f && !fonts.includes(f[1])) fonts.push(f[1]);
  }
  return { colors, fonts };
}

// Token colours come in light and dark sets and not every shade is used, so the palette is judged by coverage.
export function checkHueConformance(project, parsed, ignore = DEFAULT_IGNORE) {
  const corpus = readCorpus(project, ignore);
  const uniq = [...new Set(parsed.colors.map((c) => c.hex))];
  const used = uniq.filter((h) => corpus.includes(h));
  const pct = uniq.length ? Math.round((used.length / uniq.length) * 100) : 0;
  const findings = [{ kind: 'palette', name: `Hue token palette coverage ${pct}% (${used.length}/${uniq.length} colours used)`, ok: pct >= 50, severity: pct >= 50 ? 'ok' : 'error' }];
  for (const c of parsed.colors) if (!corpus.includes(c.hex)) findings.push({ kind: 'color', name: `${c.role} ${c.hex}`, ok: false, severity: 'warning' });
  for (const name of parsed.fonts) { const ok = corpus.includes(name.toLowerCase()); findings.push({ kind: 'font', name: `font ${name}`, ok, severity: ok ? 'ok' : 'error' }); }
  return { findings, errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warning').length, coverage: pct };
}
