# Channel defaults and target refresh — Implementation Plan

**Epic:** POD-2087 · **Spec:** `2026-08-14-update-operations-design.md` §9.2, §10.3
**Protocol:** `2026-08-14-updater-worker-protocol.md`
**Blocked by:** nothing — land first. Replaces the retired top-level bugs POD-2092/2093.

**Goal:** One default channel everywhere, and release targets that refresh on a schedule
and on demand instead of only at boot.

**Owns:** `apps/server/src/modules/updates/service.ts` (channelOf + refresh bookkeeping),
`apps/server/src/modules/fleet/handlers.ts`, `apps/server/src/modules/updates/trpc.ts`
(one new `checkNow` mutation + `checkedAt` exposure), server boot wiring, tests. Nothing
in `apps/web` (the Settings issue consumes the new fields later).

## Context

- Disagreement: `UpdatesService.channelOf` defaults a machine with no `updateChannel` to
  `'dev'` (`service.ts:514`) while `machineSetUpdateChannelHandler` /
  `machineApplyUpdateHandler` default to `'stable'` (`modules/fleet/handlers.ts:85,94`).
- The fleet default already exists: `resolveUpdateChannel()`
  (`packages/runtime/src/config.ts:563`) = `PODIUM_UPDATE_CHANNEL` → config → `stable`.
- `refreshTarget` (`service.ts:182-203`) is called from exactly three places: boot
  (`server.ts:422-425`), `machines.setUpdateChannel`, `machines.applyUpdate`. A
  long-running server keeps a boot-time edge/stable target — or a boot-time failure
  reason — forever. `resolveReleaseTarget` (`release-target.ts`) has a 5 s timeout.
- Dev channel refresh is publisher-pushed; do not touch it.

## Tasks

- [ ] **One default** — a single `resolveMachineChannel(machine, fleetDefault)` helper in
  `service.ts` (or `packages/model` next to the channel type), used by `channelOf` and
  both fleet handlers. The default for a machine without an override is the **fleet
  default** from `resolveUpdateChannel()`, not a literal. Table-driven tests: override
  set, override absent + fleet default stable/edge/dev.
- [ ] **Refresh bookkeeping** — `UpdatesService` records per channel:
  `lastCheckedAt`, `lastCheckOutcome` (`ok | unavailable(reason)`). `refreshTarget`
  updates both. Expose on the `fleet()` payload (additive fields).
- [ ] **Scheduled refresh** — a timer (injected clock, same discipline as the operations
  engine) refreshing `edge` and `stable` every 24 h, plus a jittered initial refresh a
  few minutes after boot (boot itself already refreshes; keep that). Skip a channel while
  an update operation is active on it (do not yank a target mid-flight — coordinate via
  the existing service state; a simple "operation active → skip this tick" check).
- [ ] **On-demand check** — `updates.checkNow` mutation: refreshes the caller-relevant
  channels (fleet default + any per-machine overrides in use), returns
  `{ channel, checkedAt, outcome }[]`. Rate-limit: no more than one forced refresh per
  channel per 30 s (return the cached outcome inside the window).
- [ ] **No stale failure pinning** — a failed boot-time resolve must not persist as the
  eternal truth: `unavailableReasons` age out when a later refresh succeeds (verify this
  path; add a test — refresh success clears the recorded reason).

## Testing

Fake-clock scheduler tests (refresh fires, skips during active operation, rate limit);
default-channel table; reason-clearing test. Gates: `bun run typecheck`,
`bun run test:related -- apps/server/src/modules/updates/service.ts
apps/server/src/modules/fleet/handlers.ts apps/server/src/modules/updates/trpc.ts`, then
`bun run test`.

## Acceptance

- The same absent-channel machine resolves identically through `channelOf` and both fleet
  handlers (test asserts the shared helper is the only resolution site — grep-level check
  that the literals `'dev'`/`'stable'` defaults are gone from those call sites).
- With a fake clock, 24 h passes → both release channels re-resolve; `checkNow` inside
  the rate window returns cached, outside it re-resolves.
- `fleet()` exposes `checkedAt`/outcome per channel (consumed later by Settings).
