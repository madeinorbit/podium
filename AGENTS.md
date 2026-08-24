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

## Testing independent instances

When changing instance identity, state, endpoints, CLI routing, agent ownership, or lifecycle
behavior, follow **[docs/multi-instance.md](docs/multi-instance.md)** and run
`bun run test:multi-instance`. The acceptance lane starts fully separate concurrent runtimes;
do not substitute multiple clients routed to one server.

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

It is **four files out of everything the unit config collects**, and the footer on every run
states the exact ratio — resolved from the runner at that moment, not written down here, so
it stays true as the tree grows. Read it, and report a green as “lean gate green” rather than
“tests pass” [POD-2728]. `Tests 76 passed (76)` above that footer is the four files’ own test count, not a
suite result. When a change needs suite-level evidence, `bun run test:full` is the sweep.
Docs, copy, fonts, formatting, generated artifacts, and other changes that cannot affect runtime
may skip even this gate; state why in the handoff.

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

`bun run test:full` is the exhaustive cached package sweep for scheduled CI, merge batches, and
explicit requests. It is never the default agent command and is not required before every commit.
`bun run test:rearch` owns the whole-repository rewrite audit tests; they are excluded from the
normal package sweep.

Trust typecheck and Turbo cache hits. Never force recomputation. If a concrete cache-key gap is
known, use `-- --uncached-because="<missing input>"` and file the gap; bare `--force` and
`TURBO_FORCE` are rejected. A checkout without usable `node_modules/@podium` links is refused.

## Reference docs for agents

- [docs/multi-instance.md](docs/multi-instance.md) — operate and test fully independent instances on one machine.
- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
- [docs/agents/podium-issues.md](docs/agents/podium-issues.md) — use the `podium issue` CLI to track work from inside a session.
- [docs/agents/delegating.md](docs/agents/delegating.md) — spawn other agents: placement, naming, concurrency, advisory locks.
- [docs/agents/testing.md](docs/agents/testing.md) — every test lane, which one to run when, the generated `@podium/server` shards, and the shared-host `test:heavy` lease.
