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
  for (const id of DESIGN_TOOLS) { assert.ok(by[id], id); assert.ok(by[id].tier >= 2, `${id} runs a third-party installer: needs approval`); assert.match(by[id].install.cmds.linux, /npx -y /); }
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
