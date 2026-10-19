# AGENTS.md

Guidance for AI agents working in this repository. Claude Code loads it through `CLAUDE.md`;
other harnesses read it directly. Keep it short: detail belongs in the linked docs, and a rule
the tooling already enforces does not need repeating here.

## The repository

Podium is a self-hosted multi-agent workspace: a server, a per-machine daemon that runs agent
sessions in PTYs, and web, desktop and phone clients. It is a Bun + Turbo monorepo.

- `apps/server`, `apps/daemon`, `apps/janitor`: the backend processes. `apps/cli`: the
  `podium` command.
- `apps/web`: the web UI. `apps/desktop`: the Tauri shell around it. `apps/mobile`: the phone app.
- `packages/*`: shared code (`protocol`, `domain`, `client-core`, `client-graph`, `pty`,
  `runtime`, …).
- `docs/agents/`: how-to guides for agents (index at the end of this file).

## Working in a checkout

The shared main checkout holds other agents' uncommitted files. Do your work in your own git
worktree, and run `bun run setup:worktree` in it before anything else. The Bun version is pinned
in `mise.toml`, and plain `bun --version` must match it ([docs/toolchain.md](docs/toolchain.md)).
If the dependency tree breaks or drifts from the lockfile, stop the processes using it and run
`bun run deps:repair`.

- Every checkout gets its own `node_modules`. Never copy, symlink or share one between checkouts.
  Never delete the shared Bun or Turbo caches as part of a repair.
- Don't use `git stash`. The stash stack is shared by every worktree of this repo, so other
  agents' parked work lives there too.
- Format and lint only the files you changed (`bunx biome check --write <paths>`). A repo-wide
  `bun run format` rewrites hundreds of unrelated files and buries your diff.

## Issue tracking and landing

Work is tracked with Podium's issue tracker. Inside a Podium session, start with
`podium issue prime`, and track discovered work as issues rather than TODO lists
([docs/agents/podium-issues.md](docs/agents/podium-issues.md)).

Work lands **locally**, onto the issue's **parent branch**: the `parentBranch` field from
`podium issue show <id>`. That is `main` unless the operator's Podium settings say otherwise.
Landing never fetches, pulls or pushes; publishing to a remote is a separate decision for the
operator [spec:SP-a69c].

1. `podium merge-lock acquire <parent-branch> --wait`. Name the branch: with no branch argument
   it locks `main`. Don't pipe it. Check its exit code, then confirm with `merge-lock status`.
2. In your worktree, `git rebase <parent-branch>`, using the local ref, never `origin/…`.
   Check that `git log --oneline <parent-branch>..HEAD` lists only your own commits.
3. `podium issue action --id <id> --kind merge`. It fast-forwards the parent branch in the main
   checkout to your tip. On success it also closes the issue, so post any offer before running it.
4. Release the lock straight away (`podium merge-lock release <parent-branch>`).
5. Done when `git merge-base --is-ancestor <issue-tip> <parent-branch>` succeeds. If the merge
   reports an error, run this check before retrying. The merge can succeed even when the reply
   fails.

