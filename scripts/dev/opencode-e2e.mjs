// Maintainer tool: proves the OpenCode plugin really drives the loop, against a live OpenCode server and a fake LLM.
//   node scripts/dev/opencode-e2e.mjs <path-to-opencode-binary> <path-to-@opencode-ai/sdk>
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [OC, SDK] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-oc-e2e-'));
// FORGE_E2E_HOME keeps OpenCode's package cache between runs (the first boot downloads the fake provider package and can be slow).
const home = process.env.FORGE_E2E_HOME || path.join(tmp, 'home'), proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'), CLAUDE_PROJECT_DIR: proj, FORGE_TOOLS_DIR: path.join(proj, '.forge', 'tools') };
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { env, cwd: proj, encoding: 'utf8', ...o });

const step = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
// 1. install Forge into this OpenCode, set up a running loop
let r = run(process.execPath, [path.join(root, 'scripts', 'opencode-install.mjs'), '--global']);
if (r.status !== 0) throw new Error('install failed: ' + r.stderr);
step('forge installed into OpenCode');
const forge = path.join(home, '.config', 'opencode', 'forge', 'scripts', 'forge.mjs');
const { rawPlan } = await import(pathToFileURL(path.join(root, 'tests', 'helpers.mjs')).href);
const F = (...a) => { const x = run(process.execPath, [forge, ...a]); if (x.status !== 0) throw new Error(`forge ${a.join(' ')}: ${x.stderr}${x.stdout}`); return x.stdout; };
F('init', 'build a tiny thing', '--auto');
fs.writeFileSync(path.join(proj, '.forge', 'plan.draft.json'), JSON.stringify(rawPlan()));
F('plan-set'); F('start');
step('loop started in the project');

// 2. a fake OpenAI-compatible LLM that always answers "done" and records what it was asked
const seen = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) { res.writeHead(404).end(); return; }
    try { const j = JSON.parse(body); const last = [...j.messages].reverse().find((m) => m.role === 'user'); seen.push(typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)); } catch { seen.push('?'); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: 'done' }));
    res.write(chunk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});
await new Promise((ok) => llm.listen(0, '127.0.0.1', ok));
const llmPort = llm.address().port;
step(`fake LLM on :${llmPort}`);
fs.writeFileSync(path.join(proj, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'fake/fake-model', provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'fake', options: { baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'x' }, models: { 'fake-model': { name: 'fake', limit: { context: 100000, output: 4000 } } } } } }));

// 3. start OpenCode headless and send one prompt
const port = 4100 + Math.floor(Math.random() * 400);
const srv = spawn(OC, ['serve', '--port', String(port), '--print-logs'], { env, cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
step(`opencode serve spawned on :${port}`);
let logs = '';
srv.stdout.on('data', (d) => (logs += d)); srv.stderr.on('data', (d) => (logs += d));
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
const { createOpencodeClient } = await import(pathToFileURL(path.join(SDK, 'dist', 'index.js')).href);
let ok = false, why = '';
try {
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, directory: proj });
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { try { await client.session.list(); up = true; } catch { await sleep(500); } }
  if (!up) throw new Error('opencode serve never became ready (first boot installs the fake provider package; check network). Log tail: ' + logs.split('\n').slice(-6).join(' | '));
  step('server answering');
  const s = await client.session.create({ body: { title: 'forge e2e' } });
  step('session created; sending prompt');
  await client.session.promptAsync({ path: { id: s.data.id }, body: { parts: [{ type: 'text', text: 'Build the thing.' }] } });
  for (let i = 0; i < 90 && seen.length < 2; i++) await sleep(500);
  console.log(`LLM requests seen: ${seen.length}`);
  seen.forEach((t, i) => console.log(`  #${i + 1}: ${String(t).slice(0, 150).replace(/\n/g, ' ')}`));
  ok = seen.length >= 2 && /\[forge\] Round 1/.test(seen[1]) && /Run the machine checks/.test(seen[1]) && /forge\.mjs/.test(seen[1]);
  why = ok ? '' : 'the second prompt was not the Forge gate instruction';
  const st = JSON.parse(fs.readFileSync(path.join(proj, '.forge', 'state.json'), 'utf8'));
  console.log(`state: status=${st.status} session_id=${st.session_id ? 'adopted' : 'none'} blocks=${st.blocks}`);
  ok = ok && !!st.session_id;
} catch (e) { why = String(e); }
srv.kill('SIGTERM'); llm.close();
if (!ok) { console.log('LOG TAIL:\n' + logs.split('\n').filter((l) => /error|forge|plugin/i.test(l)).slice(-12).join('\n')); }
console.log(ok ? 'PASS: the OpenCode plugin drove the loop (idle -> gate -> next prompt)' : `FAIL: ${why}`);
process.exit(ok ? 0 : 1);
