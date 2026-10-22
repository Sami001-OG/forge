// forge shot <url> [--out path.png] [--full] [--mobile] [--wait ms]
// Screenshots a page with the project-local Playwright, and records console errors and failed requests.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { projectDir, forgeDir, toolsDir, readJson, posix } from './lib/util.mjs';

const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.match(/^--(out|wait)$/));
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
if (!url) { console.error('usage: forge shot <url> [--out file.png] [--full] [--mobile] [--wait ms]'); process.exit(2); }

const project = projectDir();
const state = readJson(path.join(forgeDir(project), 'state.json'), {});
const dir = path.join(forgeDir(project), 'evidence');
fs.mkdirSync(dir, { recursive: true });
const stamp = `r${state.round ?? 0}-shot-${Date.now()}${flag('mobile') ? '-mobile' : ''}`;
const out = path.resolve(val('out') || path.join(dir, `${stamp}.png`));

let chromium;
try {
  const req = createRequire(path.join(toolsDir(project), 'npm', 'playwright', 'package.json'));
  ({ chromium } = req('playwright'));
} catch {
  console.error('forge: playwright is not installed. Run: node <forge.mjs> tool install playwright');
  process.exit(3);
}

const report = { url, console_errors: [], page_errors: [], failed_requests: [], http_errors: [] };
let browser;
try {
  browser = await chromium.launch({ args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });
  const ctx = await browser.newContext(flag('mobile') ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') report.console_errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => report.page_errors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => report.failed_requests.push(`${r.method()} ${r.url().slice(0, 200)} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) report.http_errors.push(`${r.status()} ${r.url().slice(0, 200)}`); });
  const t0 = Date.now();
  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (val('wait')) await page.waitForTimeout(parseInt(val('wait'), 10));
  report.status = resp?.status();
  report.load_ms = Date.now() - t0;
  report.title = await page.title();
  report.dom_nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  report.horizontal_scroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.screenshot({ path: out, fullPage: flag('full') });
  fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(report, null, 2));
  const bad = report.console_errors.length + report.page_errors.length + report.failed_requests.length + report.http_errors.length;
  console.log(JSON.stringify({ status: report.status, title: report.title, load_ms: report.load_ms, problems: bad, horizontal_scroll: report.horizontal_scroll }));
  console.log(`screenshot: file:${posix(path.relative(project, out))}  (view it with the Read tool)`);
  console.log(`report: file:${posix(path.relative(project, out.replace(/\.png$/, '.json')))}`);
  if (bad) console.log('problems:\n' + [...report.console_errors, ...report.page_errors, ...report.failed_requests, ...report.http_errors].slice(0, 10).map((x) => '  - ' + x).join('\n'));
} catch (e) {
  console.error('forge shot failed: ' + (e.message || e));
  if (/Executable doesn't exist|browserType.launch/.test(String(e))) console.error('hint: browser missing or missing system libs. Run `playwright install chromium` via forge tool run, and on Linux `playwright install-deps` (needs sudo).');
  process.exit(1);
} finally {
  await browser?.close();
}
