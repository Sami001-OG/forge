import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, loadBundles, loadTargets, catalogDir } from '../scripts/lib/catalog.mjs';
import { normalizePlan, validatePlan } from '../scripts/lib/plan.mjs';
import { findSkills, DESIGN_TOOLS, DESIGN_SKILLS } from '../scripts/lib/design.mjs';
import { loadPlaywright, launchArgs } from '../scripts/lib/pw.mjs';
import { tmpProject, rawPlan } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE = path.join(root, 'scripts', 'forge.mjs');
const fixture = (n) => `file://${path.join(root, 'tests', 'fixtures', 'ui', n)}`;

test('design stack is catalogued: skills need approval, the detector is auto-installable, all in the ui-design bundle', () => {
  const tools = loadCatalog();
  const by = Object.fromEntries(tools.map((t) => [t.id, t]));
  for (const id of DESIGN_TOOLS) { assert.ok(by[id], id); assert.ok(by[id].tier >= 2, `${id} runs a third-party installer: needs approval`); assert.match(by[id].install.cmds.linux, /npx -y |git clone /); }
  assert.equal(by['impeccable-detect'].tier, 0);
  const b = loadBundles()['ui-design'];
  for (const id of [...DESIGN_TOOLS, 'impeccable-detect', 'playwright', 'axe', 'lighthouse', 'pngjs', 'pixelmatch']) assert.ok(b.includes(id), `ui-design lacks ${id}`);
  const t = JSON.parse(fs.readFileSync(path.join(catalogDir, 'check-templates.json'), 'utf8')).templates;
  assert.ok(t.uiaudit && t['impeccable-detect']);
});

test('UI targets enable the design stack and carry the UI axes', () => {
  const targets = loadTargets().targets;
  for (const n of ['web-ui', 'fullstack-web', 'design', 'desktop']) assert.equal(targets[n].design_stack, true, n);
  const axes = targets['web-ui'].extra_axes.map((a) => a.id);
  for (const id of ['ux_polish', 'accessibility', 'motion', 'typography', 'originality']) assert.ok(axes.includes(id), id);
});

test('plan: --ui forces design_stack; design object is validated', () => {
  const p = normalizePlan(rawPlan(), { ui: true });
  assert.equal(p.design_stack, true);
  assert.deepEqual(validatePlan(p, tmpProject()), []);
  p.design = { direction: 'Editorial, warm paper tones, one confident serif, motion only on state change.' };
  assert.deepEqual(validatePlan(p, tmpProject()), []);
  p.design = { tone: 'x' };
  assert.match(validatePlan(p, tmpProject()).join('\n'), /design must be an object with a direction/);
});

test('design skills are found by path in the user and project skill dirs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  const proj = tmpProject();
  for (const [root2, name] of [[path.join(home, '.claude', 'skills'), 'emil-design-eng'], [path.join(proj, '.claude', 'skills'), 'design-taste-frontend']]) {
    fs.mkdirSync(path.join(root2, name), { recursive: true });
    fs.writeFileSync(path.join(root2, name, 'SKILL.md'), '---\nname: x\n---\n');
  }
  const saved = process.env.HOME; const savedU = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  try {
    const f = findSkills(proj);
    assert.deepEqual(f['design-emil'].map((x) => x.name), ['emil-design-eng']);
    assert.deepEqual(f['design-taste'].map((x) => x.name), ['design-taste-frontend']);
    assert.equal(f['design-impeccable'].length, 0);
    const run = (...a) => spawnSync(process.execPath, [FORGE, ...a], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') }, encoding: 'utf8' });
    const st = run('design', 'status');
    assert.match(st.stdout, /ok\s+design-emil: 1\/4/);
    assert.match(st.stdout, /MISSING design-impeccable/);
    const pth = run('design', 'path');
    assert.equal(pth.status, 0);
    assert.match(pth.stdout, /emil-design-eng\/SKILL\.md/);
    // Installing third-party skills without approval is refused.
    const inst = run('tool', 'install', 'design-emil', 'design-taste', 'design-impeccable');
    assert.notEqual(inst.status, 0);
    assert.match(inst.stdout, /design-emil \(already available\)/);
    assert.match(inst.stdout, /design-taste \(already available\)/);
    assert.match(inst.stdout, /NEEDS_APPROVAL design-impeccable/);
    assert.equal((inst.stdout.match(/NEEDS_APPROVAL/g) || []).length, 1, 'only the missing skill asks for approval');
  } finally { process.env.HOME = saved; process.env.USERPROFILE = savedU; }
});

