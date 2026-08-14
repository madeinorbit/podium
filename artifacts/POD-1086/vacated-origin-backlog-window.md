# The vacated origin went silent again — POD-1073

## What happened

POD-1073's agent finished the work, closed the issue, and spun off POD-1085
("Merged detection survives rebase") to carry on with. `attach --spinoff` does
two things at once: it files the new issue in **`backlog`**, and it re-homes the
session onto it. Nothing stages the new issue afterwards except the agent
remembering to — POD-1073's agent got there two minutes later.

For those two minutes POD-1073 said **"Completed · session retired"**, which is
the one sentence POD-957 shipped to delete. Had the agent never staged it, the
origin would have said that forever.

## Why

`hasLeftMission` decides whether a spin-off has left its origin, and it reads the
**stage alone**:

```ts
const UNSTARTED = new Set(['proposed', 'backlog'])
!UNSTARTED.has(issue.stage) && spinOffOriginId(issue) !== null
```

A `backlog` spin-off has not left, so `liveSpinOffTip` found no tip, and every
surface that reads it went quiet at once: no continuation line, no departure
tick, no signpost.

That rule has a good half. Work nobody has picked up genuinely has not gone
anywhere — it belongs on the origin's spine, where the operator triages it in the
context that produced it. The bad half is that it cannot see the one fact that
settles the question: an agent is sitting on it.

## The fix

A spin-off with an open session on it has left, whatever its stage says. It is
read in `liveSpinOffTip` only — `hasLeftMission` also governs mission membership
through an index keyed on the issue slice alone, and membership must stay a fact
about the issue rather than about the sessions. The unstaffed half of the rule is
untouched.

The note helpers needed the wider session slice to see it, since a hop's
destination holds none of the origin's own sessions. The flight deck's root seat,
its empty-spine line and the issue panel's presence line now pass it.

## Replayed against the live POD-1073 record

Both columns are the real database rows, with POD-1085 rewound to the `backlog`
it was created in.

| | before | after |
|---|---|---|
| `liveSpinOffTip(1073)` | `null` | `POD-1085` |
| `issueContinuation(1073)` | `null` | Work continued in POD-1085 |
| `presenceNote(1073)` | Completed · session retired | Work continued in POD-1085 |
| departure ticks under POD-1073 | none | POD-1085 |
| sidebar row line 2 | *(silent)* | work continued in POD-1085 |

Two regression tests in `mission.test.ts` pin both halves: the staffed backlog
spin-off is named, and the one nobody is on stays on the spine.
