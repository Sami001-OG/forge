#!/usr/bin/env node
// forge CLI: the only sanctioned writer of loop state. Used by commands, agents, and the gate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectDir, forgeDir, readJson, writeJsonAtomic, readStdin, clip, toolEnv, toolsDir, toolPathDirs, posix } from './lib/util.mjs';
import { loadState, saveState, loadArtifacts, artifactFile, DEFAULT_CAPS } from './lib/state.mjs';
import { applicableChecks, applicableCriteria, stageBrief, barFor } from './lib/gate-logic.mjs';
import { normalizePlan, validatePlan, writeRubric } from './lib/plan.mjs';
import { loadCatalog, loadBundles, loadTargets, search, pluginRoot } from './lib/catalog.mjs';
import * as prov from './lib/provision.mjs';
import { loadImgLibs, comparePng } from './lib/visual.mjs';
import { DESIGN_TOOLS, DESIGN_SKILLS, ROLE, findSkills } from './lib/design.mjs';
import { takeSnapshot, scopeFp, changedFiles, hitsShared, snapshotObject, matcher, DEFAULT_IGNORE, DEFAULT_SHARED } from './lib/fingerprint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = projectDir();
const [cmd, ...rest] = process.argv.slice(2);

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith('--') && !['auto', 'json', 'force', 'full', 'mobile', 'installed', 'confirm', 'update', 'ui'].includes(k)) { flags[k] = n; i++; } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}
const die = (m, code = 1) => { process.stderr.write(m + '\n'); process.exit(code); };
const out = (m) => process.stdout.write(m + '\n');
const need = () => { const s = loadState(project); if (!s) die('forge: no active loop in this project. Start one with /forge:build'); return s; };

const expand = (c) => String(c).replaceAll('{forge}', `node "${posix(path.join(here, 'forge.mjs'))}"`);
const bar = (n, w = 10) => '▮'.repeat(Math.max(0, Math.min(w, Math.round(n)))) + '▯'.repeat(w - Math.max(0, Math.min(w, Math.round(n))));

function statusText(s) {
  const L = [];
  const elapsed = Math.round((Date.now() - s.created_at) / 60000);
  L.push(`FORGE ▸ ${s.status}${s.delivering_reason ? ` (${s.delivering_reason})` : ''}`);
  L.push(`request: ${clip(s.prompt, 120)}`);
  if (!s.plan) { L.push('no plan yet'); return L.join('\n'); }
  const st = s.plan.stages[s.stage_idx];
  L.push(`target: ${s.plan.target_type} · env: ${s.plan.environment}`);
  L.push(`stage ${s.stage_idx + 1}/${s.plan.stages.length} ${st.id} (bar ${barFor(s.plan, st.id)}) · round ${s.round}/${s.caps.max_rounds} · ${elapsed}/${s.caps.max_minutes}m · loop ${s.blocks || 0}/${s.caps.max_blocks}`);
  const last = [...(s.history || [])].slice(-1)[0];
  const art = loadArtifacts(project, s.round);
  const prev = loadArtifacts(project, Math.max(1, s.round - 1));
  const v = (art.supervisor && art.critic) ? art : prev;
  if (v.supervisor && v.critic) {
    L.push('axes (min of supervisor, critic):');
    for (const a of s.plan.axes) {
      const m = Math.min(Number(v.supervisor.axes?.[a.id] ?? 0), Number(v.critic.axes?.[a.id] ?? 0));
      L.push(`  ${a.id.padEnd(16)} ${bar(m)} ${m}/10${a.critical ? ' *' : ''}`);
    }
  }
  L.push(`this round: checks ${art.checks ? (art.checks.all_pass ? 'PASS' : 'FAIL') : '-'} · supervisor ${art.supervisor?.verdict || '-'} · critic ${art.critic?.verdict || '-'}`);
  if (art.scope) L.push(`verification: ${art.scope.full ? `FULL (${art.scope.full_reason})` : `incremental, ${art.scope.changed_count} file(s) changed`} · re-verify ${art.scope.dirty_criteria.length}, carried ${art.scope.carried_criteria.length}${s.mode === 'tweak' ? ' · TWEAK mode' : ''}`);
  const T = s.timings || [];
  if (T.length) {
    const sum = (k) => T.reduce((a, t) => a + (t[k] || 0), 0);
    const fmt = (n) => (n >= 3600 ? `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m` : n >= 60 ? `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s` : `${n}s`);
    const parts = [['build', sum('build_s')], ['checks', sum('checks_s')], ['verification', sum('verify_s')]];
    const tot = parts.reduce((a, [, v]) => a + v, 0) || 1;
    L.push(`time over ${T.length} round(s): ${parts.map(([n, v]) => `${n} ${fmt(v)} (${Math.round((v / tot) * 100)}%)`).join(' · ')}; critic ran in ${T.filter((t) => t.critic_ran).length}/${T.length}`);
    const [slow, slowV] = [...parts].sort((a, b) => b[1] - a[1])[0];
    if (slow === 'verification' && slowV / tot > 0.55) L.push('hint: verification dominates. Options: scope slow checks in the plan, --verifier-model for routine rounds, /forge:tweak for small edits.');
  }
  if (s.opts?.verifier_model) L.push(`routine verification model: ${s.opts.verifier_model} (final stage uses the session model)`);
  if (last) L.push(`last scored round: ${last.round} stage ${last.stage} score ${last.score} ${last.approved ? 'APPROVED' : 'rejected'}`);
  return L.join('\n');
}

