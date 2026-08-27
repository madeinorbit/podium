# AGENTS.md

Guidance for AI agents working in this repository.

## Verifying interaction-boundary changes

Do not browser-drive ordinary visual changes such as fonts, spacing, colours, copy, or
straightforward component styling. Runtime verification is reserved for changed behavior whose
correctness depends on a real boundary that code review and hermetic tests cannot establish—for
example terminal link dispatch, OS editor open/save, browser new-tab behavior, or pointer/keyboard
event routing. When such a boundary is the task, drive the smallest affected interaction once and
observe the external effect.

See **[docs/agents/driving-podium.md](docs/agents/driving-podium.md)** for how to drive
Podium through Playwright or the native Linux shell — including isolation, the `?e2e=1`
test API, terminal cells, and choosing the harness vs. a live instance.

A browser cannot stand in for the desktop shell when the boundary IS the shell: the
all-in-one window loads the bundled UI from `tauri://localhost` and talks to a loopback
backend, so cross-origin, cookie and sidecar-spawn behavior only reproduce there. See
**[docs/agents/driving-desktop.md](docs/agents/driving-desktop.md)** — including the
isolation this needs, since the shell spawns its sidecar with `--takeover`.

## Testing independent instances

When changing instance identity, state, endpoints, CLI routing, agent ownership, or lifecycle
behavior, follow **[docs/multi-instance.md](docs/multi-instance.md)** and run
`bun run test:multi-instance`. The acceptance lane starts fully separate concurrent runtimes;
do not substitute multiple clients routed to one server.

## Checkout-local dependencies

For a fresh checkout or git worktree, run:

```bash
bun run setup:worktree
```

This is the supported topology-following frozen install: it uses the linker setting tracked in
`bunfig.toml` (currently `linker = "hoisted"`) and creates a dependency tree inside the current
checkout. The command does not override that setting, so it follows future tracked linker changes.
Never share, copy, symlink, or bind-mount a complete `node_modules` tree between checkouts; isolated
checkout state is the boundary.

If the checkout has a damaged or mixed-linker install, stop processes using it and run:

```bash
bun run deps:repair
```

`deps:repair` composes the checkout-scoped `deps:clean-local-installs` cleanup with a
topology-following frozen reinstall (`bun install --frozen-lockfile`). The cleanup removes only
`node_modules` entries under this checkout, does not follow directory symlinks, and stops before
reinstalling if it finds an unsafe entry.
`bun run test` is the normal cached gate after repair; its admission census must pass before Turbo
can reuse or create a result.

Neither command deletes shared caches. Do not add global Bun cache deletion (`bun pm cache rm`,
removing `~/.bun/install/cache`, or deleting the configured equivalent) or shared Turbo-cache
deletion to a repair. A reinstall may reuse or populate Bun's shared cache, but repair owns only
the current checkout's dependency tree.
Only `deps:rollback-hoisted` intentionally forces `--linker=hoisted`; setup and repair follow the
tracked `bunfig.toml` setting.

## Issue tracking with Podium

This project uses Podium's issue tracker for work management. If you are running inside a Podium
session, use the `podium issue` CLI (start with `podium issue prime`). Track durable/discovered
work as issues, not markdown TODO lists. Full guide: **[docs/agents/podium-issues.md](docs/agents/podium-issues.md)**.

### Landing on main

