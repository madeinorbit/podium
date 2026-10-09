# Startup baseline

The baseline and the safety check for POD-5592 (First screen before history).
Measurement and test infrastructure only: no product or protocol change.

## Corpus

The startup corpus is the two-axis fixture (`buildCorpusCell`, POD-4747):
history (closed, archived and deleted work and its sessions) and active work
(open issues, live sessions, visible rows, lanes) grow separately. History x10
keeps every active row of the base cell exactly; active x4 keeps every history
row exactly (`tests/worklist/harness/src/fixture/cells.test.ts`). Seeded
PRNG only, no wall clock, no operator data.

`apps/web/harness/old-vs-new-corpus.mjs --cell=<cell> [--seed=4443]` writes the
cell's corpus and the wire rows the cold-start collector feeds the app, as
`.artifacts/old-vs-new/{corpus,rows}-<cell>.json`, and prints their digests.

| Cell | History | Active | Issues | Sessions | Wire rows | Rows SHA-256 (seed 4443) |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `h1a1` | x1 | x1 | 4,867 | 4,304 | 21,958 | `5b65dceb…8069e` |
| `h10a1` | x10 | x1 | 27,601 | 30,611 | 136,128 | `06d70c9c…0ff5` |
| `h1a4` | x1 | x4 | 11,890 | 8,447 | 49,572 | `fbe4793a…4cb18` |
| `h10a4` | x10 | x4 | 34,624 | 34,754 | 163,742 | `da1f49f5…d89252` |

`h10a1` against `h1a1` is the key case: the same active work under ten times
the history. Determinism, shown on flatblock 2026-10-09: two `h10a1` runs with
seed 4443 wrote byte-identical row files (`cmp`); seed 777 wrote different rows
(135,699 rows, `7cd75882…`).

## The "no wrong number" check

`tests/worklist/harness/src/startup/no-wrong-number.ts` asks one fixed list of
questions of a CONTROL pool (the full bootstrap) and a CANDIDATE pool in any
intermediate startup state. Every candidate answer must equal the control's or
be `LOADING` (rule 7 of `docs/agents/frontend-data.md`: here, on its way, or
gone). Anything else is a wrong number.

The questions (`startupQuestions`), over targets picked from the control's rows
(`startupTargets`):

- **first screen**: the sidebar row of each open top-level issue;
- **counts**: issue and session counts, undeleted issues, the board's tab
  counts, proposed issues;
- **search**: command palette issues; per needle, the local text index, chat
  mention matches and the board's search;
- **board archive**: every explorer tab (the closed work sits in `done` and
  `cancelled`) and the archived issues;
- **closed-children progress**: per parent with closed children, the child
  counts question, the issue model's counts, the mission pane's progress and
  the board card's progress.

To use it from a later issue (POD-5595, 5597, 5598, 5599):

```ts
const qs = startupQuestions(startupTargets(feed.rows))
const report = checkNoWrongNumber(ask(controlPool, qs), ask(candidatePool, qs))
assertNoWrongNumber(report, 'active rows painted, history arriving')
```

`startup-states.ts` opens the real engine's pooled feed on a cell and builds
the states this issue proves the check on: `fullPool` (control),
`partialPool` (active rows only, no markers) and `lazyPool` (the production
lazy pool on the whole feed, before and after `hydrateAll`).

Results on `h1a1` (flatblock, 2026-10-09; `no-wrong-number.test.ts` and
`no-wrong-number.lazy.test.ts`), answers per group as equal / LOADING / wrong:

| Candidate state | First screen | Counts | Search | Board archive | Closed children |
| --- | --- | --- | --- | --- | --- |
| Second full bootstrap | 24 / 0 / 0 | 5 / 0 / 0 | 13 / 0 / 0 | 9 / 0 / 0 | 96 / 0 / 0 |
| Partial store, no markers | 9 / 0 / **15** | 1 / 0 / **4** | 1 / 0 / **12** | 0 / 0 / **9** | 18 / 0 / **78** |
| Lazy pool, history cold | 9 / 15 / 0 | 5 / 0 / 0 | 13 / 0 / 0 | 9 / 0 / 0 | 62 / 34 / 0 |
| Lazy pool, history loaded | 24 / 0 / 0 | 5 / 0 / 0 | 13 / 0 / 0 | 9 / 0 / 0 | 96 / 0 / 0 |

The check is armed: a pool given only the active rows, with nothing saying
history is missing, answers smaller counts, misses search hits, shows empty or
short closed tabs and lower closed-children progress (147 questions, 118
wrong). That is the state POD-5597 paints first, and POD-5595's markers must
turn every one of those answers into LOADING. Today's lazy pool stays honest
because its cold index still holds every row the feed carried: its unloaded
rows answer LOADING (first-screen rows and closed-children progress) or from
their declared summaries (counts, search, closed tabs), and after loading
(1,552 rows) every answer equals the control. The second full bootstrap shows
the check is not noisy.

Memory: the questions are the heavy part (about 0.75 GB of heap to ask them of
a 1x pool); the engine that publishes the feed is dropped once its rows are
read. `PODIUM_STARTUP_MEMORY=1` logs RSS and heap per stage. Both files stay
under the 3 GB worker cap at 1x (peak RSS about 1.8 GB); a 10x run of the check needs the
`meter:flatblock` lease.

## First paint

PENDING.

## How to rerun

PENDING.
