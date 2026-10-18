import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, evaluate } from '../scripts/lib/gate-logic.mjs';
import { makeState, fullArt, supervisorVerdict, criticVerdict } from './helpers.mjs';

const NOW = 1_000_000 + 60_000;
const cli = 'forge';
const empty = { checks: null, supervisor: null, critic: null, signoff: null, delivery: false };

test('inactive states allow stop', () => {
  for (const status of ['planning', 'done', 'aborted']) {
    assert.equal(decide(makeState({ status }), empty, NOW, { cli }).allow, true);
  }
});

test('missing artifacts: asks for checks and the supervisor; the critic waits until the supervisor approves', () => {
  const r = decide(makeState(), empty, NOW, { cli });
  assert.equal(r.allow, false);
  assert.match(r.reason, /checks/);
  assert.match(r.reason, /subagent_type "forge:supervisor"/);
  assert.doesNotMatch(r.reason, /subagent_type "forge:critic"/);
});

test('supervisor approved but no critic yet: only the critic is requested', () => {
  const s = makeState();
  const a = fullArt(s);
  const r = decide(s, { ...a, critic: null }, NOW, { cli });
  assert.equal(r.allow, false);
  assert.doesNotMatch(r.reason, /subagent_type "forge:supervisor"/);
  assert.match(r.reason, /subagent_type "forge:critic"/);
});

test('supervisor rejected: the critic is skipped and the builder gets feedback immediately', () => {
  const s = makeState({ last_critic_axes: { functionality: 9, correctness: 9, docs: 9 } });
  const a = fullArt(s, { sup: { verdict: 'continue', score: 6, issues: ['empty state is broken'], next_prompt: 'Fix the empty state first.' } });
  const r = decide(s, { ...a, critic: null }, NOW, { cli });
  assert.equal(r.allow, false);
  assert.doesNotMatch(r.reason, /forge:critic/);
  assert.match(r.reason, /empty state is broken/);
  assert.equal(r.state.round, 2);
  assert.equal(r.state.last_sup_approved, false);
});

test('parallel launch when approval is likely (previous supervisor approved, or final stage)', () => {
  for (const st of [makeState({ last_sup_approved: true }), makeState({ stage_idx: 4 })]) {
    const r = decide(st, { ...empty, checks: { round: 1, results: [], all_pass: true } }, NOW, { cli });
    assert.match(r.reason, /BOTH subagents in ONE message/);
    assert.match(r.reason, /subagent_type "forge:supervisor"/);
    assert.match(r.reason, /subagent_type "forge:critic"/);
  }
});

test('verifier model is opt-in and never applies to the final stage', () => {
  const early = decide(makeState({ opts: { bar: null, verifier_model: 'haiku' } }), empty, NOW, { cli });
  assert.match(early.reason, /Use model "haiku"/);
  const last = decide(makeState({ stage_idx: 4, opts: { bar: null, verifier_model: 'haiku' } }), empty, NOW, { cli });
  assert.doesNotMatch(last.reason, /Use model/);
  assert.doesNotMatch(decide(makeState(), empty, NOW, { cli }).reason, /Use model/);
});

test('round timing is recorded from artifact timestamps', () => {
  const s = makeState({ round_started_at: Date.parse('2026-01-01T00:00:00Z') });
  const a = fullArt(s);
  a.checks.started_at = '2026-01-01T00:10:00Z'; a.checks.ran_at = '2026-01-01T00:12:00Z';
  a.supervisor.written_at = '2026-01-01T00:20:00Z'; a.critic.written_at = '2026-01-01T00:25:00Z';
  const t = decide(s, a, NOW, { cli }).state.timings.at(-1);
  assert.equal(t.build_s, 600);
  assert.equal(t.checks_s, 120);
  assert.equal(t.verify_s, 780);
  assert.equal(t.critic_ran, true);
});

test('approved stage advances to the next stage and bumps the round', () => {
  const s = makeState();
  const r = decide(s, fullArt(s), NOW, { cli });
  assert.equal(r.allow, false);
  assert.equal(r.state.stage_idx, 1);
  assert.equal(r.state.round, 2);
  assert.match(r.reason, /PASSED/);
  assert.match(r.reason, /STAGE 2\/5/);
});

test('rejection by critic produces feedback and a new round', () => {
  const s = makeState();
  const r = decide(s, fullArt(s, { cri: { verdict: 'reject', blocking: ['crashes on empty input'], score: 7 } }), NOW, { cli });
  assert.equal(r.allow, false);
  assert.equal(r.state.stage_idx, 0);
  assert.equal(r.state.round, 2);
  assert.match(r.reason, /crashes on empty input/);
  assert.match(r.reason, /REJECTED/);
});

test('failing hard check blocks approval even when both agents approve', () => {
  const s = makeState();
  const a = fullArt(s);
  a.checks = { round: 1, results: [{ id: 'smoke', ok: false, code: 1, tail: 'boom' }], all_pass: false };
  const ev = evaluate(s, a);
  assert.equal(ev.approved, false);
  assert.ok(ev.problems.some((p) => /check FAILED: smoke/.test(p)));
});

test('unobserved criterion (blind spot) blocks approval', () => {
  const s = makeState();
  const ev = evaluate(s, fullArt(s, { sup: { observed: false } }));
  assert.equal(ev.approved, false);
  assert.ok(ev.problems.some((p) => /NOT OBSERVED/.test(p)));
});

