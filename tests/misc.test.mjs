import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isProtectedPath, bashTouchesProtected } from '../scripts/lib/guard-logic.mjs';
import { pickVersion, cmpVersion } from '../scripts/lib/versions.mjs';
import { loadCatalog, loadBundles, loadTargets, catalogDir } from '../scripts/lib/catalog.mjs';
import { normalizePlan, validatePlan } from '../scripts/lib/plan.mjs';
import { rawPlan, tmpProject } from './helpers.mjs';

test('guard: protected paths', () => {
  const p = '/proj';
  assert.equal(isProtectedPath(p, '/proj/.forge/state.json'), true);
  assert.equal(isProtectedPath(p, '.forge/verdict-3-supervisor.json'), true);
  assert.equal(isProtectedPath(p, '.forge/checks-2.json'), true);
  assert.equal(isProtectedPath(p, '.forge/approvals.json'), true);
  assert.equal(isProtectedPath(p, '.forge/plan.draft.json'), false);
  assert.equal(isProtectedPath(p, '.forge/DELIVERY.md'), false);
  assert.equal(isProtectedPath(p, 'src/state.json'), false);
  assert.equal(isProtectedPath(p, '../elsewhere/.forge/state.json'), false);
});

test('guard: bash writes to protected files are blocked, forge CLI and reads are not', () => {
  assert.equal(bashTouchesProtected('echo {} > .forge/state.json'), true);
  assert.equal(bashTouchesProtected('sed -i s/a/b/ .forge/verdict-1-critic.json'), true);
  assert.equal(bashTouchesProtected('rm .forge/checks-1.json'), true);
  assert.equal(bashTouchesProtected('cat .forge/state.json'), false);
  assert.equal(bashTouchesProtected('npm run build'), false);
  assert.equal(bashTouchesProtected('node "/x/scripts/forge.mjs" verdict critic <<EOF\n{}\nEOF'), false);
});

test('versions: newest stable release at least 14 days old', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const times = {
    '1.0.0': '2026-01-01T00:00:00Z',
    '1.2.0': '2026-09-01T00:00:00Z',
    '1.3.0': '2026-10-10T00:00:00Z', // too new
    '2.0.0-beta.1': '2026-08-01T00:00:00Z', // prerelease
  };
  assert.equal(pickVersion(times, now), '1.2.0');
  assert.equal(pickVersion({ '3.0.0': '2026-10-14T00:00:00Z' }, now), null);
  assert.ok(cmpVersion('1.10.0', '1.9.0') > 0);
});

test('catalog: large, consistent, safe', () => {
  const tools = loadCatalog();
  assert.ok(tools.length >= 100, `catalog has ${tools.length} tools`);
  const ids = new Set();
  for (const t of tools) {
    assert.ok(!ids.has(t.id), 'duplicate ' + t.id);
    ids.add(t.id);
    assert.ok(['npm', 'pip', 'system', 'builtin'].includes(t.install.method), t.id);
    assert.ok([0, 1, 2, 3].includes(t.tier), t.id);
    assert.ok(t.summary && t.summary.length > 5, t.id);
    if (t.install.method === 'system') assert.ok(t.tier >= 2, `system tool ${t.id} must need approval`);
    if (t.install.method === 'npm') assert.ok(t.install.pkg, t.id);
    if (t.install.method === 'pip') assert.ok(t.install.pkg, t.id);
    if (t.tier === 3) assert.ok(t.requires_env?.length, `${t.id} tier 3 needs requires_env`);
    for (const r of t.requires || []) assert.ok(tools.find((x) => x.id === r), `${t.id} requires unknown ${r}`);
  }
  const bundles = loadBundles();
  for (const [b, list] of Object.entries(bundles)) for (const id of list) assert.ok(ids.has(id), `${b} -> ${id}`);
  const targets = loadTargets().targets;
  for (const [n, t] of Object.entries(targets)) for (const b of t.bundles) assert.ok(b === 'core' || bundles[b], `${n} -> ${b}`);
});

test('catalog: tools.json is up to date with build.mjs', async () => {
  const { spawnSync } = await import('node:child_process');
  const before = fs.readFileSync(path.join(catalogDir, 'tools.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(catalogDir, 'build.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(catalogDir, 'tools.json'), 'utf8'), before);
});

test('plan: example plan validates; common mistakes are caught', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(catalogDir, 'plan.example.json'), 'utf8'));
  assert.deepEqual(validatePlan(normalizePlan(ex), tmpProject()), []);
  const ok = normalizePlan(rawPlan());
  assert.deepEqual(validatePlan(ok, tmpProject()), []);
  const bad = normalizePlan(rawPlan());
  bad.criteria[0].observe.tool = 'not-a-real-tool';
  bad.criteria[1].stage = 'nope';
  bad.checks = [];
  bad.axes = bad.axes.slice(0, 1);
  const errs = validatePlan(bad, tmpProject()).join('\n');
  assert.match(errs, /not in the catalog/);
  assert.match(errs, /stage must be one of/);
  assert.match(errs, /at least one hard check/);
  assert.match(errs, /at least 3 rubric axes/);
});

test('plan: --bar raises the last three stage bars', () => {
  const p = normalizePlan(rawPlan(), { bar: 10 });
  assert.equal(p.bars.finish, 10);
  assert.equal(p.bars.polish, 10);
  assert.equal(p.bars.skeleton, 6);
});
