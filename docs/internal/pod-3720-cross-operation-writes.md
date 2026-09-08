# POD-3720 — concurrent whole-state drafts

Reachable. Two successful `write()` calls on one session, each mutating a
different field, lose the first field. Named test:

`keeps both fields when two write() calls overlap on one session`

A's `name` came back `''`. POD-3717 made each caller await its own persist;
it does not stop two awaits from interleaving. POD-3330's drafts stop one
writer persisting another's *uncommitted* fields; they do not stop a later
*committed* whole-state snapshot from restoring fields it never changed.

## Options

1. **Per-session write lease.** Queue cut+mutate+persist per session. Sibling
   `write()` recuts after the previous install. Nested writes from inside a
   commit hook must re-enter (ALS) or they deadlock. A `persistDraft` of an
   already-cut draft still clobbers: the lease serialises persist, not the cut.

2. **Version-checked refuse.** Stale draft throws; caller retries. Every writer
   needs a retry loop. A dropped retry is a lost write by another name.

3. **Narrow draft.** Each writer carries only what it changed. Touches every
   persistDraft-direct site. Highest cost, same merge semantics as (1)+(overlay).

## Recommendation (implemented)

Lease on `write` / `persist` / `persistDraft` (ALS-reentrant) plus a shallow
origin overlay at persist time. `write()` recuts inside the turn. An already-cut
`persistDraft` overlays only the fields that differ from its origin onto live
state after the previous sibling has installed.

Same-field concurrent writes remain last-persist-wins.

Mutation on the final base:

- drop the `write()` lease → `keeps both fields when two write() calls overlap on one session` red (`name` is `''`)
- skip the overlay → `keeps both fields when two persistDrafts overlap on already-cut drafts` red (`name` is `''`)
