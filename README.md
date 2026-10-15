# Forge

**One prompt in, a verified, world-class product out.**

Forge is a [Claude Code](https://claude.com/claude-code) plugin that turns your coding agent into a self-driving build loop. You describe what you want once. Forge then keeps the agent working, inspects the *real running result* with real tools (browser, test runners, scanners, profilers), and only stops when a supervisor, an adversarial critic, hard checks, and the builder's own sign-off all agree the result meets a world-class bar.

There is no second LLM and no API key to configure. The builder, supervisor, and critic are all the Claude Code you already run.

## Why

A coding agent normally stops when *it* thinks it is done, and it grades its own homework. Forge separates the roles and puts a deterministic gate between "I think it's done" and "it's delivered":

- the **supervisor** inspects the actual product and writes the next instruction
- the **critic** tries to break it and find reasons to reject
- a **gate script** (plain code, not an LLM) refuses to approve anything that was not actually observed, or that fails a hard check

## Install

```
/plugin marketplace add Sami001-OG/forge
/plugin install forge@forge-marketplace
```

Requirements: Claude Code, Node 18+, git. Python 3 and Docker are optional (some tools use them). Check with `/forge:doctor`.

## Quick start

```
/forge:build a landing page and waitlist for a smart water bottle
```

That is all. Forge plans, asks you one confirmation question (skip it with `--auto`), installs the tools it needs to see the product, and loops until it is done.

| Command | What it does |
|---|---|
| `/forge:build <what to build> [flags]` | Start a loop |
| `/forge:status` | Stage, round, scores per axis, what is pending |
| `/forge:abort` | Stop the loop (state stays in `.forge/`) |
| `/forge:doctor` | Check prerequisites, the catalog, and installed tools |

Flags for `/forge:build`:

| Flag | Default | Meaning |
|---|---|---|
| `--auto` | off | No confirmation questions; installs only tier-0 tools |
| `--bar N` | 9 | Quality bar (out of 10) for the last three stages |
| `--max-rounds N` | 40 | Hard cap on verify rounds |
| `--max-minutes N` | 240 | Hard cap on wall-clock time |

Run it in a project directory (an empty one is fine). For unattended runs, use a container or VM: the builder runs commands and installs tools.

## How a run works

```
 your prompt
     |
     v
 PLAN      planner: classify target, local vs remote, research reference products,
           write rubric + stages + acceptance criteria + hard checks      (you confirm once)
     |
     v
 PROVISION toolsmith installs what is needed to see/control the product
     |
     v
 +-> BUILD one stage (skeleton > function > harden > polish > finish)
 |        |
 |        |  builder tries to stop
 |        v
 |   STOP HOOK  "not accepted until verified. Run:"
 |        1. hard checks   (build, tests, lint, smoke run...)
 |        2. supervisor    (runs the product, screenshots, scores every axis)
 |        3. critic        (attacks it: bad input, mobile, restarts, scanners...)
 |        |
 |        v
 |   GATE (code)  approve?
 |      no  -> feedback goes back to the builder, new round ------------+
 |      yes -> next stage                                               |
 +---------------------------------------------------------------------+
     |  last stage approved
     v
 SIGN-OFF  builder must say honestly: complete / incomplete
     |
     v
 DELIVER   .forge/DELIVERY.md + final summary: what was built, how to run it, scores, known gaps
```

### The gate's rules

A stage passes only if all of these hold:

1. Every **rubric axis** is at or above the stage bar. Each axis is scored by both the supervisor and the critic and the **minimum** counts. Non-critical axes get one point of slack.
2. Every **acceptance criterion** in force was *actually observed* (not guessed) and passed, with evidence that exists on disk: a screenshot, a report, or a hard-check result. An unobservable criterion is a blind spot and blocks approval. The toolsmith is then called to provision the missing tool.
3. All **hard checks** pass.
4. Supervisor and critic both said approve.
5. On the final stage: the builder's own `signoff complete`.

### Stages and bars

| Stage | Goal | Default bar |
|---|---|---|
| skeleton | Architecture, scaffold, one end-to-end slice running | 6 |
| function | Every feature works, with tests | 8 |
| harden | Edge cases, failure modes, security, performance | 9 |
| polish | Design system, states, interaction quality | 9 |
| finish | Docs, run/deploy instructions, cleanup, final verification | 9 |

### What it can build

The planner picks a target type and the matching verification playbook: `web-ui`, `fullstack-web`, `api`, `cli-lib`, `bot`, `mobile`, `systems`, `embedded`, `data-ml`, `game`, `media`, `desktop`, `docs`, `design`. It also decides local vs remote execution: anything needing a public URL, a persistent process, a GPU, secrets, or real infrastructure is planned as remote or hybrid. Bots and integrations are always planned in paper/sandbox mode.

## Tools: a large catalog, installed on demand

The catalog has 140 tools in 12 bundles (web, API, security, systems, mobile, game, media, data, bots, devops, docs, core): Playwright, Lighthouse, axe, k6, Semgrep, Trivy, valgrind, ffmpeg, adb, and more. Only what the plan needs is installed, so context and disk stay small.

| Tier | Meaning |
|---|---|
| 0 | User-space npm/pip install into `.forge/tools` (automatic) |
| 1 | Heavy or container-oriented: automatic only inside a container, otherwise asks you |
| 2 | System-level (apt, brew, Docker, curl installers): always asks you first |
| 3 | Needs an account or token: skipped unless you set the env var. Forge never handles secrets |

Install safety: npm/pip installs pick the newest stable release that is **at least 14 days old**, skip install scripts by default, run project-locally, and are logged to `.forge/tools.json`. Anything outside the catalog needs your approval.

Handy commands (inside a project):

```
node <plugin>/scripts/forge.mjs tool list --bundle web-pro
node <plugin>/scripts/forge.mjs tool list --search lint
node <plugin>/scripts/forge.mjs shot http://localhost:3000 --mobile
```

## Safety rails

- Round, time, and loop-budget caps; when hit, Forge delivers the best version with an honest gap report.
- Stall detection: three rounds without improvement forces a strategy change; repeated stalls end the run.
- The Stop hook fails open: an internal error can never trap your session.
- Only the session that started a loop is affected. Other sessions run normally.
- A guard hook stops the agent hand-editing the loop's state, verdicts, and check results.
- No real-money or real-account side effects.

## What lives where

```
.claude-plugin/      plugin.json, marketplace.json
commands/            /forge:build, status, abort, doctor
agents/              planner, supervisor, critic, toolsmith
hooks/hooks.json     Stop hook (the loop) + PreToolUse guard
scripts/             forge.mjs CLI, gate.mjs, guard.mjs, shot.mjs, lib/
catalog/             tools.json (140 tools), bundles, target playbooks, plan example
tests/               unit tests + a full loop driven through the real hook
```

In your project, Forge writes only to `.forge/` (git-ignored): `state.json`, `rubric.md`, per-round `checks-N.json` / `verdict-N-*.json`, `evidence/` (screenshots, HTTP reports), `tools/`, and finally `DELIVERY.md`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/forge:doctor` says FAIL | Install what it names (Node 18+, git) |
| Screenshots fail on Linux | `forge tool run playwright -- install-deps` (needs sudo), or run in the Playwright Docker image |
| A tool shows NEEDS_APPROVAL | That is by design: approve it when asked, or accept the blind spot |
| Loop ended with "capped" or "stalled" | Read `.forge/DELIVERY.md` for the gap report, raise caps, or narrow the request |
| Want out | `/forge:abort` |

## FAQ

**Does it cost more than a normal run?** Yes. Every round runs a builder turn, a supervisor, and a critic. That is the price of verification; the caps bound it.

**Why not a separate supervisor model?** Fewer moving parts and nothing extra to configure. The risk is correlated blind spots, which hard evidence, the adversarial critic, and min-scoring are there to reduce.

**Can it run headless?** Yes, hooks also run under `claude -p`, including on a remote server.

## Honest limits

- State integrity is best-effort, not a security boundary: an agent with shell access could tamper with `.forge/` if it tried hard.
- Same-model supervision cannot fully remove shared blind spots.
- iOS verification needs macOS. There is no dedicated deploy adapter yet; remote deploys are done by the builder with approved tools.

## Develop

```
npm test                     # unit tests + full loop through the real hook script
npm run build:catalog        # regenerate catalog/tools.json from catalog/build.mjs
claude plugin validate . --strict
claude --plugin-dir .        # try it without installing
```

Release: bump `version` in `.claude-plugin/plugin.json` and tag. Users update with `/plugin marketplace update forge-marketplace` then `/plugin update forge`.

## License

[MIT](LICENSE)