This repository lands work locally; publishing to a remote is a separate decision
[spec:SP-a69c]. Take the mutex with `podium merge-lock` (its canonical name is
`merge:<branch>`), rebase the **issue branch** onto the current local `main`, fast-forward
local `main` to the issue tip, then release the lock. Landing does not require a fetch, pull, or
push; remote synchronization is a separate action. Never reset local `main` to a remote-tracking
ref: local main may intentionally contain unpublished landings, and a reset can discard them
silently. Never cherry-pick onto main or land
the content under a different SHA, because the issue tip must remain in main's history. Done when
the issue tip is an ancestor of local `main` (`git merge-base --is-ancestor <issue-tip> main`, or
`gitState.merged`). Full write-up:
**[docs/agents/podium-issues.md § Landing on main](docs/agents/podium-issues.md#landing-on-main)**.

## Delegating to other agents

`podium agent spawn` puts another agent on an issue. Podium infers nothing about a delegate —
no roles, no write-claim, no auto-isolation [spec:SP-4ef9] — so what you tell it in the spawn
prompt is the only lever: its job, a title to give itself, who else is on the issue, and who
owns which files. Full guide: **[docs/agents/delegating.md](docs/agents/delegating.md)**.

## Testing: one end-of-task gate

Do not run tests after edits or intermediate commits. Implement the complete change first,
then run **one** validation command at the end. The normal agent gate is:

```
bun run test
```

It runs cached, lock-free typecheck followed by a tiny, hermetic, one-worker boot-wiring and lane-configuration probe. It is designed to
answer “is this candidate internally coherent and are the basic runtime pieces still wired?”
without traversing every package, starting browsers, or taking the whole-host heavy-test lease.
Docs, copy, fonts, formatting, generated artifacts, and other changes that cannot affect runtime
may skip even this gate; state why in the handoff.

For a narrow change, use the focused lane that matches its risk, such as `bun run test:related --
<test-file>`, `bun run test:changed`, `bun run test:web`, `bun run test:mobile`, or an applicable
server shard. Keep focused lanes targeted; use the normal cached gate as the default admission
check and add only the one specialized lane that the changed behavior requires.

Run another lane only when the changed behavior matches its trigger. Examples: database/store
changes use the server store shard; daemon or PTY process behavior uses integration; instance
identity or lifecycle uses multi-instance. A UI edit does **not** require browser automation or
manual click-driving unless the task is specifically about interaction behavior whose correctness
cannot be established from the code and types. Rewrite migration audits, the full package sweep,
browser suites, performance benchmarks, the oracle, and real-agent smoke are never routine agent
gates.

Do not stack validation commands “for confidence.” If a specialized lane is required, run it
instead of `test` when it already covers the relevant basic check; otherwise run
`test` once and the one specialized lane once, sequentially. The default `test` deliberately
does not take `test:heavy`: it neither waits behind nor delays heavyweight suites.
Never overlap other validation commands in one session.

The complete map from changed paths and behavior to commands—including exact test locations,
filename patterns, configs, parent commands, caching, and exclusions—is in
**[docs/agents/testing.md](docs/agents/testing.md)**. Read that file before selecting anything
other than `test`.

`bun run test:full`, `bun run test:unit`, and `bun run oracle` are exhaustive or multi-lane
validation reserved for scheduled CI, merge/release validation, or explicit requests—not routine
agent work. `bun run test:rearch` owns the whole-repository rewrite audit and is likewise not an
ordinary gate.

Trust typecheck and Turbo cache hits. Never use a forced cache bypass as routine verification.
Do not set `TURBO_FORCE`, pass `--force`, or use write-only `--cache` flags. If a concrete
cache-key gap is known, document it and use `--uncached-because="<missing input>"` only as an
explicit exception while filing the gap; the normal cached gate remains the contract. A checkout
without usable `node_modules/@podium` links is refused.

## Reference docs for agents

- [docs/multi-instance.md](docs/multi-instance.md) — operate and test fully independent instances on one machine.
- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/driving-desktop.md](docs/agents/driving-desktop.md) — run the Tauri desktop shell headlessly, for the few properties only the real webview answers (cross-origin, cookies, sidecar spawn).
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
- [docs/agents/podium-issues.md](docs/agents/podium-issues.md) — use the `podium issue` CLI to track work from inside a session.
- [docs/agents/delegating.md](docs/agents/delegating.md) — spawn other agents: placement, naming, concurrency, advisory locks.
- [docs/agents/testing.md](docs/agents/testing.md) — every test lane, which one to run when, the generated `@podium/server` shards, and the shared-host `test:heavy` lease.
