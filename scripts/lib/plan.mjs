import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, loadBundles, loadTargets } from './catalog.mjs';
import { DEFAULT_STAGES, DEFAULT_BARS, STAGE_PRESETS } from './state.mjs';
import { forgeDir } from './util.mjs';
import { DEFAULT_SHARED } from './fingerprint.mjs';

const METHODS = new Set(['screenshot', 'test', 'http', 'run', 'inspect', 'metric', 'manual']);
const ENVS = new Set(['local', 'remote', 'hybrid']);

export function normalizePlan(plan, opts = {}) {
  const p = structuredClone(plan);
  const preset = STAGE_PRESETS[p.stage_preset] || STAGE_PRESETS.full;
  p.stages = Array.isArray(p.stages) && p.stages.length ? p.stages : structuredClone(preset.stages);
  for (const s of p.stages) s.name ||= s.id;
  p.bars = { ...preset.bars, ...(p.bars || {}) };
  for (const s of p.stages) if (typeof p.bars[s.id] !== 'number') p.bars[s.id] = 9;
  if (typeof opts.bar === 'number') {
    const n = p.stages.length;
    p.stages.forEach((s, i) => { if (i >= n - 3) p.bars[s.id] = Math.max(p.bars[s.id] ?? 0, opts.bar); });
  }
  p.checks = (p.checks || []).map((c) => ({ timeout_s: 600, ...c }));
  p.references ||= [];
  if (opts.ui) p.design_stack = true;
  p.ignore = Array.isArray(p.ignore) ? p.ignore : [];
  p.shared = Array.isArray(p.shared) && p.shared.length ? p.shared : [...DEFAULT_SHARED];
  p.bundles = [...new Set(['core', ...(p.bundles || [])])];
  return p;
}

export function validatePlan(plan, project) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };
  const targets = loadTargets().targets;
  const bundles = loadBundles();
  const toolIds = new Set(loadCatalog(project).map((t) => t.id));

  need(plan && typeof plan === 'object', 'plan must be an object');
  if (errs.length) return errs;
  need(typeof plan.summary === 'string' && plan.summary.length > 20, 'summary: required string (>20 chars)');
  need(targets[plan.target_type], `target_type must be one of: ${Object.keys(targets).join(', ')}`);
  need(ENVS.has(plan.environment), 'environment must be local|remote|hybrid');
  need(plan.design_stack === undefined || typeof plan.design_stack === 'boolean', 'design_stack must be boolean');
  need(plan.design === undefined || (plan.design && typeof plan.design === 'object' && typeof plan.design.direction === 'string'), 'design must be an object with a direction string');
  need(plan.stage_preset === undefined || STAGE_PRESETS[plan.stage_preset], `stage_preset must be one of: ${Object.keys(STAGE_PRESETS).join(', ')}`);
  need(Array.isArray(plan.axes) && plan.axes.length >= 3, 'axes: at least 3 rubric axes required');
  const axisIds = new Set();
  for (const a of plan.axes || []) {
    need(a.id && typeof a.id === 'string', 'every axis needs an id');
    need(!axisIds.has(a.id), `duplicate axis ${a.id}`);
    axisIds.add(a.id);
    need(typeof a.critical === 'boolean', `axis ${a.id}: critical must be boolean`);
    need(typeof a.anchor === 'string' && a.anchor.length > 5, `axis ${a.id}: anchor (what a 10 looks like) required`);
  }
  const stageIds = new Set();
  for (const s of plan.stages) {
    need(s.id && typeof s.id === 'string', 'every stage needs an id');
    need(!stageIds.has(s.id), `duplicate stage ${s.id}`);
    stageIds.add(s.id);
    need(typeof s.goal === 'string' && s.goal.length > 3, `stage ${s.id}: goal required`);
  }
  need(Array.isArray(plan.criteria) && plan.criteria.length >= 2, 'criteria: at least 2 acceptance criteria required');
  const cids = new Set();
  for (const c of plan.criteria || []) {
    need(c.id && !cids.has(c.id), `criterion id missing or duplicate: ${c.id}`);
    cids.add(c.id);
    need(typeof c.text === 'string' && c.text.length > 8, `criterion ${c.id}: text required`);
    need(stageIds.has(c.stage), `criterion ${c.id}: stage must be one of ${[...stageIds].join(', ')}`);
    need(typeof c.critical === 'boolean', `criterion ${c.id}: critical must be boolean`);
    need(c.scope === undefined || (Array.isArray(c.scope) && c.scope.length && c.scope.every((x) => typeof x === 'string')), `criterion ${c.id}: scope must be a non-empty array of path globs`);
    need(c.observe && METHODS.has(c.observe.method), `criterion ${c.id}: observe.method must be one of ${[...METHODS].join(', ')}`);
    const tool = c.observe?.tool;
    need(tool === 'manual' || tool === 'builtin' || toolIds.has(tool), `criterion ${c.id}: observe.tool "${tool}" is not in the catalog (use "builtin" or "manual", or add it with the toolsmith)`);
  }
  need(Array.isArray(plan.checks) && plan.checks.length >= 1, 'checks: at least one hard check required');
  const kids = new Set();
  for (const k of plan.checks || []) {
    need(k.id && !kids.has(k.id), `check id missing or duplicate: ${k.id}`);
    kids.add(k.id);
    need(typeof k.cmd === 'string' && k.cmd.trim(), `check ${k.id}: cmd required`);
    need(!k.stage || stageIds.has(k.stage), `check ${k.id}: unknown stage ${k.stage}`);
    need(k.changed_cmd === undefined || (typeof k.changed_cmd === 'string' && k.changed_cmd.includes('{changed}')), `check ${k.id}: changed_cmd must be a string containing {changed}`);
    need(k.changed_match === undefined || (Array.isArray(k.changed_match) && k.changed_match.every((x) => typeof x === 'string')), `check ${k.id}: changed_match must be an array of globs`);
    need(k.scope === undefined || (Array.isArray(k.scope) && k.scope.length && k.scope.every((x) => typeof x === 'string')), `check ${k.id}: scope must be a non-empty array of path globs (omit it to always run)`);
  }
  need((plan.checks || []).some((k) => !k.stage || k.stage === plan.stages[0].id), `at least one check must apply from the first stage (${plan.stages[0].id})`);
  for (const b of plan.bundles || []) need(b === 'core' || bundles[b], `unknown bundle ${b} (known: ${Object.keys(bundles).join(', ')})`);
  return errs;
}

