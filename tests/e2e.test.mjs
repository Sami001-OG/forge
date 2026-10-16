// Drives the real CLI and the real Stop-hook script through a complete loop in a temp project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpProject, rawPlan } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGE = path.join(root, 'scripts', 'forge.mjs');
const GATE = path.join(root, 'scripts', 'gate.mjs');
const GUARD = path.join(root, 'scripts', 'guard.mjs');

const proj = tmpProject();
const env = { ...process.env, CLAUDE_PROJECT_DIR: proj };
const forge = (args, input) => spawnSync(process.execPath, [FORGE, ...args], { cwd: proj, env, encoding: 'utf8', input });
const hook = (script, payload) => spawnSync(process.execPath, [script], { cwd: proj, env, encoding: 'utf8', input: JSON.stringify({ cwd: proj, session_id: 's1', ...payload }) });
const stop = () => hook(GATE, { hook_event_name: 'Stop', stop_hook_active: false });
const state = () => JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'state.json'), 'utf8'));

function verdicts(sup = {}, cri = {}) {
  const s = state();
  const axes = Object.fromEntries(s.plan.axes.map((a) => [a.id, 10]));
  const idx = s.stage_idx;
  const crit = s.plan.criteria.filter((c) => s.plan.stages.findIndex((x) => x.id === c.stage) <= idx);
  const sv = { verdict: 'approve', axes, criteria: crit.map((c) => ({ id: c.id, pass: true, observed: true, evidence: ['check:smoke'] })), issues: [], next_prompt: 'ok then', ...sup };
  const cv = { verdict: 'approve', axes, blocking_issues: [], probes: ['a', 'b', 'c'], ...cri };
  return [forge(['verdict', 'supervisor'], JSON.stringify(sv)), forge(['verdict', 'critic'], JSON.stringify(cv))];
}

test('doctor passes on this machine', () => {
  const r = forge(['doctor']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /catalog: \d+ tools/);
});

test('hook is inert when no loop exists', () => {
  assert.equal(stop().status, 0);
  assert.equal(stop().stdout, '');
});

test('full loop: init -> plan -> start -> reject -> fix -> advance through all stages -> sign-off -> deliver', () => {
  assert.equal(forge(['init', 'build', 'a', 'tool', '--auto', '--bar', '9']).status, 0);
  assert.equal(stop().stdout, '', 'planning status must not block');

  fs.writeFileSync(path.join(proj, '.forge', 'plan.draft.json'), JSON.stringify({ ...rawPlan(), checks: [{ id: 'smoke', cmd: 'node -e "process.exit(0)"', stage: 'skeleton' }] }));
  let r = forge(['plan-set']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(proj, '.forge', 'rubric.md')));

  r = forge(['start']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /STAGE 1\/5/);
  assert.equal(state().status, 'running');

  // Builder stops with nothing verified: the gate demands the protocol.
  let g = JSON.parse(stop().stdout);
  assert.equal(g.decision, 'block');
  assert.match(g.reason, /checks/);

  // A verdict cannot be recorded without this round's checks existing (evidence check:smoke).
  assert.notEqual(verdicts()[0].status, 0);

  assert.equal(forge(['checks']).status, 0);
  let [a, b] = verdicts({ verdict: 'continue', next_prompt: 'Make the help text complete and accurate.', issues: ['help text is thin'] }, { verdict: 'reject', blocking_issues: ['crashes on empty arg'] });
  assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
  g = JSON.parse(stop().stdout);
  assert.match(g.reason, /crashes on empty arg/);
  assert.match(g.reason, /Make the help text/);
  assert.equal(state().round, 2);

  // Pass every stage.
  for (let stage = 0; stage < 5; stage++) {
    assert.equal(forge(['checks']).status, 0);
    [a, b] = verdicts();
    assert.equal(a.status, 0, a.stderr); assert.equal(b.status, 0, b.stderr);
    g = JSON.parse(stop().stdout);
    if (stage < 4) { assert.match(g.reason, /PASSED/); assert.equal(state().stage_idx, stage + 1); }
  }
  assert.match(g.reason, /FINAL GATE/);

  assert.equal(forge(['signoff', 'complete', 'verified', 'end', 'to', 'end']).status, 0);
  g = JSON.parse(stop().stdout);
  assert.match(g.reason, /DELIVERY\.md/);
  assert.equal(state().status, 'delivering');

  fs.writeFileSync(path.join(proj, '.forge', 'DELIVERY.md'), '# done');
  const last = stop();
  assert.equal(last.stdout, '');
  assert.equal(state().status, 'done');
  assert.equal(stop().stdout, '');
});

