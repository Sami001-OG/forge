import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globToRegExp, scopeFp, changedFiles, matcher } from '../scripts/lib/fingerprint.mjs';
import { decide } from '../scripts/lib/gate-logic.mjs';
import { tmpProject, rawPlan, makeState, fullArt } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE = path.join(root, 'scripts', 'forge.mjs');

test('glob matching: bare names, **, and anchoring', () => {
  const m = (g, f) => globToRegExp(g).test(f);
  assert.ok(m('src/**', 'src/a/b.js'));
  assert.ok(!m('src/**', 'lib/a.js'));
  assert.ok(m('package.json', 'package.json'));
  assert.ok(m('package.json', 'apps/web/package.json')); // bare names match at any depth
  assert.ok(m('*.config.*', 'vite.config.ts'));
  assert.ok(m('**', 'anything/at/all.txt'));
  assert.ok(!m('src/a.txt', 'src/a.txt.bak'));
});

test('scope fingerprint changes only when files in scope (or shared files) change', () => {
  const base = new Map([['src/a.js', '1'], ['src/b.js', '2'], ['docs/x.md', '3'], ['package.json', 'p']]);
  const fpA = scopeFp(base, ['src/a.js'], ['package.json']);
  assert.equal(scopeFp(new Map([...base, ['src/b.js', 'CHANGED']]), ['src/a.js'], ['package.json']), fpA);
  assert.equal(scopeFp(new Map([...base, ['docs/x.md', 'CHANGED']]), ['src/a.js'], ['package.json']), fpA);
  assert.notEqual(scopeFp(new Map([...base, ['src/a.js', 'CHANGED']]), ['src/a.js'], ['package.json']), fpA);
  assert.notEqual(scopeFp(new Map([...base, ['package.json', 'CHANGED']]), ['src/a.js'], ['package.json']), fpA);
  assert.deepEqual(changedFiles({ 'src/a.js': '1', gone: 'z' }, new Map([['src/a.js', '2'], ['new.js', 'n']])), ['gone', 'new.js', 'src/a.js']);
});

test('gate: a carried criterion satisfies coverage only with a matching stored pass', () => {
  const s = makeState();
  s.stage_idx = 1; // function: c1 and c2 in force
  const a = fullArt(s);
  a.supervisor.criteria = a.supervisor.criteria.filter((c) => c.id === 'c2'); // c1 not re-assessed
  a.scope = { carried_criteria: ['c1'], dirty_criteria: ['c2'], criteria_fp: { c1: 'fp1', c2: 'fp2' } };
  assert.equal(decide(s, a, 1_060_000, { cli: 'forge' }).state.last_eval.approved, false, 'no stored pass: not covered');
  s.verified = { checks: {}, criteria: { c1: { fp: 'fp1', pass: true, observed: true, evidence: ['check:smoke'], round: 1 } } };
  assert.equal(decide(s, a, 1_060_000, { cli: 'forge' }).state.last_eval.approved, true, 'stored pass with matching fingerprint: carried');
  s.verified.criteria.c1.fp = 'stale';
  assert.equal(decide(s, a, 1_060_000, { cli: 'forge' }).state.last_eval.approved, false, 'stale fingerprint: not carried');
});

