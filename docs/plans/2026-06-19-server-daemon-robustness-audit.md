# Server + Daemon Robustness Audit

_2026-06-19. Audit of `apps/server` (coordinating relay) and `apps/daemon` (per-machine
agent host) for stability and performance, motivated by repeated incidents where a single
misbehaving agent took down all of Podium. Prioritized fix list with blast radius and the
UX cost of each change._

## Summary

The server/daemon process split (`scripts/server.ts` vs `scripts/daemon.ts`) is the correct
structural foundation: the coordinating loop does **no** PTY/spawn/scan work, so a reattach
storm or a busy agent cannot starve `/health` or the UI. The remaining risk is concentrated in:

1. **Missing safety nets** — no process-level crash handler, no daemon↔server heartbeat, no
   process watchdog — that turn a single fault into a total, non-self-healing outage.
2. **Synchronous blocking work still on the daemon's loop** — spawn, kill, image write,
   per-session SQLite pollers — which is the actual wedge mechanism.
3. **Unbounded fan-out / buffering** with no backpressure, which is the OOM mechanism.

The headline gaps were confirmed directly in the source: there is **zero**
`process.on('uncaughtException' | 'unhandledRejection')` anywhere; `wsServer.ts` sweeps only
the client sockets, never the `/daemon` socket; and the boot watchdog lives only in the
now-unused single-process `host.ts`, not in the split `daemon.ts`/`server.ts`.

## What runs on each event loop

| | Server loop (coordinating) | Daemon loop (per-agent) |
|---|---|---|
| **Blocking work that's present and shouldn't be** | Synchronous `node:sqlite` on every persist; `indexConversations` upserting the **full** conversation list every 15 s; `broadcastSessions()` O(sessions×clients) on many events; fire-and-forget sends with no backpressure | Synchronous PTY **spawn** (`execFileSync`) and **kill** (`spawnSync`); synchronous `writeFileSync` of base64 images; synchronous `parseControlMessage`+switch with no frame-size cap; per-session 700 ms **sync SQLite** pollers (codex/opencode); 15 s discovery **stat-storm** |
| **Correctly off the loop / already hardened** | client heartbeat + reconnect (both directions); bounded 256 KB replay ring; 12 k-item transcript cap | reattach gated + async (`REATTACH_CONCURRENCY=6`, `abducoHasSessionAsync`); `discoveryInFlight` coalescing; usage/quota TTL memos; uploads GC; async file RPCs |

---

## P0 — A single agent/frame can take down all of Podium and won't self-heal

### P0-1. No process-level crash net (keystone)
Neither `scripts/server.ts` nor `scripts/daemon.ts` installs `unhandledRejection` /
`uncaughtException` handlers, so any escaped throw or un-`.catch`'d rejection kills the whole
process. Live unguarded feeders:

- the `ws.send` closures (`wsServer.ts:66,80`),
- `Session.broadcast` (`session.ts:534`),
- the title-debouncer **timer** callback (`relay.ts:1107`),
- the three file-RPC `.then()`s with no `.catch` (`daemon.ts:1169-1184`),
- the `onExit` async IIFE (`daemon.ts:880`) — spawns `abduco` under fork pressure exactly when
  the host is already stressed and agents are exiting,
- the `wrapPty` frame/title callback fan-out (`agent-bridge/src/session.ts`).

**Fix:** add log-and-survive handlers in both entrypoints; wrap the two `send` closures and the
`handleControlMessage` switch body in try/catch. This converts most findings below from
"process death" to "logged and survived." **Do this first** — it's the cheapest, highest-leverage change.

### P0-2. No daemon↔server heartbeat — the documented wedge
`daemonWss.on('connection')` (`wsServer.ts:65-75`) wires only `message` + `close`. A wedged-but-open
daemon socket (Recv-Q stuck) never fires `close`, so `detachDaemon()` never runs; every
daemon-backed tRPC (`scan`/`refreshRepos`/`quota`) hits its 10 s timeout, and the UI falls back to
the empty new-install repo screen. **Never self-heals** without `systemctl restart podium-daemon`.

**Fix:** symmetric `/daemon` heartbeat mirroring `sweepClientLiveness` — server pings the daemon
socket and `terminate()`→`detachDaemon` after N missed pongs; the daemon self-pings the server and
reconnects on timeout, the same way the browser `SocketHub` already does.

### P0-3. No process watchdog; boot watchdog lost in the split
Neither split unit sets `WatchdogSec`/`Type=notify`, and the daemon exposes no health surface, so
`Restart=always` (exit-only) and any external `/health` probe are both blind to a wedged-but-alive
daemon. The boot watchdog exists only in `host.ts:22-28`, not in `daemon.ts` (which has the real
boot-wedge risk).

**Fix:** `WatchdogSec=30` + `Type=notify` + `sd_notify("WATCHDOG=1")` **pet driven from inside the
daemon read loop** (a stalled loop stops petting → systemd restarts it); port the `host.ts` boot
watchdog into `daemon.ts`; and **commit the split systemd units** — the repo's `scripts/systemd/*`
are stale single-process copies; the live `podium-{server,daemon,health}` units are not git-tracked.

