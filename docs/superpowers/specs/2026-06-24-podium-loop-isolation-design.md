# Podium loop isolation — design

Date: 2026-06-24
Status: approved-for-planning
Worktree: `worktree-typing-latency-profiling` (off live main `ebe5449`)

## Problem (measured, not assumed)

Typing into a session is fluid for a few characters, then stalls ~1s, then the
typed characters replay in a burst. Root cause was established with real data
(full writeup: `docs/superpowers/specs/2026-06-24-typing-latency-findings.md`;
reusable prober to be promoted to `scripts/loop-probe.mjs`):

- A triangulating black-box prober (10 Hz, 6 min) showed the prober's **own**
  loop lag stayed low (p50 4ms, max 150ms) while **server** and **daemon** WS/HTTP
  round-trips spiked to 0.5–2.5s. → the stalls are **in-process JS blocking on
  the backend**, not host scheduling.
- The stalls are **periodic (~16s)** and **cascade**: a daemon stall (700–950ms)
  is followed ~1s later by a ~500ms server stall (the daemon's frozen loop stops
  draining 92 sessions' PTY output; on unblock the backlog floods the server).

### Confirmed causes

1. **PRIMARY — discovery scan blocks the daemon loop.** Every 15s
   (`DEFAULT_DISCOVERY_SCAN_INTERVAL_MS`, `daemon.ts:88`) the daemon re-derives
   **~2,730 conversations** (`scanAgentConversations`, `scanner.ts:36`). Measured
   with `monitorEventLoopDelay`: a single **contiguous ~800ms** loop block per
   scan (806–808ms). Mechanism: a wide `await Promise.all` over thousands of files
   whose `JSON.parse` continuations drain as one **microtask storm** — async I/O
   fanned out wide still produces a synchronous CPU stall.
2. **SECONDARY — `memoryBreakdown` /proc walk.** `HostMemoryView.tsx:170` polls
   `hosts.memoryBreakdown` **every 5s** while open; the daemon answers with a
   **synchronous** `readFileSync` walk of every `/proc/<pid>` (`smaps_rollup` PSS
   page-table walk dominates). Measured **~1.1s** (1030 pids, 64 procs >100MB).
3. **AMPLIFIERS.** Host oversubscription, and a leaked `timeout 12 … server.ts`
   orphan busy-looping at 99.9% on a core for 2+ days (**killed 2026-06-24**;
   load average fell ~9→3.8).

### Why this is safe to fix the way we propose

The discovery scan is **100% background**. The web app no longer consumes the
`conversationsChanged` broadcast (enforced by `shell.structure.test.ts:123`);
search and the resume picker read the durable SQLite FTS index **on demand**
(`trpc.conversations.search`). The scan's only job is to keep that index fresh.
**Loaded/active sessions** get their title/state/transcript from per-session
transcript tailers + state observers + hooks (`daemon.ts:320,337`,
`initSessionObservers`), entirely independent of the scan. **Nothing the user
waits on depends on the scan.**

Counts on this host: **61 non-archived sessions (38 live)** vs **2,730**
conversations rescanned every 15s — ~45:1 waste.

## Goal

The interactive loop must only ever do **bounded, per-keystroke-scale work.** All
unbounded/batch work moves off it — either eliminated (made incremental/lazy) or
run on a background worker loop. Target: daemon main-loop lag p99 < 50ms under the
current 92-session load; the periodic ~16s stall and its server cascade gone.

## Non-goals (YAGNI / deferred)

- **Fine-grained focused-session prioritization.** Once background work is off the
  interactive loop, the loop should be clean. We confirm with the new
  instrumentation and only add per-session priority if data still shows
  contention. The existing `presence{visible}` signal is the hook if needed.
- **`fs.watch`-based discovery.** Rejected: the inotify **instance** cap is 128
  with 85 already in use, and Node's `fs.watch` burns one instance per call, so
  per-file watchers don't scale; the codebase already deliberately avoids
  `fs.watch` (`tailer.ts:55` — atomic-rename writes confuse watchers) in favor of
  cheap stat-polls. We keep that model.

## Architecture

### Component 1 — Background worker (the "second loop")

A single long-lived `worker_threads` Worker owned by the daemon, running heavy
batch jobs on its **own event loop**. The daemon's interactive loop only posts a
request and receives a small result; an 800ms job blocks the *worker*, never the
keystroke path.

- **Units**
  - `apps/daemon/src/discovery-worker.ts` — the worker entry. Owns `discovery.db`
    (the mtime→summary cache) **exclusively** — no cross-thread SQLite contention.
    Handles two job kinds: `indexRefresh` and `memoryBreakdown`.
  - `apps/daemon/src/worker-client.ts` — daemon-main wrapper: typed
    `runJob(job): Promise<result>`, **one job in flight per kind** (coalesce
    duplicate requests), bounded request timeout, **auto-restart on worker
    exit/crash** (mirrors the existing daemon-WS reconnect philosophy).
- **Job protocol** (structured-clone-able messages, versioned):
  - `indexRefresh{ roots, providers }` → `{ deltas: ConversationSummary[], removed: id[] }`
  - `memoryBreakdown{ sessionHints, roots, selfPid }` → `MemoryAttribution`
- **Error handling:** a job that throws returns a typed error result; the daemon
  logs (never silent) and keeps serving. A worker crash → `worker-client`
  respawns and re-arms; in-flight jobs reject and are retried on next trigger.

### Component 2 — Eliminate the periodic full scan

Replace the 15s full re-derive with three freshness sources:

- **Active/loaded sessions → event-driven.** The per-session transcript tail
  already fires on every append (`ensureTranscriptTail`, `daemon.ts:337`). On a
  tail delta we mark that one conversation **dirty**; a coalesced micro-job has
  the worker re-summarize just that file and emit a single-conversation
  `scanResult` delta. Zero scanning for the sessions the user is in.
- **Inactive/historical → incremental on the worker.** A low-frequency
  (configurable; default 15s, but now on the worker and bounded) `indexRefresh`
  job does an **mtime-diff** against `discovery.db`: re-parse only files whose
  mtime changed since cache; emit deltas. On a quiet box ~0 files; even a large
  delta never touches the daemon loop. (Decision: incremental-on-worker over
  fully-lazy, so search stays warm with ~0 cost when nothing changed.)
- **Result application unchanged:** daemon sends `scanResult` deltas to the
  server, which upserts into `podium.db` conversations + FTS (`indexConversations`,
  `relay.ts:1429`). Now deltas, not a full 2,730-row list.

### Component 3 — Memory walk on the worker (core), cheaper later (Phase 2)

- **Core (this plan):** `snapshotProcesses` (the `/proc` walk) and
  `attributeMemory` move into the worker's `memoryBreakdown` job. Still fires only
  while the Host Memory view is open (already gated by the 5s client poll). The
  ~1.1s cost stays on the worker, off the keystroke loop.
- **Phase 2 (separate follow-up — make it intrinsically cheaper):** evaluate
  RSS-from-`statm` for the bulk with `smaps_rollup`/PSS reserved for only the
  top-N shown; cache static per-process fields (cmdline/cwd/ppid) and re-read just
  the memory number each tick; relax the 5s cadence. Designed in its own pass so
  it doesn't bloat the core change.

### Component 4 — Permanent loop instrumentation

- **Unit:** `packages/core/src/loop-metrics.ts` (shared) — wraps
  `monitorEventLoopDelay` into a sampler exposing p50/p99/max, plus a **"long tick
  > N ms" warning logger** (env-gated verbosity, e.g. `PODIUM_LOOP_PROFILE`).
  Wired into both `apps/server` and `apps/daemon` startup.
- Promote the diagnostic prober to `scripts/loop-probe.mjs` (own-lag vs server vs
  daemon triangulation), documented next to `profile-backend.sh`.
- The existing systemd `WatchdogSec=30` still backstops full wedges; this adds
  sub-second visibility it lacks.

### Component 5 — Quick cleanups

- Orphan killed (done).
- Optional: stop broadcasting `conversationsChanged` to clients (vestigial — web
  reads the index on demand). Reduces server fan-out; low risk. Include only if it
  doesn't widen the blast radius.

## Data flow (after)

```
Active session append ─tail delta─▶ daemon marks conv dirty
                                      └─(coalesced)─▶ worker.indexRefresh(1 file)
Worker (own loop): mtime-diff scan / re-summarize ─▶ deltas
   └─postMessage─▶ daemon main (cheap) ─scanResult deltas─▶ server.indexConversations ─▶ podium.db FTS
Keystroke ▶ server ▶ daemon ▶ PTY ▶ echo ▶ … (interactive loop now does ONLY this + control + tails)
Host Memory view open ─5s poll─▶ daemon ─job─▶ worker /proc walk ─result─▶ daemon ─▶ server ─▶ client
```

## Testing strategy (TDD)

1. **Loop-isolation regression (the headline test):** with the worker running a
   deliberately heavy `indexRefresh`/`memoryBreakdown` job, assert the daemon
   **main-loop lag stays low** (e.g. < 50ms) for the duration — mirrors the
   prober. This is the test that would have caught the original bug.
2. **Worker job protocol:** `indexRefresh` over a fixture dir returns correct
   deltas; `memoryBreakdown` over a fixture `/proc` returns correct attribution;
   malformed job → typed error, worker survives.
3. **mtime-diff incrementality:** unchanged files are skipped; only changed files
   re-parsed; removals emit `removed`.
4. **Event-driven active update:** a synthetic tail delta produces exactly one
   single-conversation index delta (coalesced under bursts).
5. **Worker lifecycle:** killing the worker mid-flight → `worker-client` respawns,
   pending job rejects then retries; no daemon crash.
6. **`loop-metrics`:** sampler reports percentiles; long-tick logger fires above
   threshold, throttled.
7. **End-to-end with the prober:** re-run `scripts/loop-probe.mjs` against the
   patched daemon; expect daemon RTT p99 to drop from ~700ms to < 50ms and the
   ~16s periodic stall to vanish.

## Rollout

Build + test in the worktree. The live backend runs from the **main checkout**
(redeploy on `.git/logs/HEAD`); integrate via the established rebase + `merge
--ff-only` only when the user says, then redeploy and re-run the prober on the
live host to confirm the p99 drop under real load.

## Open questions

None blocking. Phase 2 (cheaper memory walk) is intentionally deferred to its own
design pass.
