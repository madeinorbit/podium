# POD-2055 reconnect fixes — implementation plan

*Parent: POD-2055 (Reconnect architecture review, `docs/reviews/reconnect-architecture-review.md`). Integration branch: `issue/2055-reconnect-architecture`. All sub-issue branches fork from and ff-merge back into that branch — never onto main directly.*

All findings re-verified 2026-08-14 against `2610ba21f`:

- **F1** `hello` carries no cursor (`socket-hub.ts:596-630`); server `FeedServing.attach` calls `serveWorld` for every peer without an existing connection (`apps/server/src/gateway/feed-serving.ts:214-224`), so a plain reconnect gets a full world pushed while the client's `D7-1-RESUME` heal (`replica.ts:306-314`) runs a redundant `changesSince` in parallel. World reuse (`worldFor`, `feed-serving.ts:312+`) only helps when `authority.cursor()` and auth revision are unchanged.
- **F2** `scheduleReconnect` is pure `delay*2` capped 10 s, no jitter, delay reset on TCP `onopen` (`socket-hub.ts:595,727-737`).
- **F3** the only `hub.connect()` sites are `runtime.ts:582` (boot) and mobile pull-to-refresh; `online` is consumed only by the outbox (`outbox.ts:158-170`).
- **F4** zero `AppState`/NetInfo anywhere in `apps/mobile`; `tabIsVisible()` is `true` without `document` (`engine/state.ts:169`), and server push is suppressed when any client is `visible` (`notify/service.ts:296-300`); `platformOnlineEvents()` guards `typeof window` but calls `window.addEventListener` (RN defines `window` without it) from unconditional `outbox.attach()` (`runtime.ts:456`); `readServerConfig` dereferences `window.location` when `window` exists (`apps/mobile/src/client/trpc.ts:168`); `platformIsOnline()` is permanently true on RN.
- **F5** `SetupGate` wraps `AppShell` (`main.tsx:44-46`); a rejected probe retries 5× (~8 s) then renders `SetupUnreachable` with manual retry only — the replica never mounts (filed separately, not in this plan).
- **F6** feed ingress drains one envelope per `setTimeout(0)` task into an uncapped queue (`socket-hub.ts:549,1318-1373`) (filed separately, not in this plan).

This plan covers the three work packages the epic starts with: **WP-A** (F1), **WP-B** (F2+F3), **WP-C** (F4).

---

## Sequencing and integration protocol

- **WP-B lands first** — it is small, and WP-C consumes its new `connectNow()` API. WP-A is independent of B at the design level but touches `socket-hub.ts`; A rebases over B's landed change.
- Each WP works on its own sub-issue branch forked from `issue/2055-reconnect-architecture`.
- Integration, per WP, done by that WP's agent:
  1. `podium lock acquire pod2055-integrate --wait` — proceed **only** if the output says `acquired` (the lock fails open on relay timeout; a refused release later is the tell that you never held it).
  2. `git fetch` nothing — this is a local integration. On the sub-issue branch: `git rebase issue/2055-reconnect-architecture`.
  3. Run gates (typecheck + affected test lanes) on the rebased tip.
  4. On the integration worktree via `git -C /home/mgw/src/other/podium/.worktrees/issue-2055-reconnect-architecture merge --ff-only <sub-branch>` (never `cd` into it).
  5. `podium lock release pod2055-integrate`, mail the coordinator (`podium issue mail send 2055 --body "…"`).
- Commit messages carry a `Podium-Issue: POD-<sub>` trailer. Never use backticks in `-m` strings — write the message with `git commit -F <file>`.
- Nobody touches main; the epic merges to main once, later, from the integration branch.

---

## WP-B — Reconnect jitter + immediate reconnect on network-restore (F2+F3)

Smallest, highest-leverage, all in `packages/client-core`.

### B1. Jitter in `scheduleReconnect` (`socket-hub.ts:727-737`)

Replace the fixed delay with a jittered one. Reuse the shape (and the rationale comment) of `packages/client-core/src/logging/forward-sink.ts:181-186`: a fleet that lost the same server in the same second must not come back in lockstep. Concretely:

```ts
const base = this.reconnectDelay                    // 500 → 10_000 as today
const jittered = base / 2 + Math.random() * (base / 2)   // [base/2, base)
this.reconnectTimer = setTimeout(…, jittered)
this.reconnectDelay = Math.min(base * 2, RECONNECT_MAX_MS)
```