Never reset the parent branch to a remote-tracking ref. Never cherry-pick onto it or land the
same content under a different SHA. Never move a branch other than the issue's parent. If the
rebase hits commits that aren't yours, or the fast-forward is refused, stop and ask. Don't invent
another route. Recovery cases, such as untracked files blocking the fast-forward or a rewritten
parent branch, are in
[podium-issues.md § Landing on main](docs/agents/podium-issues.md#landing-on-main).

To put another agent on an issue, use `podium agent spawn`. Podium infers nothing about a
delegate (no role, no write claim, no isolation), so the spawn prompt must give it everything:
its job, a session title, who else is on the issue, and who owns which files
([docs/agents/delegating.md](docs/agents/delegating.md)).

## Testing

This host is shared by many agents, and test lanes compete for its CPU and memory. That is why
validation is budgeted:

- **End of task:** run `bun run test` once. It runs a cached typecheck, the span-effect lint and
  four hermetic boot-wiring files. Report a pass as "lean gate green", never as "tests pass".
  A run ending `LEAN GATE INCOMPLETE` is no result at all.
- **While working:** run the tests for the code you are changing with
  `bun run test:file -- <paths> [-t "name"]`. Don't rerun broad lanes after every edit.
- **Risky areas:** add the one specialized lane that matches the change: the store shard for
  database changes, integration for daemon/PTY behavior, `test:multi-instance` for instance
  identity or lifecycle. Use [docs/agents/testing.md](docs/agents/testing.md) to pick it.
- **Skip the gate** for docs, copy and formatting changes, and anything else that can't affect
  runtime. Say so in the handoff.
- Run one validation command at a time. Never stack lanes "for confidence".
- `test:full`, `test:unit`, `oracle`, `test:rearch`, browser suites and benchmarks are for CI,
  release validation or an explicit request.
- Trust Turbo and typecheck cache hits. Never force a cache bypass.

Always go through the `bun run` wrappers. The command guard refuses raw `vitest`, `tsc`,
`playwright` and `turbo` and names the lane to use instead. A raw vitest on server or web
files collects zero tests and still exits 0. If a lane dies with exit 144 and an empty log, the
host killed it, usually for memory. That says nothing about your change, so run it again.

## Verifying behavior at runtime

For visual changes, a screenshot is cheap and catches real mistakes. Take it from the stubbed
web layout harness (`apps/web/harness/`) or a worktree dev server. Clicking through the live app is not needed for styling. Drive a real
interaction only when its correctness depends on a boundary that tests can't reach: terminal
link dispatch, opening or saving in the OS editor, new-tab behavior, pointer and keyboard
routing. Drive the smallest affected interaction once and observe the external effect.

- Web UI through Playwright: [docs/agents/driving-podium.md](docs/agents/driving-podium.md).
- The desktop shell, when the boundary is the shell itself (cross-origin, cookies, sidecar
  spawn): [docs/agents/driving-desktop.md](docs/agents/driving-desktop.md).
- Windows (desktop app, ConPTY, installers): a boat.dev sandbox,
  [docs/agents/boat-windows.md](docs/agents/boat-windows.md).
- Instance identity, state, endpoints, CLI routing or lifecycle: run fully separate instances,
  not several clients on one server
  ([docs/agents/multi-instance.md](docs/agents/multi-instance.md)).

## Frontend data

Before changing how a client screen gets or derives data, including `packages/client-graph`
models, read [docs/agents/frontend-data.md](docs/agents/frontend-data.md). It covers one shared
model per record, `@lazy` derived fields, and view models and companions.

## Legacy code with a removal date

Code kept only for old installs carries one header line:
`// LEGACY(remove-after: YYYY-MM): <what it is for; what removing it drops>`.
List them with `git grep -n "LEGACY(remove-after:"`. Once the date has passed, delete the code,
or move the date and say why in the same commit.

## Reference docs

- [testing.md](docs/agents/testing.md): every test lane, when to run it, caches, the shared-host lease.
- [podium-issues.md](docs/agents/podium-issues.md): the `podium issue` CLI and the full landing write-up.
- [delegating.md](docs/agents/delegating.md): spawning agents, placement, naming, locks.
- [frontend-data.md](docs/agents/frontend-data.md): client data models in the MobX pool.
- [driving-podium.md](docs/agents/driving-podium.md) and [driving-desktop.md](docs/agents/driving-desktop.md): runtime verification.
- [multi-instance.md](docs/agents/multi-instance.md): independent instances on one machine.
- [boat-windows.md](docs/agents/boat-windows.md): the Windows sandbox.
- [agent-state-classification.md](docs/agents/agent-state-classification.md): how agent run state is read from transcripts.