test('end to end: a small edit re-verifies only the affected criterion; fast path; tweak mode', () => {
  const proj = tmpProject();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  const forge = (args, input) => spawnSync(process.execPath, [FORGE, ...args], { cwd: proj, env, encoding: 'utf8', input });
  const readScope = (r) => JSON.parse(fs.readFileSync(path.join(proj, '.forge', `scope-${r}.json`), 'utf8'));
  const state = () => JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'state.json'), 'utf8'));
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'a1');
  fs.writeFileSync(path.join(proj, 'src', 'b.txt'), 'b1');
  fs.writeFileSync(path.join(proj, 'docs.md'), 'd1');

  assert.equal(forge(['init', 'x', '--auto']).status, 0);
  const plan = rawPlan();
  plan.criteria = [
    { id: 'c1', text: 'Feature A works for real input', stage: 'skeleton', critical: true, scope: ['src/a.txt'], observe: { method: 'run', tool: 'builtin' } },
    { id: 'c2', text: 'Feature B works for real input', stage: 'skeleton', critical: true, scope: ['src/b.txt'], observe: { method: 'run', tool: 'builtin' } },
  ];
  plan.checks = [{ id: 'smoke', cmd: 'node -e "process.exit(0)"', stage: 'skeleton' }];
  fs.writeFileSync(path.join(proj, '.forge', 'plan.draft.json'), JSON.stringify(plan));
  assert.equal(forge(['plan-set']).status, 0);
  assert.equal(forge(['start']).status, 0);

  const verdict = (role, ids, extra = {}) => {
    const s = state();
    const axes = Object.fromEntries(s.plan.axes.map((a) => [a.id, 10]));
    const body = role === 'supervisor'
      ? { verdict: 'approve', axes, criteria: ids.map((id) => ({ id, pass: true, observed: true, evidence: ['check:smoke'], depends_on: [id === 'c1' ? 'src/a.txt' : 'src/b.txt'] })), issues: [], next_prompt: '' }
      : { verdict: 'approve', axes, blocking_issues: [], probes: ['p1', 'p2', 'p3'] };
    return forge(['verdict', role], JSON.stringify({ ...body, ...extra }));
  };

  // First verification is full: everything is dirty.
  let r = forge(['checks']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readScope(1).full, true);
  assert.deepEqual(readScope(1).dirty_criteria, ['c1', 'c2']);
  // A verdict that skips a dirty criterion is rejected.
  assert.notEqual(verdict('supervisor', ['c1']).status, 0);
  assert.equal(verdict('supervisor', ['c1', 'c2']).status, 0);
  assert.equal(verdict('critic').status, 0);
  assert.deepEqual(Object.keys(state().verified.criteria).sort(), ['c1', 'c2']);

  // Edit only a.txt and re-run checks in the same round: only c1 is dirty.
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'a2');
  r = forge(['checks']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readScope(1).dirty_criteria, ['c1']);
  assert.deepEqual(readScope(1).carried_criteria, ['c2']);
  assert.match(r.stdout, /re-verify 1 criteria/);
  assert.notEqual(verdict('supervisor', ['c2']).status, 0);
  assert.equal(verdict('supervisor', ['c1']).status, 0, 'only the dirty criterion needs assessing');

  // Editing an unrelated doc dirties nothing.
  fs.writeFileSync(path.join(proj, 'docs.md'), 'd2');
  r = forge(['checks']);
  assert.deepEqual(readScope(1).dirty_criteria, []);

  // A shared file change forces a full pass.
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"x"}');
  r = forge(['checks']);
  assert.equal(readScope(1).full, true);
  assert.match(readScope(1).full_reason, /shared/);

  // After a full pass the supervisor re-verifies everything, which refreshes the stored fingerprints.
  assert.equal(verdict('supervisor', ['c1', 'c2']).status, 0);

  // Fast path: previous verdict approved this stage and nothing relevant changed.
  const s0 = state();
  s0.last_eval = { approved: true, round: 1, stage: s0.plan.stages[s0.stage_idx].id };
  s0.last_axes = Object.fromEntries(s0.plan.axes.map((a) => [a.id, 10]));
  s0.round = 2;
  fs.writeFileSync(path.join(proj, '.forge', 'state.json'), JSON.stringify(s0));
  r = forge(['checks']);
  assert.match(r.stdout, /FAST PATH/);
  const sv = JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'verdict-2-supervisor.json'), 'utf8'));
  assert.equal(sv.synthetic, true);

  // Tweak mode needs a finished loop and then shortens everything.
  assert.notEqual(forge(['tweak', 'change the title']).status, 0, 'refuses while running');
  const s1 = state();
  s1.status = 'done';
  fs.writeFileSync(path.join(proj, '.forge', 'state.json'), JSON.stringify(s1));
  r = forge(['tweak', 'change', 'the', 'title']);
  assert.equal(r.status, 0, r.stderr);
  const s2 = state();
  assert.equal(s2.status, 'running');
  assert.equal(s2.mode, 'tweak');
  assert.equal(s2.stage_idx, s2.plan.stages.length - 1);
  assert.equal(s2.caps.max_minutes, 45);
  assert.equal(s2.round, s1.round + 1);
});

