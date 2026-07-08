# @podium/runtime

Node-runtime plumbing shared by `apps/server`, `apps/daemon`, `apps/cli`, and (for its
browser-safe pieces) `apps/web`. This is infrastructure, not the domain model — entity
types and pure business logic (the issue stage machine, authorization policy, snooze/
identity predicates, git-remote identity) live in `@podium/domain` instead, which this
package re-exports pieces of (e.g. `normalizeOriginUrl`) where a runtime-facing subpath
needs them.

What's actually here:

- **`config.ts`** — `PodiumConfig`/`PodiumMode` (mode, serverUrl, port, pairCode, …),
  loaded from `$PODIUM_STATE_DIR/config.json`. Node-only (`node:fs`/`node:os`/`node:path`)
  — behind the `@podium/runtime/config` subpath, not the root barrel.
- **`settings.ts`** — the global `PodiumSettings` zod schema + `normalizeSettings`
  (isomorphic — safe for the web bundle).
- **`sqlite/`** — the runtime-neutral SQLite shim (`node:sqlite` ⇄ `bun:sqlite`) behind
  `@podium/runtime/sqlite`.
- **`git.ts`** — isomorphic; re-exports `@podium/domain`'s `normalizeOriginUrl`.
- **`connectivity.ts`**, **`join.ts`**, **`setup.ts`** — pairing/join-code + first-run
  setup helpers, each behind their own subpath (some are Node-only).
- **`auth-store.ts`**, **`local-machine.ts`**, **`run-registry.ts`**,
  **`process-safety.ts`**, **`sd-notify.ts`**, **`loop-metrics.ts`** — daemon/server
  process concerns (token storage, machine identity, PID/run-file bookkeeping, signal
  safety, systemd watchdog, event-loop-lag sampling). All Node-only, each behind its own
  subpath.

Browser-safety is a hand-maintained convention, not (yet) lint-enforced: only `git.ts`
and `settings.ts` are exported from the root barrel (`src/index.ts`), and the doc comment
at the top of that file says why. See `scripts/check-boundaries.ts` for the enforced half
of the contract — `@podium/runtime` may only depend on the `@podium/protocol` and
`@podium/domain` leaves, never another app or package.

Not published. Consumed as TypeScript source via Bun workspace symlinks.
