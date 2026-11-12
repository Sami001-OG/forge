import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shardCount, partition, mergeSupervisor } from '../scripts/lib/shards.mjs';
import { decide, activeChecks, criticNeeded } from '../scripts/lib/gate-logic.mjs';
import { normalizePlan, validatePlan } from '../scripts/lib/plan.mjs';
import { tmpProject, rawPlan, makeState } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE = path.join(root, 'scripts', 'forge.mjs');
const NOW = 1_060_000;
const cli = 'forge';
const empty = { checks: null, supervisor: null, critic: null, signoff: null, delivery: false, supShards: [] };
const passing = (ids = ['smoke']) => ({ round: 1, results: ids.map((id) => ({ id, ok: true, code: 0, tail: '' })), all_pass: true });

test('shards: counts, balanced round-robin partition, lead-shard merge', () => {
  assert.deepEqual([0, 4, 5, 9, 10, 30].map((n) => shardCount(n)), [1, 1, 2, 2, 3, 3]);
  assert.equal(shardCount(30, 2), 2);
  assert.equal(shardCount(30, 1), 1);
  assert.deepEqual(partition(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'c', 'e'], ['b', 'd']]);
  assert.deepEqual(partition([], 3), [[], [], []]);
  const m = mergeSupervisor([
    { shard: 1, verdict: 'continue', criteria: [{ id: 'c2' }], issues: ['b'], next_prompt: 'fix c2', written_at: '2026-01-01T00:00:02Z' },
    { shard: 0, verdict: 'approve', axes: { x: 9 }, criteria: [{ id: 'c1' }], issues: [], next_prompt: '', written_at: '2026-01-01T00:00:01Z' },
  ]);
  assert.equal(m.verdict, 'continue', 'one dissenting shard blocks approval');
  assert.deepEqual(m.axes, { x: 9 });
  assert.deepEqual(m.criteria.map((c) => c.id), ['c1', 'c2']);
  assert.match(m.next_prompt, /\[shard 2\] fix c2/);
  assert.equal(mergeSupervisor([{ shard: 0, verdict: 'approve', axes: {}, criteria: [] }, { shard: 1, verdict: 'approve', criteria: [] }]).verdict, 'approve');
});

test('fail-fast: a failing machine check rejects at once, with no reviewer launched', () => {
  const s = makeState();
  const a = { ...empty, checks: { round: 1, results: [{ id: 'smoke', ok: false, code: 1, tail: 'TypeError: x is not a function' }], all_pass: false } };
  const r = decide(s, a, NOW, { cli });
  assert.equal(r.allow, false);
  assert.match(r.reason, /REJECTED by the machine checks/);
  assert.match(r.reason, /No review was run/);
  assert.match(r.reason, /TypeError: x is not a function/);
  assert.doesNotMatch(r.reason, /subagent_type/);
  assert.equal(r.state.round, 2);
  assert.equal(r.state.history.at(-1).failfast, true);
});

test('fail-fast: the same failure repeating forces a new approach, then ends the run', () => {
  let st = makeState();
  const bad = () => ({ ...empty, checks: { round: st.round, results: [{ id: 'smoke', ok: false, code: 1, tail: 'boom' }], all_pass: false } });
  const notes = [];
  for (let i = 0; i < 8 && st.status === 'running'; i++) { const r = decide(st, bad(), NOW, { cli }); st = r.state; if (/STALL/.test(r.reason || '')) notes.push(i); }
  assert.ok(notes.length >= 1);
  assert.equal(st.status, 'delivering');
  assert.equal(st.delivering_reason, 'stalled');
  const s2 = makeState({ ff: { sig: 'other', n: 5 } });
  assert.equal(decide(s2, bad(), NOW, { cli }).state.ff.n, 1, 'a different failure resets the streak');
});

test('phase B launches every reviewer and the slow checks in ONE message; only missing shards are asked for', () => {
  const plan = rawPlan();
  plan.checks = [{ id: 'smoke', cmd: 'true', stage: 'skeleton' }, { id: 'e2e', cmd: 'true', stage: 'skeleton', tier: 'slow' }];
  const s = makeState({ plan: normalizePlan(plan), last_sup_approved: true });
  const a = { ...empty, checks: passing(['smoke']), scope: { shards: [['c1'], ['c2'], ['c3']] } };
  const r = decide(s, a, NOW, { cli });
  assert.match(r.reason, /Launch ALL of these in ONE message/);
  assert.match(r.reason, /forge checks --tier slow/);
  for (const i of [1, 2, 3]) assert.match(r.reason, new RegExp(`shard ${i}/3`));
  assert.match(r.reason, /lead shard you also score the axes/);
  assert.match(r.reason, /subagent_type "forge:critic"/, 'approval is likely, so the critic runs in parallel too');
  const r2 = decide(s, { ...a, checks: passing(['smoke', 'e2e']), supShards: [0, 2] }, NOW, { cli });
  assert.match(r2.reason, /shard 2\/3/);
  assert.doesNotMatch(r2.reason, /shard 1\/3|shard 3\/3/);
  assert.doesNotMatch(r2.reason, /--tier slow/);
});

