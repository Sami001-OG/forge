import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePlan } from '../scripts/lib/plan.mjs';
import { DEFAULT_CAPS } from '../scripts/lib/state.mjs';

export const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));

export const rawPlan = () => ({
  summary: 'A small command-line tool that does a thing very well, with tests and docs.',
  target_type: 'cli-lib',
  environment: 'local',
  remote: { kind: 'none', notes: '' },
  bundles: ['core'],
  builder_notes: 'Plain Node, no dependencies.',
  axes: [
    { id: 'functionality', critical: true, anchor: '10 = every feature works end to end' },
    { id: 'correctness', critical: true, anchor: '10 = edge cases handled' },
    { id: 'docs', critical: false, anchor: '10 = a stranger can use it from the README' },
  ],
  criteria: [
    { id: 'c1', text: 'The tool runs and prints help text', stage: 'skeleton', critical: true, observe: { method: 'run', tool: 'builtin' } },
    { id: 'c2', text: 'The main command produces correct output for real input', stage: 'function', critical: true, observe: { method: 'run', tool: 'builtin' } },
  ],
  checks: [{ id: 'smoke', cmd: 'node -e "process.exit(0)"', stage: 'skeleton' }],
});

export const makeState = (over = {}) => ({
  version: 1, status: 'running', prompt: 'build a tool', auto: true, opts: { bar: null },
  created_at: 1_000_000, caps: { ...DEFAULT_CAPS }, round: 1, stage_idx: 0, blocks: 0, idle_blocks: 0, last_fp: null,
  history: [], best: null, stall: { rounds_without_gain: 0, strategy_changes: 0 }, session_id: null,
  plan: normalizePlan(rawPlan()), ...over,
});

export const goodChecks = (state) => ({ round: state.round, results: state.plan.checks.map((c) => ({ id: c.id, ok: true, code: 0, tail: '' })), all_pass: true });

export const supervisorVerdict = (state, o = {}) => {
  const axes = Object.fromEntries(state.plan.axes.map((a) => [a.id, o.score ?? 10]));
  const idx = state.stage_idx;
  const crit = state.plan.criteria.filter((c) => state.plan.stages.findIndex((s) => s.id === c.stage) <= idx);
  return {
    verdict: o.verdict ?? 'approve', axes,
    criteria: crit.map((c) => ({ id: c.id, pass: o.pass ?? true, observed: o.observed ?? true, evidence: ['check:smoke'] })),
    issues: o.issues ?? [], next_prompt: o.next_prompt ?? 'Do the thing better, concretely.', needs_tool: o.needs_tool,
  };
};

export const criticVerdict = (state, o = {}) => ({
  verdict: o.verdict ?? 'approve',
  axes: Object.fromEntries(state.plan.axes.map((a) => [a.id, o.score ?? 10])),
  blocking_issues: o.blocking ?? [], probes: ['p1', 'p2', 'p3'],
});

export const fullArt = (state, o = {}) => ({
  checks: o.checks ?? goodChecks(state),
  supervisor: o.supervisor ?? supervisorVerdict(state, o.sup),
  critic: o.critic ?? criticVerdict(state, o.cri),
  signoff: o.signoff ?? null,
  delivery: false,
});