test('impact-selected checks: full run first, related-only after, one full confirm before approval; {forge} expands', () => {
  const proj = tmpProject();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  const forge = (args) => spawnSync(process.execPath, [FORGE, ...args], { cwd: proj, env, encoding: 'utf8' });
  const state = () => JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'state.json'), 'utf8'));
  const checksFile = () => JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'checks-1.json'), 'utf8'));
  const ran = () => (fs.existsSync(path.join(proj, 'ran.log')) ? fs.readFileSync(path.join(proj, 'ran.log'), 'utf8').trim().split('\n') : []);
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'a1');
  fs.writeFileSync(path.join(proj, 'rec.js'), "require('fs').appendFileSync('ran.log', process.argv.slice(2).join(' ') + '\\n');");
  assert.equal(forge(['init', 'x', '--auto']).status, 0);
  const plan = rawPlan();
  plan.checks = [
    { id: 'unit', cmd: 'node rec.js full', changed_cmd: 'node rec.js impact {changed}', changed_match: ['src/**'], stage: 'skeleton', timeout_s: 60 },
    { id: 'fx', cmd: '{forge} env', stage: 'skeleton', timeout_s: 60 },
  ];
  fs.writeFileSync(path.join(proj, '.forge', 'plan.draft.json'), JSON.stringify(plan));
  assert.equal(forge(['plan-set']).status, 0);
  assert.equal(forge(['start']).status, 0);

  let r = forge(['checks']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ran(), ['full'], 'first run in a stage is the full suite');
  assert.equal(checksFile().results.find((x) => x.id === 'fx').ok, true, '{forge} placeholder expands');

  fs.writeFileSync(path.join(proj, 'src', 'a.txt'), 'a2');
  r = forge(['checks']);
  assert.equal(ran().length, 2);
  assert.match(ran()[1], /^impact src\/a\.txt$/); // the shell strips the quotes around the path
  assert.equal(checksFile().results.find((x) => x.id === 'unit').impact, true);

  r = forge(['checks', '--confirm']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ran().slice(2), ['full'], 'confirm runs the full suite once');
  const unit = checksFile().results.find((x) => x.id === 'unit');
  assert.equal(unit.impact, false);
  assert.equal(unit.confirmed, true);
  assert.equal(state().verified.checks.unit.full_stage, 'skeleton');

  r = forge(['checks']); // nothing changed: carried, nothing runs
  assert.equal(ran().length, 3);
  assert.equal(checksFile().results.find((x) => x.id === 'unit').carried, true);
});

test('assert-json passes and fails on thresholds', () => {
  const proj = tmpProject();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  const run = (...a) => spawnSync(process.execPath, [FORGE, 'assert-json', ...a], { cwd: proj, env, encoding: 'utf8' });
  fs.writeFileSync(path.join(proj, 'r.json'), JSON.stringify({ categories: { performance: { score: 0.93 } }, items: [{ n: 'x' }] }));
  assert.equal(run('r.json', 'categories.performance.score', '>=', '0.9').status, 0);
  assert.equal(run('r.json', 'categories.performance.score', '>=', '0.95').status, 1);
  assert.equal(run('r.json', 'items.0.n', '==', 'x').status, 0);
  assert.equal(run('r.json', 'missing.path', '>=', '1').status, 1);
});

test('visual compare detects pixel differences (skipped without network)', async (t) => {
  const proj = tmpProject();
  const tools = path.join(proj, '.forge', 'tools');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: tools };
  const inst = spawnSync(process.execPath, [FORGE, 'tool', 'install', 'pngjs', 'pixelmatch'], { cwd: proj, env, encoding: 'utf8', timeout: 120000 });
  if (inst.status !== 0) return t.skip('could not install pngjs/pixelmatch (offline?)');
  process.env.FORGE_TOOLS_DIR = tools;
  const { loadImgLibs, comparePng } = await import('../scripts/lib/visual.mjs');
  const { PNG, pixelmatch } = await loadImgLibs(proj);
  const make = (w, h, dots = 0) => {
    const png = new PNG({ width: w, height: h });
    png.data.fill(255);
    for (let i = 0; i < dots; i++) { png.data[i * 4] = 0; png.data[i * 4 + 1] = 0; png.data[i * 4 + 2] = 0; }
    return PNG.sync.write(png);
  };
  assert.equal(comparePng(PNG, pixelmatch, make(10, 10), make(10, 10)).pct, 0);
  const d = comparePng(PNG, pixelmatch, make(10, 10), make(10, 10, 5));
  assert.ok(d.pct > 4 && d.pct < 6, `pct ${d.pct}`);
  assert.equal(comparePng(PNG, pixelmatch, make(10, 10), make(12, 10)).sizeMismatch, true);
});
