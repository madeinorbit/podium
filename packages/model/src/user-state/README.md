# `user-state/` — reserved (POD-1076)

The per-user state family, keyed `(userId, entityId)` — `readAt`, snooze, pins, tab order,
sidebar/tab layout, personal preferences (`docs/multi-user-readiness.md` §3.3, and §3.1.1's
"per-user state: never shared, one row per user").

Once keyed per user these fields stop being multi-writer at all: each user writes their own row,
`single-writer` applies, and ADR 1 D3's field-LWW carve-out shrinks toward empty.

Empty today by design. POD-299 reserved the home AND settled the clock representation
(`../clock.ts`), so moving `snoozedUntil` here is a **re-key** of the row the snooze predicates
read — not a change to what they compute or to what the wire carries.
