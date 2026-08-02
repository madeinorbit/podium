# POD-1399 — the handoff coordinator, cut into four phases

Branched from `1de31536`. `apps/server/src/modules/sessions/handoff/` only; no
sibling's files were touched.

## What was wrong with it

616 physical / 421 code lines, six methods, and one of them — `run()` — held 401
of the 421 code lines. It would have PASSED a weaker instrument: at 421 code
lines the audit's `documented` predicate is satisfied outright, and an entry
saying so would have been technically true and would have papered over a single
method that was effectively the whole module. It was refused on the argument.

## The seam: what an exit COSTS

The phases are not equal slices of a sequence. Each boundary below is the same
kind of line — a change in what abandoning the move costs — because that is the
property this choreography turns on. A refusal is only safe where nothing has
happened yet, so the code was already sorted by that; the split names it.

| phase | file | lines | refusing costs |
| --- | --- | ---: | --- |
| admission | `admission.ts` | 115 | nothing. Owns the single-flight registry. |
| placement | `placement.ts` | 181 | nothing. Reads only — its port type has no write on it. |
| pre-flight | `preflight.ts` | 134 | one overlay. Clone + base handshake, all reversible. |
| transfer | `transfer.ts` | 368 | an unwind — and past the authorized target claim, nothing: the target keeps the session. |
| (sequencer) | `coordinator.ts` | 154 | — holds no state, decides nothing. |
| receipt | `attribution.ts` | 96 | — one derivation, two consumers. |

Three consequences worth stating, because each is a thing the split could have
got wrong instead:

**The single-flight registry got an owner FIRST, as its own commit.** `inFlight`
is what stops a duplicate dispatch exporting the package twice and spawning it
twice on the target. It is private to `HandoffAdmission`, reachable from nothing
else, and `isTransferring` is the only read anyone else gets. Passing the map
into the pieces that prepare and apply a transfer would have made the audit
greener and the design worse.

**The transfer is deliberately still ONE function.** `targetClaimed`,
`sourceCommitted` and `winnerAuthorized` are not bookkeeping — they are the
rollback's inputs, and the `catch` reads all three to decide whether the target
keeps the session or the source gets it back. Splitting the legs apart would
distribute those three flags across the split: the coupling a decomposition
exists to remove, recreated by the decomposition.

**Placement's argument list is its own assertion.** It takes
`Pick<HandoffPorts, 'getSession' | 'listRepos' | 'listMachines' | 'issueMeta'>`,
so no test has to prove that resolution wrote nothing — `mutateSessionView`,
`toMachine`, `persist` and `rpc` are not reachable from inside it. Every port
slice in the new modules is a `Pick<>` of the real thing; none is restated.

## The export-to-import region did NOT move in shape

The oracle's release clause (POD-1409) covers the SOURCE RELEASE specifically.
Everything from the export to the import is still pinned by ordering alone, and
ordering survives a reshape — which is how the deleted `sleep` went unnoticed at
25/25. So that region was moved and not touched:

```
HEAD~ coordinator.ts:185-443  ==  transfer.ts:107-365     259 lines, diff-empty
```

byte for byte, including indentation and comments. The free names it reads are
bound by a destructure ABOVE line 107. One line inside the moved span changed in
an earlier commit — `this.recordHandoff(...)` became `recordHandoff(ports, ...)`
— and it sits after the import leg, outside the region in question.

This is the claim. The oracle's 26/26 is not the claim, and must not be read as
one.

## Mutation table — every mutant, including the one that did not fire

Each applied to exactly one site (the helper refuses a target with a match count
other than 1), run, reverted with `git checkout --`, and grepped back.

| # | mutant | fired | what went red |
| --- | --- | --- | --- |
| A | repo sort ascending — shallowest registered repo wins | yes | `placement.test`: picks the DEEPEST registered repo |
| B | offline target classified `unauthorized`, not `unreachable` | yes | `placement.test`: OFFLINE is unreachable (M5) |
| C | issue-worktree fallback ignores which machine the issue is homed on | **NO**, then yes | see below |
| D | a dispatch to a DIFFERENT target joins instead of being refused | yes | `admission.test` + oracle: concurrent dispatch to a different target |
| E | coalesce BEFORE authorizing — joiner rides the initiator's gate | yes | `admission.test` + oracle: a joining caller is authorized with its OWN rights |
| F | agent actor replaced by its human — the pair collapses | yes | `attribution.test` ×2 + oracle: agent-initiated move distinguishable from a human one |
| G | delete `await sleep(SOURCE_RELEASE_MS)` — the POD-1385 hole, re-run after the MOVE | yes | oracle: "export reached the source 0ms after the kill, before its 120ms release finished", 1 failed / 25 passed |
| H | drop the apply-time re-authorization in front of the import (D8) | yes | oracle: grant REVOKED MID-TRANSFER refuses at apply |
| I | drop the post-handshake re-authorization (obligation 2, first checkpoint) | yes | oracle: revocation during the base handshake refuses before the kill |
| J | leave the overlay painted when the pre-flight refuses | yes | oracle ×2: no verified common base; revocation during handshake |
| K | `targetWins = targetClaimed` — claim alone wins, without authorization | yes | oracle: revoked claimant loses at first ownership apply |
| L | the receipt is never written | yes | oracle ×2: durable record; smuggled input identity is inert |

**C is the one worth reading.** Deleting the machine check from the
issue-worktree fallback left `placement.test.ts` **16/16 green**. The fixture's
worktree path (`/elsewhere/wt`) sat outside the source repo, so the `startsWith`
guard refused it anyway and the clause under test was never the reason the case
passed — a test that could not fail, found by mutation and not by review. The
path now sits under the source repo (`/repo/wt/elsewhere`), where the machine
check is the only thing that can refuse it, and the same mutant goes red on the
named case.

G is the one that matters for the move: the clause POD-1409 added still sees the
region in its new file.

## Gates

| gate | result |
| --- | --- |
| `bun run typecheck` (workspace) | 22/22, exit 0 |
| `bun run audit:god-objects` | 2 items, exit 1 — `lifecycle.ts` (POD-1396) and `messages/service.ts` (POD-1397). This file is out of the population. |
| `bun scripts/audit-ambient-principals.ts` | 41 usage sites, baseline 41, no drift, exit 0 |
| `bun run lint:boundaries` | exit 1, pre-existing — 0 findings name `handoff/` |
| `bun run lint:shadowing` | exit 1, pre-existing — `packages/harness/src/registry.ts` |
| `bunx biome check handoff/` | exit 1 on four files byte-identical to the base commit (`access.ts`, `refusal.ts`, `refusal.test.ts`, `ports.types.test.ts`); the new and changed files are clean |

## What a later reader should not assume

- The audit exiting 1 is correct until POD-1396 and POD-1397 land. This item is
  gone from its population; the criterion is not met yet.
- The chunk transfer and the import leg still have no factual assertion of their
  own. Nothing in this issue added one, because nothing in this issue changed
  that region. The next change there does need one, to POD-1390's M5 standard.
- The four teardown severities POD-1385 flagged (row / transcript / resume ref /
  worktree) do not live in this directory — they are the stop/kill/delete paths
  in `lifecycle.ts`. What DOES live here is the four transfer exits, and those
  are a table in `transfer.ts`'s header.
