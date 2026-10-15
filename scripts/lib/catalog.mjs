import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, forgeDir } from './util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const catalogDir = path.join(root, 'catalog');
export const pluginRoot = root;

export function loadCatalog(project) {
  const base = readJson(path.join(catalogDir, 'tools.json'), { tools: [] }).tools;
  const custom = project ? readJson(path.join(forgeDir(project), 'custom-tools.json'), { tools: [] }).tools : [];
  const byId = new Map();
  for (const t of base) byId.set(t.id, t);
  for (const t of custom) byId.set(t.id, { ...t, custom: true, tier: Math.max(2, t.tier ?? 2) });
  return [...byId.values()];
}

export const loadBundles = () => readJson(path.join(catalogDir, 'bundles.json'), {});
export const loadTargets = () => readJson(path.join(catalogDir, 'targets.json'), { targets: {}, common_axes: [] });

export function search(tools, q) {
  const s = String(q).toLowerCase();
  return tools.filter((t) => [t.id, t.summary, ...(t.domains || []), ...(t.observes || []), ...(t.controls || [])].join(' ').toLowerCase().includes(s));
}
