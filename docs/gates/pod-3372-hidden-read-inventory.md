# The hidden-read inventory (POD-3256, corrected by POD-3372)

`scripts/scan-hidden-store-reads.ts`, with its own fixture probe and
`scripts/scan-hidden-store-reads.test.ts`. It runs as `bun run audit:hidden-reads` — its
own blocking CI step, next to `lint:span-effects` and for the same reasons.

## The rule it encodes

Spec §3.6: **no store read runs when a constructor or a getter runs.** At the flip a
repository read returns a promise, and neither a constructor nor a getter can await one, so
a read reached eagerly from either is a site that has to move to a `static create()` factory
or an explicit `hydrate()` step *before* the flip, while everything is still synchronous.

POD-3256 emptied the category — eleven sites. This is what stops it refilling.

## What POD-3372 found, and why it is not a false-positive story

At `2b4c7a607` the scan exited 1 with **32 shipping findings, all of them
`legacyHandle(executor)`** in a repository constructor. `legacyHandle` returns
`executor.legacy` or throws; it issues no statement, and it is declared in
`apps/server/src/store/executor/`, which the scan's own `notStorePaths` excludes. So every
one of the 32 was false, and the report was 32/33 noise.

The cause was not the exclusion list. It was the classification:

> `checker.getSymbolAtLocation` on an imported identifier returns the **alias** symbol,
> whose only declaration is the `import { … }` specifier — a node in the **importing** file.

So the scan classified callees by where the *import statement* sits, not by where the
function lives. POD-3256's own ledger §2 states the opposite in plain words ("a store call
is decided by where the CALLEE IS DECLARED"); the code never did that for an imported name.
The mistake is wrong in both directions, and only one of them is visible:

- **FLOOD.** Every repository imports `legacyHandle` *into* `store/<repository>.ts`, a store
  path. 32 reports for a function that touches no database. Loud, and the reason the bug was
  found at all.
- **LOSS.** The same mistake reversed: a genuine repository function imported into a file
  **outside** `store/` — a module service, the relay — is classified by that non-store import
  specifier and silently dropped. Silent, and the half that matters.

`calleeDeclarations` now follows `getAliasedSymbol` to the end of the re-export chain, so
classification always reads the declaration site. That is a one-expression change and it
takes the report from 32 to 0 without excluding anything.

**Why an exclusion list was refused.** Dropping `legacyHandle` by name makes the count zero
and leaves the loss half in place. The probe below encodes that refusal: mutating the fix to
"alias-blind classification + `legacyHandle` allowlisted by name" makes the flood check pass
and the scan still fails its own probe, naming the two planted reads it lost.

## Every check can say yes — `--probe`

"No hidden read in shipping code" is an absence claim, and an absence is what a broken
instrument reports. `--probe` runs the analysis over a four-file in-memory fixture whose
*paths* carry the classification, and runs FIRST on every invocation, flag or no flag:

| The fixture site | What it is | Expected |
|---|---|---|
| `modules/probe-service.ts` `PlantedService` ctor → `probeRead()` imported from `store/` | a real store read, in a file outside the store | **found** |
| `modules/probe-service.ts` `LazyService.rows` → `this.hydrate()` → `probeRead()` | a getter whose read is one transitive hop away | **found** |
| `store/probe-repo.ts` `CleanRepo` ctor → `legacyHandle()` imported from `store/executor/` | the shape of all 32 | **quiet** |
| `store/probe-repo.ts` `RegistrarUser` ctor → a named registration | issues no statement | **its own section, never shipping** |

Both halves matter: a scan that fires on everything is as useless as one that fires on
nothing.

## The residue it reports rather than hides

Two categories are not clean, are not filtered away, and are printed and counted on every
run:

- **Nine `SessionStore` boot reads** (`store.ts`) — the boot heals and the legacy-identity
  refusals, which spec §3.6 hands to the flip [B1] as `SessionStore.open()`.
- **One listener registration** — `SessionRegistry` → `EventsRepository.onAppend`, which is
  `this.appendListener = listener`. Named one by one with the reason, so a member that grows
  a query falls back into the report.

## What it still cannot see

Two limits, stated because a gate that overclaims is worse than one that reports narrowly.

- **Structurally-typed ports.** POD-3256's third mutation probe: the same read reached
  through a parameter typed `{ repairSubagentSegmentPaths(): void }` is missed. `relay.ts`
  narrows the store to structural ports throughout. What catches that class is not a scan —
  it is the flip itself, where every repository method returns a promise and the compiler
  enumerates the callers.
- **Classification is by directory, not by effect.** `apps/server/src/store/` also holds
  pure row-mapping helpers (`issue-storage.ts`, `helpers.ts`). None is reached from a
  constructor or a getter today, so nothing is over-reported now; if one ever is, it will be
  reported as a store call and want a human, not a heuristic.

This scan proves the lexical category is empty, and nothing more.
