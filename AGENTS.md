# AGENTS.md

Guidance for AI agents working in this repository.

## Verifying UI / interaction changes

Automated tests, build, and review do not replace runtime verification for changed
UI/interaction behavior (clickable elements, terminal link clicks, editor open/save).
Before calling such work done, drive the real app and observe the behavior (a real
click, a real new tab, the file actually changing on disk).

See **[docs/agents/driving-podium.md](docs/agents/driving-podium.md)** for how to drive
Podium with Playwright — the `?e2e=1` test API, navigating the current DOM, reading
terminal output, clicking terminal cells, and the harness vs. the live instance.

## Testing independent instances

When changing instance identity, state, endpoints, CLI routing, agent ownership, or lifecycle
behavior, follow **[docs/multi-instance.md](docs/multi-instance.md)** and run
`bun run test:multi-instance`. The acceptance lane starts fully separate concurrent runtimes;
do not substitute multiple clients routed to one server.

## Issue tracking with Podium

This project uses Podium's issue tracker for work management. If you are running inside a Podium
session, use the `podium issue` CLI (start with `podium issue prime`). Track durable/discovered
work as issues, not markdown TODO lists. Full guide: **[docs/agents/podium-issues.md](docs/agents/podium-issues.md)**.

## Delegating to other agents

`podium agent spawn` puts another agent on an issue. Podium infers nothing about a delegate —
no roles, no write-claim, no auto-isolation [spec:SP-4ef9] — so what you tell it in the spawn
prompt is the only lever: its job, a title to give itself, who else is on the issue, and who
owns which files. Full guide: **[docs/agents/delegating.md](docs/agents/delegating.md)**.

## Cached checks

Run `bun run typecheck` and trust a cache hit. Never force a recompute: a forced run
costs ~3m14s of CPU against ~2s cached (110x, measured on 22 packages) on a host
shared with a live Podium instance. The cache key covers source files, `bun.lock`,
`package.json`, `tooling/tsconfig`, and — via `scripts/typecheck.ts`'s environment
fingerprint (`PODIUM_CHECK_ENV_HASH` in `turbo.json` `globalEnv`) — `bunfig.toml`
and the `node_modules/@podium` link census. Installs, linker changes, and git base
swaps therefore invalidate the cache by themselves; you do not need `--force` after
a merge. A checkout with no usable `node_modules/@podium` links is refused outright
(a cached green there is not evidence — POD-1343).

If you have a concrete reason to believe the cache is wrong, state it:

```
bun run typecheck -- --uncached-because="<what the cache key is missing>"
```

and file the gap as an issue so the key gets fixed. Bare `--force` and `TURBO_FORCE`
exit with an error.

### Cached test lanes

Two test lanes are turbo tasks and reuse a cache (POD-1687):

| Lane | Runs | Cached |
| --- | --- | --- |
| `bun run test:web` | the `apps/web` suite | yes |
| `bun run test:mobile` | the `apps/mobile` suite | yes |
| `bun run test:cached` | both of the above | yes |
| every other `bun run test*` | root/integration/bun lanes | no — always executes for real |

They go through `scripts/test.ts`, which reuses `scripts/typecheck.ts`'s environment
fingerprint, so **the same rules apply**: a checkout with no usable
`node_modules/@podium` links is refused outright, bare `--force`/`TURBO_FORCE` exit
with an error, and `-- --uncached-because="<reason>"` is the only way past the cache.
Cold, the two lanes cost ~2m33s; a hit returns in well under a second.

Tell a hit from a miss by turbo's summary line — you do not have to guess:

```
Cached:    2 cached, 2 total          Time:   302ms >>> FULL TURBO   <- hit, nothing ran
Cached:    1 cached, 2 total          Time:   4m17s                  <- miss, the suite really ran
```

`>>> FULL TURBO` means nothing executed. That is the intended outcome of an unrelated
edit, and it is evidence — the key covers each suite's own files *plus* the workspace
sources it reaches (`packages/*/src`, and `apps/daemon/src` for web), because both
suites import `@podium/*` as source and `apps/web/test/shell.structure.test.ts` reads
`packages/client-core/src` off disk. `dependsOn: ["^test"]` does **not** cover that.

The `test` task is deliberately **pinned** to those two packages — there is no generic
`test` entry, so `turbo run test` resolves to `@podium/web#test` and `@podium/mobile#test`
and nothing else — including under `--filter`. About twenty other packages define a bare
`vitest run --passWithNoTests` script, but those are deliberately OUT: run from the
package directory vitest does not walk up, so it finds no config — no `@podium/source`
condition, and no `setupFiles`, meaning the `test-hermetic-*.ts` guards that strip
ambient Podium session env never run. Most pass by luck, not scoping. Adding a package
to this task requires giving it a real config first — see POD-1693.

Evidence for the cache-key coverage table: **[docs/agents/pod-1378-cache-evidence.md](docs/agents/pod-1378-cache-evidence.md)**.

## Testing policy

Match testing effort to regression risk. Simple, low-risk changes may skip automated tests when
they do not alter runtime behavior, are fully mechanical, or are already protected by existing
coverage; state the reason in the handoff. Do not test trivial wiring, static types, framework
contracts, or assertions already covered at another layer.

When coverage is warranted, write the smallest focused set that protects the changed behavior.
Prefer extending existing tests or adding table-driven cases over creating parallel suites. Run
`bun run test` before commits containing substantive code changes; docs, copy, formatting, and
other test-independent edits may skip it. Add integration, E2E, multi-instance, or agent-smoke
lanes only when the change matches the decision table in
**[docs/agents/testing.md](docs/agents/testing.md)**. Do not create or run long, complex E2E flows
for small or local changes; reserve them for critical cross-boundary behavior or regressions that
require the real stack. Real-agent smoke tests require an explicit human request. Changed
UI/interaction behavior still requires runtime verification.

## Reference docs for agents

- [docs/multi-instance.md](docs/multi-instance.md) — operate and test fully independent instances on one machine.
- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
- [docs/agents/podium-issues.md](docs/agents/podium-issues.md) — use the `podium issue` CLI to track work from inside a session.
- [docs/agents/delegating.md](docs/agents/delegating.md) — spawn other agents: placement, naming, concurrency, advisory locks.
- [docs/agents/testing.md](docs/agents/testing.md) — the four test lanes and which suite to run when.
