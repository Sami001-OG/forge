// Pure decision logic for the Stop-hook loop. No I/O: state + artifacts in, decision + new state out.
import { clip } from './util.mjs';

const MAX_REASON = 7000;

export const stageIndex = (plan, id) => {
  const i = plan.stages.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
};

export const barFor = (plan, stageId) => (typeof plan.bars?.[stageId] === 'number' ? plan.bars[stageId] : 9);

export const applicableCriteria = (plan, stageIdx) => plan.criteria.filter((c) => stageIndex(plan, c.stage) <= stageIdx);
export const applicableChecks = (plan, stageIdx) => plan.checks.filter((c) => !c.stage || stageIndex(plan, c.stage) <= stageIdx);

// Score every rubric axis as the MIN of supervisor and critic, so both must be convinced.
export function evaluate(state, art) {
  const plan = state.plan;
  const stage = plan.stages[state.stage_idx];
  const bar = barFor(plan, stage.id);
  const problems = [];
  const { checks: chk, supervisor: sup, critic: cri } = art;

  const needChecks = applicableChecks(plan, state.stage_idx).map((c) => c.id);
  const ran = new Set((chk.results || []).map((r) => r.id));
  const missingChecks = needChecks.filter((id) => !ran.has(id));
  const failedChecks = (chk.results || []).filter((r) => !r.ok);
  if (missingChecks.length) problems.push(`checks not run: ${missingChecks.join(', ')}`);
  for (const f of failedChecks) problems.push(`check FAILED: ${f.id} (exit ${f.code}) ${clip((f.tail || '').trim().split('\n').slice(-6).join(' | '), 400)}`);

  const crit = applicableCriteria(plan, state.stage_idx);
  const byId = new Map((sup.criteria || []).map((c) => [c.id, c]));
  let passedCriteria = 0;
  for (const c of crit) {
    let e = byId.get(c.id);
    if (!e && (art.scope?.carried_criteria || []).includes(c.id)) {
      // Unchanged since it last passed (same content fingerprint): carried forward, not re-verified.
      const v = state.verified?.criteria?.[c.id];
      if (v && v.pass && v.observed && v.fp === art.scope?.criteria_fp?.[c.id]) e = { ...v, carried: true };
    }
    if (!e) problems.push(`criterion not assessed: ${c.id} - ${c.text}`);
    else if (!e.observed) problems.push(`criterion NOT OBSERVED (blind spot): ${c.id} - ${c.text}`);
    else if (!e.pass) problems.push(`criterion FAILED: ${c.id} - ${c.text}`);
    else passedCriteria++;
  }

  const hard = problems.length > 0; // failing checks/criteria, as opposed to axes merely below the bar
  const failedAxes = [];
  let score = 0;
  const mins = {};
  for (const a of plan.axes) {
    // If the critic was skipped (supervisor rejected), cap with the critic's last known score so progress stays comparable.
    const cs = cri ? Number(cri.axes?.[a.id] ?? 0) : Number(state.last_critic_axes?.[a.id] ?? 10);
    const s = Math.min(Number(sup.axes?.[a.id] ?? 0), cs);
    mins[a.id] = s;
    score += s;
    const need = a.critical ? bar : bar - 1;
    if (s < need) failedAxes.push({ id: a.id, score: s, need });
  }
  for (const f of failedAxes) problems.push(`axis below bar: ${f.id} ${f.score}/${f.need}`);
  score += passedCriteria;

  const supOk = sup.verdict === 'approve';
  const criOk = !!cri && cri.verdict === 'approve';
  if (!supOk) problems.push('supervisor did not approve');
  if (cri && !criOk) problems.push('critic did not approve');

  const approved = problems.length === 0 && supOk && criOk && chk.all_pass === true;
  return { approved, score, problems, failedAxes, bar, stage, axes: mins, hard };
}

function feedback(state, ev, art) {
  const { supervisor: sup, critic: cri } = art;
  const out = [];
  out.push(`Round ${state.round} REJECTED at stage "${ev.stage.id}" (bar ${ev.bar}/10, score ${ev.score}).`);
  if (ev.problems.length) {
    const prio = (p) => (/^check/.test(p) ? 0 : /^criterion (FAILED|NOT)/.test(p) ? 1 : /^criterion/.test(p) ? 2 : /^axis/.test(p) ? 4 : 3);
    const sorted = [...ev.problems].sort((a, b) => prio(a) - prio(b));
    out.push('Fix list, in priority order:\n' + sorted.map((p, i) => `${i + 1}. ${p}`).join('\n'));
  }
  if (sup.issues?.length) out.push('Supervisor issues:\n' + sup.issues.map((p) => `- ${p}`).join('\n'));
  if (cri?.blocking_issues?.length) out.push('Critic blocking issues:\n' + cri.blocking_issues.map((p) => `- ${p}`).join('\n'));
  if (sup.next_prompt) out.push('Supervisor directive:\n' + sup.next_prompt);
  return out.join('\n\n');
}