### P0-4. Daemon loop does synchronous blocking work (the wedge mechanism)
- `spawnAbducoAgent` → `execFileSync(systemd-run)` + `execFileSync(abduco)` per spawn (`abduco.ts:263,282`)
- `killAbducoSession` → `spawnSync` per kill (`abduco.ts:114`, called from `daemon.ts:1120`)
- `writeFileSync` of a decoded base64 image (`daemon.ts:1072`)
- synchronous `parseControlMessage` + switch on every frame, no size cap (`daemon.ts:1087,1424`)

**Fix:** async spawn/kill (`killAbducoSessionAsync` can reuse the async-list primitive already next
door); async image write; cap/stream inbound frame size; `setImmediate`-yield between dispatches so
socket reads interleave.

### P0-5. Fire-and-forget sends → server OOM
Every `ws.send(encode(msg))` (`wsServer.ts:66,80`) and every broadcast
(`session.ts:onFrame→broadcast`, `relay.ts` loops) skips any `bufferedAmount` check. A runaway agent
(`yes`, a huge paste echo) into a sleeping/mobile client balloons the per-socket send buffer in
process memory → server OOM kills **every** session. The client heartbeat does not help: a
slow-but-alive socket keeps ponging while its buffer grows.

**Fix:** a `bufferedAmount` gate in the send closures — above a threshold (e.g. 8–16 MB) drop output
frames for that client (it full-replays off the bounded ring) or `terminate()` it; apply to the
daemon link too.

---

## P1 — Severe degradation under load (recoverable)

### P1-6. Synchronous store on the coordinating loop
`indexConversations` → `upsertConversations` runs `BEGIN … N stmt.run() … COMMIT` with FTS triggers
over the **full** conversation list on every 15 s push, even when unchanged (`store.ts:380`,
`relay.ts:1124/1136`). The `conversations` table also has **no indices** — search/browse do full
scans + filesorts.
**Fix:** skip-when-unchanged + index only changed rows (or move the store to a worker thread); add
`idx_conversations(updated_at)` and `(project_path)` — one-liners.

### P1-7. Per-session 700 ms sync-SQLite pollers
`observeCodexState`/`observeOpencodeState` open a fresh `DatabaseSync` and `SELECT *` over unbounded
tables every 700 ms **per session** on the daemon loop (`codex-state.ts:58`, `opencode.ts:77-163`).
N sessions = N sync queries 1.4×/s.
**Fix:** reuse one DB handle, gate the read on the rollout file's mtime, and/or lengthen the
interval.

### P1-8. `broadcastSessions()` fan-out
O(sessions×clients) re-serialize on `onActivity`, `sessionResumeRef`, first `transcriptAppend`, etc.
(`relay.ts:1467`) — `agentState`/`title` were already moved to per-session deltas for this exact
reason.
**Fix:** extend the per-session-delta pattern to activity/resumeRef; coalesce/debounce.

### P1-9. 15 s discovery stat-storm + full-table `deleteMissing`
Every tick `stat()`s every transcript file across all projects (`scanner.ts:129`) and `SELECT`s the
entire cache table (`cache.ts:132`), even when nothing changed — the cold-start/slowness culprit.
**Fix:** watch the session dirs (`fs.watch`), drop to a long idle interval when no session is live,
and skip `deleteMissing` when nothing was seen-new.

### P1-10. Hook-ingest unbounded body
`req.on('data', …)` with no cap + sync `JSON.parse` (`hook-ingest.ts:38`). The hook port is baked
into each agent's settings, so an agent can OOM/block the daemon with one large POST.
**Fix:** cap accumulated body size; 413 past the limit.

### P1-11. Conversation snapshot has no retention
The `conversations` table and discovery cache never prune by age; the full (4.8 MB+) snapshot is
`JSON.stringify`'d every 15 s and re-sent on **every** client connect (`daemon.ts:765`,
`relay.ts:917`).
**Fix:** window/paginate the wire snapshot (clients query the FTS index for the rest); add age
retention.

### P1-12. Per-session maps leak on natural exit
`draftBySession`, `titleDebouncers`, `draftWriteTimers`, and `sessions` itself are only cleaned by
`killSession` (`relay.ts:660`), not by `agentExit` (`relay.ts:1027`) — a slow leak that also inflates
every `broadcastSessions`.
**Fix:** prune on exit; cap retained exited sessions.

