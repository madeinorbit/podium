# Landing order for the four in-flight Phase 4/6 branches

Written 2026-08-01 09:05 at integration `4e1d9a7b`, while all four are still in
flight. **Re-measure before trusting any number here** — every measured claim on a
moving tree goes stale, which cost this programme real time tonight.

## Why order matters at all

Tonight established it empirically: STRUCTURAL changes should land BEFORE SEMANTIC
ones, because re-applying a semantic edit onto a settled structure is far cheaper
than re-deriving structure under semantic edits. POD-1283 (semantic) against
POD-393/394/399 (structural) produced 53 conflict hunks across 23 files; the same
work re-applied after those landed produced ZERO.

## Measured footprints

    #395  4.3d lifecycle       apps/server/src/modules/sessions/, scripts/audit-*,
                               scripts/rearch-audit*, boundary-allowlist.ts,
                               packages/model/src/representations
    #320  4.4 IssueService     apps/server/src/modules/issues/  (ONLY)
    #317  4.1 gateway          apps/server/src/gateway/, packages/protocol/src/
                               {messages,planes}, packages/sync/src/feed
    #401  6.1b replica binding apps/web/src, packages/client-core/src/{engine,replica},
                               packages/sync/src/adapters

The three server branches occupy DIFFERENT subdirectories of apps/server/src
(sessions / issues / gateway). That is the fan-out working: four workers, no shared
file. Verified this tick — the gateway file sets of #395 and #317 do not intersect.

## The order

1. **#401 whenever it is ready.** It is fully disjoint from the server three
   (client-core + web + sync/adapters). No reason to sequence it behind anything.
2. **#395 first among the server three.** It carries the rename
   `sessions/service.ts` -> `sessions/lifecycle.ts` and the widest apps/server
   footprint. Blast radius measured SMALL: only 2 files import the old
   `sessions/service` path. Landing it first means the other two rebase onto the
   settled name rather than the reverse.
3. **#320 second.** apps/server/src/modules/issues/ only — the narrowest server
   footprint, so it is the cheapest to re-apply if anything moves under it.
4. **#317 last among the server three.** It reaches furthest outside apps/server
   (protocol messages + planes, sync/feed), so it is the most likely to collide
   with a Phase 6 branch, and it should settle on top.

## Watch items at merge time

- **#395 and #317 both touch `apps/server/src/gateway/`.** Disjoint files as of
  this writing (#395: principal-capability.ts, ws-boundary.test.ts; #317:
  client-mux, client-registry, client-socket, plane-liveness, ws-send). Re-check
  the intersection before merging the second of the two.
- **#395 touches `scripts/rearch-audit-baseline.json` and
  `scripts/boundary-allowlist.ts`. Those are MEASUREMENTS.** Regenerate with one
  binary over the merged tree; never hand-merge two baselines, and never accept an
  auto-merged one.
- **Both fail-closed seams live here**: `gateway/daemon-fail-closed.test.ts` and
  `gateway/ws-boundary.test.ts`. If either merge touches those paths, plant a
  violation and confirm the test FAILS before believing the pass.
- **Phase 3 is days old, not settled convention.** Authenticated transports now
  mint real per-user principals; `gateway/client-principal.ts` is device-grade
  legacy. A merge that re-derives a device-grade principal on an authenticated path
  is INVISIBLE to typecheck and silently undoes Phase 3. Check it by hand.
- Typecheck target is **22/22 with 0 cached**. Not 23 (agent-bridge is deleted),
  not 26. And run `bun install` after any package.json change BEFORE believing a
  typecheck failure.
