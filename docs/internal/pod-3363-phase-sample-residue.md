# POD-3363 — the stale `session.phase` samples: leave them alone

**Decision: do not migrate.** The rows stay as they were written. What follows is
why, which readers were checked and how, what was confirmed against real data,
and the two tests that now pin the bound the decision rests on.

## What the residue is

POD-3331 gave `SessionActivityHistory` its own event kind,
`session.phase_sample`. Before that fix, from `a9245aa9e`
(2026-08-31 22:56 +0200) onward, the recorder appended its observational
samples to `podium_events` under `session.phase` — the notification service's
semantic transition log. Every real phase flip in that period therefore wrote
two rows, and the recorder additionally wrote a `prev`-undefined seed row that
the semantic log is designed never to contain.

**The window is not four days and it is not closed.** `a9245aa9e` is an
ancestor of `origin/main`; the POD-3331 fix (`c188e042e` / `4a5b39c94`,
2026-09-04 01:00) is not. It exists only on this epic's integration branch. So
every instance tracking `main` is still double-writing right now, and the window
closes when this epic lands — not before.

That reframing matters, because it means a migration would not be tidying up a
historical accident. It would be shipping, in the same release as the fix, a
rewrite of rows the release itself had been producing minutes earlier.

## Half (b): the semantic readers. Not fixable by a migration, at all.

The brief describes the steward and the superagent's turn watcher as "still
seeing two rows per real transition for that window". They saw them once, live.
They cannot see them again, and no migration can reach back and change what they
did with them.

The complete set of readers was derived, not guessed. Only three methods on
`EventsRepository` can return a `podium_events` row: `listEventsSince`,
`listKindSinceWithPrior`, `listKindSubjectSinceWithPrior`. Every production call
site of those three:

| Call site | Reads `session.phase`? | Bound |
|---|---|---|
| `steward.ts:511` | yes | persisted cursor, `resolveCursor()` |
| `modules/superagent/tools.ts:555` | yes, explicitly | `since = maxEventId()` at call time |
| `modules/issues/service/reads.ts:649` → `issues.events` API | yes, if a caller asks | caller-supplied cursor |
| `modules/superagent/service.ts:1633` | no — filtered to `issue.*` | — |
| `modules/messages/brakes.ts:137` | no — `message.spawned` / `agent.spawned` | — |
| `modules/messages/service.ts:1827` | no — `message.requeued` | — |
| `modules/sessions/concurrency-history.ts:157` | no — `fleet.agent_concurrency` | — |
| `modules/sessions/activity-history.ts:111` | no — `session.phase_sample` | 48h window + one prior |
| `modules/messages/characterization-support.ts:492` | test support, not production | — |

The steward's cursor is monotone and, crucially, *self-seeding forward*:
`resolveCursor()` returns the persisted value when present, and when the row is
absent (first enable) or corrupt it re-seeds to `maxEventId()` — deliberately,
so "weeks of stale events must never replay as fresh unblock comments/nudges".
There is no path that rewinds it. `lastPhaseBySession` and the trigger rules
both operate on `events`, the current poll's window, not on a historical query.
This is already pinned by `steward.test.ts` at lines 355, 420 and 966.

The superagent watcher takes `since = store.events.maxEventId()` *at call time*
and only ever reads forward of it. Its exposure to any pre-existing row is
identically zero, permanently.

So the duplicate-row harm was a live, write-time harm. It happened while the bad
build ran and it is unrecallable. **A re-key today buys the semantic readers
nothing.** Half (b) is not a reason to migrate; it is a reason the fix had to
ship, which it has.

The one reader that *can* still see the residue is `issues.events` — a raw
event-log query with caller-supplied kind and cursor. It has no semantics of its
own: it returns what the log contains. Someone reading it during that window
should see that the log was double-written, because it was. Re-keying the rows
to make that query look tidier is precisely the thing an event log must not do.

## Half (a): the waterfall. Real, transient, self-clearing, with a deadline.

This is the half with a genuine cost, and it is smaller than it first looks.

`SessionActivityHistory.history()` reads
`listKindSubjectSinceWithPrior(SESSION_PHASE_EVENT, sessionId, now - 48h)`. Two
properties bound it:

1. **Kind-scoped.** A residue row sitting under `session.phase` in the same
   window for the same session is simply not part of the answer.
2. **At most one row older than the window.** The carried-in "prior" row
   establishes the opening edge of a bar; everything else must be inside 48h.

On the client, `WATERFALL_MAX_WINDOW_MS` is also 48h and `clampViewport` pins
`start >= now - WATERFALL_MAX_WINDOW_MS * 1.05`. Zoom can widen the span to
`* 1.3`, but the clamp still applies afterwards. **The panel's absolute backward
reach is 50.4 hours.** No gesture reaches further.

