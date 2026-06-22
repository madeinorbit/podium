# Conversation identity — stop duplicate sessions, fix lost drafts/pins, fix grok mis-bind

## Problem (diagnosed 2026-06-22)
A single underlying agent conversation can get MULTIPLE Podium session rows (each = its own
abduco master = its own process). `dedupeSessionsByResume` masks them but is **archived-blind**
and **tie-unstable** (winner = broadcast order on equal `lastActiveAt`), so the visible row
flips on every daemon restart → sessions vanish, pins orphan, native-view drafts get swapped out.
Root cause: **row id (sessionId) is used as conversation identity**, and recency/mtime is used as
binding identity.

## Chosen model (user decision): stable `conversation_id`
- The `sessions` table already has an UNUSED `conversation_id` column — use it.
- **Conversation** = stable id, owns conversation-scoped state (drafts, panel-pins, snoozes,
  tab_order, btw threads).
- **Row/process** = transient, owns process state only (PTY/durable_label/agentState/resume-ref).
- After this, `dedupeSessionsByResume` is **not needed for correctness** (no dupes to dedup) —
  delete it as the mechanism; at most keep a deterministic, pin/archived-aware stub as DEFENSE.

## Plan (TDD, each slice independently testable)

### Slice 0 — grok prod fix (ship first; isolated, actively biting prod) [task #5]
`chooseGrokSessionDir` (`packages/agent-bridge/src/agent-state/grok-binding.ts`): on reattach
`watermarkMs=0` + mtimes bumped to ~now → order-dependent tie → two unbound grok sessions grab
the SAME dir → identical resume_value → collision.
- Pass + reuse the row's bound grok id (boundId from `resume_value`) on reattach.
- Exclude grok dirs already claimed by ANOTHER live session from candidates (daemon tracks
  claimed grok ids) — a dir is bound by at most one session.
- An already-spawned session that can't resolve its dir stays UNBOUND rather than stealing the
  globally-freshest dir. Add test: two concurrent unbound reattaches must not converge.

### Slice 1 — conversation_id foundation [task #1]
- Schema v4→v5: backfill `conversation_id` (group live rows by `(machine_id,resume_kind,
  resume_value)`; rows without a resume ref get their own id).
- Mint conversation_id at row creation; never changes when the row's resume-ref is rebound.

### Slice 2 — one live row per conversation [task #2]
- resume/createSession: reattach/focus the existing row for the conversation instead of spawning.
- rebind (`relay.ts:1241`): merge into canonical row, don't create a collision.
- Partial-unique index `(machine_id, resume_kind, resume_value)` as a backstop.

### Slice 3 — re-key conversation state [task #3]
- drafts, pins(panel), snoozes, tab_order, btw threads → keyed by `conversation_id`. Migrate.
- Drafts also flush on blur/unmount (web) so an in-flight draft survives a row swap.

### Slice 4 — retire dedup [task #4]
- Delete `dedupeSessionsByResume` as the load-bearing path (`derive.ts:458`, `store.tsx:496`).
  Optional deterministic+pin+archived-aware stub for defense only. Update derive-sidebar tests.

## Constraints
- Backend runs from the live `main` checkout — build/verify ONLY in this worktree; never break main.
- Web tests need the `apps/web` happy-dom config; never vitest-alias `@podium/core`.
- Dispatch any subagents on opus.
