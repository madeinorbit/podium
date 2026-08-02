# POD-1078 closure evidence

Reconciled with integration `c557f306` at merge tip `6b006f41` on 2026-08-02. The implementation and cross-user mutation proof landed at `0c27d300` and `b26696c5` respectively.

## Acceptance evidence

| Requirement | Construction or test evidence |
|---|---|
| One registry for scoped feed and room presence | `apps/server/src/relay.ts` constructs the sole production `SubscriptionRegistry` and injects it into both `FeedServing` and `PresenceRouting`. `routing.test.ts` rejects a router built over a foreign registry. |
| Entity-reference rooms and join semantics | `presence-rooms.ts` defines the closed `session`/`issue` entity-reference union, reserves `document` for the ADR 1 op-stream amendment, and defines subscribe/unsubscribe/update plus snapshot/delta/closed frames. `stream-port.test.ts` proves the occupancy snapshot on join. |
| Transport-authenticated identity | Inbound presence frames contain no identity field; `PresenceRouting` derives it from the authenticated `ClientConn.principal`. The protocol and gateway tests prove forged payload attribution is unrepresentable. |
| Cursor-rate isolation and lossy pressure | The stream router uses coalesce, drop, then room-only eviction; durable delivery forbids coalescing and demotes to resync. The real-server reattach-storm test publishes at 50 Hz while all health probes and control delivery remain live. |
| Blank offline | Presence state exists only in `StreamPlanePort` maps. Disconnect and a fresh registry both produce empty occupancy; there is no store row, migration, tombstone, or oplog write. |
| Visibility-gated, non-distinguishing joins | Hidden and nonexistent rooms both return the same `presenceRoomClosed` shape without a reason code and create no subscription. Feed rescope/evict revalidates existing rooms and removes only stale room keys. |
| Wire totality | The four-file deliberate-violation suite includes `inventory.test.ts`; the re-derived implementation inventory is 34 server, 19 client, 47 control, and 53 daemon messages (153 post-auth total). |
| Browser-open room cutover | The four browser-open messages now deliver or resolve only through session-room membership; parked requests replay on successful room join. |

## Deliberate-violation results

The acceptance commands below exited `0` at the verified tree state.

```text
bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts \
  packages/protocol/src/planes/routing.test.ts \
  packages/protocol/src/planes/stream-port.test.ts \
  packages/protocol/src/planes/inventory.test.ts \
  apps/server/src/gateway/presence-routing.test.ts

4 files passed; 67 tests passed.
```

For the required cross-user counterfactual, the production join condition was temporarily changed to bypass visibility. The new test failed with exit 1 and showed Bob receiving a room snapshot containing Alice's live cursor. The original file hash `15524e1680fae5546b96a4abf44ced754765a1c82c50f1efe4e791a0c5407bea` was restored, and the same test passed 1/1.

The suite explicitly rejects a second/foreign registry, contradictory durability, durable coalescing, denied-room subscription, existence-distinguishing refusal, identity supplied by a payload, presence writes to the durable pipe, and stream buffering beyond the coalesce/drop/evict policy. It also proves disconnect and restart blanking.

```text
bun --bun node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts \
  apps/server/src/gateway/reattach-storm.integration.test.ts

1 file passed; 2 tests passed.
```

## Wider verification

- Merged focused gateway/protocol/wire suite: 9 files, 209 tests passed.
- Cross-user visibility mutation: 1 file, 1 test failed as required; restored gate rerun passed.
- Typecheck: 22 tasks passed.
- Web: 183 files, 1,460 tests passed.
- Mobile: 4 files, 34 tests passed.
- Bun SQLite: 14 tests passed.
- Independent-instance lane: runtime isolation 1 test, managed-account spawn 3 tests, installer suite `ALL OK`.
- Historical full unit sweep at `02b65cbe` under three concurrent foreign runners exited `1`: 5 files failed, 638 passed, 3 skipped; 10 tests failed, 9,346 passed, 33 skipped. The count is seven timed-out tests plus three POD-1315 failures; `terminal-view.keyboard.test.ts` separately failed its 10-second `beforeAll` hook and skipped 13 tests, so it was a failed file but did not add an eleventh failed test. Isolated reruns were green for every timeout group: architecture 1 file/72 tests/exit 0, normalized wire 1/7/exit 0, live-scale benchmark 1/1/exit 0, and terminal keyboard 1/13/exit 0. The three POD-1315 compile-time probes remained red in isolation at that tree (1 file, 3 failed/3 passed, exit 1); integration now contains `f4fbeee6`, which makes the probes declared-and-never-invoked rather than executable tests; the corrected merged tree passes 1 file/3 tests with exit 0.
- Structural gates: composition graph 176 modules/0 cycles; construction order 51 declarations/0 forward, deferred, or late bindings; reactions ledger 25 entries.

`bun run lint:boundaries` reaches an unrelated pre-existing violation in `apps/server/src/modules/sessions/daemon-lifecycle.ts` and a dead allowlist entry, now tracked as POD-1362. The room/host-edge totality assertions themselves pass in `inventory.test.ts`; no changed file introduces the reported dependency.