test('--fast: slow checks and the critic wait for the final stage', () => {
  const plan = rawPlan();
  plan.checks = [{ id: 'smoke', cmd: 'true', stage: 'skeleton' }, { id: 'e2e', cmd: 'true', stage: 'skeleton', tier: 'slow' }];
  const norm = normalizePlan(plan);
  const early = makeState({ plan: norm, opts: { bar: null, fast: true } });
  assert.deepEqual(activeChecks(early).map((c) => c.id), ['smoke']);
  assert.equal(criticNeeded(early, { supervisor: { verdict: 'approve' } }), false);
  const last = makeState({ plan: norm, stage_idx: 4, opts: { bar: null, fast: true } });
  assert.deepEqual(activeChecks(last).map((c) => c.id), ['smoke', 'e2e']);
  assert.equal(criticNeeded(last, { supervisor: { verdict: 'approve' } }), true);
  assert.deepEqual(activeChecks(makeState({ plan: norm })).map((c) => c.id), ['smoke', 'e2e']);
});

test('plan: tier and after are validated', () => {
  const p = rawPlan();
  p.checks = [{ id: 'build', cmd: 'true', stage: 'skeleton' }, { id: 'e2e', cmd: 'true', stage: 'skeleton', tier: 'slow', after: ['build'] }];
  assert.deepEqual(validatePlan(normalizePlan(p), tmpProject()), []);
  p.checks[1].tier = 'glacial';
  p.checks.push({ id: 'x', cmd: 'true', after: ['nope'] });
  const errs = validatePlan(normalizePlan(p), tmpProject()).join('\n');
  assert.match(errs, /tier must be fast or slow/);
  assert.match(errs, /after refers to unknown check nope/);
  assert.equal(normalizePlan(rawPlan()).checks[0].tier, 'fast', 'tier defaults to fast');
});

// ---------- the CLI, for real ----------
function project(planMut) {
  const proj = tmpProject();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  const forge = (args, input) => spawnSync(process.execPath, [FORGE, ...args], { cwd: proj, env, encoding: 'utf8', input });
  const readJson = (f) => JSON.parse(fs.readFileSync(path.join(proj, '.forge', f), 'utf8'));
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  for (let i = 1; i <= 6; i++) fs.writeFileSync(path.join(proj, 'src', `f${i}.txt`), `v${i}`);
  assert.equal(forge(['init', 'x', '--auto']).status, 0);
  const plan = rawPlan();
  planMut(plan);
  fs.writeFileSync(path.join(proj, '.forge', 'plan.draft.json'), JSON.stringify(plan));
  const ps = forge(['plan-set']);
  assert.equal(ps.status, 0, ps.stderr);
  assert.equal(forge(['start']).status, 0);
  return { proj, forge, readJson };
}
const sleepCmd = (ms) => `node -e "setTimeout(()=>{},${ms})"`;

test('checks run in parallel: four 1-second checks finish in about one second', () => {
  const { forge, readJson } = project((p) => { p.checks = ['a', 'b', 'c', 'd'].map((id) => ({ id, cmd: sleepCmd(1000), stage: 'skeleton' })); });
  const t0 = Date.now();
  const r = forge(['checks', '--jobs', '4']);
  const took = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(took < 2800, `took ${took}ms; sequential would be about 4000ms`);
  assert.deepEqual(readJson('checks-1.json').results.map((x) => x.id), ['a', 'b', 'c', 'd'], 'results keep plan order');
  assert.equal(readJson('checks-1.json').all_pass, true);
  assert.match(r.stdout, /up to 4 at a time/);
});

test('check dependencies: a dependent of a failed check is skipped, not run', () => {
  const { forge, readJson } = project((p) => { p.checks = [{ id: 'build', cmd: 'node -e "process.exit(1)"', stage: 'skeleton' }, { id: 'e2e', cmd: sleepCmd(5000), stage: 'skeleton', after: ['build'] }]; });
  const t0 = Date.now();
  const r = forge(['checks']);
  assert.ok(Date.now() - t0 < 4000, 'the 5s dependent never ran');
  const res = readJson('checks-1.json').results;
  assert.equal(res.find((x) => x.id === 'build').ok, false);
  const e2e = res.find((x) => x.id === 'e2e');
  assert.equal(e2e.code, -2);
  assert.match(e2e.tail, /skipped: it depends on check "build"/);
  assert.match(r.stdout, /NEXT: fix the failing checks/);
});

