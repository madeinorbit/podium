# Issue-mail delivery: what `delivered_to IS NULL` actually meant

**POD-1420 · measured 2026-08-02 against `~/.podium/podium.db`**

## Summary

Three quarters of today's issue-addressed mail appeared to have reached nobody. It had not. The
delivery ledger was erasing its own evidence, and the resulting count was read — by two separate
issues — as a mass delivery failure.

The originating measurement grouped `messages` by `delivered_to` and read `NULL` as "no
recipient". `NULL` is also what a **correct pull** recorded.

## The corrected breakdown

Today's 144 issue-addressed rows with `delivered_to IS NULL`:

| bucket | n | verdict |
|---|---|---|
| `delivered`, read receipt from a session **on the target issue** | 94 | delivered correctly |
| `delivered`, no receipt (all predate the receipts table) | 15 | not judgeable |
| `queued` — genuinely held, nobody has it | 30 | real |
| `dead_letter` — terminal, sender told | 6 | working as designed |

`message_reads` — the only instrument that distinguishes a pull-path success from a non-route —
was created **today at 10:33:50** (POD-1379), first receipt 11:14. Nothing before that can be
judged by it, which is why the 15 no-receipt rows are not evidence of loss.

**POD-279, all-time: `queued` = 0.** 110 pull-path reads, 78 pushed to a session, 46 read,
2 expired. The "112 held all-time" figure was the pull-path reads.

## Root cause

`IssueService.mailInbox` (and `mailClaim`) advanced the shared ledger with
`markDelivered(id, NULL, at)`. That `UPDATE` sets `delivered_to` unconditionally, so:

1. every inbox read recorded the message as delivered to **nobody**; and
2. worse — it **erased a push target already stamped by `markInjected`**.

`markInjected` records the session a message was pushed to while leaving status `queued`. So a
message routed correctly, injected into a live session, and echoed in its transcript became a
`NULL` row the moment the agent opened its mailbox.

POD-1365 caught the erase independently on a controlled probe while diagnosing its own defect:

```
msg_284ff66e   injected_at  14:44:17Z   delivered_to = aa1f8b5d…   routed correctly
               delivered_at 14:44:40Z   delivered_to = NULL        erased by the pull
```

It had also read those rows as non-routes. This is why the non-uniformity was the tell: rows
confirmed by transcript echo or at a turn boundary keep their id; rows the agent **pulled** lost it.

## Premises checked and found sound

Worth recording, because each was an assumed defect:

- **The age-out path works.** `MESSAGE_WAIT_TTL_MS` is 7 days; the stuck rows were ~4 days old and
  not yet due. Expiry has produced 104 rows historically.
- **`suppressSelf` is not implicated** — the senders were not members of the target issues.
- **`podium mail send` already rendered `held` distinctly.** `podium issue mail send` — the command
  agents actually use — did not: `queued` fell through to a bare `mail sent to #N`.
- **No empty strings.** `typeof(delivered_to)` across every issue-addressed row: 863 null, 523
  text, zero `''`. An `IS NULL` count is sound.

## Fixed here

- `markDeliveredByPull` names the reader and **COALESCEs** rather than overwrites, so a pull can
  never erase a push target again.
- Every non-`delivered` send disposition now tells the sender the recipient does not have it yet.
  `queued` — the commonest send, fyi mail to a busy live session — was previously the silent one.
- `podium mail status` no longer claims *"appeared in the target's transcript — the agent has it"*
  for a row with no `delivered_to`. It now says **no recipient session was named**. A named
  session still gets the confirming wording.

## Postscript, 2026-08-03: the same inference, a third time

POD-279 reported 26 overnight messages as having "reached no session", citing
`status='delivered', delivered_to IS NULL` — the same reading corrected above. Checked:

| | |
|---|---|
| rows with a read receipt | **26 of 26** |
| reader was a session **on POD-279** | **26 of 26** |
| worst created → read latency | **104 minutes** (not the 16 hours claimed — that was the query window span) |
| POD-279 rows with `status='queued'`, all-time | **0** (a claimed "held 17→20" table has no basis) |

Three readers — POD-1365, POD-279, and me for part of a day — have now drawn a non-route
conclusion from this column. That frequency is itself the finding: the ambiguity is not a
reporting nuisance, it manufactures false diagnoses. POD-279's design point was right even
though its data was not, and it is what prompted the `mail status` fix above.

**Not** repaired with a `NOT NULL` constraint: delivered-to-nobody is sometimes the truth
(`suppressSelf` consumes a send whose only recipient was its own sender). The honest repair is
to make the two cases *read* differently. Making them unrepresentable needs a distinct status
plus a migration — its own issue, not a schema change smuggled into this one.

## Left open, deliberately

- **fyi mail to a live session waits for an idle boundary that may not come.** 18 messages queued
  against *live* sessions, aging up to 14 hours, every one `urgency=fyi lifecycle=wait`. This is
  **POD-1174**, not duplicated here.
- **Held mail outlives its issue** — ~20 messages against `stage=done` issues with no sessions,
  waiting out the full 7-day TTL. Filed as **POD-1432**.

## The transferable lesson

Both issues were looking only at failures. The **successes** — the read receipts — are what
separated pull-path delivery from non-routing, and correlating successes is the same move that
broke POD-1365 open. A column that is wiped on some paths and not others is a better lead than a
count.
