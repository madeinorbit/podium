# Session Snooze — Design

**Date:** 2026-06-19
**Branch:** `worktree-feat+session-snooze`
**Status:** approved (brainstorming), pending spec review

## Problem

A session that "NEEDS YOUR ATTENTION" (the agent is blocked on the user, errored, or
idle with pending work) is surfaced at the top of the sidebar. Sometimes the user has
seen it but does not want to act on it *now*. Today the only ways to get it out of the
way are to act on it or pin it — neither of which says "remind me later."

We want a **snooze**: a way to temporarily move a session out of the attention surface
without changing its agent state, and have it return to the normal attention flow later.

## Goals

- A snooze control next to the pin, in the **NEEDS YOUR ATTENTION** rows, in the
  **worktree-list** rows (permanently visible), and in the **full session view**
  toolbar (when the session is in an attention state).
- **Direct click** → snooze *until next message*.
- **Hover** → "Snooze for" submenu: **1h**, **Until tomorrow** (next 5am local),
  **Until next message**. When already snoozed, also offer **Un-snooze**.
- Snoozing is **orthogonal to agent state** — it never mutates `agentState.phase`. It is
  a separate, persisted flag.

## Effect of an (effective) snooze

1. The session is **excluded** from the top **NEEDS YOUR ATTENTION** group in the sidebar.
2. Within its worktree's session list, it **sinks to the bottom** (below non-snoozed
   attention rows).
3. The snooze control renders in its "snoozed" (highlighted) state, with a tooltip
   describing the wake condition/time.

Snooze is allowed on *any* session, but only *manifests* when the session would
otherwise be in the attention group. (Snoozing a `working` session is harmless; it will
already be cleared, see Clear triggers, by the time it could matter.)

## Data model & persistence

Mirrors the existing `pins` table pattern in `apps/server/src/store.ts`.

New table:

```sql
CREATE TABLE IF NOT EXISTS snoozes (
  session_id    TEXT PRIMARY KEY,
  snoozed_until TEXT,            -- ISO 8601, or NULL = "until next message"
  created_at    TEXT NOT NULL
)
```

Interpretation:

| Row state                         | Meaning                                                    |
|-----------------------------------|-----------------------------------------------------------|
| no row                            | not snoozed                                               |
| row, `snoozed_until = NULL`       | snoozed **until next message** (indefinite)               |
| row, `snoozed_until = <ISO>`      | snoozed **until that time** — also cleared early (msg)    |

Persisting in SQLite means a 1h / tomorrow snooze survives a server redeploy, matching
how pins behave.

### Protocol

Add to `SessionMeta` (`packages/protocol/src/messages.ts`):

```ts
// Snooze state. `undefined` = not snoozed; `null` = snoozed until next message;
// ISO string = snoozed until that time (or next message, whichever first).
snoozedUntil: z.string().nullable().optional(),
```

The server populates `snoozedUntil` on each `SessionMeta` from the `snoozes` table when
it builds the wire view (the same place pins/workState are joined in).

## "Effectively snoozed" (render-time)

A session is *effectively snoozed right now* when:

```ts
snoozedUntil !== undefined && (snoozedUntil === null || Date.now() < Date.parse(snoozedUntil))
```

This is computed in the web layer (a small `isSnoozed(session, now)` helper in
`derive.ts`). The store keeps a `now` value that ticks every 60s so a lapsed timed
snooze re-surfaces without any server round-trip. The server additionally deletes
expired rows lazily when it lists snoozes (housekeeping; not relied on for correctness).

## Clear triggers ("normal state flow again")

A snooze row is **deleted** (server-side) on either of:

1. **Submit** — the user submits a prompt to the session. Hook the two explicit
   chat-submit registry paths: `registry.sendText` and `registry.resumeAndSend`. Mere
   typing / raw keystrokes do **not** clear it; only a submitted message does. (For
   terminal sessions, submitting a prompt flips the agent to `working`, which trigger 2
   catches.)
2. **Agent leaves attention** — in the `agentState` handler (`relay.ts`, beside
   `notifyAttention(session, prev, state)`), when the phase transition moves the session
   **out of** the `needsYou` attention group (e.g. `needs_user` → `working`), clear it.

Both express "the user/agent has moved on." Timed snoozes additionally lapse by clock
(handled at render time + lazy server cleanup).

A snooze `set` to a new value (or to un-snooze) is an explicit user action via the
router and replaces/removes the row directly.

## Filtering & ordering (web `derive.ts`)

- `partitionWorkItems(sessions, pinnedSessionIds, now)`: an effectively-snoozed session
  is **not** pushed into the `attention` array. It is otherwise unchanged (still appears
  under its worktree). Pinned-panel and working partitioning is unaffected.
