# Persist session activity timestamps

**Date:** 2026-06-29
**Status:** Design — awaiting review

## Problem

Hibernation decisions (and potentially presence/ordering) depend on "when was this
session last active." Today the relay tracks two activity signals as **in-memory
only** state on `Session`, both reset to `0` on every server restart:

- `outputAtMs` — wall-clock ms of the last PTY output frame (`onFrame`).
- `resumedAtMs` — wall-clock ms of the last resume/resurrect (added by the in-flight
  hibernation-resume fix).

Because the live backend runs from a checkout that **redeploys on every HEAD move**,
restarts are frequent. After a restart these signals are `0`, so the hibernation
gate falls back to the persisted `lastActiveAt` alone — which is why a freshly
resumed-but-idle session can be re-parked right after a redeploy.

There is also **no input signal at all**: the relay never records that the user
typed/clicked in a session, so "the user is actively here" can't inform hibernation.

## Goal

Make the activity signals **durable and reliable across restarts** by persisting
them to the `sessions` table, and add a user-input signal. Do this **without**
writing on the hot path (every output frame / keystroke), and **without** disturbing
`lastActiveAt`, which is authoritative for recency ordering.

## The three activity timestamps

All are absolute times stored as ISO 8601 strings, mirroring the existing
`lastActiveAt` column (readable in the DB; the hibernation gate already
`Date.parse`es `lastActiveAt`, so comparisons stay uniform).

| Field          | Meaning                                              | Source |
|----------------|------------------------------------------------------|--------|
| `lastOutputAt` | Last PTY output frame — "the process is painting"    | `Session.onFrame()` |
| `lastInputAt`  | Last controller input — any keys/mouse/paste bytes   | `Session.handleInput()` |
| `lastResumedAt`| Last resume/resurrect — "the user just reopened it"  | `resurrectSession()` / `resumeSession()` live branch |

### Why `lastInputAt` is "any input," not differentiated

In this codebase mouse, keys, paste, and escape sequences all arrive as one
undifferentiated PTY byte stream in `handleInput(clientId, data)`; only "a line was
submitted" (CR/LF) and "a chat message was sent" (`sendText`) are cleanly separable.

`lastInputAt` records **any** controller input. The consumer we actually have is
hibernation/presence — "don't park a session the user is interacting with" — for
which any interaction is the right, most-protective signal. A separate
"deliberate-action recency" field has no consumer that `lastActiveAt` doesn't
already serve (YAGNI); the hooks to add one later (`submitsCommandLine`, `sendText`)
already exist, so it's a cheap future upgrade if a real need appears.

### Relationship to `lastActiveAt` (do not conflate)

`lastActiveAt` stays exactly as-is: agent-activity / shell-busy driven, authoritative
for recency ordering, deliberately **not** moved by raw input, raw output, reattach,
or resume. The three new timestamps are independent activity inputs to the
hibernation decision; none of them feed ordering. This preserves the invariant that
reopening/waking a stale session must not reshuffle the session list.

## Persistence strategy: in-memory live truth, lazy durable flush

The hot path must pay nothing. Frames and keystrokes update an **in-memory epoch-ms
counter** (cheap `Date.now()`, no string work) and mark the session dirty. The
durable copy is written lazily.

1. **In-memory is the source of truth for the live value.** `onFrame` / `handleInput`
   bump `outputAtMs` / `inputAtMs` (epoch ms) and set a per-session `activityDirty`
   flag. `markResumed()` bumps `resumedAtMs` and marks dirty.
2. **One registry-wide periodic flush sweep.** A single repeating timer (every
   **~12s**) writes all dirty sessions' three timestamps in **one batched
   transaction**, stringifying epoch-ms → ISO at write time, then clears the dirty
   flags. This coalesces any frame rate across any number of sessions into one
   wakeup + one write per interval. Worst-case staleness on crash = the interval;
   hibernation thresholds are minutes, so this is invisible.
3. **Opportunistic flush on existing transitions** where exactness already matters
   and `persist()` is already called: hibernate, last-client detach, status change,
   `agentExit`, and graceful shutdown. Common cases land exact, not interval-rounded.
4. **Seed in-memory from the columns on load.** On registry load, initialize
   `outputAtMs` / `inputAtMs` / `resumedAtMs` from the persisted ISO values
   (`Date.parse`) so a restart inherits real values instead of `0`.

Why a single sweep rather than the per-session debounce used for drafts: drafts are
low-frequency, so per-session timers are fine there; output/input are high-frequency
across many sessions, so one batched periodic write is cheaper and bounds staleness
cleanly. Flush-on-transition **alone** is insufficient — a long-running agent that
prints for 20 minutes without any "transition" would never persist its output time
and would look stale after a crash. The periodic sweep is what makes it reliable.

## Hibernation integration

The eligibility check in `maybeAutoHibernate` (relay.ts) currently uses
`max(lastActiveAt, lastResumedMs) <= idleCutoff` plus the 60s output-quiet gate.
After this change the "idle since" becomes the latest of all genuine activity
signals. Note the representation split: the persisted/serialized fields are ISO
strings named `lastOutputAt` / `lastInputAt` / `lastResumedAt`; the relay reads the
cheap in-memory epoch-ms counters (`outputAtMs` / `inputAtMs` / `resumedAtMs`) for
the arithmetic, so only `lastActiveAt` (ISO) needs a `Date.parse`:

```ts
const idleSinceMs = Math.max(
  Date.parse(s.lastActiveAt),  // ISO column
  s.resumedAtMs,               // in-memory epoch ms
  s.inputAtMs,                 // in-memory epoch ms
)
// candidate only if idleSinceMs <= idleCutoff && now - s.outputAtMs >= OUTPUT_QUIET_MS
```

`outputAtMs` keeps its existing role as the separate 60s output-quiet gate (a
running TUI repaints, so recent output means work is still happening). Adding
`lastInputAt` to the idle-since max means a session the user typed in within
`idleMinutes` is not a candidate, even with no agent activity.

## Schema / migration

Add to the `sessions` table (store.ts), nullable, via the additive-`ALTER` +
`colNames.has(...)` guard pattern already at store.ts:1163:

```sql
ALTER TABLE sessions ADD COLUMN last_output_at  TEXT;
ALTER TABLE sessions ADD COLUMN last_input_at   TEXT;
ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT;
```

`SessionRow`, `toRow()`, the upsert, and the row→`SessionInit` load path each gain
the three fields. Old rows read `NULL` → in-memory `0` → behave exactly as today
until the first live activity.

## Testing

- **Unit (relay):** existing resurrect-doesn't-re-hibernate test stays green.
- **Persistence round-trip:** drive output/input/resume on a `SessionRegistry`
  backed by a real `SessionStore` (temp file, as the draft-persistence test does),
  trigger a flush, construct a fresh registry on the same DB, and assert the
  in-memory timestamps are seeded from disk and the hibernation gate honors them
  (no immediate re-park after a simulated restart).
- **Throttle:** with fake timers, assert N output frames produce at most one DB
  write per flush interval (no per-frame writes).
- **No-regression:** `lastActiveAt` / recency ordering unchanged by input/output/
  resume (guard the do-not-conflate invariant).

## Out of scope

- Differentiated key-vs-mouse-vs-text input signals (future, if a consumer appears).
- Feeding any new timestamp into recency ordering / NEEDS YOUR ATTENTION.
- Persisting other in-memory runtime state (shell-busy, agentState, etc.).
