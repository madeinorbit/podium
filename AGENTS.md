# AGENTS.md

Guidance for AI agents working in this repository. Claude Code loads it through `CLAUDE.md`;
other harnesses read it directly. Keep it short: detail belongs in the linked docs, and a rule
the tooling already enforces does not need repeating here.

## The repository

Podium is a self-hosted multi-agent workspace: a server, a per-machine daemon that runs agent
sessions in PTYs, and web, desktop and phone clients. It is a Bun + Turbo monorepo.

- `apps/server`, `apps/daemon`: the backend processes. `packages/janitor`: the server's
  maintenance worker. `apps/cli`: the `podium` command.
- `apps/web`: the web UI. `apps/desktop`: the Tauri shell around it. `apps/mobile`: the phone app.
- `packages/*`: shared code (`protocol`, `model`, `client-core`, `client-graph`, `pty`,
  `runtime`, …).
- `docs/agents/`: how-to guides for agents (index at the end of this file).

## Working in a checkout

The shared main checkout holds other agents' uncommitted files. Do your work in your own git
worktree. In a fresh checkout, select the Bun version pinned in `mise.toml` and confirm plain
`bun --version` matches it, then run `bun run setup:worktree` before building or validating
([docs/toolchain.md](docs/toolchain.md)). Resumed and read-only work does not need another install.
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
`podium issue show <id> --json`. Creation uses an explicit parent, then the operator's
`gitWorkflow.defaultParentBranch`, then `main`; changing the default does not retarget existing
issues. Landing never fetches, pulls or pushes [spec:SP-a69c].

Merge only after the user approves landing and closing. The merge action stops every session
on the issue, so the runner must survive that shutdown: an operator, an authorized session
outside the issue, or a detached command process using the issue's existing scoped relay.
Finish the issue's work and publish its handoff before the runner starts.

1. Verify the issue worktree is on its issue branch and the main checkout is already on the
   stored parent branch. On a mismatch, including an older or stacked issue, stop and ask;
   switching the live main checkout's branch can disrupt the running backend.
2. `podium merge-lock acquire <parent-branch> --wait`. Don't pipe it. Check its exit code and
   confirm ownership with `podium merge-lock status <parent-branch>`. Omission locks `main`.
3. Keep the runner's cwd. Inspect `git -C <issue-worktree> log --oneline <parent-branch>..HEAD`
   before and after `git -C <issue-worktree> rebase <parent-branch>`; only this issue's commits
   belong in that range. Record the rebased tip with `git -C <issue-worktree> rev-parse HEAD`.
4. The runner calls `podium issue action --id <id> --kind merge`, checks
   `git -C <main-checkout> merge-base --is-ancestor <issue-tip> <parent-branch>`, and releases
   its lock with `podium merge-lock release <parent-branch>`. Check ancestry even if the action
   reports an error before considering a retry. Release the held lock on refusals and failures too.
   If session-exit cleanup already released it, confirm that with the named lock's status.

Never reset the parent branch to a remote-tracking ref. Never cherry-pick onto it or land the
same content under a different SHA. In the shared checkout, advance only the issue's parent;
rebasing the issue branch belongs in its worktree. If unexpected commits appear in the issue's
`<parent-branch>..HEAD` range or landing is refused, release the lock and ask. Do not bypass
the action with a manual merge. Lease renewal, recovery and historical landing evidence are in
[podium-issues.md § Landing on the parent branch](docs/agents/podium-issues.md#landing-on-the-parent-branch).

To put another agent on an issue, use `podium agent spawn`. Podium infers nothing about a
delegate (no role, no write claim, no isolation), so the spawn prompt must give it everything:
its job, a session title, who else is on the issue, and who owns which files
([docs/agents/delegating.md](docs/agents/delegating.md)).

## Testing

This host is shared by many agents, and test lanes compete for its CPU and memory. That is why
validation is budgeted:

- **Default final check:** `bun run test` runs cached typecheck and static checks, then four
  hermetic boot-wiring files. Report a pass as "lean gate green"; `LEAN GATE INCOMPLETE` is no
  result. After a fix, rerun affected checks; don't repeat a green on an unchanged candidate.
- **While working:** use `bun run test:file -- <paths> [-t "name"]` when focused tests answer
  a concrete question. Don't rerun broad lanes after every edit.
- **Risky areas:** choose the specialized lane matching the change: the store shard for
  database changes, integration for daemon/PTY behavior, or multi-instance for instance identity
  or lifecycle. If it covers the relevant basic wiring, it replaces the default gate; otherwise
  run both sequentially. Use [docs/agents/testing.md](docs/agents/testing.md) to choose.
- **Skip the gate** for docs, copy and formatting changes, and anything else that can't affect
  runtime. Say so in the handoff.
- Run one validation command at a time. Never stack lanes "for confidence".
- Full sweeps, the oracle, browser suites, audits and benchmarks need their trigger in the
  lane guide, such as changed behavior, CI, release validation or an explicit request. Taking
  a merge lock is not itself a trigger for the oracle.
- Trust Turbo and typecheck cache hits by default. For a concrete missing cache input, file
  the gap and use the documented `--uncached-because="<missing input>"` exception.

Use the `bun run` wrappers so admission, install checks and test selection apply. Raw runners
can silently miss server or web tests. An empty-log exit 144 has occurred under host memory
pressure; it is no validation result. Retry the affected lane, and inspect diagnostics if it
recurs rather than inferring a source failure from the exit code alone.

## Verifying behavior at runtime

For visual changes, a screenshot is cheap and catches real mistakes. Take it from the stubbed
web layout harness (`apps/web/harness/`) or a worktree dev server. Clicking through the live app
is not needed for styling. Drive a real interaction only when its correctness depends on a
boundary that tests can't reach: terminal link dispatch, opening or saving in the OS editor,
new-tab behavior, pointer and keyboard
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