- Worktree session ordering (`sortSessionsForSidebar` / whatever feeds
  `WorktreeNavView.sessions`): add a tie-break so effectively-snoozed attention sessions
  sort **after** non-snoozed ones within the same group. Working sessions already sink to
  the bottom; snoozed-attention sits just above working (still visible, de-emphasised),
  i.e. ordering becomes: non-snoozed attention → snoozed attention → working.

`now` threads in from the store tick so ordering/partitioning re-evaluate on lapse.

## Server wiring

New tRPC router `snoozes` (mirrors `pins`) in `apps/server/src/router.ts`. Two explicit
operations so "snooze until next message" (`until: null`) is never confused with
"un-snooze":

```ts
snoozes: t.router({
  list: t.procedure.query(({ ctx }) => ctx.registry.listSnoozes()),
  // Snooze. until === null => "until next message"; ISO string => timed.
  set: t.procedure
    .input(z.object({ sessionId: z.string(), until: z.string().nullable() }))
    .mutation(({ ctx, input }) => { ctx.registry.setSnooze(input); return ctx.registry.listSnoozes() }),
  // Un-snooze (delete the row).
  clear: t.procedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ ctx, input }) => { ctx.registry.clearSnooze(input.sessionId); return ctx.registry.listSnoozes() }),
})
```

`registry`/`relay` gain `listSnoozes()`, `setSnooze({sessionId, until})`, and
`clearSnooze(sessionId)`, backed by `store` methods (`listSnoozes`, `setSnooze`,
`clearSnooze`) following the `listPins`/`setPin` shape. The internal trigger-2 path
(agent leaves attention) and trigger-1 path (`sendText`/`resumeAndSend`) call
`clearSnooze` directly. Setting/clearing a snooze re-broadcasts the affected session so
`snoozedUntil` propagates to clients (reuse the existing `broadcastSessions()` /
per-session update path).

The web store gains `setSnooze(sessionId, until)` and `clearSnooze(sessionId)` actions
with optimistic update + refetch, mirroring `setPinned`.

## UI

### `SnoozeButton` (new, in `Sidebar.tsx`, next to `Pin` in `PanelRow`)

- Icon: lucide `AlarmClock` / `BellOff` / `Clock` (pick one that reads as snooze;
  `AlarmClock` preferred). Permanently visible, same sizing as the pin button.
- Highlighted (`text-primary`) when effectively snoozed; muted otherwise. Tooltip:
  "Snooze" when not snoozed; "Snoozed until <when> — click to un-snooze" when snoozed.
- **Direct click**:
  - not snoozed → snooze **until next message** (`setSnooze(id, null)`).
  - snoozed → **un-snooze** (`clearSnooze(id)`).
- **Hover** → `dropdown-menu` (already in `components/ui/dropdown-menu.tsx`) opened on
  hover, "Snooze for": **1h**, **Until tomorrow**, **Until next message**, plus
  **Un-snooze** when snoozed. Time math:
  - 1h → `now + 3_600_000`.
  - Until tomorrow → next **05:00 local** (today 5am if currently before it, else
    tomorrow 5am).

Placement: between the existing Pin button and the hover-revealed close (X) in
`PanelRow`. Used by both the top WORK ITEMS rows and the worktree-list rows, so it is
permanently visible in the worktree list as required.

### Full session view (`AgentPanel.tsx` toolbar)

Add the same snooze affordance to the panel toolbar, shown when the session is in (or
effectively in) an attention state. Reuses the same `setSnooze` store action + a shared
snooze-menu component so behaviour matches the sidebar.

## Edge cases

- **Lapse while looking at it:** the 60s store tick re-evaluates; a lapsed timed snooze
  re-enters attention on the next tick. Acceptable latency for this feature.
- **Snooze a non-attention session:** allowed; no visible effect until/unless it would
  enter attention, and it is likely cleared first by trigger 2. We do not special-case
  it.
- **Session ends / archived:** snooze row may linger; harmless (filtered out with the
  session). Optionally cleaned when the session is removed (low priority).
- **`null` vs `undefined` on the wire:** `undefined`/absent = not snoozed; explicit
  `null` = until-next-message. Keep the distinction intact through zod + serialization.

## Testing

- `derive.ts`: unit tests for `isSnoozed(now)`, `partitionWorkItems` excluding snoozed
  from attention, and worktree ordering (non-snoozed → snoozed → working).
- `store.ts`: snooze CRUD + lazy expiry cleanup.
- Clear-trigger logic: a focused test that `sendText`/`resumeAndSend` clear the row, and
  that a `needs_user → working` transition clears it while `working → needs_user` does
  not.
- The existing brittle `shell.structure.test.ts` has 4 pre-existing failures on this
  baseline (unrelated tab/menu/conn-indicator string assertions); do not regress the
  sidebar one further.

## Out of scope

- Snooze for repos/worktrees (only per-session/panel).
- A global "snoozed" list view or bulk un-snooze.
- Notifications when a snooze lapses.
