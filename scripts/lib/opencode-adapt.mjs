// Turns Forge's Claude Code agents and commands into OpenCode agents and commands.
// OpenCode agents have no tool allowlist (read-only is a `permission`), commands are plain markdown, and there is no
// ${CLAUDE_PLUGIN_ROOT}, so the installer bakes in the absolute runtime path.
const NAMES = /forge:(planner|supervisor|critic|toolsmith)/g;

export function adaptBody(text, { runtimeDir }) {
  return String(text)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', runtimeDir)
    .replace(NAMES, 'forge-$1')
    .replace(/\/forge:(build|ui|tweak|status|abort|doctor)\b/g, '/forge-$1')
    .replace(/Agent tool/g, 'Task tool')
    .replace(/AskUserQuestion/g, 'the question tool')
    .replace(/Stop hook/g, 'Forge loop plugin');
}

export function splitFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: String(text) };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) {
      let v = line.slice(i + 1).trim();
      if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { /* keep raw */ } }
      fm[line.slice(0, i).trim()] = v;
    }
  }
  return { fm, body: m[2] };
}

const q = (v) => JSON.stringify(String(v));

export function adaptAgent(text, { runtimeDir, verifierModel }) {
  const { fm, body } = splitFrontmatter(text);
  const lines = ['---', `description: ${q(fm.description || '')}`, 'mode: subagent'];
  if (verifierModel && ['supervisor', 'critic'].includes(fm.name)) lines.push(`model: ${verifierModel}`);
  if (/^\d+$/.test(fm.maxTurns || '')) lines.push(`steps: ${fm.maxTurns}`);
  // Every Forge subagent is read-only on product code (it works through bash and the forge CLI).
  lines.push('permission:', '  edit: deny', '---', '');
  return lines.join('\n') + adaptBody(body, { runtimeDir });
}

export function adaptCommand(text, { runtimeDir, args }) {
  const { fm, body } = splitFrontmatter(text);
  let out = adaptBody(body, { runtimeDir });
  if (args) out = out.replaceAll('$ARGUMENTS', args);
  return ['---', `description: ${q(fm.description || '')}`, '---', ''].join('\n') + out;
}
