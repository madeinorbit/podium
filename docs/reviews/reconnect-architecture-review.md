# Reconnect architecture review (web, desktop, Expo)

*As of main @ 7b62c707c, 2026-08-14. Question: is the reconnect system optimal and architecturally correct for an offline-first sync system, and does it have negative impacts?*

## Verdict

The **architecture is fundamentally sound** — better than most offline-first stacks:

- One socket, one reconnect loop (`SocketHub`), with terminal PTY streams, the sync feed, transcripts, and presence all multiplexed over it. No competing reconnect systems.
- Reconnect is a **delta heal by default** (`D7-1-RESUME` from a persisted `(feedId, epoch, seq)` cursor), with a principled ladder (transition table, `packages/sync/src/replica/transition-table.ts`) deciding when a full bootstrap is forced. Compaction, epoch mismatch, and rescope are all explicit rungs, not accidents.
- The replica stays **stale-visible on disconnect** — the UI serves cached data, never blanks. Terminals resume from a `sinceSeq` cursor without clearing the screen on a blip; offline keystrokes queue and flush in order.
- Durability is real: SQLite on mobile, IndexedDB on web, cursor and rows committed in one transaction; outbox writes are persisted with durable `nextAttemptAt` backoff and server-side `mutationId` dedup.

The problems are **operational tuning and platform wiring**, not design. Ranked:

## High impact

### 1. Full world pushed on every socket attach — negates delta catch-up
`FeedServing.attach` unconditionally `serveWorld`s any peer without an existing connection (`apps/server/src/gateway/feed-serving.ts:214-224`). There is no "I hold cursor X" in the client `hello`, so on a plain reconnect the client runs a small `changesSince` heal **while the server simultaneously streams the entire visible world** over the socket. The cached world is reused only when `throughSeq` and the auth revision are unchanged — rare on a busy server. Every Wi-Fi flap, laptop wake, or cellular handover costs a full-world read and transfer. This is the single biggest bandwidth/CPU cost, and it hits mobile (metered links, frequent socket death) hardest.

**Fix direction:** carry the client cursor in `hello`; serve a delta (or nothing) when the change log covers it, world only when it doesn't.

### 2. Reconnect backoff has no jitter — thundering herd
`scheduleReconnect` is pure `delay*2` capped at 10 s, no randomization (`packages/client-core/src/socket-transport/socket-hub.ts:727-737`), and the delay resets on TCP open (not on `welcome`). A server restart brings every client back in lockstep at 0.5/1/2/4/8/10 s — each paying a `hello` + attach fan-out + full world (issue 1), synchronized. The repo already has a jitter formula with a comment explaining exactly this ("must not come back in lockstep") in `packages/client-core/src/logging/forward-sink.ts:181-186` — the transport just doesn't use it.

### 3. Network-restore is discovered by polling, not by the OS
Nothing wires `window` `online` (web) or NetInfo/AppState (native) to `hub.connect()`. Only the **outbox** listens to `online` (`packages/client-core/src/outbox.ts:158-170`), so after a network flap mutations flush instantly over HTTP while the feed and terminals stay dark for up to 10 s waiting out the backoff timer. Cheap fix: on `online`/foreground, reset `reconnectDelay` and connect immediately. (The only manual escape hatch today is mobile pull-to-refresh, `apps/mobile/src/hooks/useRefreshableTab.tsx:59`; web has none.)

### 4. Native mobile has no platform connectivity wiring at all — and two likely crashes
The Expo app ships/tests as react-native-web; there is **no `AppState` listener, no NetInfo dependency** anywhere. Consequences on a real native build:
- Socket never torn down on background; heartbeat (2.5 s), reconnect loop, outbox retry (5 s), and a 60 s snapshot tick all keep running until iOS kills the process's sockets — then the app churns retries in the background and may sit inside a 10 s backoff at foreground.
- `tabIsVisible()` returns `true` without `document` (`packages/client-core/src/engine/state.ts:169`), so a native client registers as permanently "watching" — which **suppresses ntfy/Telegram push** server-side (`apps/server/src/modules/notify/service.ts:296-300`). A backgrounded phone silently swallows its own notifications.
- Two shared paths likely throw on device, masked by the happy-dom test alias: `platformOnlineEvents()` calls `window.addEventListener` (RN defines `window` without it), and `readServerConfig` dereferences `window.location` (`apps/mobile/src/client/trpc.ts:159-169`).
- `navigator.onLine` is undefined on RN ⇒ outbox believes it is always online and retries every 5 s in airplane mode.

### 5. `SetupGate` blocks the offline-first app on a network probe
`SetupGate` wraps the whole `AppShell`; on a cold offline load it probes `/setup/config`, retries 5×, then renders `SetupUnreachable` with manual-retry only (`apps/web/src/features/setup/SetupGate.tsx:9-11,78-90`) — the fully populated IndexedDB replica never mounts. `LoginGate` already has the right shape (degrades to `ready` on fetch rejection, `LoginGate.tsx:444-446`).

### 6. Hidden-tab feed drain: one frame per second, unbounded queue
The feed ingress queue processes one envelope per macrotask via `setTimeout(task, 0)` (`socket-hub.ts:549,1318-1373`); hidden tabs clamp timers to ≥1 s, so a backgrounded tab drains one frame/second while `feedIngressQueue` grows without cap. A reconnect while hidden can blow the 30 s bootstrap-chunk timeout purely on scheduling. Meanwhile the 2.5 s heartbeat and presence traffic keep running hidden.

## Medium impact

