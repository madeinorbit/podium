# POD-1396 — finishing the `lifecycle.ts` decomposition

## Status as of this branch (re-measured)

| metric | before this session | after four cuts |
| --- | ---: | ---: |
| `lifecycle.ts` lines | 2457 (session-start already out) | **1355** |
| modules extracted (total for POD-1396) | 6 (leases, proof, reconciler, naming, launch-config, start) | **9** (+ teardown, revival, wiring) |
| constructor span | 409–459 | **5** (body in `session-wiring.ts`) |
| largest remaining method | constructor 459 | authorizeQueuedInputAtApply ~84 |
| composition | 193 modules / 309 edges | **196 modules / 324 edges** / 0 cycles |
| ambient USAGE | 41 | **41 (delta 0)** |
| construction order | 52/0/0/0 | **52/0/0/0** |

Still above the 600-line review signal. The four planned cuts landed; the residue
is a facade of thin delegates plus mid-sized methods that were never part of the
four-cut plan (authorizeQueuedInputAtApply, reattachMessageFor, client/daemon
frame handlers, issue delete/restore plans). Do not ledger-exempt the 1355-line
file — argue further cuts or a predicate-backed exception with evidence.

Edge accounting for this session: +3 modules, +15 edges net. The jump from 313→344
when wiring landed was wiring's value imports of every collaborator; converting
lifecycle's class field imports to `import type` brought edges to 324. Cycles 0.

---

## What has come out so far

| module | what it owns | why it was a seam |
| --- | --- | --- |
| `observation-leases.ts` | the durable observer lease book | a raw `Map` was shared **by reference** across lifecycle, repository and daemon-lifecycle; all three could get/set/delete/clear it |
| `terminal-proof.ts` | "may this session be parked?" | lifecycle already passed `terminalCandidateFacts` into daemon-lifecycle as an explicit **port** |
| `machine-reconciler.ts` | daemon appear/vanish reconciliation | the gateway already owned the transport half and called lifecycle for the session half |
| `naming.ts` | the curated name slot + provenance | two setters distinguishable only by the user-sovereign rule between them |
| `launch-config.ts` | model/effort/credential for a spawn frame | exactly two callers need exactly this — initial spawn and resurrect-respawn |

Ordering note that cost nothing to preserve and would have cost a lot to lose:
the lease book came out **first**, as ownership rather than a code move. Moving
the lease *readers* out while leaving the `Map` shared would have made the
god-object audit greener and the design worse.

## What is left, measured

91 methods, 2542 lines inside method bodies. The blocks that matter:

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
  44  handoffSession
  41  killSession / handoffs
  39  emitSessionExited / removeSessionRuntime
```

## Proposed remaining cuts, in dependency order

**1. `session-start.ts` (~330 lines, was ~450 before `launch-config.ts` came
out).** `createSession` (173) and `spawn` (157). One job: turn a create request
into a live session and its daemon spawn frame.

`spawn` has TWO callers — `createSession` (L1224) and `resumeSession` (L1373) —
so it becomes a public method of the new module and `resumeSession` calls into
it. The union of both port lists is 15 members; broad, but shallow (19 total
`this.` references across spawn's 157 lines), so it is a wide seam rather than a
deep one.

*Measured coupling — this is the port list, not a guess.* `spawn` touches 12
lifecycle members, `createSession` 8:

```
spawn          broadcastSessions, deps, launchConfig, machines, repository,
               sessions, settingsViewer, state, store, terminalProof,
               toMachine, view
createSession  bus, deps, machines, sessionOwner, setSessionDraft,
               settingsViewer, store, spawn
```

Twelve ports is large but in line with `machine-reconciler.ts`, which also takes
twelve. Every one is already a collaborator or an existing port — none of them
requires reaching into another module's internals, which is what makes this a
seam rather than a tangle.

*Hazard:* `settingsViewer()` has five callers and returns `FIRST_ADMIN_USER_ID`.
It must **stay in lifecycle** and be passed as a port.

But note it is **not the only ambient site in the moving code** — `lifecycle.ts`
holds four, and three sit in methods that move:

```
L1217  createSession   ownerUserId ?? FIRST_ADMIN_USER_ID   -> moves with session-start
L1373  resumeSession   ownerUserId ?? FIRST_ADMIN_USER_ID   -> moves with session-revival
L2433  spawn           ownerUserId ?? FIRST_ADMIN_USER_ID   -> moves with session-start
L2535  settingsViewer  the one that must stay
```

**Do not verify this with the old grep.** Use `bun run audit:ambient-principals`
and read the USAGE DELTA, which must be exactly **0** across a pure move. The raw
line count will rise by one per new module that needs the import — that is an
artefact of the file boundary, not a finding. Baseline is 41 usage sites; the 77
that circulated was a line grep that was wrong three separate ways (see the
census header).

*Hazard:* `createSession` calls `spawn`. Keep them in the SAME module — splitting
them puts a call across a new boundary for no gain, and `spawn` is not
independently meaningful.

**2. `session-teardown.ts` — MEASURED at 557 lines, 12 methods.** Prepared in
detail below; the cut itself is mechanical from here.

```
 128  stopSession                    99  hibernateSession
  94  stopIssue                      48  tryAutoArchiveStoppedObserved
  41  killSession                    39  removeSessionRuntime
  39  emitSessionExited              25  parkArchivedSession
  13  killStoppedSession             12  finalizeDeferredStopKill
  12  maybeReapDraftIssue             7  sessionRemovalSpecs