export function stageBrief(state, idx = state.stage_idx) {
  const plan = state.plan;
  const st = plan.stages[idx];
  const crit = applicableCriteria(plan, idx);
  return [
    `STAGE ${idx + 1}/${plan.stages.length}: ${st.name || st.id} (bar ${barFor(plan, st.id)}/10)`,
    `Goal: ${st.goal}`,
    st.exit?.length ? 'Exit criteria:\n' + st.exit.map((e) => `- ${e}`).join('\n') : '',
    'Acceptance criteria in force:\n' + crit.map((c) => `- [${c.id}]${c.critical ? ' (critical)' : ''} ${c.text}`).join('\n'),
  ].filter(Boolean).join('\n');
}

const verifierModel = (st) => (st.opts?.verifier_model && st.stage_idx < st.plan.stages.length - 1 ? st.opts.verifier_model : null);

// The critic is the expensive adversarial pass: it only runs when the supervisor is satisfied (or approval is likely).
export function criticNeeded(st, art) {
  if (art.supervisor) return art.supervisor.verdict === 'approve';
  return st.stage_idx === st.plan.stages.length - 1 || !!st.last_sup_approved; // launch in parallel up front
}

function protocol(state, art, cli, wantCritic) {
  const r = state.round;
  const sid = state.plan.stages[state.stage_idx].id;
  const model = verifierModel(state);
  const modelNote = model ? ` Use model "${model}" for this delegation (the Agent tool's model parameter, if it supports one).` : '';
  const sup = `Delegate to the forge:supervisor subagent (Agent tool, subagent_type "forge:supervisor"). Prompt: "Verify round ${r}, stage ${sid}, per the forge protocol." It records its verdict itself.${modelNote}`;
  const cri = `Delegate to the forge:critic subagent (Agent tool, subagent_type "forge:critic"). Prompt: "Attack round ${r}, stage ${sid}, per the forge protocol." It records its verdict itself.`;
  const steps = [];
  if (!art.checks) steps.push(`Run the hard checks: ${cli} checks`);
  const needSup = !art.supervisor;
  const needCri = wantCritic && !art.critic;
  if (needSup && needCri) steps.push(`Launch BOTH subagents in ONE message (two Agent tool calls in the same response) so they run in parallel:\n   a) ${sup}\n   b) ${cri}`);
  else if (needSup) steps.push(sup + ' (The critic is only needed if the supervisor approves.)');
  else if (needCri) steps.push(cri + ' (The supervisor approved; the adversarial pass is now required.)');
  return steps.map((x, i) => `${i + 1}. ${x}`).join('\n');
}

function roundTiming(st, art) {
  const t = (x) => (x ? Date.parse(x) : null);
  const cs = t(art.checks?.started_at), ce = t(art.checks?.ran_at);
  const vs = [t(art.supervisor?.written_at), t(art.critic?.written_at)].filter(Boolean);
  const ve = vs.length ? Math.max(...vs) : null;
  const sec = (a, b) => (a != null && b != null ? Math.max(0, Math.round((b - a) / 1000)) : null);
  return { round: st.round, stage: st.plan.stages[st.stage_idx].id, build_s: sec(st.round_started_at, cs), checks_s: sec(cs, ce), verify_s: sec(ce, ve), critic_ran: !!art.critic };
}

function deliveryMessage(state, cli) {
  const why = {
    approved: 'APPROVED: supervisor, critic, hard checks, and your own sign-off all agree.',
    capped: 'STOPPED AT A CAP (rounds, time, or loop budget). The result is the best version so far, not an approved one.',
    stalled: 'STOPPED: the loop is no longer making progress.',
    plateau: 'STOPPED AT DIMINISHING RETURNS: what remains is marginal and rounds stopped improving. Deliver with an honest gap report.',
  }[state.delivering_reason] || 'Finishing.';
  if (state.mode === 'tweak') return [`[forge] ${why}`, `Now write .forge/DELIVERY.md for this tweak ("${clip(state.tweak?.prompt, 200)}"): what changed, how it was verified (what was re-verified vs carried over unchanged), and any gaps. Then end your turn with a two-line summary. Do not start new work.`].join('\n');
  const gaps = state.gaps?.length ? `Gaps accepted along the way (list them under known gaps): ${state.gaps.map((g) => `${g.stage}: ${g.items.join(', ')}`).join(' | ')}` : null;
  return [
    `[forge] ${why}`,
    ...(gaps ? [gaps] : []),
    'Now write .forge/DELIVERY.md with: (1) what was built, (2) exactly how to run/open it, (3) final rubric scores from the last verdicts, (4) honest known gaps (empty if truly none), (5) where deployed (if anything), (6) a short time breakdown (build / checks / verification) from `forge status`.',
    `Then end your turn with a short final message for the user containing the same essentials. Do not start new work. (Status: ${cli} status)`,
  ].join('\n');
}

