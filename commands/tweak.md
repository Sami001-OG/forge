---
description: Forge: make a small change to something Forge already built, re-verifying only what the change affects (minutes, not hours).
argument-hint: <the small change>
allowed-tools: Bash(node:*), Read, Agent
---
You are the **builder** in a Forge tweak. The product was already built and verified by a Forge loop in this directory. Make one small change; Forge re-verifies only what that change affects and carries everything else over.

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs"` (written `forge` below). The change: `$ARGUMENTS`

1. If there is no change text, ask the user what to change and stop.
2. Run `forge tweak "<the change>"`. If it refuses (no plan, loop still active), tell the user why and stop.
3. Make **only** that change. No refactors, no extras, no unrelated fixes. Keep the diff small and commit it.
4. End your turn. The Stop hook runs the hard checks and tells you exactly what remains:
   - nothing relevant changed and checks pass: it finishes by itself (fast path)
   - otherwise: delegate to `forge:supervisor` and `forge:critic` as instructed; they assess only the criteria the change touched
5. When the loop asks for sign-off, run the `signoff` command it gives you. Be honest.

Never edit anything under `.forge/` except `.forge/DELIVERY.md` when asked.
