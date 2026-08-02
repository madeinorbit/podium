# POD-1396 — finishing the `lifecycle.ts` decomposition

**State:** 2955 → 2749 lines, 93 methods, four modules extracted.
**Target:** under the 600-line review signal, or an argued exception its own
predicate can satisfy. At 2749 it is not that, and no honest exception exists.

## What has come out so far

| module | what it owns | why it was a seam |
| --- | --- | --- |
| `observation-leases.ts` | the durable observer lease book | a raw `Map` was shared **by reference** across lifecycle, repository and daemon-lifecycle; all three could get/set/delete/clear it |
| `terminal-proof.ts` | "may this session be parked?" | lifecycle already passed `terminalCandidateFacts` into daemon-lifecycle as an explicit **port** |
| `machine-reconciler.ts` | daemon appear/vanish reconciliation | the gateway already owned the transport half and called lifecycle for the session half |
| `naming.ts` | the curated name slot + provenance | two setters distinguishable only by the user-sovereign rule between them |

Ordering note that cost nothing to preserve and would have cost a lot to lose:
the lease book came out **first**, as ownership rather than a code move. Moving
the lease *readers* out while leaving the `Map` shared would have made the
god-object audit greener and the design worse.

## What is left, measured

93 methods, 2592 lines inside method bodies. The blocks that matter:

```
 372  constructor                  the per-module composition root
 173  createSession
 157  spawn
 118  stopSession
  99  hibernateSession
  86  stopIssue
  84  authorizeQueuedInputAtApply
  79  resumeSession
  61  finishResurrect
  59  reattachMessageFor
  48  tryAutoArchiveStoppedObserved
  45  modelDefaults
  44  handoffSession
  41  killSession / handoffs
  39  emitSessionExited / removeSessionRuntime
```

## Proposed remaining cuts, in dependency order

**1. `session-start.ts` (~450 lines).** `createSession`, `spawn`,
`modelDefaults`, `accountEnv`, `reattachMessageFor`. One job: turn a
create/resume/reattach request into a daemon spawn or reattach message, with the
launch configuration resolved from settings and accounts.

*Hazard:* `settingsViewer()` has five callers and returns `FIRST_ADMIN_USER_ID`.
It must **stay in lifecycle** and be passed as a port. Moving it would relocate
an ambient-principal site, and the production count (77) must not change. Verify
with `grep -rn FIRST_ADMIN_USER_ID apps packages --include=*.ts | grep -v test`
before and after.

**2. `session-teardown.ts` (~450 lines).** `stopSession`, `stopIssue`,
`hibernateSession`, `killSession`, `killStoppedSession`, `removeSessionRuntime`,
`sessionRemovalSpecs`, `emitSessionExited`, `finalizeDeferredStopKill`. One job:
end a session at each of its four distinct severities, and emit what each
implies.

*Hazard:* these differ from each other only in what survives (row, transcript,
resume ref, worktree). That table belongs in the module header or the next
reader will collapse two of them. `hibernateSession` also consumes the terminal
proof — keep it a **reader** of `terminal-proof.ts`, never a second judge.

**3. `session-revival.ts` (~260 lines).** `resumeSession`, `resurrectSession`,
`finishResurrect`, `handoffSession`, `handoffs`, `findLiveByResume`. One job:
bring an existing session back, locally or on another machine.

**4. `wiring.ts` (~372 lines).** The constructor. Do this **last**: every cut
above shrinks it, so doing it first means doing it twice.

*Hazard, and the reason this one is last rather than first:* construction order
is a real contract, and `scripts/server-construction-order.ts` only walks the
**relay** root — it will not catch a reordering inside this constructor. Extract
as a builder returning the collaborator set, and change no ordering in the same
commit as the move.

Landing all four leaves a facade of delegations plus small methods, roughly
400–600 lines, which is at or under the signal.

## The rule this file exists to keep

Do not ledger-exempt any of this to force the audit to zero. A 2749-line
`lifecycle.ts` talked into `cohesive-owner` would be the exact disease the
instrument was built to detect, committed by its author. If a residue genuinely
is a justified exception, argue it **with the predicate** — and note that the
`operation-surface` predicate refuses any file with one method over 180 lines,
which today the constructor alone violates.

## Verification bar for each cut

Established over the four already landed, and worth keeping:

1. `bun run typecheck` — 22/22.
2. Targeted suites for the moved behaviour, green.
3. **A mutation that proves the moved logic is actually covered.** Every cut so
   far was verified this way, and it is not ceremony: the observation-lease
   mutation that mattered was the *second* one, because the first was too weak
   to cross the predicate's own threshold and its silence proved nothing.
4. Regenerate all three graph documents and **account for every number that
   moves**, including ones that move the "wrong" way. Edges went *down* during
   this work (287 → 286) and the explanation was a lint autofix converting
   already-type-only imports, not coupling improving.
5. Dispose contracts: check whether the extracted module owns a timer, loop or
   async work. None of the four so far did — but that was checked, not assumed.
   POD-1390 proved this is where a split silently drops behaviour.

## Known red to ignore

`apps/server/src/modules/sessions/oracle-authz.test.ts` — one case,
`sessions.handoff` returning "no such procedure" instead of the permission
message. POD-1386's allowlist entry without its dispatch arm. Attributed and
being fixed; not caused by this work.

## Known coverage hole — do not build on it

`oracle-handoff.test.ts` advertises the rollback contract and does hold it, but
`await sleep(SOURCE_RELEASE_MS)` can be **deleted entirely with 25/25 still
green**. Tracked as POD-1409. `handoff/coordinator.ts` (POD-1399) must not be
restructured until that assertion exists — a falsified oracle is not a safety
net.
