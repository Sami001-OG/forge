// forge uiaudit <url> [--pages /,/pricing] [--viewports 375x812,768x1024,1440x900] [--max-ui-ms 400] [--strict] [--max-warnings N]
// Deterministic UI/UX audit with real Playwright: screenshots at every breakpoint, dark mode, reduced motion,
// keyboard focus, layout shift, overflow, tap targets, text size, accessible names, and motion hygiene.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, forgeDir, readJson, posix } from './lib/util.mjs';
import { loadPlaywright, launchArgs } from './lib/pw.mjs';

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const base = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
if (!base) { console.error('usage: forge uiaudit <url> [--pages /,/x] [--viewports 375x812,768x1024,1440x900] [--max-ui-ms 400] [--strict] [--max-warnings N]'); process.exit(2); }

const project = projectDir();
const state = readJson(path.join(forgeDir(project), 'state.json'), {});
const evidence = path.join(forgeDir(project), 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const pw = loadPlaywright(project);
if (!pw) { console.error('forge: playwright is not installed. Run: forge tool install playwright'); process.exit(3); }

const viewports = val('viewports', '375x812,768x1024,1440x900').split(',').map((v) => { const [w, h] = v.split('x').map(Number); return { width: w, height: h }; });
const pages = val('pages', '').split(',').filter(Boolean);
const urls = (pages.length ? pages : ['']).map((p) => ({ label: p || '/', url: p ? new URL(p, base).href : base }));
const maxUiMs = Number(val('max-ui-ms', 400));
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'home';

// Runs inside the page.
const inPage = ({ maxUiMs }) => {
  const found = new Map();
  const add = (type, severity, el, detail) => {
    const f = found.get(type) || { type, severity, count: 0, examples: [] };
    f.count++;
    if (f.examples.length < 4) {
      let sel = '';
      if (el) { sel = el.id ? `#${el.id}` : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''); }
      f.examples.push(`${sel}${detail ? ` ${detail}` : ''}`.trim());
    }
    found.set(type, f);
  };
  const vw = window.innerWidth;
  const root = document.documentElement;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0'; };
  const ms = (s) => Math.max(0, ...String(s).split(',').map((x) => { x = x.trim(); return x.endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000; }).filter((n) => !Number.isNaN(n)));

  if (!root.lang) add('missing-lang', 'error', root, '<html> has no lang attribute');
  if (!document.title.trim()) add('missing-title', 'error', null, 'document has no <title>');
  if (!document.querySelector('meta[name=viewport]')) add('missing-viewport-meta', 'error', null, 'no <meta name="viewport">: mobile browsers will render a zoomed-out desktop layout');
  const h1 = document.querySelectorAll('h1').length;
  if (h1 === 0) add('no-h1', 'warning', null, 'page has no <h1>');
  if (h1 > 1) add('multiple-h1', 'warning', null, `${h1} <h1> elements`);
  if (root.scrollWidth > vw + 1) add('overflow-x', 'error', null, `page is ${root.scrollWidth}px wide in a ${vw}px viewport`);

  const els = [...document.querySelectorAll('body *')].filter(visible).slice(0, 4000);
  const interactiveSel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[tabindex]:not([tabindex="-1"])';
  const hasName = (el) => {
    const al = el.getAttribute('aria-label'); if (al && al.trim()) return true;
    const lb = el.getAttribute('aria-labelledby'); if (lb && lb.split(/\s+/).some((id) => { const t = document.getElementById(id); return t && t.textContent.trim(); })) return true;
    if ((el.textContent || '').trim()) return true;
    if (el.getAttribute('title')) return true;
    if (el.tagName === 'INPUT' && el.value) return true;
    const img = el.querySelector('img[alt]'); if (img && img.alt.trim()) return true;
    return !!el.querySelector('svg title');
  };
  let animated = false;
  for (const el of els) {
    const cs = getComputedStyle(el);
    const tag = el.tagName;
    if (tag === 'IMG' && !el.hasAttribute('alt')) add('img-no-alt', 'error', el, 'image has no alt attribute');
    const interactive = el.matches(interactiveSel);
    if (interactive) {
      const r = el.getBoundingClientRect();
      const inline = cs.display === 'inline';
      if (!inline) {
        const m = Math.min(r.width, r.height);
        if (m < 24) add('tap-target-too-small', 'error', el, `${Math.round(r.width)}x${Math.round(r.height)}px (minimum 24px)`);
        else if (vw < 500 && m < 44) add('tap-target-below-44', 'warning', el, `${Math.round(r.width)}x${Math.round(r.height)}px on mobile (aim for 44px)`);
      }
      if ((tag === 'BUTTON' || tag === 'A') && !hasName(el)) add('no-accessible-name', 'error', el, 'interactive element has no accessible name');
      if (tag === 'INPUT' && !['submit', 'button', 'reset', 'image', 'hidden'].includes(el.type) && !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) add('input-no-label', 'warning', el, 'input has no label');
    }
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (hasOwnText && parseFloat(cs.fontSize) < 12 && !['SUP', 'SUB'].includes(tag)) add('tiny-text', 'warning', el, `${cs.fontSize} text`);
    const td = ms(cs.transitionDuration);
    if (td > 0) {
      animated = true;
      if (cs.transitionProperty === 'all' || cs.transitionProperty.split(',').map((x) => x.trim()).includes('all')) add('transition-all', 'warning', el, 'transition: all animates every property; name the properties');
      if (interactive && td > maxUiMs) add('slow-ui-transition', 'warning', el, `${Math.round(td)}ms on an interactive element (aim for under ${maxUiMs}ms)`);
      const tf = cs.transitionTimingFunction;
      if (/^(linear|ease-in)(,|$)/.test(tf.trim())) add('weak-easing', 'warning', el, `${tf.split(',')[0]} feels sluggish for UI; prefer ease-out or a custom curve`);
    }
    if (cs.animationName !== 'none' && ms(cs.animationDuration) > 0) animated = true;
  }
  let reducedRule = false;
  const scan = (rules) => { for (const r of rules) { try { if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) reducedRule = true; if (r.cssRules) scan(r.cssRules); } catch { /* cross-origin sheet */ } } };
  for (const sh of document.styleSheets) { try { scan(sh.cssRules); } catch { /* cross-origin sheet */ } }
  if (animated && !reducedRule) add('no-reduced-motion-rule', 'warning', null, 'transitions or animations exist but no prefers-reduced-motion rule was found');
  return { issues: [...found.values()], elements: els.length };
};

