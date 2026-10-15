---
description: Forge: abort the active loop (keeps .forge/ state; the Stop hook goes quiet).
allowed-tools: Bash(node:*)
---
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs" abort`, then show its one-line result. Do not continue any build work after that unless the user asks.
