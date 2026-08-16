# POD-1149 — what the mission gauge counts

The operator's screenshot: POD-993's deck, header reading **`1 DONE`** across the
full track, beside a **`1 working`** fleet chip, above a spine holding one
cancelled task and one proposal. A mission in `review`, with an agent visibly
computing, reporting itself 100% complete.

This is what moved.

## POD-993's actual shape

Three rows, and the two that are not the root reach the deck the same way:

| issue | stage | `closedReason` | `parentId` | `discovered-from` | reaches the mission by |
|---|---|---|---|---|---|
| POD-993 | `review` | — | — | — | it is the root |
| POD-1115 | `done` | `cancelled` | none | none | `startedBySession` |
| POD-1082 | `proposed` | — | none | none | `startedBySession` |

Neither graft is decomposition. POD-993's session filed them; that is
provenance, and `hasLeftMission` can never release them because it keys on a
`discovered-from` edge neither one has.

## The arithmetic

Run against that shape (the fixture is now a regression test —
`mission.test.ts` → *does not measure a mission by the work its agent merely
filed*):

|  | before | after |
|---|---|---|
| `missionProgress` | `{ total: 1, done: 1, run: 0, review: 0, block: 0, wait: 0 }` | `{ total: 1, done: 0, run: 0, review: 1, block: 0, wait: 0 }` |
| gauge reads | `1 DONE`, full track | `1 IN REVIEW` |
| POD-1115's strip | ⊗ cancel glyph · **`Done`** | ⊗ cancel glyph · **`Cancelled`** |

Both grafts still render. Membership of the deck is wider than membership of
the meter, deliberately — the operator watched an agent file that work here,
and *where did it go* has to stay answerable from the surface it went missing
from.

## The two rules

**1 · A unit is decomposition, not provenance.** The denominator is now the
formal parent–child subtree and nothing else. That is the same line the CLI
already draws for every agent: *could the current issue close with it
untouched?* Yes → `--spinoff`, a top-level issue with a provenance edge. No →
`--subissue`, which writes `parentId`. Only the second says "this mission is
not finished until that is", which is exactly the claim a segment of the meter
makes.

Because the graft was POD-993's only "member", the container rule then demoted
the root out of its own gauge — a mission in review with no segment at all.

**2 · Cancelled is not done.** POD-1074 split Completed from Canceled the way
Linear does. The deck adopted half of it: `issueStatusOf` gives the strip the
right glyph, and `stage === 'done' || closedReason` fused the endings back
together one line later. Cancelled work now leaves the fraction entirely — it
is neither work completed nor work still owed. `issueAbandoned` delegates to
`issueStatusOutcome`, so `duplicate`, `superseded` and the legacy `wontfix`
rows all answer with it rather than this file holding a second opinion.

### What that does to other missions

| mission | before | after |
|---|---|---|
| 3 sub-issues: 1 done, 1 cancelled, 1 running | `3 total · 2 done` | `2 total · 1 done` |
| root in review, one cancelled sub-issue | `1 total · 1 done` | `1 total · 1 review` (the root) |
| root + 4 spin-offs it filed, none started | `5 total` | `1 total` (the root) |
| root + 4 sub-issues | unchanged | unchanged |

## Deliberately unchanged

- **`MissionGauge.tsx`.** Cancelled work gets no band of its own, so POD-1146's
  rewrite of that file stands untouched. Confirmed zero overlap with its branch.
- **`issueClosed`.** "Is this over" is the right question for attention, seats
  and offers, and both endings answer yes. Only the readers that report *what
  happened* were wrong.
- **The spine's rows.** Nothing left the deck; only the meter's denominator and
  three words changed.
- **The tree rails.** The screenshot's missing connector is a separate defect —
  the guides are drawn, at ~0 contrast against the surface behind them. POD-1152.
