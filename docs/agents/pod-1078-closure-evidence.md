# POD-1078 closure evidence

Verified at commit `76c895d2` on 2026-08-02.

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

All commands exited `0` at the verified tree state.

```text
bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts \
  packages/protocol/src/planes/routing.test.ts \
  packages/protocol/src/planes/stream-port.test.ts \
  packages/protocol/src/planes/inventory.test.ts \
  apps/server/src/gateway/presence-routing.test.ts

4 files passed; 66 tests passed.
```

The suite explicitly rejects a second/foreign registry, contradictory durability, durable coalescing, denied-room subscription, existence-distinguishing refusal, identity supplied by a payload, presence writes to the durable pipe, and stream buffering beyond the coalesce/drop/evict policy. It also proves disconnect and restart blanking.

```text
bun --bun node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts \
  apps/server/src/gateway/reattach-storm.integration.test.ts

1 file passed; 2 tests passed.
```

## Wider verification

- Focused gateway/protocol/wire suite: 6 files, 161 tests passed.
- Browser-open oracle plus architecture audit rerun: 2 files, 83 tests passed.
- Typecheck: 22 tasks passed.
- Web: 182 files, 1,456 tests passed.
- Mobile: 4 files, 34 tests passed.
- Bun SQLite: 14 tests passed.
- Independent-instance lane: runtime isolation 1 test, managed-account spawn 3 tests, installer suite `ALL OK`.
- Full unit lane: 636 files and 9,341 tests passed; its four reported failures were one now-fixed roomless browser oracle plus three contention timeouts. The repaired oracle and all timeout cases passed together in the isolated 83-test rerun.

`bun run lint:boundaries` reaches an unrelated pre-existing violation in `apps/server/src/modules/sessions/daemon-lifecycle.ts` and a dead allowlist entry, now tracked as POD-1362. The room/host-edge totality assertions themselves pass in `inventory.test.ts`; no changed file introduces the reported dependency.
