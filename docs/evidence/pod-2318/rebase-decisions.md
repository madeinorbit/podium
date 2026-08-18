# Agent runtime rebase decisions

## Scope and invariants

This is the decision record for the intent-preserving rebase of
`issue/1761-agent-runtime` onto `origin/main`.

- Original merge base: `311567084afd649cb74072c0158afd0938a6c4b9`
- Original epic tip: `c2bcd521e5d2c3d1b372c51eda42a2466611e795`
- Rebase base: `a4b4fdeb9e5e62e0cab44675600dfade5665da78`
- The late POD-2292 fix round at `c2bcd521e` was included before the branch
  switch.
- Main was fetched again after validation and remained at `a4b4fdeb`.
- The work was built on `issue/2318-epic-rebase-onto-main`; main was never
  modified or pushed.

The architectural authority was
`docs/plans/pod-1761-agent-runtime-plan.md`. For each textual conflict I
read the old epic commit, the main-side commits and blame around the affected
lines, and the resulting call chain. The result keeps the epic as a
driver-neutral runtime behind the shared contract while retaining main's
newer shipping, update, identity, lifecycle, protocol-boundary, and client
interaction contracts.

There were no irreconcilable product-intent collisions. The rulings below are
composition or supersession rulings where one side had become a strict
superset; none discard a still-live behavior from either branch.

## Textual conflict rulings

| Epic commit | Area | Ruling |
| --- | --- | --- |
| `003b7f7` | Shipping recovery fixture | Main's POD-989/POD-831 fixture now supplies typed evidence and `recoveryPolicy`; it strictly supersedes the epic's typecheck repair. Kept main's fixture and preserved the old commit as an empty replay marker. |
| `27d6fd3` | Architecture manifest | Composed main's neutral/browser entrypoints with the epic's new `packages/agent-runtime` package and allowed dependency edges. |
| `00437c0` | Protocol shipping corpus | Main's current fixture machinery and shipping goldens are a strict superset of the old corpus repair. Kept the current corpus and preserved the old commit as an empty replay marker. |
| `6af2d4d` | Terminal driver wire | Kept main's shipping repair RPCs and protocol package split, then retained the epic runtime frames; the composed RPC canary is 33. |
| `acbf076` | Relay construction | Kept main's shipping service construction and the epic's `shippingCell` dependency. |
| `a29547f` | Interactions backbone | Composed main's operations migrations with the epic pending-interaction migration and relay wiring, preserving chronological migration order. |
| `49e1c8c` | Interactions CLI | Composed both sync families; the resulting composition count and canary are 13. |
| `961c607` | Interaction supersession | Placed `20260814032524_interactions-superseded` after main's 03:21 migration and before its 04:20 migration. |
| `85f7093` | Receipt protocol | Kept `TurnReceipt` at the root protocol boundary and main's `ControlMessage`/`DaemonMessage` daemon subpath split. |
| `90e30dc` | Issue audit tests | Kept the epic's totality-canary intent and explanatory assertions on top of main's registry. Git represented the resolved replay as `a66562e`, with its original POD-2049 trailer intact. |
| `bd78f2a` | Driver registration | Composed the 33-arm RPC total with root `RuntimeContractRequest` and daemon-subpath control messages. |
| `cf9652e` | Session identity | Kept `asSessionId` and root `PeerBuild`, while importing daemon-only messages through `@podium/protocol/daemon`. |
| `2894008` | Host service | Kept root client/server protocol types and moved only daemon control/message types to the daemon subpath. |
| `95ad1e0` | Durable delivery | Preserved the full frame-to-owner-to-relay-to-store pipeline and placed `20260816202210_add-message-delivery-deferral` in the merged migration sequence. |
| `620d234` | Probe timeout UI | Main had extracted `agent-capability.tsx`, removed resume from `NewPanel`, and introduced a shared session context menu. Kept that component structure and “New means start” behavior, while threading `inventory-unavailable` and `harness-probe-timed-out`: authenticated clients tolerate absent inventory, explicit timeouts refuse, and the server remains strict. |
| `0942e42` | Driver degradation | Regenerated the complete current corpus so main's driver/probe/feed/update fields and the epic degradation fields coexist. Local workspace package links were repaired first so the generator resolved the rebased protocol rather than main's checkout. |
| `255f2ee` | Probe goldens | Its intended golden refresh is contained in the corrected full-corpus regeneration from `0942e42`; preserved it as an empty replay marker. |
| `13b308c` | Queue abandonment | Composed main's `encodeDaemonMessage` package split with the epic's boolean `send()` acceptance contract. |
| `3de4178` | Timed-out probes | Kept main's model/protocol split and smoke-test identity imports together with `AgentProbeError` and timeout classification. |
| `b7206a6`, `6fc6456` | Driver teardown | Kept the daemon protocol split, driver-family helpers, and the epic's resume-kind fallback and teardown behavior. |
| `7a417be` | Login gate | Kept main's `accountHome`/host construction and the epic's synchronous `harnessLoginState` gate. |
| `35790f0` | Driver selection | Composed the `AgentKind` model move, root `ServerTransfer` proof types, daemon message imports, and the epic selection behavior. |
| `c6d58c5` | Queued chat | Main requires transcript-confirmed PTY delivery; the epic adds server-driver receipts. A queued turn is now accepted by either the server receipt or PTY transcript confirmation, never merely by transport write. |
| `987463a` | Driver-family view | Retained main's lifted-offer CSS/classes and the epic's `gates.nativePaneRendered`, stalled overlay, and no-phantom-PTY rules, using the current protocol split and regenerated goldens. |
| `5e0eb36` | Harness login helper | Kept main's `accountHome`; the helper owns `homeDir` and login state. |
| `c2bcd52` | Late POD-2292 fix | Replayed after the first rebase pass: selection is announced only after refusal checks, spawn errors clear pre-bind selection facts, same-home pinning remains intact, and the production login-context path is covered. |

