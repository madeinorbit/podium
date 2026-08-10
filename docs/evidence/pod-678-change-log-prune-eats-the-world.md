# POD-678 — the change-log prune was eating the installed world

**Symptom.** `POD-N` references in terminals and chat rendered as *unknown* — the
brand-yellow fallback accent — for issues that plainly still exist. Roughly
anything not written in the last day.

**Measured on the live install, 2026-08-10.**

## 1. The log is a window, and the window is ~27 hours

| fact | value |
| --- | --- |
| rows in `changes` | 20 002 (`CHANGE_KEEP_ROWS` = 20 000) |
| oldest retained `event_time` | 2026-08-09T06:11 |
| newest retained `event_time` | 2026-08-10T09:50 |
| span | ~27h |

The **row** budget bites long before `CHANGE_MAX_AGE_MS` (3 days) ever does, so
the age budget is not what is in force here.

## 2. Most of the world had no row left

```sql
SELECT COUNT(*) FROM issues i
 WHERE i.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM changes c
                    WHERE c.entity = 'issue' AND c.entity_id = i.id);
```

**567 of 631** non-deleted issues had **zero** retained change rows. Only 64 had
any. Same story for `issueProjection` (46 distinct ids retained) and `issueDep`
(16).

## 3. Which is exactly what a connecting client got

A probe client attached to the live server over `ws://…/client`, wire v2, and
read its `feedBootstrap` frame:

```
feedBootstrap seq=357915 minAvailableSeq=337909 changes=231
by entity: { conversation: 46, issueDep: 16, issue: 66, issueProjection: 45,
             userReadPosition: 1, session: 53, userLayout: 4 }
issue seqs delivered: 15,16,21,92,349,411,412,413,426,427,429,431,432,475,476,
  494,496,559,563,564,565,566,571,583,592,596,605,614,617,618,619,621,624,626,
  630,633,636,641,651…679
```

**66 issues out of 631.** `POD-561`, `POD-612` and `POD-623` are not in that
list, and neither is anything below `POD-559` except a handful. The client's
`useReplicaIssues()` is fed from this frame, so `resolveIssueReference` finds no
row and returns `availability: 'unavailable'` — the unknown-reference paint.

## 4. Why: the world was a fold over the pruned table

`Authority.bootstrap` → `store.latestChangeStates()`, which was
`SELECT … FROM changes` grouped to the max seq per (entity, id). The port
docstring argued the read "is defined per (entity, id) over the whole table
precisely so it survives" pruning — but the whole table is what retention
deletes from. A restart hid it: the issues boot reconcile re-stages every issue
whose baseline aged out, so the world came back for about a day and then
decayed again.

## 5. The fix

`change_latest` — the latest **live** upsert per (entity, id) — written by
`SyncRepository.appendChanges` inside the same transaction that appends the
change, deleted on `remove`, and never touched by `pruneChangeBatch`. The row
budget now bounds only what `changesSince` can serve. Size is O(live entities):
**4.0 MB** across 2 294 rows on this install.

## 6. Verification, on real data, with the log deliberately destroyed

A server on a `VACUUM INTO` copy of the live database, migrated, booted once to
populate the world, then:

```
DELETE FROM changes;   -- 22 156 rows -> 0
```

…restarted, and probed again:

```
feedBootstrap seq=361094 changes=2289
by entity: { issue: 665, issueProjection: 665, issueDep: 407, session: 501,
             conversation: 45, userLayout: 4, userReadPosition: 1, repo: 1 }
issue seqs delivered: 1,2,3,4,5,6,7,9,11,…,681      (all of them)
changes rows after boot: 0
```

All 665 issues delivered — `POD-561`, `POD-612` and `POD-623` among them — with
**zero rows in the change log**. The trailing `changes rows after boot: 0` is
the load-bearing half: nothing was re-reconciled to produce that world, so it
came from `change_latest` and nowhere else.