export function renderRubric(state) {
  const p = state.plan;
  const L = [];
  L.push(`# Forge plan\n`, `**Request:** ${state.prompt}\n`, `**Summary:** ${p.summary}\n`);
  L.push(`**Target:** ${p.target_type} · **Environment:** ${p.environment}${p.remote?.kind && p.remote.kind !== 'none' ? ` (${p.remote.kind}: ${p.remote.notes || ''})` : ''}\n`);
  if (p.builder_notes) L.push(`## Builder notes\n${p.builder_notes}\n`);
  if (p.references?.length) L.push('## Reference products\n' + p.references.map((r) => `- ${r.name}${r.url ? ` (${r.url})` : ''}: ${r.why || ''}`).join('\n') + '\n');
  L.push('## Stages and bars\n' + p.stages.map((s, i) => `${i + 1}. **${s.name}** (bar ${p.bars[s.id]}/10): ${s.goal}`).join('\n') + '\n');
  L.push('## Rubric axes (scored 0-10; 10 anchors)\n' + p.axes.map((a) => `- **${a.id}**${a.critical ? ' (critical)' : ''}: ${a.anchor}`).join('\n') + '\n');
  L.push('## Acceptance criteria\n' + p.criteria.map((c) => `- [${c.id}] (from ${c.stage}${c.critical ? ', critical' : ''}) ${c.text}  -> observe via ${c.observe.method}/${c.observe.tool}${c.scope ? ` [scope: ${c.scope.join(', ')}]` : ''}`).join('\n') + '\n');
  L.push('## Hard checks\n' + p.checks.map((c) => `- ${c.id}${c.stage ? ` (from ${c.stage})` : ''}${c.scope ? ` [scoped: ${c.scope.join(', ')}]` : ' [always runs]'}: \`${c.cmd}\``).join('\n') + '\n');
  return L.join('\n');
}

export function writeRubric(project, state) {
  fs.mkdirSync(forgeDir(project), { recursive: true });
  fs.writeFileSync(path.join(forgeDir(project), 'rubric.md'), renderRubric(state));
}