## Non-conflicting seam audit

The following changes merged textually but were not accepted on that fact
alone:

1. **Protocol export split.** Main moved daemon-only messages off the package
   root. Eleven daemon files and one server test still imported those types
   from `@podium/protocol`. They now use `@podium/protocol/daemon`. An AST
   sweep of 3,544 TypeScript files found no remaining daemon-only root
   imports.
2. **Fixture generator resolution.** The generator initially resolved
   workspace packages through another checkout's stale `node_modules`
   links. After installing links for this worktree, the complete protocol
   corpus was regenerated and inspected; runtime, probe, feed, update, and
   driver fields are all present.
3. **Server test ownership.** Main added five tests that were absent from
   `test-shards.json`: feed-serving resume, shipping-train proof authority,
   shipping queue, context users, and setup password. The generated shard
   manifest and Turbo inputs now own all five.
4. **Queued-turn readiness.** Main's transcript-confirmed PTY delivery and the
   epic's driver receipt path meet at relay restart. The fixture now emits the
   post-bind harness state that proves this process is ready; the silent path
   waits through the current ten-second wake grace.
5. **Update lifecycle.** Main now requires a durable database snapshot,
   bundle-only remote placement, and observable operation-step progression.
   Router tests use a file-backed store, model a real remote bundle consumer,
   wait for grant/running transitions, and mark both daemon and remote current
   before the server restart.
6. **Server readiness and auth boundary.** Role tests create configured server
   state before boot so the readiness 503 cannot mask authorization behavior.
   The detailed WebSocket 503 test uses a raw HTTP upgrade because Bun's
   compatibility WebSocket does not emit Node's `unexpected-response`
   event.
7. **Contract drift.** Tests now account for main's `driverSelected` session
   frame, the issue `start` mutation carrier, richer web `appVersion`
   identity, and canonical shipping aliases sharing one train rank.
8. **Architecture boundary lint.** The agent-runtime manifest additions
   introduce no finding. The lane remains red on pre-existing current-main
   violations (including Pulse/activation harness branching, update-state
   local storage, and store/perf console ownership); the affected source is
   byte-identical to `origin/main`. This independently shippable baseline
   work is tracked as POD-2330.
9. **Client-core baseline.** The required driver-family tests pass. The full
   client-core suite has one mark-read throttle-tail failure in code
   byte-identical to `origin/main`; it is tracked separately as POD-2329.

## Commit and trailer preservation

The old range has 140 commits. The rebased range initially had 137 because
Git omitted three patch-equivalent commits and represented one conflict
resolution as a newly paired commit. The latter (`90e30dc` to
`a66562e`) already retains its exact POD-2049 trailer. The following three
commits are appended as empty replay markers using their original complete
messages, authorship, and `Podium-Issue` trailers:

- `003b7f7` — POD-2029, shipping fixture repair superseded by main.
- `00437c0` — POD-2033, shipping protocol corpus superseded by main.
- `255f2ee` — POD-2119, probe goldens subsumed by full regeneration.

This preserves the epic's complete attribution without reverting newer main
contracts or duplicating generated data.

## Validation evidence

All heavy work ran while holding `test:heavy`; the lease was released
immediately after the last gate.

| Lane | Result |
| --- | --- |
| Whole-graph uncached typecheck | 25/25 tasks passed, 0 cached |
| Agent-runtime conformance | 17 files passed; 341 passed, 5 skipped |
| Daemon runtime and registry | 81 files passed, 1 skipped; 958 passed, 5 skipped |
| Protocol | 55 files passed; 1,106 passed |
| Client driver-family predicate | 6 passed |
| Web driver-family arbitration, panel, startup overlay | 3 files passed; 64 passed |
| Server store shard | 125 files passed; 2,152 passed |
| Server services shard | 48 files passed; 612 passed |
| Server normalized-wire shard | 2 files passed; 8 passed |
| Server contracts shard | 89 files passed; 1,246 passed |
| Server boundary shard | 76 files passed; 1,287 passed, 1 skipped |
| Focused WebSocket auth + issue revision | 2 files passed; 171 passed |
| Focused update router packaging | Passed |

No browser drive was used: the changes are import, protocol, persistence, and
test-contract reconciliation, and the affected behavior is covered at its
native hermetic boundaries.