```

Six of the twelve call each other and must move together: `stopSession`,
`killStoppedSession`, `removeSessionRuntime`, `sessionRemovalSpecs`,
`emitSessionExited`, `maybeReapDraftIssue`.

**The 19 ports that cross the boundary** (measured, not guessed): autoContinue,
broadcastSessions, bus, clients, daemonProjection, deps, listSessions, machines,
now, rearmUnread, repository, rpc, sessions, setArchived, state, store,
terminalProof, toMachine, view.

**THE SURVIVAL TABLE — put this in the module header.** These four operations
differ ONLY in what survives, and a reader who cannot see the difference will
collapse two of them:

| operation | process | worktree | branch | transcript | row | resume ref |
| --- | --- | --- | --- | --- | --- | --- |
| `hibernateSession` | killed | **kept** | kept | kept | kept | **required** — refuses without one rather than silently becoming a kill |
| `stopSession` | killed | **freed** when safe | kept | kept | kept | kept |
| `stopIssue` | all killed | freed | kept | kept | kept | kept |
| `killSession` | killed | — | — | kept | **tombstoned** | — |

**ORDERING CONTRACT inside `killSession`, load-bearing (#247):** the durable
tombstone commits FIRST, live teardown after. A commit throw must leave the
session fully alive — still in the map, clients attached, PTY not signalled —
and propagate to the caller, rather than tearing down live state for a row the
rolled-back transaction still holds. The remove change also commits in the SAME
transaction as the tombstone ([spec:SP-3fe2]) so the durable change log can
never say something the sessions table does not. Reversing either is invisible
to types and to a passing build.

*Hazard:* `hibernateSession` consumes the terminal proof — keep it a **reader**
of `terminal-proof.ts`, never a second judge.

**3. `session-revival.ts` (~260 lines).** `resumeSession`, `resurrectSession`,
`finishResurrect`, `handoffSession`, `handoffs`, `findLiveByResume`. One job:
bring an existing session back, locally or on another machine.

**4. `wiring.ts` (~372 lines).** The constructor. Do this **last**: every cut
above shrinks it, so doing it first means doing it twice.

*Hazard, and the reason this one is last rather than first:* construction order
is a real contract, and `scripts/server-construction-order.ts` only walks the
**relay** root — it will not catch a reordering inside this constructor. **That
blind spot is now tracked as POD-1411**, because it is a gap in the instrument
the gate cites for ordering, sitting directly beneath a 372-line block with real
ordering semantics. Until it closes, nothing is watching this constructor.

Therefore: extract as a builder returning the collaborator set, and change **no
ordering** in the same commit as the move. Say so explicitly in the commit
rather than letting a green generator imply a check it did not perform.

Landing all four leaves a facade of delegations plus small methods, roughly
400–600 lines, which is at or under the signal.

## The rule this file exists to keep

Do not ledger-exempt any of this to force the audit to zero. A 2700-line
`lifecycle.ts` talked into `cohesive-owner` would be the exact disease the
instrument was built to detect, committed by its author. If a residue genuinely
is a justified exception, argue it **with the predicate** — and note that the
`operation-surface` predicate refuses any file with one method over 180 lines,
which today the constructor alone violates.

## Verification bar for each cut

Established over the five already landed, and worth keeping:

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
   async work. None of the five so far did — but that was checked, not assumed.
   POD-1390 proved this is where a split silently drops behaviour.
6. **GREP FOR THE OLD PATH IN THINGS THAT NAME IT, not just things that import
   it.** Two separate instruments have now caught the same side effect of these
   cuts, and neither typecheck nor any test can see it:

   - `scripts/boundary-allowlist.ts` — a per-FILE exemption does not travel with
     an extracted import. Moving `@podium/harness` imports into new paths made
     `lint:boundaries` red while the design was unchanged.
   - `packages/model/src/representations/registry.ts` — a representation entry
     names a declaration SITE. Moving `SessionSpawnResult` left the entry
     pointing at a module that only re-exported it, and **a re-export is not a
     declaration**. `audit:rearch` caught it as registry rot.

   So after each cut: `grep -rn '<old/path>' scripts/ packages/ docs/` and check
   allowlists, registries and ledgers. The rule of thumb is that anything keyed
   by a PATH rather than by a symbol will rot silently when the path changes.

## Two files whose lane verdict is ORDER-DEPENDENT

Fixed as of `dfa58a4f` — `oracle-authz.test.ts` is 29/29 again and a red there is
now a real signal. But POD-1394 measured both of these as order-dependent, in
*opposite* directions:

| file | scoped | in a full lane |
| --- | --- | --- |
| `modules/sessions/oracle-authz.test.ts` | red | green |
| `wsServer.client-auth.test.ts` | green | red |

So **a green on either file inside a multi-file run is not evidence about that
file.** If a count you are quoting hinges on either, re-run it standalone. Both
were verified standalone at `6c56bbf0`: 29/29 and 7/7.

This does not affect the decomposition. It affects how you read your own lane
output, which is the more dangerous of the two.

## Known coverage hole — do not build on it

`oracle-handoff.test.ts` advertises the rollback contract and does hold it, but
`await sleep(SOURCE_RELEASE_MS)` can be **deleted entirely with 25/25 still
green**. Tracked as POD-1409. `handoff/coordinator.ts` (POD-1399) must not be
restructured until that assertion exists — a falsified oracle is not a safety
net.