test('verdict validation rejects fake evidence and missing axes', () => {
  forge(['init', 'x', '--auto', '--force']);
  fs.writeFileSync(path.join(proj, '.forge', 'plan.draft.json'), JSON.stringify(rawPlan()));
  assert.equal(forge(['plan-set']).status, 0);
  assert.equal(forge(['start']).status, 0);
  assert.equal(forge(['checks']).status, 0);
  const s = state();
  const axes = Object.fromEntries(s.plan.axes.map((a) => [a.id, 9]));
  const fake = forge(['verdict', 'supervisor'], JSON.stringify({ verdict: 'approve', axes, criteria: [{ id: 'c1', pass: true, observed: true, evidence: ['file:.forge/evidence/nope.png'] }], issues: [] }));
  assert.notEqual(fake.status, 0);
  assert.match(fake.stderr, /does not exist/);
  const noAxes = forge(['verdict', 'critic'], JSON.stringify({ verdict: 'approve', axes: { functionality: 9 }, blocking_issues: [], probes: ['a', 'b', 'c'] }));
  assert.notEqual(noAxes.status, 0);
  assert.match(noAxes.stderr, /axes\.correctness/);
  const lazy = forge(['verdict', 'critic'], JSON.stringify({ verdict: 'approve', axes, blocking_issues: [], probes: ['only one'] }));
  assert.notEqual(lazy.status, 0);
});

test('guard blocks hand-edits of loop state, allows the rest', () => {
  const edit = hook(GUARD, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, '.forge', 'state.json') } });
  assert.equal(edit.status, 2);
  const ok = hook(GUARD, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, 'src', 'app.js') } });
  assert.equal(ok.status, 0);
  const sh = hook(GUARD, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo {} > .forge/checks-1.json' } });
  assert.equal(sh.status, 2);
});

test('a different session is never affected by the loop', () => {
  const s = state();
  s.session_id = 'owner';
  fs.writeFileSync(path.join(proj, '.forge', 'state.json'), JSON.stringify(s));
  const other = hook(GATE, { hook_event_name: 'Stop', session_id: 'someone-else' });
  assert.equal(other.status, 0);
  assert.equal(other.stdout, '');
});

test('abort silences the hook', () => {
  assert.equal(forge(['abort']).status, 0);
  assert.equal(stop().stdout, '');
});

test('tool provisioning policy: approval and credentials are enforced', () => {
  const sys = forge(['tool', 'install', 'trivy']);
  assert.notEqual(sys.status, 0);
  assert.match(sys.stdout, /NEEDS_APPROVAL/);
  const cred = forge(['tool', 'install', 'flyctl']);
  assert.notEqual(cred.status, 0);
  assert.match(cred.stdout, /FLY_API_TOKEN/);
  const info = forge(['tool', 'list', '--bundle', 'web-pro']);
  assert.match(info.stdout, /playwright/);
});

test('forge exec puts project-local tools on PATH; env prints the export line', () => {
  const dir = path.join(proj, '.forge', 'tools', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'forge-demo-tool');
  fs.writeFileSync(bin, '#!/bin/sh\necho demo-tool-ok\n');
  fs.chmodSync(bin, 0o755);
  const r = forge(['exec', '--', 'forge-demo-tool']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /demo-tool-ok/);
  const missing = forge(['exec', '--', 'definitely-not-a-real-binary-xyz']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /not found|not on PATH/i);
  const e = forge(['env']);
  assert.match(e.stdout, /export PATH=.*\.forge\/tools\/bin/);
});

test('SessionStart hook writes PATH into CLAUDE_ENV_FILE, idempotently and silently', () => {
  const envFile = path.join(proj, 'envfile.sh');
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'env-hook.mjs')], { cwd: proj, env: { ...env, CLAUDE_ENV_FILE: envFile }, encoding: 'utf8', input: JSON.stringify({ cwd: proj, hook_event_name: 'SessionStart' }) });
  const a = run(); const b = run();
  assert.equal(a.status, 0); assert.equal(a.stdout, '');
  const txt = fs.readFileSync(envFile, 'utf8');
  assert.equal(txt.split('\n').filter((l) => l.includes('forge-tools-path')).length, 1);
  assert.match(txt, /\.forge\/tools\/venv\/bin/);
  assert.equal(b.status, 0);
});
