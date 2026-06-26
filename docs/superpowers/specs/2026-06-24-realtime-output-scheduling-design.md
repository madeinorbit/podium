# Realtime output scheduling + redeploy-race fix — design

Date: 2026-06-24
Status: approved-for-planning
Follows: `2026-06-24-podium-loop-isolation-design.md` (loop isolation shipped live `faef6da`; loop-stall attribution + profiler fix shipped `abae6f2`).

## Problem (measured)

After loop isolation moved the discovery scan + memory walk off the daemon's
interactive loop, the in-process attribution profiler (`PODIUM_LOOP_PROFILE`,
`loop-attribution.ts`) showed the residual daemon hitches (~100–470ms, occasional)
are dominated by **PTY output-frame relay churn**:

```
stall 469ms | frames=269 bytes=36KB worker=0
stall 262ms | frames=182 worker=0
stall 203ms | frames=241 worker=0   (~⅔ of stalls track a burst of 100–270 frames)
stall 293ms | frames=9  control=0 worker=0 | heap … (~⅓ are GC/low-activity)
```

`worker=0` on nearly every stall confirms the scan is genuinely off the loop. The
hitch is the daemon relaying **all ~90 sessions'** output to the server — including
sessions **no client is watching** — at one `JSON.stringify` + `ws.send` **per
frame**. Bytes are small (1–36KB); the cost is per-frame overhead × many frames.
When a background agent dumps output, it hitches the same loop that carries the
focused session's keystroke echo.

A second, independent issue surfaced while deploying the profiler fix: the
**redeploy races the working-tree checkout**. `redeploy.path` fires on the
`.git/logs/HEAD` reflog append and `redeploy.service` immediately restarts the
backend; under load a fast-forward merge's checkout can lag the reflog (observed:
daemon booted 16s before the merged files landed), so the services boot **stale
source**.

## Goals

1. The **focused session's keystroke echo never waits** behind background sessions'
   output relay.
2. Eliminate the per-frame relay overhead (batch frames; relay unwatched sessions
   lazily).
3. Redeploy can never boot stale source.

## Non-goals

- GC tuning (the ~⅓ low-activity stalls). Revisit if the output-scheduling win
  isn't enough.
- Changing the server→client fan-out or xterm rendering. The measured hitch is the
  daemon→server relay; this design targets that. (Server-side coalescing can be a
  later increment if its loop shows contention.)

---

## Part 1 — Redeploy race fix (ships first; small, independent)

**Change:** add an `ExecStartPre` gate to `podium-redeploy.service` that waits for
git to be quiescent before the restart.

`scripts/redeploy-wait.sh` (new), invoked as `ExecStartPre`:
1. Poll until `<repo>/.git/index.lock` is **absent** — git holds the index lock for
   the duration of a merge's index+working-tree update and releases it only when the
   checkout is complete. Its absence means the working tree is fully written.
2. Add a short fixed settle (e.g. 500ms) for filesystem flush.
3. Overall timeout (e.g. 30s) → proceed anyway (never wedge the redeploy; a stale
   boot is rare and self-corrects on the next deploy, a wedged redeploy is worse).

This touches only the wait gate — it never modifies the working tree, so the user's
uncommitted work is untouched. Unit-test `redeploy-wait.sh` against a temp dir with
a synthetic `index.lock` that a background process removes after a delay (asserts it
waits, then returns; and that it times out cleanly if the lock never clears).

**Files:** create `scripts/redeploy-wait.sh` + `scripts/redeploy-wait.test.ts` (or a
shell test); modify `scripts/systemd/podium-redeploy.service` (add `ExecStartPre`).
Installing the updated unit is a manual `systemctl --user daemon-reload` step noted
in the plan (systemd units in `~/.config/systemd/user/` are copies).

---

## Part 2 — Output scheduler

### Component A — Client view-state signal

The client already sends `attach`/`transcriptSubscribe` per session (→ the server
knows **attached**). Add a per-client **view-state** it sends whenever its rendered
panels or input focus change:

- Protocol (client→server): `viewState { visible: string[]; focused: string | null }`
  - `visible` = session ids currently rendered on screen (covers split-view: more
    than one).
  - `focused` = the single session that has input focus (would receive a keystroke
    without clicking), or null.
- Client wiring: `packages/terminal-client/src/connection.ts` gains
  `setViewState(visible, focused)`; `apps/web/src/store.tsx` calls it when the
  visible panel set or the focused panel changes (debounced; re-asserted on
  reconnect like `presence`).

`presence{visible}` (global tab visibility) stays as-is for push routing; `viewState`
is the new per-session signal. A client whose tab is hidden reports `visible: []`,
`focused: null` (nothing on screen) so its sessions drop in priority.

### Component B — Server priority aggregation (union across clients)

`apps/server/src/relay.ts` tracks per-client `{ attached: Set, visible: Set, focused }`
(attached from existing attach state; visible/focused from `viewState`). It computes
each session's priority as the **maximum any connected client assigns it**:

