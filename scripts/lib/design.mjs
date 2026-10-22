// The UI/UX design stack: skills Forge installs from their own repos (never vendored) and reads by path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DESIGN_TOOLS = ['design-emil', 'design-taste', 'design-impeccable'];
export const DESIGN_SKILLS = {
  'design-emil': ['emil-design-eng', 'review-animations', 'animation-performance', 'break-ui'],
  'design-taste': ['design-taste-frontend'],
  'design-impeccable': ['impeccable'],
};
export const ROLE = {
  'emil-design-eng': 'motion and the unseen details (Emil Kowalski)',
  'review-animations': 'animation review lens (Emil Kowalski)',
  'animation-performance': 'animation performance (Emil Kowalski)',
  'break-ui': 'break the UI with worst-case data (Emil Kowalski)',
  'design-taste-frontend': 'art direction, anti-slop, pre-flight (Taste Skill)',
  impeccable: 'shape, craft, audit, critique, polish (Impeccable)',
};

export const skillRoots = (project) => [path.join(os.homedir(), '.claude', 'skills'), path.join(project, '.claude', 'skills')];

export function findSkills(project) {
  const out = {};
  for (const [tool, names] of Object.entries(DESIGN_SKILLS)) {
    out[tool] = [];
    for (const name of names) {
      for (const root of skillRoots(project)) {
        const file = path.join(root, name, 'SKILL.md');
        if (fs.existsSync(file)) { out[tool].push({ name, path: file }); break; }
      }
    }
  }
  return out;
}
