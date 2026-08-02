# POD-1399 — the handoff coordinator, cut into four phases

Rebased onto integration `183f25f8` (37 commits, including POD-1397's messages
split). Every number below is measured on the REBASED tip, not the pre-rebase
one. `apps/server/src/modules/sessions/handoff/` only, plus this note and two
generated/architecture records; no sibling's source was touched.

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
57ba56b9^ coordinator.ts:185-443  ==  transfer.ts:107-365   259 lines, diff-empty
md5 ae31aa85961501c10d0618b982c4ace7 on both sides
```

byte for byte, including indentation and comments — `57ba56b9` is the commit
that moved it, and its parent is the last tree that still had it inline. The
md5 is quoted so the claim survives a further rebase renumbering the SHAs. The
free names the region reads are bound by a destructure ABOVE line 107. One line
inside the moved span changed in an earlier commit — `this.recordHandoff(...)`
became `recordHandoff(ports, ...)` — and it sits after the import leg, outside
the region in question.

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

**Five of the twelve were re-run on the rebased tip** — C, B and E (the three
whose subject code the rebase could have reached) and G and H (the two the
oracle's partial net depends on). All five went red on the same named cases.
The rest were not re-run; their subject lines are byte-identical across the
rebase, which is a weaker claim than re-running them and is stated as such.

## A finding about the METHOD, not the code

`git add -A` in a worktree where you are planting mutants is how a mutant
escapes. Mine nearly did: a concurrent test lane had planted `"x-planted": 99`
over `"publish-computed-fanout": 0` in `scripts/rearch-audit-baseline.json` —
its own fixture, correctly restored a second later — and a `git add -A` of mine
committed that instant. The commit message said "regenerate the composition
graph"; the diff said otherwise.

Two things about it are worth keeping:

- **The tell was not the test failing.** It was `git log -1 -- <file>` naming
  MY commit as the last to touch a file I had never edited. Nothing else
  flagged it: the working tree was correct within seconds, so `git status` was
  clean and every gate passed.
- **It cost nothing to fix and would have cost a lot to find later.** A bisect
  landing on that commit would have hit a rearch-audit failure with no
  relationship to the commit's subject. The rebase has since dropped the
  restoring commit entirely (its patch became empty once the plant was removed
  from the commit that introduced it), so the landed history never contains the
  planted state.

Stage by path. On a shared box, `-A` stages whatever another process happens to
be holding open at that instant.

## Gates

All measured on the rebased tip.

| gate | result |
| --- | --- |
| `bun run typecheck` (workspace) | `Tasks: 22 successful, 22 total` / `Cached: 20 cached, 22 total` / 1m6.9s, **exit 0** |
| `bun run audit:god-objects` | **1 item**, exit 1 — `lifecycle.ts` alone (2450/1702). This file is out of the population; the probe passed first, so the instrument was shown able to say YES before its NO was believed. |
| handoff + oracle suites | `Test Files 10 passed (10)` / `Tests 126 passed (126)`, **exit 0** |
| `bun scripts/audit-ambient-principals.ts` | 41 usage sites, baseline 41, no drift, **exit 0** |
| `bun scripts/server-composition-graph.ts` | acyclic and current, 199 modules, **Cycles: 0**, exit 0 |
| `bun run test:unit` (full lane) | `Test Files 1 failed / 663 passed / 3 skipped (667)` · `Tests 4 failed / 9563 passed / 20 skipped (9587)` · **exit 1** — see below |

**The lane's exit 1 is not this branch.** All four failures are in
`scripts/rearch-audit.test.ts`, and they split into two causes, both established
rather than assumed:

- **Three are load.** Each spawns a full-tree audit subprocess against a 20 s or
  40 s timeout and took 33–52 s on a box at load 82. Re-run alone, all three
  pass.
- **One is a real defect that lives on integration.** `exits 0 when the tree
  matches the committed baseline` fails with `expected 1 to be +0`, because
  `bun scripts/rearch-audit.ts` reports `representation-registry-rot` growing
  `0 → 1`: `apps/server/src/modules/sessions/lifecycle.ts:1 SessionSpawnResult:
  registered but no longer declared at this site`.

  Verified as NOT this branch's, by checking out integration alone in a
  throwaway worktree and running the audit there: identical finding, identical
  line, with none of this branch's commits present. This branch touches no
  `lifecycle.ts` and the string `SessionSpawnResult` appears zero times in its
  diff. It is filed separately.

  It matters beyond this issue because `audit:rearch` is one of the standing
  post-merge gates — whoever merges next inherits a red gate they did not cause.
| `bun run lint:boundaries` | exit 1, pre-existing — 0 findings name `handoff/` |
| `bun run lint:shadowing` | exit 1, pre-existing — `packages/harness/src/registry.ts` |
| `bunx biome check handoff/` | exit 1 on four files byte-identical to the base commit (`access.ts`, `refusal.ts`, `refusal.test.ts`, `ports.types.test.ts`); the new and changed files are clean |

## What a later reader should not assume

- The audit exiting 1 is correct until `lifecycle.ts` is answered for. This item
  is gone from its population; the criterion is not met yet, and one file
  leaving the list is not the criterion being met.
- The chunk transfer and the import leg still have no factual assertion of their
  own. Nothing in this issue added one, because nothing in this issue changed
  that region. The next change there does need one, to POD-1390's M5 standard.
- The four teardown severities POD-1385 flagged (row / transcript / resume ref /
  worktree) do not live in this directory — they are the stop/kill/delete paths
  in `lifecycle.ts`. What DOES live here is the four transfer exits, and those
  are a table in `transfer.ts`'s header.
