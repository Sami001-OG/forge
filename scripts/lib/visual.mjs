// Pixel comparison for `forge visual`. pngjs and pixelmatch are installed on demand by the toolsmith/provisioner.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { toolsDir } from './util.mjs';

export async function loadImgLibs(project) {
  const nm = path.join(toolsDir(project), 'npm', '_libs', 'node_modules');
  const req = createRequire(path.join(nm, 'noop.js'));
  const { PNG } = req('pngjs');
  const dir = path.join(nm, 'pixelmatch');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let entry = pkg.exports;
  if (entry && typeof entry === 'object') entry = entry['.'] ?? entry;
  if (entry && typeof entry === 'object') entry = entry.import ?? entry.default ?? entry.require;
  entry = (typeof entry === 'string' ? entry : pkg.module || pkg.main || 'index.js');
  const mod = await import(pathToFileURL(path.join(dir, entry)).href);
  return { PNG, pixelmatch: mod.default || mod };
}

export function comparePng(PNG, pixelmatch, bufA, bufB, { threshold = 0.1 } = {}) {
  const a = PNG.sync.read(bufA), b = PNG.sync.read(bufB);
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, pct: 100, diffPixels: a.width * a.height, total: a.width * a.height };
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
  const total = a.width * a.height;
  return { sizeMismatch: false, diffPixels: n, total, pct: (n / total) * 100, diffPng: PNG.sync.write(diff) };
}
