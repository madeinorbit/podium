# Should "none of these" survive an offline gap? (POD-1110)

One product call, stated so it can be answered without reading the diff.

## The decision

**Add `sessions.dismissOffer` to the set of writes that queue offline.** The set
goes from eight session writes to nine; the issue half (twelve) and the
per-user half (five) are untouched.

The code is written and green. Nothing about it is subtle enough to need
staging — the question is whether the set should grow, which the coverage
oracle says is a product decision that must be taken deliberately and recorded
in its header, not made in passing by whoever adds a kind.

## What is broken today

Dismissing an agent offer is the only row edit in the app that fails outright
when the connection is down.

Every other click of that shape — rename, archive, snooze, close, colour, stage,
labels, delete and its undo — is queued and sent when the connection returns.
Dismiss is not. Both hosts (chat and the native dock) hide the bar immediately
and then put it back on rejection, so offline the offer visibly pops back a beat
later carrying "Could not dismiss this offer". The decision the operator made is
gone, and the click reads as not having registered — the exact failure the
optimistic-overlay work exists to delete.

## Why it belongs in the set

It is a **curation write** by the definition the last extension (POD-781) wrote
down: it edits a row the operator is looking at, and its whole effect is that row
looking different. Those are the writes that queue.

It is **not** in the excluded class. `sendText`, `ask` and `uploadImage` are held
out because REPLAYING them is wrong — a chat message delivered hours late is
worse than a failure. Replay of a dismissal is safe by construction, not by
luck: the write names ONE offer by its timestamp, and the server clears the offer
only if the stamp still matches. A dismissal that drains hours late, after the
agent has posted a new offer, is refused. That guard is stronger than what most
of the already-covered writes carry, where a late replay simply re-applies.

## What is explicitly NOT included

The offer's **action buttons** stay on the direct path. Pressing one sends a
normal turn (`sessions.sendText`), which is the excluded live-interaction class,
and nothing here moves it. Only the decline — which sends no turn at all — is in.

## What the operator sees after the change

- The bar leaves on the click, offline or online, and **stays gone**, including
  across a reload while the write waits, and on the panel's other surface.
- If the server ever refuses the write outright (the session is gone, access was
  revoked), the offer comes **back** by itself and a toast says the dismissal
  did not sync — the same failure surface every other queued row edit uses.
- The ten-second **Undo** window is unchanged: nothing is written until it
  closes.

## Risks considered

| Risk | Answer |
| --- | --- |
| A late dismissal eats an offer the operator never saw | Refused by the server's stamp match; the standing offer survives. |
| A replay applies twice | The queue replays under a stable mutation id the server dedupes; pinned by a new server-side oracle test. |
| Two dismissals queued for one session | They cannot both be live — a session holds one offer, and a new one replaces the old — so the queue keeps the last and drops a round trip that would have been refused. |
| The paint hides a NEW offer that arrives mid-flight | The paint retires as soon as truth shows any other standing offer, rather than on "no offer at all". |

## If the answer is no

Revert is a single commit. The alternative fix — keep the write direct and make
the failure quieter — was not taken: it would leave dismiss as the only click of
its kind that loses the operator's decision when the network blinks.
