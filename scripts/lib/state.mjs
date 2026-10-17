import fs from 'node:fs';
import path from 'node:path';
import { forgeDir, statePath, readJson, writeJsonAtomic } from './util.mjs';

export const DEFAULT_CAPS = { max_rounds: 40, max_minutes: 240, max_blocks: 400 };

export const DEFAULT_STAGES = [
  { id: 'skeleton', name: 'Skeleton', goal: 'Architecture decided, project scaffolded, one end-to-end slice running.', exit: ['It builds and runs', 'One real end-to-end path works', 'Structure and tooling are in place'] },
  { id: 'function', name: 'Function', goal: 'Every requested feature works, with automated tests.', exit: ['All features implemented', 'Tests cover each feature', 'No placeholder or fake data paths'] },
  { id: 'harden', name: 'Harden', goal: 'Edge cases, failure modes, security, performance.', exit: ['Invalid input and failure paths handled', 'No known security issues', 'Performance measured and acceptable'] },
  { id: 'polish', name: 'Polish', goal: 'Design system, interaction quality, copy, empty/loading/error states.', exit: ['Looks and feels like a best-in-class product', 'All states designed', 'Consistent visual and interaction language'] },
  { id: 'finish', name: 'Finish', goal: 'Docs, run/deploy instructions, cleanup, final verification.', exit: ['README and run instructions are accurate', 'No dead code, TODOs, or debug leftovers', 'Final end-to-end verification passes'] },
];

export const DEFAULT_BARS = { skeleton: 6, function: 8, harden: 9, polish: 9, finish: 9 };

export function loadState(project) {
  return readJson(statePath(project), null);
}

export function saveState(project, state) {
  writeJsonAtomic(statePath(project), state);
}

export const artifactFile = (project, kind, round, role) => {
  const d = forgeDir(project);
  if (kind === 'checks') return path.join(d, `checks-${round}.json`);
  if (kind === 'verdict') return path.join(d, `verdict-${round}-${role}.json`);
  if (kind === 'signoff') return path.join(d, `signoff-${round}.json`);
  throw new Error('unknown artifact ' + kind);
};

export function loadArtifacts(project, round) {
  return {
    checks: readJson(artifactFile(project, 'checks', round), null),
    supervisor: readJson(artifactFile(project, 'verdict', round, 'supervisor'), null),
    critic: readJson(artifactFile(project, 'verdict', round, 'critic'), null),
    signoff: readJson(artifactFile(project, 'signoff', round), null),
    scope: readJson(path.join(forgeDir(project), `scope-${round}.json`), null),
    delivery: fs.existsSync(path.join(forgeDir(project), 'DELIVERY.md')),
  };
}

export const ACTIVE = new Set(['running', 'delivering']);