Keep `RECONNECT_MIN_MS`/`RECONNECT_MAX_MS` as-is. Log the actual jittered delay (the current code logs pre- and post-doubling values that disagree; make both lines report the same jittered number).

### B2. Reset backoff on evidence of a working server, not on TCP open

Move `this.reconnectDelay = RECONNECT_MIN_MS` from `onopen` (`socket-hub.ts:595`) to the first inbound message of a connection (`markAlive` path, guarded by a per-connection `sawTraffic` flag). Rationale: an accept-then-drop server (auth bounce, half-deployed proxy) currently resets backoff every cycle and loops at 500 ms forever.

### B3. `connectNow()` — the immediate-reconnect entry point

New public method on `SocketHub`:

```ts
/** Out-of-band evidence the network is back (online event, app foreground):
 *  skip the remaining backoff and try immediately. No-op when a socket
 *  already exists (open OR connecting) or the hub was disposed. */
connectNow(): void {
  if (this.socket !== undefined || this.intentionalClose) return
  if (this.reconnectTimer !== undefined) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
  this.reconnectDelay = RECONNECT_MIN_MS
  this.connect()
}
```

The `this.socket !== undefined` guard is load-bearing: `connect()` while a CONNECTING socket exists would create a second socket. Audit `connect()` itself for the same hazard while there.

### B4. Wire the browser signals (web + RN-web get this for free)

In `ClientRuntime.start()` (`engine/runtime.ts`, next to the existing `visibilitychange` wiring at :567):
- `window 'online'` → `hub.connectNow()` (feature-detect `window.addEventListener` — see WP-C4; use the same guarded helper).
- `visibilitychange` → visible → `hub.connectNow()` in addition to the existing `setVisible` call. A tab that slept through its heartbeat deadline reconnects the moment it is foregrounded instead of waiting out backoff.
Both listeners removed in `dispose()` like the existing pairs.

### B5. Tests (`packages/client-core` — vitest, fake timers, existing `makeSocket` injection)

- Jitter bounds: N scheduled reconnects all land in `[base/2, base)`; delay still doubles to the cap.
- Accept-then-drop server: backoff keeps growing (B2), does not reset to 500 ms.
- `connectNow()` while timer pending → timer cleared, connect attempted once; while CONNECTING → no second socket; after `dispose()` → no-op.
- `online` event and visible `visibilitychange` trigger `connectNow`.

**Files:** `packages/client-core/src/socket-transport/socket-hub.ts`, `packages/client-core/src/engine/runtime.ts`, tests beside them. No protocol/server change. No mobile-specific change (WP-C consumes `connectNow`).

---

## WP-A — Cursor in `hello`: stop pushing full worlds on plain reconnects (F1)

Protocol + server + client-sink change. The design constraint that shapes everything: today **every admitted socket is promised one world** (`sink.ts:45-49` `expectWorld()`), and `requestFreshWorld()` obtains a world *by* cycling the socket. Sending a cursor breaks the "world always follows" promise, so the promise must become explicit.

### A1. Protocol (`packages/protocol`)

- `hello` gains an optional field:
  ```ts
  feedCursor?: { feedId: string; epoch: number; seq: number }
  ```
  Only sent in wire-v2 feed mode (same guard as `wireVersion`). Absent ⇒ exactly today's behavior (v1 and old clients unaffected).
- New server frame `feedResume`:
  ```ts
  { type: 'feedResume', feedId: string, epoch: number, seq: number }   // seq = publisher position granted
  ```
  Meaning: "your cursor was accepted; no world follows; deltas resume after `seq`". A server that instead rejects the cursor sends the normal `feedBootstrap` stream (existing frames, unchanged).

### A2. Client: hub sends the cursor

`SocketHub` must not read replica internals (deliberate layering, `socket-hub.ts:601-603`), so extend the opaque sink port instead: `FeedSinkPort` gains `position(): { feedId: string; epoch: number; seq: number } | null`, implemented by `FeedSink` via `replica.getCursor()` (already synchronous). In `onopen`, include `feedCursor: sink.position()` when non-null — **except** when a fresh world was explicitly requested: `requestFreshWorld()` sets a `wantWorld` flag consumed by the next `hello` (omit the cursor), so rungs 2–6 keep working unchanged.

### A3. Client: conditional world expectation