const browser = await pw.chromium.launch({ args: launchArgs() });
const results = [];
const issueCount = { error: 0, warning: 0 };
const record = (label, viewport, mode, issues, shot, extra = {}) => {
  for (const i of issues) issueCount[i.severity] += 1;
  results.push({ page: label, viewport: `${viewport.width}x${viewport.height}`, mode, screenshot: shot ? posix(path.relative(project, shot)) : null, issues, ...extra });
};

try {
  for (const { label, url } of urls) {
    for (const [vi, vp] of viewports.entries()) {
      const mobile = vp.width < 500;
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
      await ctx.addInitScript(() => { window.__cls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch { /* unsupported */ } });
      const page = await ctx.newPage();
      const runtime = [];
      page.on('console', (m) => { if (m.type() === 'error') runtime.push({ type: 'console-error', severity: 'error', count: 1, examples: [m.text().slice(0, 200)] }); });
      page.on('pageerror', (e) => runtime.push({ type: 'page-error', severity: 'error', count: 1, examples: [String(e).slice(0, 200)] }));
      page.on('response', (r) => { if (r.status() >= 400) runtime.push({ type: 'http-error', severity: 'error', count: 1, examples: [`${r.status()} ${r.url().slice(0, 160)}`] }); });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(700);
      const shot = path.join(evidence, `r${state.round ?? 0}-ui-${slug(label)}-${vp.width}x${vp.height}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      const { issues } = await page.evaluate(inPage, { maxUiMs });
      const cls = await page.evaluate(() => window.__cls || 0);
      if (cls > 0.1) issues.push({ type: 'layout-shift', severity: 'warning', count: 1, examples: [`cumulative layout shift ${cls.toFixed(3)} (aim for under 0.1)`] });
      if (vp.width >= 1024 && vi === viewports.length - 1) {
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Tab');
          const r = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const cs = getComputedStyle(el); return { ok: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none'), sel: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') }; });
          if (r && !r.ok) { issues.push({ type: 'no-focus-indicator', severity: 'warning', count: 1, examples: [`${r.sel} shows no visible focus style when tabbed to`] }); break; }
        }
      }
      record(label, vp, 'light', [...runtime, ...issues], shot);
      await ctx.close();
    }
    // Dark mode and reduced motion, at the widest viewport.
    const vp = viewports[viewports.length - 1];
    for (const mode of ['dark', 'reduced-motion']) {
      const ctx = await browser.newContext({ viewport: vp, ...(mode === 'dark' ? { colorScheme: 'dark' } : { reducedMotion: 'reduce' }) });
      const page = await ctx.newPage();
      const runtime = [];
      page.on('pageerror', (e) => runtime.push({ type: 'page-error', severity: 'error', count: 1, examples: [String(e).slice(0, 200)] }));
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(500);
      const shot = path.join(evidence, `r${state.round ?? 0}-ui-${slug(label)}-${mode}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      const issues = [...runtime];
      if (mode === 'dark') {
        const { issues: all } = await page.evaluate(inPage, { maxUiMs });
        issues.push(...all.filter((i) => i.type === 'overflow-x'));
      } else {
        const n = await page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect && a.effect.getTiming(); return a.playState === 'running' && t && (t.iterations === Infinity || t.duration > 1000); }).length);
        if (n > 0) issues.push({ type: 'ignores-reduced-motion', severity: 'warning', count: n, examples: [`${n} long or endless animation(s) still run with prefers-reduced-motion: reduce`] });
      }
      record(label, vp, mode, issues, shot);
      await ctx.close();
    }
  }
} catch (e) {
  console.error('forge uiaudit failed: ' + (e.message || e));
  if (/Executable doesn't exist|browserType.launch/.test(String(e))) console.error('hint: browser missing. Run `forge tool run playwright -- install chromium` (and `install-deps` on Linux).');
  await browser.close();
  process.exit(1);
}
await browser.close();

const reportFile = path.join(evidence, `r${state.round ?? 0}-uiaudit.json`);
const report = { url: base, generated: new Date().toISOString(), viewports: viewports.map((v) => `${v.width}x${v.height}`), totals: issueCount, results };
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

const maxWarn = val('max-warnings') !== undefined ? Number(val('max-warnings')) : flag('strict') ? 0 : Infinity;
const fail = issueCount.error > 0 || issueCount.warning > maxWarn;
for (const r of results) {
  const e = r.issues.filter((i) => i.severity === 'error').length, w = r.issues.filter((i) => i.severity === 'warning').length;
  console.log(`${e ? 'FAIL' : 'ok  '} ${r.page} ${r.viewport} ${r.mode}: ${e} error type(s), ${w} warning type(s)`);
  for (const i of r.issues) console.log(`   ${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.type} x${i.count}: ${i.examples[0] || ''}`);
}
console.log(`${fail ? 'FAIL' : 'PASS'} uiaudit: ${issueCount.error} error(s), ${issueCount.warning} warning(s) across ${results.length} capture(s)`);
console.log(`report: file:${posix(path.relative(project, reportFile))}`);
for (const r of results) if (r.screenshot) console.log(`screenshot: file:${r.screenshot}  (${r.page} ${r.viewport} ${r.mode})`);
process.exit(fail ? 1 : 0);
