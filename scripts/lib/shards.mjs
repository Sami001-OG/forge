// Fan-out: split the criteria a supervisor must assess across several supervisors that run at the same time.
export function shardCount(dirty, max = 3) {
  const n = dirty >= 10 ? 3 : dirty >= 5 ? 2 : 1;
  return Math.max(1, Math.min(n, Math.max(1, max)));
}

// Round-robin keeps the shards balanced and each one in plan order.
export function partition(ids, k) {
  const out = Array.from({ length: Math.max(1, k) }, () => []);
  ids.forEach((id, i) => out[i % out.length].push(id));
  return out;
}

// Shard 0 is the lead: it also scores the rubric axes. The merged verdict approves only if every shard approves.
export function mergeSupervisor(parts) {
  const ordered = [...parts].sort((a, b) => a.shard - b.shard);
  const lead = ordered[0];
  return {
    verdict: ordered.every((p) => p.verdict === 'approve') ? 'approve' : 'continue',
    axes: lead.axes || {},
    criteria: ordered.flatMap((p) => p.criteria || []),
    issues: ordered.flatMap((p) => p.issues || []),
    next_prompt: ordered.filter((p) => p.next_prompt).map((p) => (ordered.length > 1 ? `[shard ${p.shard + 1}] ${p.next_prompt}` : p.next_prompt)).join('\n'),
    needs_tool: ordered.flatMap((p) => p.needs_tool || []),
    shards: ordered.length,
    written_at: ordered.map((p) => p.written_at).sort().at(-1),
  };
}