// The audit tests need a real Chromium; skipped where there is none (for example a bare CI runner).
async function chromiumOrSkip(t) {
  const pw = loadPlaywright(tmpProject());
  if (!pw) return t.skip('playwright not installed') || null;
  try { const b = await pw.chromium.launch({ args: launchArgs() }); await b.close(); return pw; } catch { return t.skip('no launchable chromium') || null; }
}
const audit = (url, ...extra) => {
  const proj = tmpProject();
  return spawnSync(process.execPath, [FORGE, 'uiaudit', url, '--viewports', '375x812,1280x800', ...extra], { cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') }, encoding: 'utf8', timeout: 120000 });
};

test('uiaudit passes a well-built page', async (t) => {
  if (!(await chromiumOrSkip(t))) return;
  const r = audit(fixture('good.html'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS uiaudit: 0 error\(s\), 0 warning\(s\)/);
  assert.match(r.stdout, /screenshot: file:.*dark/);
  assert.match(r.stdout, /screenshot: file:.*reduced-motion/);
});

test('uiaudit fails a sloppy page and names the problems', async (t) => {
  if (!(await chromiumOrSkip(t))) return;
  const r = audit(fixture('bad.html'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const type of ['missing-lang', 'missing-title', 'missing-viewport-meta', 'overflow-x', 'img-no-alt', 'tap-target-too-small', 'no-accessible-name', 'tiny-text', 'transition-all', 'slow-ui-transition', 'weak-easing', 'no-reduced-motion-rule']) assert.match(r.stdout, new RegExp(type), type);
});

// ---------- UI UX Pro Max: design system generation and conformance ----------
import { parseDesignSystem, checkConformance, findPython } from '../scripts/lib/design.mjs';

const SAMPLE = `## Design System: Demo

### Colors
| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | \`#0F172A\` | \`--color-primary\` |
| On Primary | \`#FFFFFF\` | \`--color-on-primary\` |
| Secondary | \`#1E293B\` | \`--color-secondary\` |
| Accent/CTA | \`#22C55E\` | \`--color-accent\` |
| Background | \`#020617\` | \`--color-background\` |
| Foreground | \`#F8FAFC\` | \`--color-foreground\` |
| Muted | \`#1A1E2F\` | \`--color-muted\` |

### Typography
- **Heading:** Fira Code
- **Body:** Fira Sans
`;

test('design system markdown is parsed (palette roles, hex, variables, fonts)', () => {
  const p = parseDesignSystem(SAMPLE);
  assert.equal(p.colors.length, 7);
  assert.deepEqual(p.colors[3], { role: 'Accent/CTA', hex: '#22c55e', variable: '--color-accent' });
  assert.deepEqual(p.fonts, { heading: 'Fira Code', body: 'Fira Sans' });
});

test('conformance: core palette roles and fonts are errors, others warnings', () => {
  const proj = tmpProject();
  const css = ':root{--color-primary:#0F172A;--color-secondary:#1E293B;--color-accent:#22C55E;--color-background:#020617;--color-foreground:#F8FAFC}\nbody{font-family:"Fira Sans"} h1{font-family:"Fira Code"}';
  fs.writeFileSync(path.join(proj, 'style.css'), css);
  const parsed = parseDesignSystem(SAMPLE);
  let r = checkConformance(proj, parsed);
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 2, 'On Primary #fff and Muted are non-core and missing');
  fs.writeFileSync(path.join(proj, 'style.css'), css.replace('#22C55E', '#ff00aa').replace('Fira Code', 'Georgia'));
  r = checkConformance(proj, parsed);
  assert.equal(r.errors, 2, 'accent colour and heading font missing');
  assert.ok(r.findings.some((f) => f.name.startsWith('Accent/CTA') && f.severity === 'error'));
  assert.ok(r.findings.some((f) => f.name === 'heading font Fira Code' && f.severity === 'error'));
});

test('forge design system / check end to end with a stub skill (needs python3)', (t) => {
  if (!findPython()) return t.skip('python3 not available');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  const proj = tmpProject();
  const skill = path.join(home, '.claude', 'skills', 'ui-ux-pro-max');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: ui-ux-pro-max\n---\n');
  fs.writeFileSync(path.join(skill, 'scripts', 'search.py'), `import sys\nprint(${JSON.stringify(SAMPLE)}.replace('Demo', sys.argv[sys.argv.index('-p') + 1]) + '\\n<!-- args: ' + ' '.join(sys.argv[2:]) + ' -->')\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  const run = (...a) => spawnSync(process.execPath, [FORGE, ...a], { cwd: proj, env, encoding: 'utf8' });

  assert.notEqual(run('design', 'system').status, 0, 'keywords are required');
  const chk0 = run('design', 'check');
  assert.equal(chk0.status, 1, 'skill installed but no design system generated yet');
  const gen = run('design', 'system', 'fintech', 'dashboard', '--name', 'Acme', '--stack', 'nextjs', '--motion', '4');
  assert.equal(gen.status, 0, gen.stderr + gen.stdout);
  const md = fs.readFileSync(path.join(proj, '.forge', 'design-system.md'), 'utf8');
  assert.match(md, /Design System: Acme/);
  assert.match(md, /--stack nextjs/);
  assert.match(md, /--motion 4/);
  assert.match(gen.stdout, /Fira Code \/ Fira Sans/);
  assert.notEqual(run('design', 'system', 'x', '--motion', '99').status, 0, 'dials are validated');

  assert.equal(run('design', 'check').status, 1, 'code does not use the palette yet');
  fs.writeFileSync(path.join(proj, 'app.css'), ':root{--color-primary:#0F172A;--color-secondary:#1E293B;--color-accent:#22C55E;--color-background:#020617;--color-foreground:#F8FAFC} body{font-family:"Fira Sans"} h1{font-family:"Fira Code"}');
  const ok = run('design', 'check');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /PASS design check: 0 error\(s\)/);
  assert.match(run('design', 'path').stdout, /design-system\.md/);
});

test('design check is skipped when the skill is not installed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  const proj = tmpProject();
  const r = spawnSync(process.execPath, [FORGE, 'design', 'check'], { cwd: proj, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIP/);
});

// ---------- Hallmark, Hue, Interface Design, Better Typography ----------
import { parseHueModel, checkHueConformance } from '../scripts/lib/design.mjs';

const HUE_YAML = `name: "Ledger"
primitives:
  colors:
    cream:
      50:  "#F6F1E0"
tokens:
  colors:
    canvas:        "#F0EAD6"
    text:          "#0A0A0A"
    accent:        "#C8102E"   # press red
    accent-dark:   "#E8234E"
  typography:
    display:
      family: "Playfair Display"   # masthead
    body:
      family: "PT Serif"
hero_stage:
  background: "#123456"
`;

test('the four new skills are catalogued with the right installers', () => {
  const by = Object.fromEntries(loadCatalog().map((t) => [t.id, t]));
  for (const id of ['design-hallmark', 'design-hue', 'design-interface', 'design-typography']) { assert.ok(by[id], id); assert.ok(by[id].tier >= 2); assert.ok(loadBundles()['ui-design'].includes(id)); }
  assert.match(by['design-hallmark'].install.cmds.linux, /skills add https:\/\/github\.com\/Nutlope\/hallmark --skill hallmark/);
  assert.match(by['design-hue'].install.cmds.linux, /git clone --depth 1 https:\/\/github\.com\/dominikmartn\/hue/);
  assert.match(by['design-interface'].install.cmds.linux, /Dammyjay93\/interface-design --skill interface-design/);
  assert.match(by['design-typography'].install.cmds.linux, /jakubkrehel\/skills --skill better-typography/);
  assert.deepEqual(DESIGN_SKILLS['design-hue'], ['hue']);
});

test('plan: one design engine, validated', () => {
  const p = normalizePlan(rawPlan(), { ui: true });
  p.design = { direction: 'Editorial broadsheet for traders, cream stock, one red accent.', engine: 'hue' };
  assert.deepEqual(validatePlan(p, tmpProject()), []);
  p.design.engine = 'everything';
  assert.match(validatePlan(p, tmpProject()).join('\n'), /design\.engine must be/);
});

test('Hue design-model.yaml: token colours and font families are read, nothing outside tokens', () => {
  const m = parseHueModel(HUE_YAML);
  assert.deepEqual(m.colors.map((c) => c.hex), ['#f0ead6', '#0a0a0a', '#c8102e', '#e8234e']);
  assert.deepEqual(m.fonts, ['Playfair Display', 'PT Serif']);
});

test('Hue conformance: palette by coverage, fonts must be present', () => {
  const proj = tmpProject();
  const m = parseHueModel(HUE_YAML);
  fs.writeFileSync(path.join(proj, 'a.css'), ':root{--c:#F0EAD6;--t:#0A0A0A;--a:#C8102E} h1{font-family:"Playfair Display"} p{font-family:"PT Serif"}');
  let r = checkHueConformance(proj, m);
  assert.equal(r.errors, 0);
  assert.equal(r.coverage, 75);
  assert.equal(r.warnings, 1, 'the unused dark accent is only a warning');
  fs.writeFileSync(path.join(proj, 'a.css'), ':root{--c:#F0EAD6} h1{font-family:Georgia}');
  r = checkHueConformance(proj, m);
  assert.equal(r.errors, 3, 'coverage below 50% plus two missing fonts');
});

test('forge design use / check / hue-validate / sloplint end to end with stub skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
  const proj = tmpProject();
  const mk = (name, files) => { const d = path.join(home, '.claude', 'skills', name); fs.mkdirSync(path.join(d, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\n---\n`); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); return d; };
  mk('hue', { 'scripts/validate.mjs': 'console.log("hue-validate ran on " + process.argv[2]); process.exit(0);' });
  mk('hallmark', { 'scripts/sloplint.mjs': 'console.log("sloplint args: " + process.argv.slice(2).join(" ")); process.exit(process.argv.includes("--bad") ? 1 : 0);' });
  const gen = path.join(home, '.claude', 'skills', 'ledger-design');
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(path.join(gen, 'SKILL.md'), '---\nname: ledger-design\n---\n');
  fs.writeFileSync(path.join(gen, 'design-model.yaml'), HUE_YAML);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  const run = (...a) => spawnSync(process.execPath, [FORGE, ...a], { cwd: proj, env, encoding: 'utf8' });

  assert.notEqual(run('design', 'use', path.join(home, 'nope')).status, 0);
  const use = run('design', 'use', gen);
  assert.equal(use.status, 0, use.stderr + use.stdout);
  assert.match(use.stdout, /Playfair Display, PT Serif/);
  assert.match(run('design', 'path').stdout, /ledger-design\/SKILL\.md/);

  assert.equal(run('design', 'check').status, 1, 'code does not use the Hue tokens yet');
  fs.writeFileSync(path.join(proj, 'app.css'), ':root{--c:#F0EAD6;--t:#0A0A0A;--a:#C8102E} h1{font-family:"Playfair Display"} p{font-family:"PT Serif"}');
  const ok = run('design', 'check');
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /PASS design check \(Hue\)/);

  const hv = run('design', 'hue-validate', gen);
  assert.equal(hv.status, 0);
  assert.match(hv.stdout, /hue-validate ran on .*ledger-design/);
  const sl = run('design', 'sloplint', 'src/', '--render');
  assert.equal(sl.status, 0);
  assert.match(sl.stdout, /sloplint args: src\/ --render/);
  assert.equal(run('design', 'sloplint', '--bad').status, 1, 'the linter exit code passes through');

  const info = path.join(proj, '.interface-design');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'system.md'), '# Design System\n');
  assert.match(run('design', 'path').stdout, /Interface Design memory/);
});
