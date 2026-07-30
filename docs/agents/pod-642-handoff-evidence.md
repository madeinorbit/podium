# POD-642 — 3.2e handoff command contract: evidence

Branch `issue/642-3-2e-handoff-command-contract-daemon-tra`, off `issue/279-integration`.
Human gates are suspended for this run, so the evidence they asked for is recorded here.

## Acceptance criteria, each answered

| Criterion | Status | Evidence |
|---|---|---|
| Handoff characterization (POD-379's refreshed set) green on the new path | **met** | `oracle-handoff.test.ts` 23/23; `modules/sessions` 333/333. Two tests rewritten, both where POD-379's own tag invited it (see "the two rewrites"). |
| Two-machine handoff e2e (POD-498 isolated harness) green through the contract | **partially met, and honestly** | The harness now passes its principal explicitly, so it drives the same seam production does. It **cannot be run here**: it needs a second real machine over the tailnet and is a hand-driven script, not a lane — the same constraint POD-379 recorded. Two-machine coverage in the lane is 23 tests against the real `SessionsService` with scripted daemons on both ends. |
| Mid-transfer-crash and duplicate-dispatch semantics tested: no session fork, no silent loss | **met** | Export failure → rollback + resurrect on the source. Concurrent duplicate dispatch → one export, one import, one spawn (was two of each). Different-target dispatch → refused. Failed transfer → slot released, retryable. |
| Handoff requires `use` on both source and target; lacking it on the target is DENIED, never silently retargeted | **met** | Source and target both asserted before anything moves; a caller that may use the source but not the target gets `not authorized to use machine 'm2'`, the session stays put, and no import runs anywhere. |
| Denied vs unreachable distinguishable for a visible machine; an invisible machineId fails identically to a nonexistent one | **met** | Visible + offline → `target machine is offline`. Visible + no `use` → `not authorized to use machine '<id>'`. Invisible → `unknown machine '<id>'`, asserted as an *equality* against the nonexistent path rather than as two independent string checks. |
| Owner preserved across the transfer; rights re-resolved live on the target, not carried as a snapshot | **met** | The persisted row changes **only** `cwd`, `machineId`, `activityCount`, `lastResumedAt` — asserted as a diff over the whole row, so any new field the transfer starts writing has to be justified. Rights are re-resolved by calling the gate again at each apply point; nothing is captured. |
| Revocation mid-transfer: the import leg is refused at apply time, not completed on a dispatch-time check | **met** | Two checkpoints, two tests: a revocation landing during the base handshake refuses before the kill; one landing after the export refuses the import and rolls back to the source. |
| Delegation chain and SessionBinding identity intact on the target; no transfer-specific identity introduced | **met by absence** | Nothing mints a capability, token or identity; asserted by the row diff above rather than by a no-op method, so it gets louder when POD-1075 adds an owner column instead of going quiet. |
| Hand-written handoff proc deleted at the POD-382 cutover | **not this issue** | Edge added there. The proc now delegates to the handler and validates with the contract's own schema, which is what makes that deletion a one-line change. |
| The contract itself (name / version / policy / exposure / delivery / redaction / ownership / attribution / errorConsistency) | **met** | `packages/commands/src/sessions/handoff.ts`, declared against POD-728's framework: `resource: 'machine'`, `machineVerb: 'use'`, `exposure: ['trpc']`, `delivery.class: 'online-only'` with its reasoning, redaction reviewed-and-empty, `creates: []`. Passes `classificationErrors` with no errors, and has a caller (the tRPC procedure validates with `sessionHandoffInput`). |

## The blocker, and how it resolved

For most of this issue the contract could not land: it declares POD-380's facets
**plus** POD-381's `policy.machineVerb`, and integration carried the first but not the second. I
declined to land it without `machineVerb` — not out of caution, but because POD-381's
`command-facet-rules.test.ts` *scans* every contract table, so a handoff contract omitting the
field would not have failed the rule enforcing its consequence; it would simply not have been
looked at. Same class as a detector that stops matching, at the one command the field exists for.

While waiting, the framework moved again: POD-728 landed `packages/commands` as the real L1 home
POD-311 specifies, with a totality rule (every facet required, including the ones whose answer is
"none") and `classificationErrors`. The contract went **there** rather than into the protocol-side
table — it is the destination, its lint is the stronger guard, and its `errorConsistency` type
already carries the M5 carve-out this command needs. The cost is that POD-381's protocol-side scan
does not see it, so the D18.3 rule (`machineVerb: 'use'` ⇒ not offline-eligible) is now **also** a
clause in `classificationErrors`, with a named-exception list whose emptiness is checked.

## The two rewrites

`willChange('POD-642')` — *"CONCURRENT duplicate dispatch is NOT serialized today — BOTH
orchestrations run end to end"* → **single-flighted: one export, one import, one spawn**. The tag
existed to make this change visible; the counts fell to one and were not "fixed" by restoring the
duplication. POD-642 is also dropped from `SUPERSEDING_ISSUES`, because a landed issue left in that
list keeps asserting that a pending change is still pending.

`willChange('POD-1079')` — *"handoff to any paired ONLINE machine is allowed with no per-machine
authorization"* → the check point exists now; what POD-1079 replaces is its **backing**. Renamed
rather than supplemented: adding a truer test beside it would have left the old one wearing the old
name.

## Mutation evidence — 13 applied, 13 caught, 0 survivors

Each mutant was verified to have *applied* (pattern matched exactly once, file hash moved, mutant
text grepped back out) and reverted against a byte-compared backup, one mutant per run.

| # | Mutant | Killed by |
|---|---|---|
| 1 | drop the pre-import re-auth | revoked-mid-transfer refuses at apply |
| 2 | drop the pre-kill re-auth | revocation during the base handshake |
| 3 | never join an in-flight transfer | concurrent dispatch is single-flighted |
| 4 | release the slot only on success | a failed transfer is retryable |
| 5 | join instead of refusing a second target | different-target dispatch is refused |
| 6 | collapse the attribution pair | actor vs on-behalf-of distinguishable |
| 7 | flatten `unauthorized` into `absent` | see-grant / owner-less / admin / target-denied |
| 8 | drop the scope half of the admin check | a subtree-scoped admin is refused |
| 9 | skip authorization for joiners | the joining caller is authorized on its own rights |
| 10 | write `spawnedBy` during the move | the row changes only its placement |
| 11 | restate a composed input field as a fresh `z.string()` | the `toBe` composition test — and **nothing else**: 143 other tests including the golden wire corpus stayed green |
| 12 | expose the command on `relay` | trpc-only exposure |
| 13 | let `unauthorized` through the gate | target-denied, and both revocation tests |

Mutant 2 exposed a fault in the **test**, not the product: it was caught by a 20-second hang rather
than an assertion, because that test had re-attached a hand-written daemon answering only the base
probe. Fixed at the cause with a fixture hook — 620 ms red now. That is POD-379's round-4 failure
mode, found in the file whose job is to catch that mutant sharply.

## Two findings worth the ledger

1. **A rights gate must not also answer existence.** The first cut refused a `machineId` absent from
   the machine list. It read as defence in depth and it refused handoff *from* the local machine on
   installs whose `local` row is written lazily. POD-381 hit the same class from the other side and
   fixed it better — by synthesizing an owned row for the sentinel, so ownership stays uniform.
2. **Coalescing is not authorizing.** Single-flight has a privilege trap: if the second caller joins
   before its own rights are checked, it is told the move succeeded on the initiator's rights.
   Authorize first, coalesce second. Now a test and a mutant, and the same trap is latent in any
   other single-flight this fan-out adds.

## What replaced my stand-in when POD-381 landed

`legacyAdminMachineUse` and `grantedMachineUse` are **deleted**. `handoff/access.ts` is one call to
`checkMachineUse(principal, machineId, ownership)` plus `machineAccessMessage`. Three consequences,
all improvements:

- **no local-sentinel special case**, because `machine-access.ts` resolves `local` / `__local__` to a
  synthesized owned row and the ordinary rules run over it. Two of us hit that class from opposite
  sides; the shared rule is that *a rights gate which also answers existence gets one of the two
  questions wrong*.
- **the revocation tests revoke through ownership**, not by flipping a capability's role. That is the
  honest shape (the row changes, the resolver is consulted again) and a truer test: a role floor is a
  different gate, which the shared resolver correctly ignores for machine `use`.
- **one wording for the refusals**, the fleet's, instead of a second vocabulary of mine.

One test was **deleted rather than left wearing its name**: "an OPERATOR may hand off to any paired
online machine, and a constrained caller may not" was true of my admin-only stand-in and is false of
the shared resolver. Adding a truer test beside it would have left the false claim in the file.

## Verification lanes

```
apps/server in-package tsgo --noEmit        clean
  instrument probed: a planted @ts-expect-error in handoff/coordinator.ts reported TS2578,
  so the program does cover the new files
packages/commands in-package tsgo           clean
modules/sessions + packages/commands +
  POD-381's command-facet-rules            434 passed (36 files)
oracle-handoff.test.ts                      22 passed
router.test.ts                              52 passed, 1 skipped
relay.machines + superagent-headless +
  sessions.ledger + sessions.refs +
  characterization                          102 passed
bun scripts/check-boundaries.ts             exit 0 (harness-branching service.ts ratcheted 9 → 7)
bun scripts/rearch-audit.ts                 OK — 25 items, 219 sites (baseline exact)
bun scripts/check-no-nul-bytes.ts           ok
```

`tests/e2e` is covered by **no** typecheck program (root `tsconfig.json` has `files: []`, `tests/e2e`
has no tsconfig) — confirmed by a probe that stayed silent. The one edit there was checked through a
throwaway project over that file, which reported TS2578 for a planted directive and nothing on either
touched line.