`FeedSinkPort.connected()` becomes `connected(worldPromised: boolean)` — the hub passes `worldPromised = (cursor was not sent)`. In `FeedSink.connected`:
- `worldPromised` → exactly today: `expectWorld()` then `replica.connect()` (guarded by `isWalking()`).
- `!worldPromised` → **no** `expectWorld()`; just `replica.connect()`. From `stale` that is `D7-1-RESUME`: the HTTP `changesSince` heal covers (cursor, head] — this remains the delta mechanism; the server does not stream the gap.
- If the server *rejects* the cursor it pushes `feedBootstrap` frames anyway; they are offered to `PushedBootstrapSource` as today, and the concurrently-running heal comes back `bootstrap-required`, taking `D7-2` — the walk then `take()`s the already-offered world without a socket cycle. Verify `take()` accepts a pre-offered world in this path without the `expected` flag (it does via the freshness test on `tick`; add a test).
- `feedResume` frame handling in `sink.frame()`: currently informational — assert identity match (mismatch ⇒ treat as rung-4 epoch signal), emit telemetry. No replica input needed; the heal is already running.

### A4. Server: honor the cursor (`apps/server/src/gateway/feed-serving.ts` + hello handler in the gateway edge)

Thread `feedCursor` from the hello handler into `FeedServing.attach(peer, …)`. In `attach`, for a peer presenting a cursor:
1. Identity check: `cursor.feedId === identity.feedId && cursor.epoch === identity.epoch`, else `serveWorld` (today's path).
2. Coverage check: cursor within retention — `cursor.seq + 1 >= minAvailableSeq` and `cursor.seq <= authority.cursor()`. Reuse the exact predicate spelling from `change-log.ts:243-267` (the off-by-one here is ADR-documented). Not covered ⇒ `serveWorld`.
3. Covered ⇒ **no world**: send `feedResume{feedId, epoch, seq: cursor.seq}` and connect the publisher at the client's seq: `this.connections.set(peer.id, this.publisher.connect(peer.id, cursor.seq, principal))`. Confirm `publisher.connect` at a seq older than head is legal (it frames from live deliveries; the (cursor, head] gap is the client heal's job — that division is the point). If the publisher certifies deltas as `(fromSeq, seq]` chains starting from the granted position, granting `cursor.seq` means the first delta may chain cleanly for the client even before the heal lands; either way the replica's rung-1 gap handling covers it.
4. `serveWorld`'s `cause` gains `'cursor-rejected'` so the perf traces distinguish it from cold attaches.

### A5. Tests

- Server (`apps/server` gateway tests): reconnect with valid cursor ⇒ zero `feedBootstrap` frames, one `feedResume`, publisher positioned at cursor; compacted cursor ⇒ world with `cause: 'cursor-rejected'`; epoch mismatch ⇒ world; v1 peer / cursor-less hello ⇒ world (regression).
- Client (`packages/client-core`): hub omits cursor after `requestFreshWorld()`; sink without promised world does not arm `expectWorld`; cursor-rejected flow completes a walk from the pushed world **without a socket cycle**; `packages/sync/src/conformance` suite still green (it encodes the ladder; do not weaken gates — if a gate needs a new row, that is a conscious table change with its own test).
- End-to-end assertion of the win: a reconnect at unchanged head transfers O(delta) bytes, not O(world) — assert on frames observed by a fake peer.

**Risk notes for the implementer:** the `expectWorld`/`isWalking` seam has a documented history of live heal-loops (`sink.ts:50-58`, `bootstrap-source.ts` comments). Read `PushedBootstrapSource` fully before touching the arming rules. Do not change `requestFreshWorld`'s socket-cycle mechanism in this WP (an in-protocol bootstrap request is a separate, later issue).

---

## WP-C — Mobile native connectivity wiring (F4)

Everything here is `apps/mobile` + small guarded fixes in `packages/client-core`. Depends on WP-B's `connectNow()` (coordinate: land after B, or stub against the planned signature).

### C1. Crash-proof the shared platform probes (`packages/client-core`)