test('tiers: fast first, slow merged into the same round and scope', () => {
  const { forge, readJson } = project((p) => { p.checks = [{ id: 'unit', cmd: 'node -e "0"', stage: 'skeleton' }, { id: 'e2e', cmd: 'node -e "0"', stage: 'skeleton', tier: 'slow' }]; });
  let r = forge(['checks', '--tier', 'fast']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readJson('checks-1.json').results.map((x) => x.id), ['unit']);
  assert.match(r.stdout, /NEXT: end your turn/);
  const scope1 = readJson('scope-1.json');
  r = forge(['checks', '--tier', 'slow']);
  assert.equal(r.status, 0, r.stderr);
  const merged = readJson('checks-1.json');
  assert.deepEqual(merged.results.map((x) => x.id), ['unit', 'e2e']);
  assert.equal(merged.all_pass, true);
  assert.deepEqual(readJson('scope-1.json').dirty_criteria, scope1.dirty_criteria, 'the slow tier reuses the round scope');
  const w = forge(['wait', 'checks', '--timeout', '5']);
  assert.equal(w.status, 0);
  assert.match(w.stdout, /all checks recorded/);
});

test('wait checks times out when a slow check never reports', () => {
  const { forge } = project((p) => { p.checks = [{ id: 'unit', cmd: 'node -e "0"', stage: 'skeleton' }, { id: 'e2e', cmd: 'node -e "0"', stage: 'skeleton', tier: 'slow' }]; });
  forge(['checks', '--tier', 'fast']);
  const r = forge(['wait', 'checks', '--timeout', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /timed out waiting for checks: e2e/);
});

test('sharded supervisors: partial verdicts wait, the lead scores axes, the merge completes the round', () => {
  const { forge, readJson, proj } = project((p) => {
    p.criteria = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `c${i}`, text: `Feature number ${i} works for real input`, stage: 'skeleton', critical: true, scope: [`src/f${i}.txt`], observe: { method: 'run', tool: 'builtin' } }));
    p.checks = [{ id: 'unit', cmd: 'node -e "0"', stage: 'skeleton' }];
  });
  assert.equal(forge(['checks']).status, 0);
  const sc = readJson('scope-1.json');
  assert.equal(sc.shards.length, 2);
  assert.deepEqual(sc.shards, [['c1', 'c3', 'c5'], ['c2', 'c4', 'c6']]);
  const entry = (id) => ({ id, pass: true, observed: true, evidence: ['check:unit'], depends_on: [`src/f${id.slice(1)}.txt`] });
  const axes = Object.fromEntries(readJson('state.json').plan.axes.map((a) => [a.id, 9]));
  let r = forge(['verdict', 'supervisor', '--shard', '1'], JSON.stringify({ verdict: 'approve', criteria: [entry('c2')], issues: [] }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /criterion c4 changed .* must be assessed/);
  r = forge(['verdict', 'supervisor', '--shard', '1'], JSON.stringify({ verdict: 'approve', criteria: ['c2', 'c4', 'c6'].map(entry), issues: [] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /waiting for the other shards/);
  assert.ok(!fs.existsSync(path.join(proj, '.forge', 'verdict-1-supervisor.json')), 'not merged yet');
  r = forge(['verdict', 'supervisor', '--shard', '0'], JSON.stringify({ verdict: 'approve', criteria: ['c1', 'c3', 'c5'].map(entry), issues: [] }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /axes/);
  r = forge(['verdict', 'supervisor', '--shard', '0'], JSON.stringify({ verdict: 'approve', axes, criteria: ['c1', 'c3', 'c5'].map(entry), issues: [] }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /merged/);
  const merged = readJson('verdict-1-supervisor.json');
  assert.equal(merged.shards, 2);
  assert.deepEqual(merged.criteria.map((c) => c.id).sort(), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.deepEqual(merged.axes, axes);
  assert.deepEqual(Object.keys(readJson('state.json').verified.criteria).sort(), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  const g = spawnSync(process.execPath, [path.join(root, 'scripts', 'guard.mjs')], { cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: 'utf8', input: JSON.stringify({ cwd: proj, tool_name: 'Write', tool_input: { file_path: path.join(proj, '.forge', 'verdict-1-supervisor.shard-0.json') } }) });
  assert.equal(g.status, 2, 'shard files are protected from hand edits');
});

test('init --fast: tighter caps and plateau', () => {
  const proj = tmpProject();
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
  assert.equal(spawnSync(process.execPath, [FORGE, 'init', 'x', '--fast'], { cwd: proj, env, encoding: 'utf8' }).status, 0);
  const st = JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'state.json'), 'utf8'));
  assert.equal(st.opts.fast, true);
  assert.equal(st.opts.plateau, 1);
  assert.equal(st.caps.max_rounds, 15);
  assert.equal(st.caps.max_minutes, 120);
});