### P1-13. `readTranscriptPage` slurps the whole file
`Buffer.alloc(size)` + full parse per scroll-to-top page (`tailer.ts:106`) — daemon memory/CPU spike
on multi-hundred-MB transcripts.
**Fix:** byte-window seek / cached offset index (the code's own TODO).

---

## P2 — Efficiency / smaller wins

- **P2-14. Quota TTL race:** TTL 60 s == client poll 60 s → refetch every poll (`quota-fetch.ts:11`);
  bump to 90–120 s (same fix the usage memo already uses).
- **P2-15. Reattach tail spike:** 16 MB initial tail read per session isn't gated by the reattach
  limiter (`tailer.ts:17`) → 0.5–1.4 GB transient on a 30–90 session storm.
- **P2-16. Git metadata uncached:** re-read HEAD/refs/config/worktrees on every repo scan
  (`metadata.ts`); cache keyed by ref-file mtime.
- **P2-17. Sync fs on the daemon loop:** `memoryBreakdown` `/proc` walk + hourly `sweepUploads` →
  async + yield.
- **P2-18. `detachClient` scans all sessions** per disconnect (`relay.ts:929`) — O(clients×sessions)
  on a reconnect storm; index subscribers by client.

---

## UX impact of each change

Most of the stability work is invisible to users (pure safety) or actively *improves* UX
(self-healing). The user-facing trade-offs are concentrated in the performance throttling, and most
of those can be designed to avoid any degradation.

### Zero UX cost — pure safety or speedup
- **P0-1** crash nets + send guards — invisible.
- **P0-2 / P0-3** heartbeat + watchdog — strictly *better* UX (auto-recovery instead of a manual restart).
- **P0-4** async spawn/kill — keeps the daemon *more* responsive during spawns; the `setImmediate`
  yield adds sub-millisecond latency per message, not perceptible.
- **P1-6** store off the loop + indices — faster, invisible.
- **P1-8** per-session deltas (the delta half) — faster, invisible.
- **P1-12 / P1-13 / P2-16 / P2-17 / P2-18** — invisible or faster.

### Marginal — coalescing latency in the tens of milliseconds
- **P0-4 frame-size cap** *only if it rejects* a legitimately huge paste. Avoid by chunking/streaming
  the frame rather than rejecting it → then no UX cost.
- **P1-8 debounce** of the session-list broadcast — the sidebar (busy dot, last-active bump) updates a
  beat later (~50–100 ms). Imperceptible if the debounce is short.
- **P1-9 discovery** with `fs.watch` has no cost; the "longer idle interval" fallback makes
  externally-created conversations (started in a terminal outside Podium) appear in the history list
  slower while no session is live.
- **P2-15 reattach tail gating** — chat history for some sessions hydrates a beat later during a
  reconnect storm.

### Genuine, deliberate trade-offs (worth a conscious decision)
- **P0-5 backpressure (the one real UX cost).** Dropping frames for a slow/sleeping client means that
  client briefly sees incomplete/janky terminal output during a runaway-output burst, then a clean
  redraw/full-replay off the bounded ring. This is the intended trade — protect the shared server at
  the cost of momentary fidelity for the *slow client only*, and only above a high threshold. Other
  clients and the agent are unaffected. This is the correct call: the alternative is server OOM that
  takes down everyone.
- **P1-7 pollers — depends how you fix it.** Gating the SELECT on the rollout file's mtime keeps live
  phase/title/chat updates for codex/opencode/grok/cursor exactly as snappy (free). *Lengthening the
  700 ms interval itself* would make those agents' live state/title/chat visibly slower. Prefer
  mtime-gating; only lengthen the interval if mtime-gating proves insufficient.
- **P1-11 snapshot windowing + retention.** Windowing means older conversations aren't instantly
  present on load — they page in on scroll/search. Retention means very old history drops out of the
  index entirely. Acceptable for most users, but it changes "all history instantly searchable" into
  "recent history instantly, deep history on demand."
- **P2-14 quota TTL → 120 s.** The quota chip can be up to ~2 minutes stale instead of ~1 minute. Minor.

### Net
None of the **P0 stability** fixes meaningfully degrade UX except **P0-5 backpressure**, whose
degradation is restricted to a single slow client under pathological output and is recoverable by
design. Everything else that touches responsiveness (P1-7, P1-9) has a no-degradation implementation
(mtime-gating, `fs.watch`); the only inherent product trade-off is **P1-11** (deep history becomes
on-demand) and **P2-14** (slightly staler quota).

---

## Recommended order of attack

The first three buy the most resilience per unit effort and target the "one agent kills everything"
failure mode directly:

1. **P0-1 + the send/switch guards** — stop single faults from killing the process.
2. **P0-2 + P0-3 (heartbeat + `WatchdogSec` pet from the loop)** — make the documented wedge
   *self-heal* instead of needing `systemctl restart podium-daemon`.
3. **P0-4 (async spawn/kill + frame cap) + P0-5 (`bufferedAmount` backpressure)** — remove the actual
   wedge/OOM mechanisms.

Then the P1 batch (store off the loop, mtime-gate the pollers, broadcast deltas, fix the stat-storm)
for steady-state CPU/memory, and P2 as cleanup.

A natural first PR is the **P0 safety set** — crash nets + send guards + daemon heartbeat — which is
tight, low-risk, and has essentially no UX cost.
