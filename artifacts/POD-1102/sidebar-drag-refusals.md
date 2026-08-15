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

The same scope, replayed after compaction:

```
AFTER : 0 of 777 drop positions are refused by the wire
        longest key 3 chars
order preserved: true
```

Compaction runs in two places, so no scope can be stranded:

- **on create**, in `mintSortKey`, which covers any repo that keeps making work;
- **when a reorder lands**, so a repo that has stopped creating still repairs
  itself the first time someone drags — checked *after* the patch is applied,
  never before, since the client planned its key against the keys the scope had
  a moment ago.

It is organizational, like the reorder it protects: it does not touch
`updatedAt`, so a scope repair cannot mark a repo unread. And the 128 is an
imported constant now rather than a literal that the only other holder of the
number never knew about.

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
