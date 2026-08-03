# POD-785 — why the client outbox grew without bound

**Branch** `issue/785-bug-outbox-grows-unbounded-past-the-loca` · **base** `b82fa157`

## The short version

The ticket asked for a size cap. A size cap would have been the wrong fix, and a
dangerous one: a threshold that discards queued writes converts work a person did
into silent loss, which is exactly what ADR 3 D9 invariant 1 and D10 both refuse.

The queue did not grow because it lacked a limit. It grew because **it stopped
draining and then never stopped accepting**.

Every client write went into a single ordering partition, `client-outbox`. ADR 3
D12 stops a partition at its first unresolved entry — that is what makes FIFO
mean anything — so **one** dead-lettered write (a rename refused after a share was
revoked, say) wedged **the entire queue, permanently**. Behind it the app kept
doing what apps do: queueing a read receipt every time you opened an issue.

That is why `markIssueRead` was named as the trigger in the 2026-07-17 report. It
was not the cause. It was the highest-frequency write in the app, and so it was
the one holding the bag when the store finally refused.

## Measured, not asserted

`measure-outbox-growth.ts` drives the real kernel `Outbox`, not a model of it.
Full output in `measurement-output.txt`.

| | |
|---|---|
| 500 read receipts behind 1 parked entry, after 3 drains | **0 delivered, 500 pending** |
| same workload, per-target partitions | **all delivered**; only the revoked session stuck |
| cost of one read receipt | **361 B** |
| read receipts to fill the old 5 MB localStorage ceiling | **~14,500** — reachable in normal use once nothing drains |
| share of a wedged read-heavy queue that is superseded | **93.3%** (840 of 900) |
| tombstones leaked by 25 edits of one failing write | **25 rows / 11.4 KB**, unreachable by any surface |

One note on method: the first draft of section A reported *no wedge*. The
envelope's `command` is a string, the script read `.command.name` off it, got
`undefined`, matched nothing and answered `applied` to everything — an instrument
that could not say NO. It now asserts its own precondition before reporting.

## What changed

**1. Writes are routed by their target.** `OUTBOX_ROUTING` in
`packages/client-core/src/engine/wiring.ts` gives each queued kind a partition
derived from the row it lands on — `issue:POD-1`, `session:s-7`, `tabs:<worktree>`.
A refusal now contains itself. Writes to the *same* row still share a partition,
so their order is preserved (this is what the legacy `chained` flag tracked).

The single-partition choice was inherited from the legacy *import* path, where it
is argued in a comment as "over-serialised and correct" — true for a one-shot
drain of a handful of entries, and false for the app's steady-state queue. A
correct local decision copied into a context where its premise did not hold.

**2. Superseded writes collapse.** A command may declare a `collapseKey` naming
the *state cell* it sets. When a later queued write to that cell arrives, the
earlier one is removed under a new `superseded` removal licence. This bounds the
redundant class by the size of the user's **working set** instead of by time spent
offline — and it works even when genuinely offline, where partitioning cannot help
because nothing drains at all.

`superseded` is not a third exception to D9 invariant 1; it is the invariant's
user-action arm. The act that ends the entry is the user's own next click on the
same cell, and the intent survives in a record that is still in the queue and
still drains. It is guarded on four conditions, all checked in the one place that
issues the licence: the contract opted in, **both** entries are `queued`, same
partition, same principal.

**3. Nothing content-bearing can be reached.** Two classes declare no collapse key
and therefore cannot be collapsed at all:

- **content-bearing** — `sessions.resumeAndSend` puts text into a live PTY. Two
  sends are two sends; ADR 3 D11 names this as why "idempotent-ish" is not a
  property we may lean on.
- **partial patches** — `layout.set`, `layout.clear`, `settings.updatePersonal`
  carry only the keys they touch, so a later patch does *not* subsume an earlier
  one. Collapsing them would silently drop the fields only the first one set.

Where two commands write the *same* cell they share a key on purpose:
`markRead`/`markUnread` on an issue, `snoozeSet`/`snoozeClear` on a session. The
newest wins, which is what the user's last click meant.

**4. The tombstone leak is plugged.** `reissue()` now removes the row it cancels,
in the same transaction. It was writing it back as a permanent `cancelled` record;
nothing ever removed it, because `purgeCancelled` has exactly one caller — the
user's discard button.

## Dead letters: deliberately still unbounded

Dead letters accumulate only by user inaction, and they are the one thing here
that *is* user-authored work awaiting a decision. Pruning them on a timer would be
the silent loss this whole change exists to avoid, so nothing here touches them.
The honest bound on that set is user attention, and POD-1231 already made the
pressure legible. Left as measured, not silently capped.

## Proof the tests can say NO

Removing the opt-in guard in `collapseInto` so collapse keys off the partition
alone — which drops content-bearing writes — turns exactly one named test red:

```
capacity.test.ts > collapse never reaches work that is not redundant
  > "NEVER collapses a command that declares no collapse key"
```

Reverted from an md5-verified snapshot (`55bc120f…`), mutant marker absent
(`grep` rc=1), suite re-green.
