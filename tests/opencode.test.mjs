import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adaptAgent, adaptCommand, adaptBody, splitFrontmatter } from '../scripts/lib/opencode-adapt.mjs';
import { createHooks } from '../scripts/lib/opencode-loop.mjs';
import { decide } from '../scripts/lib/gate-logic.mjs';
import { makeState } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(root, 'scripts', 'opencode-install.mjs');
const tmp = (p = 'forge-oc-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const RT = '/opt/forge';

test('adapt: names, tools, paths and hook wording are translated', () => {
  const t = adaptBody('Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs"`. Delegate with the Agent tool to forge:supervisor, see /forge:build. The Stop hook then. Use AskUserQuestion.', { runtimeDir: RT });
  assert.match(t, /node "\/opt\/forge\/scripts\/forge\.mjs"/);
  assert.match(t, /Task tool to forge-supervisor, see \/forge-build/);
  assert.match(t, /The Forge loop plugin then/);
  assert.match(t, /the question tool/);
  assert.doesNotMatch(t, /CLAUDE_PLUGIN_ROOT|forge:|Agent tool/);
});

test('adapt: agents become read-only subagents with permission, steps, optional model', () => {
  const src = fs.readFileSync(path.join(root, 'agents', 'supervisor.md'), 'utf8');
  const out = adaptAgent(src, { runtimeDir: RT, verifierModel: 'anthropic/claude-sonnet-4-5' });
  const { fm, body } = splitFrontmatter(out);
  assert.equal(fm.mode, 'subagent');
  assert.equal(fm.steps, '80');
  assert.equal(fm.model, 'anthropic/claude-sonnet-4-5');
  assert.match(out, /permission:\n {2}edit: deny/);
  assert.doesNotMatch(out.split('\n---\n')[0], /tools:|disallowedTools|maxTurns|inherit/);
  assert.ok(fm.description.startsWith('Forge supervisor'), 'description is not double-quoted');
  assert.match(body, /forge exec --|forge verdict/);
  assert.doesNotMatch(body, /CLAUDE_PLUGIN_ROOT/);
  // the model override applies only to the verifiers
  assert.equal(splitFrontmatter(adaptAgent(fs.readFileSync(path.join(root, 'agents', 'planner.md'), 'utf8'), { runtimeDir: RT, verifierModel: 'x/y' })).fm.model, undefined);
});

test('adapt: commands keep only a description; --ui is baked into forge-ui', () => {
  const c = adaptCommand(fs.readFileSync(path.join(root, 'commands', 'build.md'), 'utf8'), { runtimeDir: RT, args: '--ui $ARGUMENTS' });
  const { fm } = splitFrontmatter(c);
  assert.deepEqual(Object.keys(fm), ['description']);
  assert.match(c, /--ui \$ARGUMENTS/);
  assert.doesNotMatch(c, /argument-hint|allowed-tools/);
});

test('installer: global install writes plugin, agents, commands, runtime; uninstall removes them', () => {
  const xdg = tmp();
  const env = { ...process.env, XDG_CONFIG_HOME: xdg };
  const base = path.join(xdg, 'opencode');
  let r = spawnSync(process.execPath, [INSTALL, '--global', '--verifier-model', 'anthropic/claude-sonnet-4-5'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(base, 'plugin', 'forge.js')));
  assert.ok(fs.existsSync(path.join(base, 'forge', 'scripts', 'forge.mjs')));
  assert.ok(fs.existsSync(path.join(base, 'forge', 'catalog', 'tools.json')));
  assert.ok(!fs.existsSync(path.join(base, 'forge', 'scripts', 'dev')), 'maintainer tools are not shipped');
  assert.deepEqual(fs.readdirSync(path.join(base, 'agent')).sort(), ['forge-critic.md', 'forge-planner.md', 'forge-supervisor.md', 'forge-toolsmith.md']);
  assert.deepEqual(fs.readdirSync(path.join(base, 'command')).sort(), ['forge-abort.md', 'forge-build.md', 'forge-doctor.md', 'forge-status.md', 'forge-tweak.md', 'forge-ui.md']);
  for (const d of ['agent', 'command']) for (const f of fs.readdirSync(path.join(base, d))) {
    const t = fs.readFileSync(path.join(base, d, f), 'utf8');
    assert.doesNotMatch(t, /CLAUDE_PLUGIN_ROOT|forge:(planner|supervisor|critic|toolsmith)|Agent tool/, f);
    assert.match(t, /^---\ndescription: "/, f);
  }
  assert.match(fs.readFileSync(path.join(base, 'command', 'forge-ui.md'), 'utf8'), /--ui \$ARGUMENTS/);
  assert.match(fs.readFileSync(path.join(base, 'agent', 'forge-critic.md'), 'utf8'), /model: anthropic\/claude-sonnet-4-5/);
  assert.doesNotMatch(fs.readFileSync(path.join(base, 'agent', 'forge-planner.md'), 'utf8'), /^model:/m);
  // the installed runtime works on its own
  const doc = spawnSync(process.execPath, [path.join(base, 'forge', 'scripts', 'forge.mjs'), 'doctor'], { env: { ...env, CLAUDE_PROJECT_DIR: tmp(), FORGE_TOOLS_DIR: tmp() }, encoding: 'utf8' });
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  r = spawnSync(process.execPath, [INSTALL, '--global', '--uninstall'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(base, 'plugin', 'forge.js')));
  assert.ok(!fs.existsSync(path.join(base, 'forge')));
  assert.deepEqual(fs.readdirSync(path.join(base, 'agent')), []);
});

test('installer: --project writes into <dir>/.opencode; --dry-run writes nothing', () => {
  const dir = tmp();
  let r = spawnSync(process.execPath, [INSTALL, '--project', dir, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.opencode')));
  r = spawnSync(process.execPath, [INSTALL, '--project', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.opencode', 'plugin', 'forge.js')));
  assert.ok(fs.existsSync(path.join(dir, '.opencode', 'agent', 'forge-supervisor.md')));
});

// ---------- plugin hooks, with a mock OpenCode client ----------
function setup(stateOver = {}) {
  const project = tmp('forge-oc-proj-');
  fs.mkdirSync(path.join(project, '.forge'), { recursive: true });
  const state = makeState({ created_at: Date.now(), ...stateOver });
  fs.writeFileSync(path.join(project, '.forge', 'state.json'), JSON.stringify(state));
  const sent = [];
  const sessions = { main: {}, child: { parentID: 'main' } };
  const client = { session: { get: async ({ path: p }) => ({ data: sessions[p.id] || {} }), promptAsync: async (a) => { sent.push(a); } } };
  let clock = 1_000_000;
  const hooks = createHooks({ client, directory: project, runtimeDir: path.join(root), now: () => clock });
  return { project, sent, hooks, client, advance: (ms) => { clock += ms; }, readState: () => JSON.parse(fs.readFileSync(path.join(project, '.forge', 'state.json'), 'utf8')) };
}
const idle = (id) => ({ event: { type: 'session.idle', properties: { sessionID: id } } });

test('plugin: main session going idle sends the gate instruction as the next prompt', async () => {
  const s = setup();
  await s.hooks.event(idle('main'));
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].path.id, 'main');
  const text = s.sent[0].body.parts[0].text;
  assert.match(text, /\[forge\] Round 1/);
  assert.match(text, /Run the machine checks/);
  // once the machine checks pass, the next instruction launches the reviewers by their OpenCode names
  fs.writeFileSync(path.join(s.project, '.forge', 'checks-1.json'), JSON.stringify({ round: 1, results: [{ id: 'smoke', ok: true, code: 0, tail: '' }], all_pass: true }));
  s.advance(3000);
  await s.hooks.event(idle('main'));
  const text2 = s.sent[1].body.parts[0].text;
  assert.match(text2, /subagent_type "forge-supervisor"/);
  assert.match(text2, /Task tool/);
  assert.doesNotMatch(text2, /forge:supervisor|Agent tool/);
  assert.equal(s.readState().session_id, 'main', 'the loop adopts the main session');
  assert.equal(s.readState().blocks, 2);
});

test('plugin: child sessions, other sessions, inactive loops and rapid repeats are ignored', async () => {
  let s = setup();
  await s.hooks.event(idle('child'));
  assert.equal(s.sent.length, 0, 'subagent sessions are never driven');
  s = setup({ session_id: 'someone-else' });
  await s.hooks.event(idle('main'));
  assert.equal(s.sent.length, 0, 'another session owns the loop');
  for (const status of ['done', 'aborted', 'planning']) { s = setup({ status }); await s.hooks.event(idle('main')); assert.equal(s.sent.length, 0, status); }
  s = setup();
  await s.hooks.event(idle('main'));
  await s.hooks.event(idle('main'));
  assert.equal(s.sent.length, 1, 'an idle right after our own prompt is the same turn');
  s.advance(3000);
  await s.hooks.event(idle('main'));
  assert.equal(s.sent.length, 2);
  await s.hooks.event({ event: { type: 'session.updated', properties: {} } });
  assert.equal(s.sent.length, 2, 'other events are ignored');
});

test('plugin: falls back to session.prompt, and never throws on client errors', async () => {
  const s = setup();
  const sent = [];
  const hooks = createHooks({ client: { session: { get: async () => ({ data: {} }), prompt: async (a) => { sent.push(a); } } }, directory: s.project, runtimeDir: root, now: () => 5_000_000 });
  await hooks.event(idle('main'));
  assert.equal(sent.length, 1);
  const bad = createHooks({ client: { session: { get: async () => ({ data: {} }), promptAsync: async () => { throw new Error('network down'); } } }, directory: setup().project, runtimeDir: root, now: () => 9_000_000 });
  await assert.doesNotReject(bad.event(idle('main')));
});

test('plugin: the guard blocks edits to loop state and allows everything else', async () => {
  const s = setup();
  const before = s.hooks['tool.execute.before'];
  await assert.rejects(before({ tool: 'write' }, { args: { filePath: path.join(s.project, '.forge', 'state.json') } }), /written only by the forge CLI/);
  await assert.rejects(before({ tool: 'edit' }, { args: { filePath: '.forge/verdict-1-critic.json' } }), /forge CLI/);
  await assert.rejects(before({ tool: 'bash' }, { args: { command: 'echo {} > .forge/checks-1.json' } }), /forge CLI/);
  await assert.doesNotReject(before({ tool: 'write' }, { args: { filePath: path.join(s.project, 'src', 'app.js') } }));
  await assert.doesNotReject(before({ tool: 'bash' }, { args: { command: 'npm test' } }));
  await assert.doesNotReject(before({ tool: 'read' }, { args: { filePath: '.forge/state.json' } }));
  const none = setup();
  fs.rmSync(path.join(none.project, '.forge', 'state.json'));
  await assert.doesNotReject(none.hooks['tool.execute.before']({ tool: 'write' }, { args: { filePath: '.forge/state.json' } }), 'inert without a loop');
});

test('plugin: shell.env puts Forge tools on PATH', async () => {
  const s = setup();
  const output = { env: { PATH: '/usr/bin' } };
  await s.hooks['shell.env']({ cwd: s.project }, output);
  assert.match(output.env.PATH, /tools\/bin/);
  assert.match(output.env.PATH, /\/usr\/bin$/);
  assert.equal(output.env.FORGE_HOST, 'opencode');
});

test('gate wording follows the host', () => {
  const st = makeState();
  const empty = { checks: null, supervisor: null, critic: null, signoff: null, delivery: false };
  const passed = { ...empty, checks: { round: 1, results: [], all_pass: true } };
  const claude = decide(st, passed, 1_060_000, { cli: 'forge' });
  const oc = decide(st, passed, 1_060_000, { cli: 'forge', host: 'opencode' });
  assert.match(claude.reason, /forge:supervisor/);
  assert.match(oc.reason, /forge-supervisor/);
  assert.match(oc.reason, /Task tool/);
});
