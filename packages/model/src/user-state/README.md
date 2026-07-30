# `user-state/` — the per-user state family (POD-1076)

State keyed `(userId, entityId)` — `readAt` ×3, snooze, tuck-away, pins ×2, tab order,
sidebar/tab layout, personal preferences (`docs/multi-user-readiness.md` §3.3, ADR 4 Amendment 1
D10, ADR 9 D3 rule 4). Never shared, never grantable, and `single-writer` because the user is in
the key.

| File | What is in it |
|---|---|
| `session-state.ts` | `SessionReadState`, `SessionSnoozeState`, `PinState`, `TabOrderState`, and `SessionUserOverlay` — the projection-time argument |
| `issue-state.ts` | `IssueUserState` (read + tuck + pin, one key), `IssueMessageReadState`, and `IssueUserOverlay` |
| `family.ts` | `PER_USER_STATE_FAMILY` (the totality list) and `PER_USER_STATE_NON_MEMBERS` (the §7.1 facts with no server row, each with its reason) |

## The rule this family exists to enforce

**A per-user value is never a field on a shared entity's row, and never a field on its broadcast
projection.** A value that differs per reader cannot be a field of a shape sent to many readers.

That rule is what the ratchet counts. Before POD-1076, `snoozes` was already keyed
`(user_id, session_id)` and the live `Session` still carried a `snoozedUntil` mirror field for the
unscoped broadcast to read — which is an instance-wide singleton however per-user the table behind
it is. Re-keying the table is half the move; deleting the mirror is the other half.

## How the projection gets a viewer without waiting on POD-1077

`toMeta()` / `toWire()` take an OVERLAY argument (`SessionUserOverlay`, `IssueUserOverlay`)
assembled for one user. The feed is still unscoped (ADR 2 D2), so today every broadcast site
supplies `FIRST_ADMIN_USER_ID`'s overlay. POD-1077's scoped feed replaces that constant with the
real principal — a change the type system now demands an argument for, instead of one that
requires finding a mirror field nobody remembers is there.
