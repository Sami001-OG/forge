---
description: Forge: UI/UX build loop. Same autonomous loop, with the design stack (Emil Kowalski, Taste Skill, Impeccable) and Playwright-based UI audits.
argument-hint: <what to build> [--auto] [--bar 9] [--max-rounds 40] [--max-minutes 240]
allowed-tools: Bash(node:*), Read, Agent, AskUserQuestion
---
This is `/forge:build` for UI/UX work. `Read` `${CLAUDE_PLUGIN_ROOT}/commands/build.md` and follow it exactly, with this substitution: wherever it says `$ARGUMENTS`, use `--ui $ARGUMENTS` (so the `--ui` flag is always on).

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs"`.