function toDelivering(st, reason, cli, prefix = '') {
  st.status = 'delivering';
  st.delivering_reason = reason;
  st.idle_blocks = 0;
  st.blocks = (st.blocks || 0) + 1;
  return { allow: false, state: st, reason: clip(`${prefix}${prefix ? '\n' : ''}${deliveryMessage(st, cli)}`, MAX_REASON) };
}

function advance(st, nowMs, headline) {
  st.stage_idx += 1;
  st.round += 1;
  st.round_started_at = nowMs;
  st.best = null;
  st.plateau = 0;
  st.stall = { rounds_without_gain: 0, strategy_changes: 0 };
  return { allow: false, state: st, reason: `${headline}\n\n${stageBrief(st)}\n\nBuild this stage now. When you believe it is done, simply end your turn; verification runs automatically.` };
}

// Re-evaluating the same round (for example after a confirm run) must replace its entry, not duplicate it.
const upsertRound = (list = [], entry) => [...list.filter((x) => x.round !== entry.round), entry].slice(-100);

export function decide(input, art, nowMs, opts = {}) {
  const cli = opts.cli || 'forge';
  const st = structuredClone(input);
  if (st.status !== 'running' && st.status !== 'delivering') return { allow: true, state: st };

  if (st.status === 'delivering') {
    if (art.delivery) { st.status = 'done'; return { allow: true, state: st }; }
    st.idle_blocks = (st.idle_blocks || 0) + 1;
    st.blocks = (st.blocks || 0) + 1;
    if (st.idle_blocks >= 3) { st.status = 'done'; return { allow: true, state: st }; }
    return { allow: false, state: st, reason: deliveryMessage(st, cli) };
  }

  const caps = st.caps;
  const elapsedMin = (nowMs - st.created_at) / 60000;
  if (st.round > caps.max_rounds) return toDelivering(st, 'capped', cli, `[forge] round cap ${caps.max_rounds} reached.`);
  if (elapsedMin > caps.max_minutes) return toDelivering(st, 'capped', cli, `[forge] time cap ${caps.max_minutes}m reached.`);
  if ((st.blocks || 0) >= caps.max_blocks) return toDelivering(st, 'capped', cli, `[forge] loop budget ${caps.max_blocks} reached.`);

  const fp = [st.round, st.stage_idx, !!art.checks, !!art.supervisor, !!art.critic, !!art.signoff].join(':');
  if (fp === st.last_fp) st.idle_blocks = (st.idle_blocks || 0) + 1;
  else { st.idle_blocks = 0; st.last_fp = fp; }
  if (st.idle_blocks >= 4) return toDelivering(st, 'stalled', cli, '[forge] the required verification steps were not performed after repeated reminders.');
  st.blocks = (st.blocks || 0) + 1;

  const header = `[forge] Round ${st.round} · stage ${st.stage_idx + 1}/${st.plan.stages.length} "${st.plan.stages[st.stage_idx].id}"`;

  // Verification protocol incomplete: ask for the missing steps (all at once). The critic only when it is needed.
  const wantCritic = criticNeeded(st, art);
  if (!art.checks || !art.supervisor || (wantCritic && !art.critic)) {
    const reason = `${header}\nBuild work for this round is not accepted until it is verified. Do these now, in order, then end your turn:\n${protocol(st, art, cli, wantCritic)}`;
    return { allow: false, state: st, reason };
  }

  const ev = evaluate(st, art);
  const plan = st.plan;
  st.last_axes = ev.axes;
  st.last_eval = { approved: ev.approved, round: st.round, stage: ev.stage.id };
  st.last_sup_approved = art.supervisor.verdict === 'approve';
  if (art.critic) st.last_critic_axes = art.critic.axes;
  st.timings = upsertRound(st.timings, roundTiming(st, art));
  st.history = upsertRound(st.history, { round: st.round, stage: ev.stage.id, score: ev.score, approved: ev.approved });

  // Supervisor hit a blind spot: provision tools, then re-verify.
  if (art.supervisor.needs_tool?.length) {
    const wants = art.supervisor.needs_tool.map((n) => `- ${n.what}: ${n.why}`).join('\n');
    st.round += 1;
    st.round_started_at = nowMs;
    return { allow: false, state: st, reason: `${header}\nThe supervisor cannot observe parts of the product (blind spots). Delegate to the forge:toolsmith subagent (Agent tool, subagent_type "forge:toolsmith") with this list, handle any NEEDS_APPROVAL it returns by asking the user, then end your turn (verification restarts as round ${st.round}; no new build work needed unless something broke):\n${wants}` };
  }

  if (ev.approved) {
    // Checks that ran only the tests related to the change must be confirmed by the full suite once, before approval.
    const impacted = (art.checks.results || []).filter((r) => r.impact).map((r) => r.id);
    if (impacted.length) {
      st.blocks -= 1; // a request, not a rejection
      return { allow: false, state: st, reason: `${header}\nEverything passed using impact-selected checks. Before approval, confirm with the full suite: run  ${cli} checks --confirm  (re-runs: ${impacted.join(', ')}). Then end your turn.` };
    }
    const last = st.stage_idx === plan.stages.length - 1;
    if (!last) return advance(st, nowMs, `[forge] Stage "${ev.stage.id}" PASSED (score ${ev.score}).`);
    if (!art.signoff) {
      st.blocks -= 1; // a request, not a rejection
      return { allow: false, state: st, reason: `${header}\nFINAL GATE. Supervisor, critic, and hard checks approved. Before delivery, you must honestly sign off. Review the product against the original request: "${clip(st.prompt, 600)}".\nRun exactly one of:\n  ${cli} signoff complete "<one-line evidence>"\n  ${cli} signoff incomplete "<what is unfinished or faked>"\nIf anything is unfinished, say so; "incomplete" simply continues the loop.` };
    }
    if (art.signoff.complete !== true) {
      st.round += 1;
      st.round_started_at = nowMs;
      return { allow: false, state: st, reason: `[forge] You reported the work incomplete: ${clip(art.signoff.notes, 800)}\nFinish exactly that, then end your turn; verification restarts as round ${st.round}.` };
    }
    return toDelivering(st, 'approved', cli);
  }

  // Diminishing returns: only axes marginally below the bar, no hard failures, no reproducible blocking issues, and no real gain.
  const plateauN = st.opts?.plateau ?? 2;
  const gain = st.best ? ev.score - st.best.score : Infinity;
  const marginal = !ev.hard && ev.failedAxes.length > 0 && ev.failedAxes.every((f) => f.need - f.score <= 1) && !(art.critic?.blocking_issues || []).length;
  st.plateau = marginal && gain < 1 ? (st.plateau || 0) + 1 : 0;
  if (plateauN > 0 && st.plateau >= plateauN) {
    const gaps = ev.failedAxes.map((f) => `${f.id} ${f.score}/${f.need}`);
    st.gaps = [...(st.gaps || []), { stage: ev.stage.id, items: gaps }];
    if (st.stage_idx === plan.stages.length - 1) return toDelivering(st, 'plateau', cli, `[forge] diminishing returns: remaining gaps (${gaps.join(', ')}) are within one point of the bar and rounds are no longer improving.`);
    return advance(st, nowMs, `[forge] Diminishing returns at stage "${ev.stage.id}": remaining gaps (${gaps.join(', ')}) are within one point of the bar and stopped improving. Moving on; they are recorded and must be fixed in later stages.`);
  }

  // Rejected: stall accounting, then feedback.
  st.stall = st.stall || { rounds_without_gain: 0, strategy_changes: 0 };
  if (st.best && ev.score <= st.best.score) st.stall.rounds_without_gain += 1;
  else { st.best = { score: ev.score, round: st.round, stage: ev.stage.id }; st.stall.rounds_without_gain = 0; }

  let stallNote = '';
  if (st.stall.rounds_without_gain >= 3) {
    st.stall.strategy_changes += 1;
    st.stall.rounds_without_gain = 0;
    if (st.stall.strategy_changes > 2) return toDelivering(st, 'stalled', cli, '[forge] no score improvement across repeated strategy changes.');
    stallNote = `\n\nSTALL: scores have not improved for 3 rounds. Do NOT keep patching the same way. Pick one: rewrite the weakest module from scratch, switch to a simpler/different approach, or cut scope to what can actually reach the bar. State the strategy change in one line, then execute it.`;
  }

  const fb = feedback(st, ev, art);
  st.round += 1;
  st.round_started_at = nowMs;
  return { allow: false, state: st, reason: clip(`${fb}${stallNote}\n\nFix everything above, then end your turn; verification restarts as round ${st.round}.`, MAX_REASON) };
}