test('missing criterion assessment blocks approval', () => {
  const s = makeState();
  const a = fullArt(s);
  a.supervisor.criteria = [];
  assert.equal(evaluate(s, a).approved, false);
});

test('axis score is the MIN of supervisor and critic', () => {
  const s = makeState();
  const a = fullArt(s, { sup: { score: 10 }, cri: { score: 4 } });
  const ev = evaluate(s, a);
  assert.equal(ev.approved, false);
  assert.ok(ev.failedAxes.length > 0);
  assert.ok(ev.failedAxes.every((f) => f.score === 4));
});

test('non-critical axes get one point of slack, critical do not', () => {
  const s = makeState({ stage_idx: 2 }); // harden, bar 9
  const a = fullArt(s);
  a.supervisor.axes.docs = 8; a.critic.axes.docs = 8; // non-critical, 8 >= 9-1
  assert.equal(evaluate(s, a).failedAxes.length, 0);
  a.supervisor.axes.functionality = 8; // critical, needs 9
  assert.deepEqual(evaluate(s, a).failedAxes.map((f) => f.id), ['functionality']);
});

test('supervisor needs_tool routes to the toolsmith and restarts verification', () => {
  const s = makeState();
  const a = fullArt(s, { sup: { verdict: 'continue', observed: false, needs_tool: [{ what: 'playwright', why: 'c1 screenshot' }] } });
  const r = decide(s, a, NOW, { cli });
  assert.equal(r.allow, false);
  assert.match(r.reason, /forge:toolsmith/);
  assert.match(r.reason, /playwright/);
  assert.equal(r.state.round, 2);
});

test('final stage approval requires builder sign-off', () => {
  const s = makeState({ stage_idx: 4, round: 9 });
  const r = decide(s, fullArt(s), NOW, { cli });
  assert.equal(r.allow, false);
  assert.match(r.reason, /FINAL GATE/);
  assert.match(r.reason, /signoff complete/);
  assert.equal(r.state.status, 'running');
});

test('incomplete sign-off continues the loop', () => {
  const s = makeState({ stage_idx: 4, round: 9 });
  const r = decide(s, fullArt(s, { signoff: { round: 9, complete: false, notes: 'search box is a stub' } }), NOW, { cli });
  assert.equal(r.allow, false);
  assert.equal(r.state.status, 'running');
  assert.match(r.reason, /search box is a stub/);
  assert.equal(r.state.round, 10);
});

test('complete sign-off moves to delivering, then DELIVERY.md ends the loop', () => {
  const s = makeState({ stage_idx: 4, round: 9 });
  const r = decide(s, fullArt(s, { signoff: { round: 9, complete: true, notes: 'verified' } }), NOW, { cli });
  assert.equal(r.allow, false);
  assert.equal(r.state.status, 'delivering');
  assert.equal(r.state.delivering_reason, 'approved');
  assert.match(r.reason, /DELIVERY\.md/);
  const r2 = decide(r.state, { ...empty, delivery: true }, NOW, { cli });
  assert.equal(r2.allow, true);
  assert.equal(r2.state.status, 'done');
});

test('delivering gives up after repeated reminders (never traps the user)', () => {
  let st = makeState({ status: 'delivering', delivering_reason: 'approved' });
  let res;
  for (let i = 0; i < 3; i++) { res = decide(st, empty, NOW, { cli }); st = res.state; }
  assert.equal(res.allow, true);
  assert.equal(st.status, 'done');
});

test('round cap, time cap, and loop budget all end in delivering(capped)', () => {
  let r = decide(makeState({ round: 41 }), empty, NOW, { cli });
  assert.equal(r.state.delivering_reason, 'capped');
  r = decide(makeState(), empty, 1_000_000 + 241 * 60000, { cli });
  assert.equal(r.state.delivering_reason, 'capped');
  r = decide(makeState({ blocks: 400 }), empty, NOW, { cli });
  assert.equal(r.state.delivering_reason, 'capped');
});

test('idle detection: repeated stops with no progress end in delivering(stalled)', () => {
  let st = makeState();
  let res;
  for (let i = 0; i < 6; i++) {
    res = decide(st, empty, NOW, { cli });
    st = res.state;
    if (st.status === 'delivering') break;
  }
  assert.equal(st.status, 'delivering');
  assert.equal(st.delivering_reason, 'stalled');
});

test('stall: 3 rounds without gain forces a strategy change; repeated stalls end the run', () => {
  let st = makeState();
  const bad = () => fullArt(st, { cri: { verdict: 'reject', blocking: ['x'], score: 5 } });
  const notes = [];
  for (let i = 0; i < 12 && st.status === 'running'; i++) {
    const res = decide(st, bad(), NOW, { cli });
    st = res.state;
    if (/STALL/.test(res.reason || '')) notes.push(i);
  }
  assert.ok(notes.length >= 1, 'strategy change was demanded');
  assert.equal(st.status, 'delivering');
  assert.equal(st.delivering_reason, 'stalled');
});

test('reasons stay bounded', () => {
  const s = makeState();
  const a = fullArt(s, { cri: { verdict: 'reject', blocking: Array.from({ length: 200 }, (_, i) => 'issue number ' + i + ' ' + 'x'.repeat(100)) } });
  const r = decide(s, a, NOW, { cli });
  assert.ok(r.reason.length <= 7000);
});