So the actual cost of doing nothing is: *at the moment this epic ships, the
waterfall's segmented bars lose their trailing history and refill over the
following 48 hours.* During that time they degrade to the solid single-colour
bar — a state the module was explicitly designed to have
("No samples is a legal state ... and degrades to today's solid bar — absence of
evidence stays visually distinct from evidence of idling"). Nothing is lost,
nothing is wrong, one panel is less informative for two days.

Beyond 50.4 hours after the ship date, the residue is unreachable by this panel
by construction. The rows themselves are deleted by retention
(`EVENT_RETENTION_MAX_AGE_DAYS = 14`, `EVENT_RETENTION_MAX_ROWS = 50_000`) — on
a busy instance the row cap bites well before the age cap.

The one part that does not clear on the 48-hour clock is the carried-in prior
row, whose lookback is unbounded: a session whose newest sample is a residue row
never gets an opening edge. But that is by definition a session that has not
changed phase since the ship date, so the carried-in value and the solid bar
say the same thing. It clears on retention regardless.

## The predicate, checked against real rows

The brief's proposed discriminator was "sample = `{phase, from}` vs semantic =
`{phase, verdict, agentKind, cwd}`". Checked against real data, **the `verdict`
half of that is wrong**: `notify/service.ts` spreads `verdict` only when
`next.idle?.kind` is set, so plenty of genuine semantic rows have no `verdict`.
`agentKind` and `cwd` are unconditional, and the recorder's `from` is always
present (`from: known ?? null`) and never appears in a semantic payload.

Every reachable database on `flatblock` was scanned. **139 genuine
`session.phase` rows** across six instances:

```
predicate: json_type(payload,'$.from') IS NOT NULL   (key present, JSON null counts)

rows | matched | has agentKind | instance
  60 |       0 |            60 | podium-driver-followups-3134-3136
  74 |       0 |            74 | p2245-9a4799-r1
   2 |       0 |             2 | p3110-grok-paired-7ef8e42-r4
   1 |       0 |             1 | p3110-grok-paired-2ac84c5-r9
   1 |       0 |             1 | p3110-grok-paired-057755c-r3
   1 |       0 |             1 | p3152-grok-reply-0d180cc-r10
 139 |       0 |           139 | TOTAL
```

The safety half holds: **the predicate matches zero genuine semantic rows.** The
archaeology agrees — `notify/service.ts` has not changed its payload since
2026-08-24, comfortably outside the 14-day retention horizon, and
`activity-history.ts` has exactly two commits in its life, so within any
surviving window there are only two payload shapes and they are disjoint.

**The coverage half could not be checked, and that is the decisive fact.** A
box-wide scan found *zero* rows of either kind written after `a9245aa9e` — no
residue rows, and no `session.phase_sample` rows either. Every instance on this
machine is a short-lived test rig running an older build. This node is
daemon-only; its server is on another host that this session has no shell
access to. **There is no residue row anywhere I can reach.**

## The trade, stated plainly

Migrating buys: one UI panel keeps up to 48 hours of segment shading across a
single upgrade, instead of refilling over the 48 hours after it.

Migrating costs: an irreversible rewrite of rows in the append-only event log,
shipped to every self-hosted install, driven by a predicate whose target rows
have never been observed — only inferred from source. It also erases the record
that the double-write happened, from the one query surface (`issues.events`)
that can still honestly report it. And it cannot help half (b) at all.

That is not a close call. **Do nothing.**

Two further notes. If the operator disagrees and wants the migration, it is a
data migration on `podium_events` and Stage A of this epic reserves migrations
to the coordinator — it would not be mine to write in any case. And it should
then be validated against the server host's actual rows, not this box's.

## The tests that pin the bound

Two properties carry the argument, and neither was pinned before.

**`apps/server/src/event-log.test.ts`** — "scopes the per-subject window to one
kind and carries in at most one prior row". Asserted against the real SQL, not
the module's test fake, because the fake implements the kind filter itself and
so could not have proved anything about the query. Seeds two pre-window sample
rows, one in-window residue row under `session.phase`, one in-window sample, and
a same-window row for a different session; expects exactly the newest prior plus
the in-window sample.

**`apps/web/src/app/flight-deck-waterfall.test.ts`** — "cannot be flown further
back than the window and its margin". Pans a month backwards, zooms all the way
out and pans again; both land exactly on `now - WATERFALL_MAX_WINDOW_MS * 1.05`.

Both were mutation-checked, and each mutation was read for its reason code
rather than merely for a red:

| Mutation | Result |
|---|---|
| `listKindSubjectSinceWithPrior` in-window query also matches `session.phase` | killed — `expected [ …(3) ] to deeply equal [ …(2) ]` (the residue row leaked in) |
| prior lookup `LIMIT 1` → `LIMIT 5`, `.get` → `.all` | killed — `expected [ …(3) ] to deeply equal [ …(2) ]` (the second, older prior leaked in) |
| `clampViewport` floor `* 1.05` → `* 10` | killed — `expected 1786449600000 to be 1787996160000` |

## Commands run

```
# reader derivation
grep -rn "listEventsSince(\|listKindSinceWithPrior(\|listKindSubjectSinceWithPrior(" \
  --include=*.ts apps packages services | grep -v node_modules | grep -v "\.test\.ts"

# box-wide scan for residue (0 hits) and for genuine semantic rows (139)
find / -name podium.db ... | sqlite3 "file:$f?mode=ro&immutable=1" \
  "SELECT COUNT(*), SUM(CASE WHEN json_type(payload,'$.from') IS NOT NULL THEN 1 ELSE 0 END), ..."

# focused lanes
apps/server: bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/event-log.test.ts
             -> Test Files 1 passed (1) | Tests 33 passed (33)
apps/web:    bun --bun vitest --config vitest.config.ts run src/app/flight-deck-waterfall.test.ts
             -> Tests 1 failed | 18 passed (19)   [the failure is pre-existing — see below]
```

`PODIUM_TEST_WORKERS` was **not** set for either run.

## One thing found on the way

`flight-deck-waterfall.test.ts > waterfall viewport > parks a completed crew on
its latest work instead of an empty present-day gap` fails on this branch:
`expected 74.10962364229079 to be greater than 85`. It is not mine — the control
run without my test is 17 passed / 1 failed, and both
`flight-deck-waterfall.ts` and its test file are byte-identical to
`origin/main`, so it is red on `main` too. Filed separately.