| tier | meaning | condition |
|---|---|---|
| **P0 focused** | someone is typing here | any client `focused === sid` |
| **P1 visible** | on someone's screen | any client has `sid ∈ visible` |
| **P2 attached** | subscribed, not on screen | any client attached, not visible |
| **P3 unwatched** | nobody attached | otherwise |

Multi-client safe by construction: mobile `focused=A` + desktop `focused=B` → A and
B both P0. On any client view-state change or disconnect, recompute and send the
**delta** to the daemon. New unit: `apps/server/src/session-priority.ts`
(`computePriorities(clients): Map<sid, tier>`), pure + table-tested.

Protocol (server→daemon): `sessionPriority { priorities: { [sid]: 0|1|2|3 } }` (full
map on daemon (re)connect; deltas thereafter). The daemon defaults an unknown
session to P1 (immediate) until told — never under-serve a session we don't yet
have priority for.

### Component C — Daemon output scheduler (where the hitch is)

`apps/daemon/src/output-scheduler.ts` (new) sits between `session.onFrame` and the
`send`. Per session it holds a pending-frame queue + its priority, and flushes as one
batched message:

- **P0 / P1 (focused / visible):** *per-tick coalesce* — on the first frame of a tick,
  schedule a `setImmediate` flush; subsequent frames in the same tick append. Flush
  sends one `agentFrameBatch`. Added latency ≈ one loop iteration (sub-ms); for echo
  this is effectively immediate, and it collapses N `stringify`+`send` into 1.
- **P2 / P3 (attached / unwatched):** *time/size coalesce* — accumulate frames; flush
  on a timer (default 75ms) OR when pending bytes exceed a cap (e.g. 64KB), whichever
  first. Keeps the server's replay ring-buffer warm in bulk without hitching the loop.

A session's priority changing flushes its pending queue immediately (so promoting a
session to focused doesn't strand buffered output). On session end/detach the queue
is flushed + disposed.

Wire: `agentFrameBatch { sessionId, frames: ConvFrame[] }` where
`ConvFrame = { seq, data }` — an **array of frames**, preserving per-frame seq (so
the server's seq-cursored ring buffer + resume logic is unchanged), but one
`encode` + one `send` for the batch. The server's daemon-message handler unpacks the
batch and runs each frame through the existing `session.onFrame(seq, data)` path.
Single `agentFrame` is retained for the trivial one-frame case / back-compat.

### Data flow

```
client focus/visibility change ─viewState─▶ server (per-client view sets)
   └─ computePriorities (union) ─sessionPriority delta─▶ daemon scheduler
PTY onData ▶ session.onFrame ▶ output-scheduler.enqueue(sid, seq, data)
   P0/P1: setImmediate flush ─agentFrameBatch─▶ server.onFrame per frame ─▶ ring + fan-out
   P2/P3: 75ms / 64KB flush  ─agentFrameBatch─▶ server.onFrame per frame ─▶ ring + fan-out
```

### Error handling

- A `viewState` for an unknown/ended session is ignored (no priority entry created).
- Scheduler flush failure (socket gone) is swallowed per the existing `send`
  contract; pending frames for a dead daemon link are dropped (the client
  full-replays off the ring buffer on reconnect, unchanged).
- Default-P1 on unknown priority guarantees no session is silently starved.

### Testing

1. **Priority aggregation** (`session-priority.test.ts`): the union table — single
   client; two clients focusing different sessions (both P0); a hidden client
   (visible=[]) dropping its sessions to P2/P3; attach-without-visible = P2.
2. **Scheduler** (`output-scheduler.test.ts`, injected clock + flush sink): P0 frames
   in one tick → one batch; P3 frames → batched on the 75ms timer / 64KB cap;
   priority promotion flushes immediately; per-frame seq preserved in the batch.
3. **Loop-isolation regression** (bun, real-ish): a P3 session enqueuing a flood of
   frames does NOT delay a P0 session's flush, and the daemon main-loop max lag stays
   low while the flood runs (mirrors the existing worker-isolation test).
4. **Wire round-trip**: `agentFrameBatch` encodes/parses; the server unpacks N frames
   to N `onFrame` calls with correct seqs; a single-frame send still works.
5. **Live**: with `PODIUM_LOOP_PROFILE` on, the frame-attributed stalls
   (`frames=NNN`) should drop sharply; background-session floods no longer hitch the
   focused echo.

---

## Rollout

Build in a worktree, verify (typecheck + suites + the bun isolation/scheduler tests
with `--conditions=@podium/source`), rebase + `git merge --ff-only` to live main
**after the Part 1 redeploy fix is in** (so this very deploy can't boot stale), then
re-run the profiler to confirm the frame-attributed stalls fall.

## Open questions

None blocking. Coalesce cadences (P2/P3 75ms / 64KB) are tunable constants; the plan
exposes them as named constants for live tuning.
