```
                    .    *   .   '   *    .
                 *    .   \  |  /   .   *
                   .   -- \ \|/ / --   .
                 ___________\_|_/___________
                /  _______________________  \
               /__/                       \__\
                   \________     ________/
                    ________|   |________
                   /____________________ \
                   |_____________________|

   ███████╗ ██████╗ ██████╗  ██████╗ ███████╗
   ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
   █████╗  ██║   ██║██████╔╝██║  ███╗█████╗
   ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
   ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
   ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
        one prompt in. a verified product out.
```

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757.svg">
  <img alt="Node 18+" src="https://img.shields.io/badge/node-%E2%89%A518-339933.svg">
  <img alt="139 tools" src="https://img.shields.io/badge/verification%20tools-139-blue.svg">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-brightgreen.svg">
  <a href="https://github.com/Sami001-OG/forge/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Sami001-OG/forge/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center">
  <code>claude-code</code> · <code>claude-code-plugin</code> · <code>ai-agents</code> · <code>autonomous-agents</code> · <code>agentic-workflows</code> · <code>quality-gate</code> · <code>developer-tools</code> · <code>mit-license</code>
</p>

**Forge** is a [Claude Code](https://claude.com/claude-code) plugin that turns your coding agent into a self-driving build loop. You describe what you want once. Forge keeps the agent working, inspects the *real running result* with real tools (browser, test runners, scanners, profilers), and only stops when a **supervisor**, an **adversarial critic**, **hard checks**, and the builder's own **sign-off** all agree the result meets a world-class bar.

No second LLM and no API key to configure: the builder, supervisor, and critic are all the Claude Code you already run. The plugin itself has zero npm dependencies.

## Contents

[Why](#why) · [Install](#install) · [Quick start](#quick-start) · [How a run works](#how-a-run-works) · [The gate](#the-gate) · [Tools](#tools) · [Safety](#safety-rails) · [Layout](#whats-in-the-repo) · [Troubleshooting](#troubleshooting) · [FAQ](#faq) · [Limits](#honest-limits) · [Develop](#develop) · [License](#license)

## Why

A coding agent normally stops when *it* thinks it is done, and it grades its own homework. Forge separates the roles and puts a deterministic gate between "I think it's done" and "it's delivered":

| Role | Job |
|---|---|
| **Builder** | Your Claude Code session. Builds one stage at a time. |
| **Supervisor** | Runs the actual product, looks at screenshots, measures, scores every rubric axis, and writes the next instruction. Read-only. |
| **Critic** | Fresh context every round. Tries to break the product and find reasons to reject. Never sees the supervisor's verdict. |
| **Toolsmith** | Installs whatever is needed to see and control the product. |
| **Gate** | Plain code, not an LLM. Refuses to approve anything that was not observed or that fails a hard check. |

## Install

```
/plugin marketplace add Sami001-OG/forge
/plugin install forge@forge-marketplace
```

Requirements: Claude Code, Node 18+, git. Python 3 and Docker are optional (some tools use them). Check with `/forge:doctor`.
Validated with Claude Code 2.1.x (`claude plugin validate . --strict`).

## Quick start

```
/forge:build a landing page and waitlist for a smart water bottle
```

Forge plans, asks you one confirmation question (skip it with `--auto`), installs the tools it needs to see the product, and loops until it is done.

| Command | What it does |
|---|---|
| `/forge:build <what to build> [flags]` | Start a loop |
| `/forge:tweak <small change>` | Change something Forge already built; re-verifies only what the change affects |
| `/forge:status` | Stage, round, scores per axis, what is pending |
| `/forge:abort` | Stop the loop (state stays in `.forge/`) |
| `/forge:doctor` | Check prerequisites, the catalog, and installed tools |

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
 PLAN       planner: classify the target, decide local vs remote, research best-in-class
            reference products, write rubric + stages + acceptance criteria + hard checks
            (you confirm once)
     |
     v
 PROVISION  toolsmith installs what is needed to see and control the product
     |
     v
 +-> BUILD  one stage:  skeleton > function > harden > polish > finish
 |       |
 |       |  the builder tries to stop
 |       v
 |   STOP HOOK  "not accepted until verified. Run:"
 |       1. hard checks   build, tests, lint, smoke run
 |       2. supervisor    runs the product, screenshots, scores every axis
 |       3. critic        attacks it: bad input, mobile, restarts, scanners
 |       |
 |       v
 |   GATE (code)  approve?
 |     no  -> feedback goes to the builder, new round -----------------+
 |     yes -> next stage                                               |
 +---------------------------------------------------------------------+
     |  last stage approved
     v
 SIGN-OFF   the builder states honestly: complete or incomplete
     |
     v
 DELIVER    .forge/DELIVERY.md and a final summary: what was built, how to run it,
            final scores, known gaps
```

### Stages and default bars

| Stage | Goal | Bar |
|---|---|---|
| skeleton | Architecture, scaffold, one end-to-end slice running | 6 |
| function | Every feature works, with tests | 8 |
| harden | Edge cases, failure modes, security, performance | 9 |
| polish | Design system, states, interaction quality | 9 |
| finish | Docs, run/deploy instructions, cleanup, final verification | 9 |

### What it can build

The planner picks a target type and its verification playbook: `web-ui`, `fullstack-web`, `api`, `cli-lib`, `bot`, `mobile`, `systems`, `embedded`, `data-ml`, `game`, `media`, `desktop`, `docs`, `design`. It also decides local vs remote execution: anything needing a public URL, a persistent process, a GPU, secrets, or real infrastructure is planned as remote or hybrid. Bots and integrations are always planned in paper/sandbox mode.

## The gate

A stage passes only if **all** of these hold:

1. Every **rubric axis** is at or above the stage bar. Supervisor and critic both score every axis and the **minimum** counts. Non-critical axes get one point of slack.
2. Every **acceptance criterion** in force was *actually observed* and passed, with evidence that exists on disk (a screenshot, a report, a hard-check result). An unobservable criterion is a blind spot and blocks approval; the toolsmith is called to provision what is missing.
3. All **hard checks** pass.
4. Supervisor and critic both said approve.
5. On the final stage: the builder's own `signoff complete`.

## Fast re-verification (no more hour-long checks for a tiny change)

Forge fingerprints the files each acceptance criterion and hard check depends on. A result that passed and whose files have not changed is **carried over**, not redone:

- **Criteria:** the supervisor and critic assess only the *dirty* ones (changed or never passed). Each assessed criterion records the files it actually exercised (`depends_on`), so later rounds get more precise.
- **Checks:** unscoped checks (fast unit/lint/type checks) always run as the safety net. Slow ones (e2e, Lighthouse, scans) carry a `scope` and are skipped when unchanged.
- **Fast path:** if nothing a verified criterion depends on changed and the checks pass, the previous verdicts are carried over automatically and no supervisor or critic is run.
- **Full pass when it matters:** the first verification, a change to shared config (`package.json`, lockfiles, `tsconfig`, `*.config.*`, `Dockerfile`, `.env*`), more than 40% of files changed, or `forge checks --full`.
- **`/forge:tweak <change>`:** for small edits to a finished product. One minimal change, a light critic, a 45-minute cap, and everything unaffected carried over.

`/forge:status` shows how many criteria were re-verified versus carried over each round.

## Performance: least time, same bar

- **Where the time goes:** `/forge:status` breaks time into build, checks, and verification, and flags when verification dominates.
- **Critic only when it matters:** the adversarial critic runs only after the supervisor approves. A rejected round goes straight back to the builder. When approval is likely (previous round approved, or the final stage), supervisor and critic launch in parallel.
- **Right-sized stages:** the planner picks `lean` (2 stages), `standard` (3), or `full` (5) based on how big and risky the product is.
- **Cheaper routine verification (opt-in):** `--verifier-model <alias>` runs routine supervisor rounds on a faster model; the final stage always uses your session model.
- **Incremental verification and `/forge:tweak`:** see above.

## Tools

The catalog has **139 tools in 12 bundles** (core, web, API, security, systems, mobile, game, media, data, bots, devops, docs): Playwright, Lighthouse, axe, k6, Semgrep, Trivy, valgrind, ffmpeg, adb, and more. Only what the plan needs gets installed.

| Tier | Meaning |
|---|---|
| 0 | User-space npm/pip install into `.forge/tools` (automatic) |
| 1 | Heavy or container-oriented: automatic only inside a container, otherwise asks you |
| 2 | System-level (apt, brew, Docker, curl installers): always asks you first |
| 3 | Needs an account or token: skipped unless you set the env var. Forge never handles secrets |

**How tools stay visible.** Each CLI tool installs in its own isolated prefix or venv (no dependency conflicts between tools) and is exposed through one shim directory, `.forge/tools/bin`. A SessionStart hook puts that directory on PATH for every command in the session, subagents included, and `forge exec -- <command>` always works as a fallback. The supervisor and critic run a preflight on every round and install any missing auto-installable tool themselves before declaring a blind spot.

**Install safety.** npm/pip installs pick the newest stable release that is **at least 14 days old**, skip install scripts by default, run project-locally, and are logged to `.forge/tools.json`. Anything outside the catalog needs your approval.

```
node <plugin>/scripts/forge.mjs tool list --bundle web-pro
node <plugin>/scripts/forge.mjs tool list --search lint
node <plugin>/scripts/forge.mjs exec -- eslint .
node <plugin>/scripts/forge.mjs shot http://localhost:3000 --mobile
```

## Safety rails

- Round, time, and loop-budget caps. When one is hit, Forge delivers the best version with an honest gap report.
- Stall detection: three rounds without improvement forces a strategy change; repeated stalls end the run.
- The Stop hook fails open: an internal error can never trap your session.
- Only the session that started a loop is affected; other sessions run normally.
- A guard hook stops the agent from hand-editing the loop's state, verdicts, and check results.
- No real-money or real-account side effects.

## What's in the repo

```
.claude-plugin/   plugin.json, marketplace.json
commands/         /forge:build, status, abort, doctor
agents/           planner, supervisor, critic, toolsmith
hooks/hooks.json  Stop hook (the loop), PreToolUse guard, SessionStart PATH
scripts/          forge.mjs CLI, gate.mjs, guard.mjs, env-hook.mjs, shot.mjs, lib/
catalog/          tools.json (139 tools), bundles, target playbooks, plan example
tests/            unit tests + a full loop driven through the real hook scripts
```

In your project Forge writes only to `.forge/` (git-ignored): `state.json`, `rubric.md`, per-round `checks-N.json` and `verdict-N-*.json`, `evidence/` (screenshots, HTTP reports), `tools/`, and finally `DELIVERY.md`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/forge:doctor` says FAIL | Install what it names (Node 18+, git) |
| "command not found" for an installed tool | Run it as `forge exec -- <command>`, or `forge tool list --installed` to confirm it is installed |
| Screenshots fail on Linux | `forge tool run playwright -- install-deps` (needs sudo), or use the Playwright Docker image |
| A tool shows NEEDS_APPROVAL | By design: approve it when asked, or accept the blind spot |
| Verification is slow | Check `/forge:status`: it shows re-verified vs carried criteria. Give slow checks a `scope`; use `/forge:tweak` for small edits |
| Loop ended "capped" or "stalled" | Read `.forge/DELIVERY.md` for the gap report, raise the caps, or narrow the request |
| Want out | `/forge:abort` |

## FAQ

**Does it cost more than a normal run?** Yes. Every round runs a builder turn, a supervisor, and a critic. That is the price of verification; the caps bound it.

**Why not a separate supervisor model?** Fewer moving parts and nothing to configure. The risk is correlated blind spots, which hard evidence, the adversarial critic, and min-scoring are there to reduce.

**Can it run headless?** Yes. Hooks also run under `claude -p`, including on a remote server.

**Does it work in other agents (OpenCode, Cursor, Codex)?** Not as-is. It is a Claude Code plugin built on Claude Code's hooks and subagents. The CLI, gate logic, and catalog are plain Node and could be reused in a port.

## Honest limits

- State integrity is best-effort, not a security boundary: an agent with shell access could tamper with `.forge/` if it tried hard.
- Same-model supervision cannot fully remove shared blind spots.
- iOS verification needs macOS. There is no dedicated deploy adapter yet; remote deploys are done by the builder with approved tools.

## Develop

```
npm test                       # unit tests + full loop through the real hook scripts
npm run build:catalog          # regenerate catalog/tools.json from catalog/build.mjs
npm run smoke:catalog          # really install every tier 0/1 npm/pip tool and run its verify (needs network)
claude plugin validate . --strict
claude --plugin-dir .          # try it without installing
```

Release: bump `version` in `.claude-plugin/plugin.json` and tag. Users update with `/plugin marketplace update forge-marketplace` then `/plugin update forge`.

## License

[MIT](LICENSE) © Sami