### 7. Re-bootstrap costs a socket cycle and rides the backoff
The protocol has no bootstrap request, so `requestFreshWorld()` = `forceClose()` + reconnect (`socket-hub.ts:812-835`). A rescope — a normal event (someone clicks "share") — tears the connection down and pays the current backoff delay, escalating toward 10 s under repeated rescopes. The seam's own comments record a past live heal-loop here.

### 8. Optimistic-overlay retirement is heuristic, not provenance-based
`OptimisticOverlayPort` has no production implementation; the kernel's one-transaction D10 retirement never fires. Retirement falls to `engine/optimism.ts` fingerprint matching with a 60 s TTL — after a reconnect, an offline write's overlay is reconciled against re-bootstrapped truth by fingerprint, so double-paint / snap-back / 60 s lingering are all reachable. This is exactly the ordering hazard the kernel design set out to remove.

### 9. Offline writes replay as blind last-writer-wins
The conflict machinery exists (`expectedRevision` → arbitration → CONFLICT dead-letter with a rebase plan), but **no client sets `expectedRevision`** and the only arbitrating site (issues) passes `omittedExpectedRevision: 'accept'`. Fine for single-user today; a decision to record before multi-user.

### 10. Legacy/compat paths are materially weaker and partly wired
- The compat client `Outbox` (non-kernel adapters, **and mobile** — web passes the kernel queue, mobile does not): single global FIFO (one stuck entry blocks everything), flat 5 s retry with no backoff, and `sweepExpired` has no caller — entries never age out, so a >30 d queue replays past receipt retention.
- Wire-v1 feed: records `epoch`/`minAvailableSeq` and never reads them (no rung 2/4), heals on a flat 3 s timer, cursor in-memory.
- The pure ladder `decideFeedAction` and paced bootstrap in `client-core/src/replica/bootstrap.ts` (which documents a production outage the pacing fixed) are **dead code**; the kernel walk installs unpaced.

### 11. Health can wedge at `down`
`markAlive` (any inbound traffic) defuses the force-close, but `pingQueue` entries clear only on a real `pong`; a server that streams output but drops pings yields permanent `down` — which also permanently suppresses the outbox's `notifyConnected` edge (`engine/runtime.ts:533-539`).

### 12. Non-idempotent replay window
`MutationLedger` records receipts after the body resolves, outside the entity transaction; a crash between apply and receipt makes a replay a fresh apply. With commands like `resumeAndSend` typing into a live PTY, double-apply is reachable, not theoretical.

## Low / hygiene

- Control messages (`resize`, `requestControl`, `detach`, drafts) issued while disconnected are **silently dropped** once `socket` is nulled (`socket-hub.ts:1800-1810`); only terminal input queues. Conversely, `preOpenQueue`d messages from a failed connect flush on a later, different connection where they may be stale.
- `everConnected` set on TCP open (not `welcome`): an accept-then-close server converts "fatal misconfiguration" into an infinite silent 500 ms loop.
- Unwired kernel liveness: `Authority.watermark()`, `Outbox.requeueStalled`, `noteTransportLost` have no callers — a lost apply notification recovers only at next `Outbox.open`.
- Heartbeat is desktop-tuned (2.5 s ping) — ~24 radio wakeups/minute on a phone; the 10 s unanswered-ping force-close tears down recoverable lossy links, each teardown costing a full world (issue 1).
- No bfcache/`pageshow`/focus revalidation on web; a frozen tab's recovery relies on the 10 s heartbeat window. Desktop (Tauri) has no suspend/resume or network hooks; two uncoordinated backoffs stack (respawn ≤5 s + WS ≤10 s).
- `use-socket-hub.ts` (terminal-client-react): dead code that polls `hub.connected` at 100 ms and builds a hub in `useMemo`; delete or rewrite on `onConnectionHealth`.
- `dispose()` doesn't reset `reconnectDelay` and never clears `eventObservers`; `terminalAttachDenials` grows monotonically.
- Cross-tab delta relay dedup map (`apps/web/src/lib/kernelReplica.ts:451-489`) never clears on principal change/reconnect; FIFO eviction can readmit an old frame (lands on the gap rung, so self-heals).

## What is genuinely good (keep)

- Single multiplexed socket; terminal resume cursors with no screen-clear on delta resume; offline keystroke queue.
- The D6/D7 transition table as declarative data — buffered frames validated before buffering, epoch checked before buffering, stale-visible posture, bounded bootstrap attempts settling to a visible stale slice.
- Change-log design: retention independent of bootstrap correctness (`latestChangeStates`), proactive `minAvailableSeq` rung, paged `readChangesSince`.
- Kernel outbox: partition FIFO, durable backoff, dead-letter horizon asserted under receipt retention, mutationId dedup with in-flight promise joining.
- Mobile data layer: SQLite replica with commit-before-publish, per-principal namespacing, cold-start-paint tests.
- Hook/listener hygiene on web is largely clean (checked pairs throughout).

## Recommended order of work

1. Jitter in `scheduleReconnect` + `online`/foreground → immediate connect (tiny, shared, defuses herd and the 10 s dead window).
2. Cursor in `hello` → stop pushing full worlds on plain reconnects (biggest bandwidth win; server + client change).
3. Mobile native wiring: AppState (close on background, connect+`setVisible` on foreground), NetInfo injection into the existing `OutboxInit` seams, feature-detect `window.addEventListener`/`window.location`, platform-configurable heartbeat; give mobile the kernel outbox web already uses.
4. `SetupGate`: degrade to cached app when the probe fails and a replica exists (mirror `LoginGate`).
5. Hidden-tab: cap/batch the feed ingress drain (drain N per task, or `MessageChannel` instead of `setTimeout`).
6. Then the medium items: in-protocol bootstrap request (no socket cycle), overlay retirement provenance, compat-outbox sweep wiring or retirement of the compat path.
