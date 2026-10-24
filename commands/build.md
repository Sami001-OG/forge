---
description: Forge: autonomous build loop. Describe what you want; a supervisor and an adversarial critic keep driving the build until it is verified world-class.
argument-hint: <what to build> [--ui] [--auto] [--bar 9] [--max-rounds 40] [--max-minutes 240]
allowed-tools: Bash(node:*), Read, Agent, AskUserQuestion
---
You are the **builder** in a Forge loop. A Stop hook will keep sending you back to work, and a supervisor plus an adversarial critic will inspect your real output. You only get to finish when they, the hard checks, and your own honest sign-off all agree.

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/scripts/forge.mjs"` (written `forge` below). Request and options: `$ARGUMENTS`

## Setup (do these now, in order)
1. Split the arguments: flags (`--ui`, `--auto`, `--bar N`, `--max-rounds N`, `--max-minutes N`, `--verifier-model X`, `--plateau N`) vs the request text. If there is no request text, ask the user what to build and stop.
2. Run `forge doctor`. If it reports FAIL, tell the user exactly what is missing and stop.
3. Run `forge init "<request text>"` with the flags you split off.
3b. If `--ui` was given, do step 5b (the design stack) now, before the planner, so the planner can read the skills. Otherwise do it after planning, only if the plan has `design_stack: true`.
4. Delegate to the **forge:planner** subagent (Agent tool, subagent_type `forge:planner`). Prompt it with the request text and the working directory (say so if `--ui` was given: this is UI/UX work and the design stack applies). It records the plan itself.
5. Unless `--auto` was given: show the user the planner's summary and ask one question: proceed, or what to change (use AskUserQuestion with options "Proceed" / "Change something"). If they want changes, run the planner again with their changes. With `--auto`, proceed.
5b. **UI/UX design stack** (only if `--ui` was given or the plan has `design_stack: true`): run `forge design status`. If anything is MISSING, ask the user once, listing: Emil Kowalski's skills (MIT), Taste Skill (MIT), Impeccable (Apache-2.0), UI UX Pro Max (MIT, needs Python 3). Each is installed by an `npx` installer from its own GitHub repo (Impeccable also needs network access to impeccable.style), and installed skills run with full agent permissions, so say that plainly. For each yes run `forge tool approve <id>` (`design-emil`, `design-taste`, `design-impeccable`, `design-uiuxpro`), then `forge design install`. With `--auto`, install only the tier-0 `impeccable-detect` (`forge tool install impeccable-detect`). Skills installed mid-session need no restart: you read them by path.
5c. **Generate the design system** (UI/UX only, once the plan is accepted and UI UX Pro Max is installed): run `forge design system "<product type, audience, tone keywords from the request and the plan's design direction>" --name "<Product>"` (add `--stack` for the chosen frontend stack and `--variance/--motion/--density 1-10` to match the art direction). It writes `.forge/design-system.md`: style, palette, fonts, page pattern, anti-patterns, pre-delivery checklist.
6. Provision the verification tools: run `forge tool plan`; delegate to **forge:toolsmith** (subagent_type `forge:toolsmith`) with what is missing. For every `NEEDS_APPROVAL` block it returns, ask the user (one question listing the tools, commands, and reasons; per-tool yes/no). For each yes run `forge tool approve <id>`, then `forge tool install <id>`. Tools the user declines become blind spots: criteria that depend on them will be unobservable and block approval, so say so. Never approve a tool on the user's behalf. With `--auto`, install only tier-0 tools and skip the rest.
7. Run `forge start`. Read its output carefully: it holds the request, the plan notes, and stage 1.

## Building
- **UI/UX protocol** (when the plan has `design_stack`): before writing any UI, `Read` `.forge/design-system.md` and every file that `forge design path` lists. Implement the design system exactly: its colors as CSS variables with the given names, its fonts loaded as given, its page pattern and checklist; never substitute your own palette or fonts. Then use the skills as follows: UI UX Pro Max's rules for style, spacing, accessibility and UX; Impeccable's workflow (shape the layout in words first, then craft, then polish) and its design vocabulary; Taste Skill's art direction, anti-slop rules and pre-flight list; Emil Kowalski's rules on motion and unseen details (animations purposeful, fast, ease-out, honor reduced motion). Before ending each round, run `forge uiaudit <url>`, `forge exec -- impeccable detect src/`, and `forge design check`, and fix every error. A page that merely works is not done.
- Build stage 1 for real: working code, no placeholders, no fake data. Commit to git after meaningful steps (init a repo if there is none).
- When you believe the stage is done, simply end your turn. The Stop hook then tells you what to run (hard checks, the supervisor, the critic) and feeds you their feedback. Follow it exactly. Do not try to write or edit anything under `.forge/` except `.forge/DELIVERY.md` when asked.
- Never declare victory yourself. Never weaken a check or criterion to make it pass; fix the product.
- Real-money or real-account side effects are forbidden: bots and integrations run in paper/sandbox mode.
- Remote targets: deploy only what the plan says, using the approved tools, and never put secrets in the repo.

Begin the setup now.