- `platformOnlineEvents()` (`outbox.ts:158-165`): guard on `typeof window !== 'undefined' && typeof window.addEventListener === 'function'` — RN defines `window = global` without DOM listeners.
- `readServerConfig()` (`apps/mobile/src/client/trpc.ts:157-169`): treat `window.location == null` the same as `typeof window === 'undefined'` (fall through to injected/env/default). On native, `EXPO_PUBLIC_PODIUM_SERVER`/`__PODIUM_SERVER__` become the only config paths, which is correct.
- Extract a shared `hasDomWindow()` helper so WP-B4's listeners use the same guard.

### C2. NetInfo as the native online signal

- Add `@react-native-community/netinfo` to `apps/mobile` (Expo-supported; needs a real `bun install` — see repo note on manual installs).
- In `MobileClientProvider` (native only, `Platform.OS !== 'web'`): build an `OnlineEvents` adapter over `NetInfo.addEventListener` (fires on reachable transitions) and an `isOnline` from the last NetInfo state. Inject through the **existing seams**: `OutboxInit.onlineEvents` / `isOnline` (`engine/wiring.ts:643-644`) — plumb them from `StoreProvider` config if not already exposed there.
- Same adapter also calls `hub.connectNow()` on connectivity-restored, so the socket does not wait out backoff after a tunnel/handover.

### C3. AppState lifecycle (`MobileClientProvider.tsx`)

Native only:
- `AppState 'active'` → `hub.connectNow()` + `hub.setVisible(true)`.
- `'background'` (and iOS `'inactive'` on the way there) → `hub.setVisible(false)` + suspend the transport: new `SocketHub.suspend()` = intentional close (no dispose): stop heartbeat, clear reconnect timer, close socket with `intentionalClose`-style latch that `connectNow()` clears. This stops the 2.5 s ping and the reconnect churn the moment the app leaves the foreground; `'active'` resumes via `connectNow()`.
- Listener added once in the boot effect, removed in cleanup (mirror the existing `pagehide` pair at `MobileClientProvider.tsx:535-538,643-646`).
- `setVisible(false)` on background is what un-suppresses server push (ntfy/Telegram, `notify/service.ts:296-300`) — add a test asserting the visibility frame is sent before the socket closes (order matters; send, flush, then close).

### C4. Visibility truth on native

`tabIsVisible()` (`engine/state.ts:169`) returns `true` without `document`. Make the visibility source injectable (runtime/provider supplies it; native implementation reads AppState) or, minimally, have the provider drive `hub.setVisible` exclusively from AppState on native so the server-side notion is correct even though the local helper stays browser-shaped. Prefer the injectable seam; the helper has other consumers.

### C5. Heartbeat tuning

Make `HEARTBEAT_INTERVAL_MS` a `SocketHub` option (default 2 500 unchanged). Mobile native passes 10 000. With C3 suspending on background, the remaining cost is foreground-only; 10 s still bounds half-open detection at ≤20 s worst case on native, acceptable there. Do not change web.

### C6. Kernel outbox parity for mobile

Web passes the kernel queue (`AppShell.tsx:180` → `createOutboxFn`); mobile falls back to the legacy `Outbox` (flat 5 s retry, no partitions, no expiry sweep). Wire `createOutboxFn` in `MobileClientProvider` over the existing SQLite outbox storage (`createKernelOutboxStorage`, `MobileClientProvider.tsx:286-291`) the same way web does. This is the largest C item — if it balloons, split it out as its own sub-issue rather than blocking C1–C5.

### C7. Tests

- A "native-globals" vitest shim (window without `addEventListener`/`location`, `navigator` without `onLine`, no `document`) under `apps/mobile` exercising: store boot (no throw), `readServerConfig` fallback, outbox attach, `platformIsOnline` behavior with an injected NetInfo state.
- AppState transitions: background ⇒ visibility frame sent then socket closed, no timers left (fake timers assert none pending); active ⇒ `connectNow` called.
- The existing cold-start-paint tests (`mobile-replica.test.ts`) stay green.

---

## Acceptance for the epic's first wave

1. Reconnect at unchanged/moved head: no `feedBootstrap` frames on the wire; O(delta) transfer (WP-A test).
2. Fleet reconnect after server restart: attempt times jittered (WP-B test); network-restore → socket back in <1 s, not ≤10 s (WP-B/C tests).
3. Native mobile: no browser-global crashes under the native-globals shim; backgrounding stops heartbeat/reconnect timers and marks the client invisible (push un-suppressed); foreground reconnects immediately (WP-C tests).
4. Conformance suite, typecheck, and the affected package test lanes green on the integration branch after each ff-merge.