async function main() {
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case 'init': {
      const prompt = pos.join(' ').trim();
      if (!prompt) die('usage: forge init "<what to build>" [--auto] [--bar N] [--max-rounds N] [--max-minutes N] [--verifier-model <alias>] [--plateau N] [--ui]');
      const old = loadState(project);
      if (old && ['running', 'delivering'].includes(old.status) && !flags.force) die('forge: a loop is already active here. /forge:status to inspect, /forge:abort to cancel.');
      fs.mkdirSync(forgeDir(project), { recursive: true });
      for (const f of fs.readdirSync(forgeDir(project))) if (/^(checks|verdict|signoff)-/.test(f) || ['state.json', 'DELIVERY.md', 'plan.draft.json'].includes(f)) fs.rmSync(path.join(forgeDir(project), f), { force: true });
      fs.writeFileSync(path.join(forgeDir(project), '.gitignore'), '*\n');
      const caps = { ...DEFAULT_CAPS };
      if (flags['max-rounds']) caps.max_rounds = parseInt(flags['max-rounds'], 10);
      if (flags['max-minutes']) caps.max_minutes = parseInt(flags['max-minutes'], 10);
      const s = {
        version: 1, status: 'planning', prompt, auto: !!flags.auto, opts: { bar: flags.bar ? Number(flags.bar) : null, verifier_model: /^[A-Za-z0-9._:-]+$/.test(String(flags['verifier-model'] || '')) ? String(flags['verifier-model']) : null, ui: !!flags.ui, plateau: Number.isInteger(Number(flags.plateau)) && flags.plateau !== undefined ? Number(flags.plateau) : 2 },
        created_at: Date.now(), caps, round: 1, stage_idx: 0, blocks: 0, idle_blocks: 0, last_fp: null,
        history: [], best: null, stall: { rounds_without_gain: 0, strategy_changes: 0 }, session_id: null, plan: null,
      };
      saveState(project, s);
      out('forge: initialised .forge/ (status: planning)');
      break;
    }
    case 'plan-set': {
      const s = need();
      if (s.status !== 'planning') die(`forge: plan can only be set while planning (status: ${s.status})`);
      const file = pos[0] || path.join(forgeDir(project), 'plan.draft.json');
      const raw = readJson(file, null);
      if (!raw) die(`forge: cannot read JSON plan at ${file}`);
      const plan = normalizePlan(raw, { bar: s.opts?.bar, ui: s.opts?.ui });
      const errs = validatePlan(plan, project);
      if (errs.length) die('forge: plan INVALID:\n' + errs.map((e) => `  - ${e}`).join('\n'));
      s.plan = plan;
      saveState(project, s);
      writeRubric(project, s);
      if (plan.design_stack) { const f = findSkills(project); const miss = DESIGN_TOOLS.filter((t) => f[t].length === 0); if (miss.length) out(`forge: note: design stack not installed (${miss.join(', ')}). Run: forge design install`); }
      out(`forge: plan accepted. ${plan.stages.length} stages, ${plan.axes.length} axes, ${plan.criteria.length} criteria, ${plan.checks.length} checks. Rubric: .forge/rubric.md`);
      break;
    }
    case 'start': {
      const s = need();
      if (s.status !== 'planning' || !s.plan) die('forge: start requires a plan in planning status');
      s.status = 'running'; s.created_at = Date.now(); s.round_started_at = Date.now(); s.round = 1; s.stage_idx = 0; s.blocks = 0; s.idle_blocks = 0; s.last_fp = null;
      saveState(project, s);
      out(`forge: loop started.\n\nOriginal request:\n${s.prompt}\n\nBuilder notes:\n${s.plan.builder_notes || '(none)'}\n\n${stageBrief(s)}\n\nHard checks (run automatically later): ${s.plan.checks.map((c) => c.id).join(', ')}\nBuild stage 1 now. When you think it is done, just end your turn; the gate takes over.`);
      break;
    }
    case 'checks': {
      const startedAt = Date.now();
      const s = need();
      if (s.status !== 'running') die(`forge: checks only run while the loop is running (status: ${s.status})`);
      const stageId = s.plan.stages[s.stage_idx].id;
      if (flags.confirm) {
        // Run the full suite for checks that only ran the tests related to the change.
        const file = artifactFile(project, 'checks', s.round);
        const cur = readJson(file, null);
        if (!cur) die('forge: run `forge checks` first');
        const imp = cur.results.filter((r) => r.impact);
        if (!imp.length) { out('forge: nothing to confirm (no impact-selected checks this round).'); break; }
        s.verified ||= { checks: {}, criteria: {} };
        for (const r of imp) {
          const c = s.plan.checks.find((x) => x.id === r.id);
          const t0 = Date.now();
          const rr = spawnSync(expand(c.cmd), { shell: true, cwd: project, env: toolEnv(project), encoding: 'utf8', timeout: (c.timeout_s || 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
          const ok = rr.status === 0;
          Object.assign(r, { ok, code: rr.status ?? 1, ms: Date.now() - t0, impact: false, confirmed: true, tail: clip(`${rr.stdout || ''}${rr.stderr || ''}`.slice(-2000), 2000) });
          s.verified.checks[r.id] = { ...(s.verified.checks[r.id] || {}), ok, round: s.round, full_stage: ok ? stageId : undefined };
          out(`${ok ? 'PASS' : 'FAIL'} ${r.id} full suite (${r.ms}ms)`);
          if (!ok) out(clip(`${rr.stdout || ''}${rr.stderr || ''}`.trim().split('\n').slice(-12).join('\n'), 1200));
        }
        cur.all_pass = cur.results.every((r) => r.ok);
        writeJsonAtomic(file, cur);
        saveState(project, s);
        out(`forge: confirm ${cur.all_pass ? 'PASSED' : 'FAILED'}. End your turn.`);
        break;
      }
      const ignore = [...DEFAULT_IGNORE, ...(s.plan.ignore || [])];
      const shared = s.plan.shared?.length ? s.plan.shared : DEFAULT_SHARED;
      const snap = takeSnapshot(project, ignore);
      const lastSnapFile = path.join(forgeDir(project), 'last-snapshot.json');
      const prev = readJson(lastSnapFile, null);
      const changed = prev ? changedFiles(prev, snap) : [];
      const total = snap.size;
      const reason = flags.full ? 'forced (--full)' : !prev ? 'first verification' : hitsShared(changed, shared) ? 'a shared/config file changed' : (total > 20 && changed.length > total * 0.4) ? 'more than 40% of files changed' : null;
      const full = !!reason;
      s.verified ||= { checks: {}, criteria: {} };
      // Criteria: re-verify only those whose dependency fingerprint changed (or that never passed).
      const dirtyC = [], carriedC = [], criteria_fp = {};
      for (const c of applicableCriteria(s.plan, s.stage_idx)) {
        const v = s.verified.criteria[c.id];
        const fp = scopeFp(snap, v?.depends_on || c.scope, shared);
        criteria_fp[c.id] = fp;
        if (!full && v && v.pass && v.observed && v.fp === fp) carriedC.push(c.id); else dirtyC.push(c.id);
      }
      // Checks: unscoped checks always run (they are the safety net); scoped ones are carried when unchanged.
      const results = [];
      for (const c of applicableChecks(s.plan, s.stage_idx)) {
        const fp = c.scope ? scopeFp(snap, c.scope, shared) : null;
        const v = s.verified.checks[c.id];
        if (!full && c.scope && v && v.ok && v.fp === fp) {
          results.push({ id: c.id, cmd: c.cmd, ok: true, code: 0, ms: 0, carried: true, from_round: v.round, tail: '' });
          out(`SKIP ${c.id} (unchanged since round ${v.round})`);
          continue;
        }
        // Impact selection: after the first full run in a stage, run only tests related to the changed files.
        let cmd = c.cmd, impact = false, nfiles = 0;
        if (c.changed_cmd && !full && prev && v?.ok && v.full_stage === stageId) {
          const m = matcher(c.changed_match?.length ? c.changed_match : ['**']);
          const files = changed.filter((f) => m(f) && fs.existsSync(path.join(project, f)));
          if (files.length === 0) {
            results.push({ id: c.id, cmd: c.cmd, ok: true, code: 0, ms: 0, carried: true, from_round: v.round, tail: '' });
            out(`SKIP ${c.id} (no relevant files changed)`);
            continue;
          }
          cmd = c.changed_cmd.replace('{changed}', files.map((f) => JSON.stringify(f)).join(' '));
          impact = true; nfiles = files.length;
        }
        const t0 = Date.now();
        const r = spawnSync(expand(cmd), { shell: true, cwd: project, env: toolEnv(project), encoding: 'utf8', timeout: (c.timeout_s || 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
        const ok = r.status === 0;
        results.push({ id: c.id, cmd, ok, impact, files: nfiles, code: r.status ?? (r.error ? -1 : 1), ms: Date.now() - t0, tail: clip(`${r.stdout || ''}${r.stderr || ''}${r.error ? '\n' + r.error.message : ''}`.slice(-2000), 2000) });
        s.verified.checks[c.id] = { fp, round: s.round, ok, full_stage: impact ? v.full_stage : ok ? stageId : undefined };
        out(`${ok ? 'PASS' : 'FAIL'} ${c.id}${impact ? ` [impact: ${nfiles} file(s)]` : ''} (${Date.now() - t0}ms)`);
        if (!ok) out(clip(`${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-12).join('\n'), 1200));
      }
      const res = { round: s.round, stage: s.plan.stages[s.stage_idx].id, started_at: new Date(startedAt).toISOString(), ran_at: new Date().toISOString(), results, all_pass: results.every((r) => r.ok) && results.length > 0 };
      writeJsonAtomic(artifactFile(project, 'checks', s.round), res);
      const scope = { round: s.round, mode: s.mode || 'loop', full, full_reason: reason, total_files: total, changed_count: changed.length, changed_files: changed.slice(0, 60), dirty_criteria: dirtyC, carried_criteria: carriedC, criteria_fp };
      writeJsonAtomic(path.join(forgeDir(project), `scope-${s.round}.json`), scope);
      writeJsonAtomic(lastSnapFile, snapshotObject(snap));
      // Fast path: nothing a verified criterion depends on changed, hard checks pass, and the previous verdict approved this same stage.
      const lastE = s.last_eval;
      let fast = false;
      if (res.all_pass && !full && dirtyC.length === 0 && lastE?.approved && lastE.stage === s.plan.stages[s.stage_idx].id && s.last_axes) {
        const base = { axes: s.last_axes, issues: [], synthetic: true, round: s.round, written_at: new Date().toISOString() };
        writeJsonAtomic(artifactFile(project, 'verdict', s.round, 'supervisor'), { ...base, role: 'supervisor', verdict: 'approve', criteria: [], next_prompt: '', carried_all: true });
        writeJsonAtomic(artifactFile(project, 'verdict', s.round, 'critic'), { ...base, role: 'critic', verdict: 'approve', blocking_issues: [], probes: ['synthetic: nothing any verified criterion depends on has changed'], carried_all: true });
        fast = true;
      }
      saveState(project, s);
      out(`forge: checks ${res.all_pass ? 'ALL PASS' : 'FAILING'} (round ${s.round}). Recorded.`);
      out(`scope: ${full ? `FULL verification (${reason})` : `incremental: ${changed.length} file(s) changed`}; re-verify ${dirtyC.length} criteria${dirtyC.length ? ` [${dirtyC.join(', ')}]` : ''}, carried over ${carriedC.length}${carriedC.length ? ` [${carriedC.join(', ')}]` : ''}.`);
      if (fast) out('FAST PATH: nothing relevant changed and checks pass. Supervisor and critic verdicts were carried over automatically; you do NOT need to delegate to them. End your turn.');
      else out(`Supervisor/critic: assess ONLY the dirty criteria (see .forge/scope-${s.round}.json); do not redo carried ones.`);
      break;
    }
    case 'verdict': {
      const s = need();
      const role = pos[0];
      if (!['supervisor', 'critic'].includes(role)) die('usage: forge verdict <supervisor|critic>  (JSON on stdin)');
      if (s.status !== 'running') die(`forge: no verdicts accepted (status: ${s.status})`);
      let v;
      try { v = JSON.parse(await readStdin()); } catch (e) { die('forge: stdin is not valid JSON: ' + e.message); }
      const errs = validateVerdict(s, role, v);
      if (errs.length) die('forge: verdict INVALID:\n' + errs.map((e) => `  - ${e}`).join('\n'));
      v.role = role; v.round = s.round; v.written_at = new Date().toISOString();
      writeJsonAtomic(artifactFile(project, 'verdict', s.round, role), v);
      if (role === 'supervisor') {
        const sc = readJson(path.join(forgeDir(project), `scope-${s.round}.json`), { criteria_fp: {} });
        s.verified ||= { checks: {}, criteria: {} };
        for (const c of v.criteria) {
          if (c.pass && c.observed) s.verified.criteria[c.id] = { fp: sc.criteria_fp?.[c.id], round: s.round, pass: true, observed: true, evidence: c.evidence, depends_on: c.depends_on || s.verified.criteria[c.id]?.depends_on, stage: s.plan.stages[s.stage_idx].id };
          else delete s.verified.criteria[c.id]; // failed or unobserved: stays dirty
        }
        saveState(project, s);
      }
      out(`forge: ${role} verdict recorded for round ${s.round}: ${v.verdict}`);
      break;
    }
    case 'signoff': {
      const s = need();
      const kind = pos[0];
      if (!['complete', 'incomplete'].includes(kind)) die('usage: forge signoff <complete|incomplete> "<notes>"');
      if (s.status !== 'running') die('forge: loop not running');
      writeJsonAtomic(artifactFile(project, 'signoff', s.round), { round: s.round, complete: kind === 'complete', notes: pos.slice(1).join(' '), at: new Date().toISOString() });
      out(`forge: sign-off recorded (${kind})`);
      break;
    }
    case 'status': {
      const s = need();
      out(flags.json ? JSON.stringify(s, null, 2) : statusText(s));
      if (flags.json) {
        const art = loadArtifacts(project, s.round);
        out('\n// current round artifacts\n' + JSON.stringify(art, null, 2));
      }
      break;
    }
    case 'abort': {
      const s = need();
      s.status = 'aborted';
      saveState(project, s);
      out('forge: loop aborted. State kept in .forge/. The Stop hook is now inactive.');
      break;
    }
    case 'tweak': {
      const s = need();
      const change = pos.join(' ').trim();
      if (!change) die('usage: forge tweak "<small change>"');
      if (!s.plan) die('forge: no plan yet. Run /forge:build first; /forge:tweak edits a product that Forge already built.');
      if (['running', 'delivering'].includes(s.status)) die('forge: a loop is still active. Let it finish or /forge:abort, then tweak.');
      if (!s.verified || !Object.keys(s.verified.criteria || {}).length) out('forge: warning: no verified baseline recorded; everything will be treated as changed.');
      for (const f of ['DELIVERY.md']) fs.rmSync(path.join(forgeDir(project), f), { force: true });
      Object.assign(s, { status: 'running', mode: 'tweak', tweak: { prompt: change, started: Date.now() }, delivering_reason: null, stage_idx: s.plan.stages.length - 1, round: s.round + 1, created_at: Date.now(), round_started_at: Date.now(), caps: { max_rounds: 10, max_minutes: 45, max_blocks: 80 }, blocks: 0, idle_blocks: 0, last_fp: null, best: null, stall: { rounds_without_gain: 0, strategy_changes: 0 }, session_id: null });
      saveState(project, s);
      out(`forge: tweak mode. Change requested:\n${change}\n\nMake ONLY this change (no refactors, no extras). When done, end your turn: Forge re-verifies only what the change affects and carries everything else over.`);
      break;
    }
    case 'assert-json': {
      const [file, jp, op, val] = pos;
      if (!file || !jp || !op || val === undefined) die('usage: forge assert-json <file.json> <dot.path> <op: >= <= > < == !=> <value>');
      const data = readJson(file, undefined);
      if (data === undefined) die(`forge: cannot read JSON from ${file}`);
      const got = jp.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
      const rhs = Number.isNaN(Number(val)) ? val : Number(val);
      const lhs = typeof rhs === 'number' ? Number(got) : got;
      const ops = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
      if (!ops[op]) die(`forge: unknown operator ${op}`);
      const pass = got !== undefined && ops[op](lhs, rhs);
      out(`${pass ? 'PASS' : 'FAIL'} ${jp} = ${got} (${op} ${val})`);
      process.exit(pass ? 0 : 1);
      break;
    }
    case 'visual': {
      // Machine-judged visual regression: screenshot vs a stored baseline. First run (or --update) records the baseline.
      const url = pos[0];
      if (!url) die('usage: forge visual <url> --name <name> [--threshold <percent, default 0.5>] [--mobile] [--full] [--update]');
      const st = loadState(project);
      for (const id of ['pngjs', 'pixelmatch']) { const r = await prov.install(project, id); if (!r.ok) die(`forge: cannot provision ${id}: ${r.reason}`); }
      const name = String(flags.name || 'page') + (flags.mobile ? '-mobile' : '');
      const dir = path.join(forgeDir(project), 'evidence');
      fs.mkdirSync(dir, { recursive: true });
      const cur = path.join(dir, `r${st?.round ?? 0}-visual-${name}.png`);
      const sh = spawnSync(process.execPath, [path.join(here, 'shot.mjs'), url, '--out', cur, ...(flags.mobile ? ['--mobile'] : []), ...(flags.full ? ['--full'] : [])], { stdio: 'inherit', env: toolEnv(project) });
      if (sh.status !== 0) die('forge visual: screenshot failed', sh.status ?? 1);
      const base = path.join(forgeDir(project), 'baselines', `${name}.png`);
      if (!fs.existsSync(base) || flags.update) {
        fs.mkdirSync(path.dirname(base), { recursive: true });
        fs.copyFileSync(cur, base);
        out(`visual: baseline ${flags.update ? 'updated' : 'created'}: ${posix(path.relative(project, base))}`);
        process.exit(0);
      }
      const { PNG, pixelmatch } = await loadImgLibs(project);
      const r = comparePng(PNG, pixelmatch, fs.readFileSync(base), fs.readFileSync(cur));
      const limit = flags.threshold !== undefined ? Number(flags.threshold) : 0.5;
      if (r.diffPng) fs.writeFileSync(cur.replace(/\.png$/, '-diff.png'), r.diffPng);
      const pass = !r.sizeMismatch && r.pct <= limit;
      out(`${pass ? 'PASS' : 'FAIL'} visual ${name}: ${r.sizeMismatch ? 'size changed' : `${r.pct.toFixed(3)}% pixels differ (limit ${limit}%)`}`);
      out(`evidence: file:${posix(path.relative(project, cur))}${r.diffPng ? ` diff: file:${posix(path.relative(project, cur.replace(/\.png$/, '-diff.png')))}` : ''}`);
      process.exit(pass ? 0 : 1);
      break;
    }
    case 'design': {
      const sub = pos[0] || 'status';
      const found = findSkills(project);
      if (sub === 'status') {
        for (const t of DESIGN_TOOLS) {
          const have = found[t].map((x) => x.name), want = DESIGN_SKILLS[t];
          out(`${have.length ? 'ok     ' : 'MISSING'} ${t}: ${have.length}/${want.length} skill(s) found${have.length ? ` (${have.join(', ')})` : ''}`);
        }
        const detect = loadCatalog(project).find((x) => x.id === 'impeccable-detect');
        out(`${prov.verify(project, detect).ok ? 'ok     ' : 'MISSING'} impeccable-detect (deterministic UI anti-pattern check)`);
        if (DESIGN_TOOLS.some((t) => !found[t].length)) out('install with: forge design install   (needs your approval: it runs npx installers from the skills\' own repos)');
      } else if (sub === 'path') {
        const all = Object.values(found).flat();
        if (!all.length) die('forge: no design skills installed. Run: forge design install');
        for (const x of all) out(`${x.path}  # ${ROLE[x.name] || x.name}`);
      } else if (sub === 'install') {
        await toolCmd(['install', ...DESIGN_TOOLS, 'impeccable-detect'], {});
      } else die('usage: forge design status | path | install');
      break;
    }
    case 'uiaudit': {
      const r = spawnSync(process.execPath, [path.join(here, 'uiaudit.mjs'), ...rest], { stdio: 'inherit', env: toolEnv(project) });
      process.exit(r.status ?? 1);
      break;
    }
    case 'doctor': await doctor(); break;
    case 'exec': {
      // Run any command with the project-local tools on PATH: forge exec -- eslint .
      if (!pos.length) die('usage: forge exec -- <command> [args]   (runs with .forge/tools on PATH)');
      const r = pos.length === 1
        ? spawnSync(pos[0], { shell: true, stdio: 'inherit', env: toolEnv(project), cwd: project })
        : spawnSync(pos[0], pos.slice(1), { stdio: 'inherit', env: toolEnv(project), cwd: project, shell: process.platform === 'win32' });
      if (r.error) die(`forge exec: ${r.error.message}${r.error.code === 'ENOENT' ? `\n  "${pos[0]}" is not on PATH or in .forge/tools. Try: forge tool list --search ${pos[0]}  then  forge tool install <id>` : ''}`, 127);
      process.exit(r.status ?? 1);
      break;
    }
    case 'env': {
      const sep = process.platform === 'win32' ? ';' : ':';
      const dirs = toolPathDirs(project).map(posix).join(sep);
      out(flags.json ? JSON.stringify({ path_prepend: toolPathDirs(project) }) : `export PATH="${dirs}${sep}$PATH"`);
      break;
    }
    case 'tool': await toolCmd(pos, flags); break;
    case 'shot': {
      const r = spawnSync(process.execPath, [path.join(here, 'shot.mjs'), ...rest], { stdio: 'inherit', env: toolEnv(project) });
      process.exit(r.status ?? 1);
      break;
    }
    case 'http': await httpCmd(pos, flags); break;
    default:
      out('forge CLI: init | plan-set | start | checks [--full] | verdict | signoff | tweak | status | abort | doctor | exec | env | tool | shot | http | visual | assert-json | uiaudit | design');
  }
}

function validateVerdict(s, role, v) {
  const errs = [];
  const plan = s.plan;
  if (!v || typeof v !== 'object') return ['verdict must be a JSON object'];
  const okVerdicts = role === 'supervisor' ? ['approve', 'continue'] : ['approve', 'reject'];
  if (!okVerdicts.includes(v.verdict)) errs.push(`verdict must be one of ${okVerdicts.join('|')}`);
  if (!v.axes || typeof v.axes !== 'object') errs.push('axes object required');
  else for (const a of plan.axes) { const n = v.axes[a.id]; if (typeof n !== 'number' || n < 0 || n > 10) errs.push(`axes.${a.id} must be a number 0-10`); }
  if (role === 'supervisor') {
    if (!Array.isArray(v.criteria)) errs.push('criteria array required');
    else {
      const checks = readJson(artifactFile(project, 'checks', s.round), { results: [] });
      const cids = new Set(plan.criteria.map((c) => c.id));
      const ckids = new Set((checks.results || []).map((r) => r.id));
      for (const c of v.criteria) {
        if (!cids.has(c.id)) { errs.push(`unknown criterion ${c.id}`); continue; }
        if (typeof c.pass !== 'boolean' || typeof c.observed !== 'boolean') errs.push(`criterion ${c.id}: pass and observed must be boolean`);
        if (c.observed) {
          const ev = Array.isArray(c.evidence) ? c.evidence : [];
          let hard = 0;
          for (const e of ev) {
            if (e.startsWith('file:')) { if (fs.existsSync(path.resolve(project, e.slice(5)))) hard++; else errs.push(`criterion ${c.id}: evidence file does not exist: ${e.slice(5)}`); }
            else if (e.startsWith('check:')) { if (ckids.has(e.slice(6))) hard++; else errs.push(`criterion ${c.id}: no such check result: ${e.slice(6)}`); }
            else if (!e.startsWith('run:')) errs.push(`criterion ${c.id}: evidence must start with file:, check:, or run:`);
          }
          if (!hard) errs.push(`criterion ${c.id}: observed=true needs at least one file:<path> or check:<id> evidence that exists`);
        }
      }
    }
    const sc = readJson(path.join(forgeDir(project), `scope-${s.round}.json`), null);
    if (!sc) errs.push('run `forge checks` first: it computes which criteria need re-verification');
    else {
      const given = new Set((v.criteria || []).map((c) => c.id));
      for (const id of sc.dirty_criteria) if (!given.has(id)) errs.push(`criterion ${id} changed (or never passed) and must be assessed`);
      const snap = (v.criteria || []).some((c) => c.depends_on) ? takeSnapshot(project, [...DEFAULT_IGNORE, ...(s.plan.ignore || [])]) : null;
      for (const c of v.criteria || []) {
        if (c.depends_on === undefined) continue;
        if (!Array.isArray(c.depends_on) || !c.depends_on.length || !c.depends_on.every((x) => typeof x === 'string')) { errs.push(`criterion ${c.id}: depends_on must be a non-empty array of file globs`); continue; }
        const m = matcher(c.depends_on);
        if (![...snap.keys()].some(m)) errs.push(`criterion ${c.id}: depends_on matches no project file`);
      }
    }
    if (!Array.isArray(v.issues)) errs.push('issues array required (may be empty)');
    if (v.verdict === 'continue' && !(typeof v.next_prompt === 'string' && v.next_prompt.length > 10)) errs.push('next_prompt required when verdict is continue');
    if (v.needs_tool && !Array.isArray(v.needs_tool)) errs.push('needs_tool must be an array of {what, why}');
  } else {
    if (!Array.isArray(v.blocking_issues)) errs.push('blocking_issues array required');
    if (v.verdict === 'reject' && !(v.blocking_issues || []).length) errs.push('reject requires at least one blocking issue');
    { const sc = readJson(path.join(forgeDir(project), `scope-${s.round}.json`), null); const min = sc?.mode === 'tweak' ? 2 : 3; if (!Array.isArray(v.probes) || (v.verdict === 'approve' && v.probes.length < min)) errs.push(`probes: list the adversarial tests you actually ran (at least ${min} to approve)`); }
  }
  return errs;
}

async function doctor() {
  const L = [];
  let bad = false;
  const major = parseInt(process.versions.node.split('.')[0], 10);
  L.push(`${major >= 18 ? 'ok  ' : 'FAIL'} node ${process.versions.node} (need >= 18)`);
  if (major < 18) bad = true;
  const sh = (c) => spawnSync(c, { shell: true, encoding: 'utf8', timeout: 10000 });
  const git = sh('git --version');
  L.push(`${git.status === 0 ? 'ok  ' : 'FAIL'} git ${git.status === 0 ? git.stdout.trim() : 'not found (required)'}`);
  if (git.status !== 0) bad = true;
  for (const [n, c] of [['python3', 'python3 --version'], ['docker', 'docker --version'], ['npm', 'npm --version']]) {
    const r = sh(c);
    L.push(`${r.status === 0 ? 'ok  ' : 'warn'} ${n}${r.status === 0 ? ' ' + (r.stdout || r.stderr).trim() : ' not found (optional; some tools need it)'}`);
  }
  L.push(`info tool cache: ${toolsDir(project)} (shared across projects)`);
  L.push(`info container: ${prov.inContainer() ? 'yes (tier-1 tools auto-install)' : 'no (tier-1 tools need approval)'}`);
  try { fs.mkdirSync(forgeDir(project), { recursive: true }); fs.accessSync(forgeDir(project), fs.constants.W_OK); L.push('ok   .forge/ writable'); } catch { L.push('FAIL .forge/ not writable'); bad = true; }
  const tools = loadCatalog(project);
  L.push(`ok   catalog: ${tools.length} tools, ${Object.keys(loadBundles()).length} bundles`);
  const t = readJson(path.join(forgeDir(project), 'tools.json'), { installed: {} });
  const ids = Object.keys(t.installed);
  if (ids.length) {
    for (const id of ids) { const tool = tools.find((x) => x.id === id); const v = tool ? prov.verify(project, tool) : { ok: false }; L.push(`${v.ok ? 'ok  ' : 'warn'} installed ${id} ${t.installed[id].version || ''}${v.ok ? '' : ' (verification failing; reinstall with: forge tool install ' + id + ')'}`); }
  } else L.push('info no project-local tools installed yet');
  out(L.join('\n'));
  process.exit(bad ? 1 : 0);
}

async function toolCmd(pos, flags) {
  const [sub, ...a] = pos;
  const tools = loadCatalog(project);
  const brief = (t) => `${t.id.padEnd(22)} t${t.tier} ${t.install.method.padEnd(7)} ${t.summary}`;
  if (sub === 'list') {
    let list = tools;
    if (flags.bundle) { const ids = new Set(loadBundles()[flags.bundle] || []); list = list.filter((t) => ids.has(t.id)); }
    if (flags.search) list = search(list, flags.search);
    if (flags.installed) { const inst = readJson(path.join(forgeDir(project), 'tools.json'), { installed: {} }).installed; list = list.filter((t) => inst[t.id]); }
    out(list.map(brief).join('\n') + `\n(${list.length} tools; tier 0 auto, 1 container-or-approval, 2 approval, 3 credentials)`);
  } else if (sub === 'info') {
    const t = tools.find((x) => x.id === a[0]);
    if (!t) die(`unknown tool ${a[0]}`);
    out(JSON.stringify(t, null, 2) + '\n' + prov.describeInstall(t));
  } else if (sub === 'plan') {
    const s = need();
    const want = new Set();
    for (const c of s.plan?.criteria || []) if (c.observe?.tool && !['manual', 'builtin'].includes(c.observe.tool)) want.add(c.observe.tool);
    const ids = new Set(tools.map((t) => t.id));
    const bundles = loadBundles();
    for (const b of s.plan?.bundles || []) for (const id of bundles[b] || []) { const t = tools.find((x) => x.id === id); if (t && t.tier === 0 && t.install.method !== 'builtin' && (b !== 'core')) { /* bundle members are available on demand, not forced */ } }
    for (const id of [...want]) { const t = tools.find((x) => x.id === id); for (const r of t?.requires || []) want.add(r); }
    const rows = [...want].filter((id) => ids.has(id)).map((id) => {
      const t = tools.find((x) => x.id === id);
      const ok = prov.verify(project, t).ok;
      const g = prov.gate(project, t);
      const how = ok ? '' : g.ok ? ' [auto-installable]' : g.needs_approval ? ' [needs user approval]' : ` [${g.reason}]`;
      return `${ok ? 'have' : 'NEED'} ${brief(t)}${how}`;
    });
    const unknown = [...want].filter((id) => !ids.has(id));
    for (const u of unknown) rows.push(`WARN unknown tool in plan: ${u}`);
    out(rows.length ? rows.join('\n') : 'no tools required by the plan beyond what is installed');
  } else if (sub === 'install') {
    const targets = [];
    for (const x of a) {
      if (x.startsWith('bundle:')) { for (const id of loadBundles()[x.slice(7)] || []) targets.push(id); }
      else if (x === 'plan') { const s = need(); for (const c of s.plan.criteria) if (c.observe?.tool && !['manual', 'builtin'].includes(c.observe.tool)) targets.push(c.observe.tool); }
      else targets.push(x);
    }
    let failed = 0;
    for (const id of [...new Set(targets)]) {
      const r = await prov.install(project, id);
      if (r.ok) out(`ok    ${id}${r.already ? ' (already available)' : ''}`);
      else { failed++; out(`${r.needs_approval ? 'NEEDS_APPROVAL' : 'FAIL'} ${id}: ${r.reason}`); }
    }
    process.exit(failed ? 1 : 0);
  } else if (sub === 'approve') {
    for (const id of a) { if (!tools.find((t) => t.id === id)) die(`unknown tool ${id}`); prov.approve(project, id); out(`approved ${id} (user decision recorded)`); }
  } else if (sub === 'run') {
    const r = await prov.runTool(project, a[0], a.slice(1));
    if (r.err) die('forge: ' + r.err, r.code);
    process.exit(r.code);
  } else if (sub === 'add') {
    const f = readJson(a[0], null);
    if (!f?.id || !f.install?.method) die('usage: forge tool add <file.json> with {id, summary, install:{method,...}, verify}');
    const cf = path.join(forgeDir(project), 'custom-tools.json');
    const cur = readJson(cf, { tools: [] });
    cur.tools = cur.tools.filter((t) => t.id !== f.id).concat([{ tier: 2, domains: [], bundles: [], observes: [], controls: [], ...f }]);
    writeJsonAtomic(cf, cur);
    out(`custom tool ${f.id} registered at tier >= 2 (needs user approval before install)`);
  } else if (sub === 'doctor') {
    await doctor();
  } else out('forge tool: list [--bundle b] [--search q] [--installed] | info <id> | plan | install <id|bundle:name|plan>... | approve <id> | run <id> -- args | add <file> | doctor\nforge exec -- <command>   run anything with project-local tools on PATH\nforge env                  print an export PATH line for the project-local tools');
}

async function httpCmd(pos, flags) {
  const url = pos[0];
  if (!url) die('usage: forge http <url> [--method GET] [--data <json>] [--header "K: V"]');
  const s = loadState(project);
  const t0 = Date.now();
  let res, body = '', err = null;
  try {
    res = await fetch(url, { method: flags.method || 'GET', body: flags.data, headers: flags.header ? Object.fromEntries([String(flags.header).split(/:\s*/, 2)]) : undefined, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    body = await res.text();
  } catch (e) { err = String(e.cause?.code || e.message || e); }
  const ms = Date.now() - t0;
  const rep = { url, method: flags.method || 'GET', ok: !!res?.ok, status: res?.status ?? null, ms, error: err, headers: res ? Object.fromEntries([...res.headers].filter(([k]) => /^(content-type|content-length|server|cache-control|strict-transport-security|content-security-policy|x-frame-options|location)$/i.test(k))) : {}, body_head: clip(body, 1500) };
  const dir = path.join(forgeDir(project), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `r${s?.round ?? 0}-http-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(rep, null, 2));
  out(JSON.stringify({ status: rep.status, ms, error: err, content_type: rep.headers['content-type'] }, null, 0));
  out(`evidence: file:${posix(path.relative(project, f))}`);
  process.exit(rep.ok ? 0 : 1);
}

main().catch((e) => die('forge: ' + (e.stack || e)));
