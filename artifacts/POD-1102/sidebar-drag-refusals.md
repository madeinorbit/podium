# A quarter of the sidebar could not be dragged — POD-1102

## What you saw

Two symptoms, one cause. Dropping a row sometimes threw an error popup, and the
row jumped back to where it started. Both are the same refused write.

The drop is optimistic: the row paints in its new slot the moment you release,
off a queued `issues.update`. When the server refuses that write definitively,
the queue drops the overlay and toasts. So the row lands, then goes home, under
an error — which from the outside reads as "the drag jumps back and forth".

It is not new with the redesign. It has been getting worse, one issue at a time,
since this repo was young.

## Why

Manual order is a fractional key per row: `sortKey`, compared lexicographically,
ascending. A reorder writes one key — the midpoint of the row's new neighbours —
and nothing is renumbered. That part works.

The problem is the other writer. **Every create mints a key strictly ABOVE its
scope's current minimum**, because "new work appears at the top" is what the
sidebar means by manual order. A scope that only ever gains rows at the head
therefore drives its own minimum steadily toward zero:

| creates in one scope | shortest key |
| --- | --- |
| 5 | `1` |
| 50 | `0000000001` |
| 400 | 80 chars |
| 641 | **129 chars** |
| 800 | 160 chars |

One character longer every five creates, without bound. This instance's
top-level scope for `podium` holds 918 rows; its shortest key is **163
characters**, and 83 live rows carry keys already over 128.

128 is where `issues.update` caps `sortKey`. And that is the whole trap: the
create that grows the key mints **server-side, inside the service, where no
schema is checked**, while the drag is the one path that has to send a key back
over the wire. The growth is completely silent right up to the moment reordering
stops working.

Replaying the sidebar's own drop plan against this instance's live keys:

```
scope: 918 rows, 776 keyed
BEFORE: 195 of 777 drop positions are refused by the wire
        longest key 163 chars
```

**A quarter of the column.** Not evenly spread either — the long keys belong to
the newest issues, which sit at the top, which is where you drag.

## The fix

Bound the other side. A scope whose minimum has grown long takes fresh,
evenly-spread keys **in the order it already renders** — three characters is
enough for a thousand rows, with a gap between every pair so ordinary reorders
keep landing on the fast path.

**Compaction belongs to `create`, and only to `create`.** Only a create makes
keys longer, so only a create has to shorten them — a drag re-keys one row
between two neighbours and cannot move the scope's minimum at all.

It was wired into the reorder too at first, so a repo that had stopped creating
would still repair itself the next time somebody dragged. Measured on this
workspace, that cost the drop **2.5 seconds** — a repair the operator waits out
mid-gesture, on a board whose drags already worked. It came out. A repo that
never creates keeps its long keys, which is a storage wart nobody can see.

Compaction is organizational, like the reorder it protects: it does not touch
`updatedAt`, so a scope repair cannot mark a repo unread. And it writes through
**one** commit for the whole scope. Row by row it took eight seconds; batching
the writes and the wire projections brought the same 922-row repair to ~2.2s, on
the create, once per ~320 creates.

### The cap had to move, and the reason is the interesting part

A 128-character ceiling on `sortKey` sounds like the thing that *stops* this. It
is the thing that *hid* it. The writer doing the growing is `mintSortKey`, which
runs server-side inside the service and never meets the schema; the only party
the ceiling could refuse was the drag, whose key is well-formed and correctly
ordered and merely inherited the scope's history.

Run against a snapshot of this workspace, that showed up immediately:

```
issues.update -> HTTP 400 {"code":"too_big","maximum":128, …}
row landed at index 8 (0 = top of the group)   ← it did not move
```

So the ceiling is now an anti-abuse bound (1024), far above anything the system
produces once compaction is doing its job, and `SORT_KEY_COMPACT_LEN` is what
actually bounds growth.

### And pinned rows share the key space

The second thing only the live run could find. Compaction first borrowed the
scope the *mint* measures — and the mint deliberately skips pinned rows, since a
pinned row is not in the list new work appears at the top of. Renumbering that
narrower set left four pinned rows holding 105-character keys in a scope where
916 others had dropped to three, and leading zeros sort first, so those four
jumped to the top of a list they were nowhere near:

```
105 pinned=true | Apple signing and TestFlight
105 pinned=true | First-run onboarding overhaul
105 pinned=true | Optimistic sidebar mutations
117 pinned=true | QR server pairing on mobile
```

Pin/unpin leaves `sortKey` untouched *precisely* so unpinning returns a row to
its old position, which only holds while pinned and unpinned rows are comparable.
So the two callers now ask different questions of the same scope: the mint
measures the unpinned rows, compaction renumbers the union. A total order
restricted to a subset preserves that subset's order, so both the pinned
section's internal order and the list's survive.

## What it does now

The whole sequence, against a from-source instance running on a snapshot of this
workspace's live database — 779 keyed rows in the `podium` top-level space, top
key 163 characters:

```
DROP "Node usage in Podium" at the top of its group
  planReorderKeys -> 1 patch, key length 164
  issues.update -> HTTP 200 in 104ms         (was: HTTP 400, row did not move)
  row landed at index 0 (asked for 0)
  previously-keyed rows in exactly the order dropped: true

NEXT CREATE in the repo -> HTTP 200 in 2050ms
  922 rows | top key 3 chars | longest 3 chars
  the dropped row is still where it was dropped: true

NEXT DRAG on the repaired space
  issues.update -> HTTP 200 in 43ms
  row landed at index 3 (asked for 3)
  whole column in exactly the order dropped: true
```

The 2-second create is the whole repair, once, and then once per ~320 creates
after that. It is the one place this change is expensive, and it is a deliberate
trade: the alternative put those two seconds on the drag.

```
```

## Two smaller things feeding the same write

The drop reads the scope's new order straight back out of the DOM, off
`data-drag-key`. So whatever carries a grip is also whatever counts as a
neighbour — one predicate, two jobs — and two rows belonged in neither.

- **An exiting row** kept its drag key for the length of its leave animation. A
  drop in that window planned a `sortKey` write against work that had already
  gone (archived, closed, moved band), and minted the moved row's key against a
  neighbour you can no longer point at.
- **A filtered column is not the scope.** Under a query the DOM holds a *sample*
  of the siblings; every hidden row between the visible ones is invisible to the
  plan, and the backfill path would renumber the sample and scatter the rest.
  Manual order is a claim about a whole scope, so the grip is only offered over
  one.

## Still open

Two things are worth naming, neither of them this change:

- **Returned-from-defer rows outrank `sortKey` inside a group.**
  `unifiedRowBand` floats them to the top of their band, so dropping an ordinary
  row above one will not stick no matter what key it gets. That is a product
  question about what a band means, not a bug in the key.
- **The drag preview and Motion's layout projection both write `style.transform`
  on the same row elements.** Nothing coordinates them: if the row set changes
  mid-gesture the projection re-measures and overwrites the preview. It was not
  needed to explain what you saw, and it has not been reproduced — but it is a
  real overlap sitting under the gesture.
