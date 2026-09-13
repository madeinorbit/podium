# Phase B's rows of the read census — a disposition for each one

PDM-253, under PDM-230 (A3.2).

**Re-derived at OSS `issue/pdm-107-multi-user` = `0716b67b97a1f40c4a86e0cae662b40b0cc53a64`**, which
is exactly the commit the cloud gitlink on `issue/107-multi-user-architecture` =
`25f30f25cb81a726a4924bb4d24a30685dc0e317` pins. Both resolved from the remotes rather than taken
from a brief. The first pass was written at `fe8a3ce84`, 46 OSS commits earlier; every row below is
re-read against the current tree, not carried.

## Why this document exists

The phase A reviewer refused to let PDM-230 block only the F review: rows owned by an earlier
phase have to be verified before THAT phase closes, and "a later phase will handle it" is not a
disposition. This is phase B's half of that obligation, by row.

## The population, re-derived rather than inherited

The brief quotes **19 ungoverned reads of 69**. That figure was dead before this issue started.
A5.4/PDM-248 rebound discovery to `appRouter._def.procedures` and the real surface is **108 served
tRPC reads — 32 classified by a command definition elsewhere, 76 owned by the census**. Of those
76, A5.4 carried forward **22** findings, **14** of them marked `owner: 'B'`.

Fourteen is the set this issue owns. Each one was read against its shipped handler.

**The census now stands at 65 governed / 11 findings**, unchanged in totality at 76. Across the
phase, nine rows were corrected as never having been defects — each disproved by deleting the cited
rule and watching a named test redden, not by argument. Eight of those nine were this issue's.

## The result

**Eight of the fourteen were not ungoverned.** A5.4 repaired the census MECHANISM — which reads
exist, and that the lists are total against the router. It did not re-read the CONTENT of the
findings it carried, and eight did not survive being read.

**Six remained, and all six were `discloses-private-execution`.** Phase B's read gap stopped being
a mixed list where the urgent rows wait behind the tidy ones.

**Three of those six have since closed. Three remain, and they are one issue.** `sessions.status`
(PDM-229) and `accounts.list` (PDM-271, completed by PDM-280) were real defects and are fixed.
`conversations.search` (PDM-274) turned out not to be a defect at all — it was governed the whole
time, three hops below a one-line forwarding method. What is left is `files.read`, `files.list` and
`files.search`, all three carried by PDM-272, which is in planning.

---

## By row

### Still open — the three that remain

| Row | What the handler does | Disposition | Owner |
|---|---|---|---|
| `files.read` | `modules/files/queries.ts` — three arms. The `artifactId` arm reads any issue's artifact by id. The `sessionId` arm takes neither guarded branch and reaches `state.rpc.readFile` with no ownership check and no root check. The `root` arm calls `assertAllowedRoot`, which asks whether the path is a known repository — a rule about PATHS, not about PEOPLE. | **Open.** PDM-272, stage `planning`. Blocks the B review. | PDM-272 → B3 |
| `files.list` | Directory listing on a named machine, `assertAllowedRoot` only. | as `files.read` | PDM-272 → B3 |
| `files.search` | Content search across a root on a named machine, `assertAllowedRoot` only. | as `files.read` | PDM-272 → B3 |

PDM-272 is deliberately **not** being closed one arm at a time. It is the tRPC transport over the
same bytes that PDM-261 (`GET /files/artifact/…`) and PDM-262 (`GET /files/asset`) expose over raw
HTTP. Closing one door of three would build the two-transport defect that the exposure check below
exists to find.

### Closed since the first pass — three of the six

Re-read against the current tree rather than believed from a handoff.

| Row | What happened | Verified how |
|---|---|---|
| `sessions.status` | **Was a real defect; fixed.** PDM-229 landed the ownership assertion. Its census row now records `mayReadSession` plus a rule the original finding did not reach: the caller-supplied REF is resolved exactly once, so the id that is checked is the id that is projected — a second resolution could authorize one member of an issue and describe another. | Row moved to `PROJECTION_POLICIES`, `caller-only`. |
| `accounts.list` | **Was a real defect; fixed.** PDM-271 — the issue this register filed — scoped both arms through `machineIdsUsableBy`, one answer per call, reusing `machine-access.ts`'s own `checkMachineUse` rather than restating it. PDM-280 then gave the managed credential slots an owner column, so `caller-only` is literally true of every row rather than true only of the rows that name somebody. | Refusals observed in `modules/accounts/list-scope.test.ts` and `native-login.test.ts`. One documented exception remains inside the row: the LEGACY `server_secrets` arm has no owner recorded anywhere to scope by. |
| `conversations.search` | **Was NOT a defect.** It was governed all along. `modules/conversations/trpc.ts` builds the service as `forReader({ kind: 'user', id: caller.userId })`, `modules/memory/search.ts` filters every candidate through `mayRead` and applies the limit AFTER the filter — so a row the caller may not read cannot consume a slot and reveal itself by absence — ending at `mayReadOwned`, the same rule `sessions.transcriptRead` applies to the same bytes. | A3.2 listed it ungoverned because the query table hands its three arguments straight to the service. The principal is two hops further down. This is the ninth finding in the phase to fall to reading past a one-line forward. Refusals observed in `search.test.ts`. |

**The pattern in that last row is worth more than the row.** Eight of this issue's fourteen, and
nine across the phase, were recorded as ungoverned by someone who stopped at the query table. A
read whose `run` is one call into a service is not an unscoped read; it is a read whose scoping is
somewhere else. That is now catalogue shape 21, "the row read only to its forwarding method".

### Corrected — the eight that were not ungoverned

The seven `workflows.*` rows were recorded as *"ownership is declared in `workflows/ownership.ts`
but not consulted by the read"*. That is false at this pin, on both served transports:

- every read ends at `WorkflowAccess` (`modules/workflows/handlers/context.ts:247`), whose
  `workflowDecision` (`packages/commands/src/workflows/ownership.ts:172`) denies a revoked human
  first, then owner wins, then explicit grant, then an admin floor, then denied;
- both transports carry a real principal — `workflowCaller`
  (`modules/workflows/trpc.ts:68`) throws `UNAUTHORIZED` without one, and the relay arm builds
  its caller from `principalForCapability` (`apps/server/src/relay.ts:638`);
- the shipped composition does **not** use the single-user ownership constant:
  `resolveOwnership` (`relay.ts:2146`) reads `store.workflows.ownerOf` and
  `store.grants.listForResource` per pass, absence being denial.

| Row | Where the decision is taken | Disposition |
|---|---|---|
| `workflows.list` | `service.ts:240` keeps only rows `canReadWorkflow` allows | moved to `PROJECTION_POLICIES`, `caller-only` |
| `workflows.get` | `service.ts:251` → `assertWorkflowRead`, one site and one message for "no such" and "not yours" | moved, `caller-only` |
| `workflows.bindings` | `service.ts:269` → `visibleBindings` | moved, `caller-only` |
| `workflows.profiles` | `service.ts:280` → `visibleProfiles`. The census row's own worry — that a profile carries machine placement and an `accountId` naming a managed credential — is recorded as the policy's `indirectResources`. | moved, `caller-only` |
| `workflows.runs` | `service.ts:360`; both arms end at `canSeeRun` | moved, `caller-only` |
| `workflows.status` | `service.ts:611` → `runFor` (`:591`) → `canSeeRun`, refusing unknown and unreadable with the same throw | moved, `caller-only` |
| `workflows.prime` | `service.ts:615` — scoped by CONSTRUCTION: it renders the live run of `caller.actor.id` and takes no input naming another run | moved, `caller-only` |
| `machines.list` | `router.ts:412` → `visibleMachinesFor` (`modules/sessions/command-ctx.ts:152` → `:170`): `canSeeMachine` filters the rows, `machineUseDecision` attaches each `use` answer | moved. Its own finding conceded *"the rule is right and its HOME is wrong"*; the ungoverned list means a read with NO reader scoping, and this read has one. The rule now has a home. |

The refusals are observed, not argued. `apps/server/src/modules/workflows/multi-user.test.ts`
asserts *"refuses one member READING another member's workflow, and honours an explicit grant"*
and *"does not list another member's RUNS, BINDINGS or PROFILES"*, each with the counterfactual
that the owner is allowed through the same call. 14/14 green at this pin (command below).

### Structural note carried forward, not a reader-scoping gap

`machines.list` is still the one hand-written read in `router.ts`. That is a question about where
a procedure lives, not about whether it scopes, and it belongs to B2 (PDM-134), whose boundary
covers `machine-access.ts` and the fleet/machine modules. It is recorded here so the move does
not lose it.

### Rows this phase does NOT own, and why that was checked

The owner field was not taken on trust. The test applied is the coordinator's: which phase's
declared write set covers the module the read lives in.

- `sync.changesSince` / `sync.feedChangesSince` / `sync.feedSlice` — owner C. The synthesised
  feed-principal fallback is the seam C4 (PDM-144) replaces; the execution charter's exposure
  order forbids touching it in B.
- `cloud.capabilities` / `cloud.runtime` — owner F. `modules/cloud` is in no B spec's boundary.
- `updates.fleet` / `operations.active` / `operations.history` — owner F. Worth stating because
  `updates.fleet` is a read over MACHINES and machines are B2's subject: the read itself lives in
  `modules/updates` and `modules/operations`, which no phase-B spec claims. The owner stands, but
  it stands on the module boundary rather than on the subject matter, and the B review should not
  read this line as agreement that a fleet-wide machine read is safe.

---

## What was changed, and what a green here does and does not prove

One file: `packages/commands/src/projections/census.ts`. Eight rows moved from
`UNGOVERNED_PROJECTIONS` to `PROJECTION_POLICIES`; the header arithmetic goes 54/22 → 62/14; a
`TRPC_RELAY` exposure constant is added because the seven workflow reads are the only census rows
served on a second transport and a policy understating its exposure would be the false entry this
file refuses. Totals are unchanged: 62 + 14 = 76.

**`projection-census.test.ts` cannot check that a rationale is true.** It checks that the two
lists are total against the router in both directions, that no read is in both, and that each
policy is well formed. A row moved from findings to governed is a claim backed by the handler it
cites and by that handler's own tests — not by this file's green. That is stated in the census
header too, so nobody reads the green as verification.

Which is why the section above exists: seven of the eight moved rows are now backed by a test that
goes red when the cited scoping is deleted, and the eighth says plainly that it is not.

## Does anything fail if the scoping each row cites is REMOVED?

Asked by the PDM-107 coordinator in review, and it is the right question: the eight moved rows
rested on a reading of the code, and `projection-census.test.ts` cannot check a rationale. So the
scoping itself was deleted and the derived tests re-run. **Seven of the eight are verified by a
test that reddens by name. One is not, and is flagged rather than left to be discovered.**

### The break, for the seven workflow rows

In `packages/commands/src/workflows/ownership.ts`, `workflowDecision`'s owner arm, grant arm and
admin floor were replaced with a bare `return 'allowed'` — the revoked-human guard left in place,
so only the *scoping* was removed. Derived selection: the three test files that reference
`workflowDecision` / `canReadWorkflowEntity` (`multi-user.test.ts`, `engine.test.ts`, both store
shard; `contracts.test.ts` in `packages/commands`).

Result: **6 failed | 104 passed (110)**. Which failing test covers which row was read off the test
bodies rather than guessed — each row below names a test that calls that service method AND failed.

| Row | Verified | The test that reddens when the scoping is removed |
|---|---|---|
| `workflows.list` | yes | `DENIES an entity the resolved view does not carry`; `refuses one member READING another member's workflow, and honours an explicit grant` |
| `workflows.get` | yes | both of the above, plus `rebuilds the view on every pass, so a revoked grant stops working immediately` and `fails closed on a row nobody owns, for a member — and an admin can still reach it` |
| `workflows.bindings` | yes | `does not list another member's RUNS, BINDINGS or PROFILES` |
| `workflows.profiles` | yes | same |
| `workflows.runs` | yes | same |
| `workflows.status` | yes | same — that test calls `status` as well as the other three |
| `workflows.prime` | **NO** | **nothing.** See below. |
| `machines.list` | yes | `relay.test.ts > SessionRegistry > scopes machine bootstrap and broadcasts to each authenticated principal` |

### The one that is not verified, and why it is a different shape

`workflows.prime` has **no test anywhere that asserts a cross-user refusal** — no test in the
repository calls `WorkflowService.prime` with a second human at all.

But the deliberate-break method cannot be applied to it either, and that is the honest
characterisation rather than an excuse. Its scoping is not a predicate: `service.ts:615` renders
the live run of `caller.actor.id`, and the query takes **no input naming another run**. There is
no guard to delete, because there is no id with which to ask for someone else's row. The claim is
structural, so what is missing is not a guard with no coverage — it is an assertion that the
structure is what the policy says it is, which would go red if someone later gave `prime` a
`runId` parameter.

**For the B reviewer:** this row's rationale is unverified by any test. It is recorded here rather
than left to be found. Building that test is a phase B implementation task, not review work, and
is not done here.

### The machine break, and one negative worth recording

`machinesForPrincipal`'s `.filter((machine) => canSeeMachine(...))` was replaced with
`.filter(() => true)`.

- `apps/server/src/modules/machines/service.test.ts` — **45 passed, green.** The most obvious
  candidate does *not* cover it.
- `apps/server/src/relay.test.ts` — **red**, at `scopes machine bootstrap and broadcasts to each
  authenticated principal`, `AssertionError: expected 3 to be 2`. The test seeds three machines
  and asserts the admin sees two of them and the member sees a different two; unfiltered, both see
  all three.

`authz-matrix.test.ts` asserts `canSeeMachine` **as a predicate** but never calls the projection,
so it would not have caught this — testing the rule and testing that the rule runs are different
checks, and only the second one was in question here.

### Two inherited reds found while doing this

`relay.test.ts` fails two tests that have nothing to do with any of this:
`hibernation > hands a live busy Grok ledger send to exit recovery and the next bind` and
`codex app-server first-prompt delivery [POD-2291] > a prompt sent during the starting window
delivers through the contract on bind — never as PTY bytes`.

Attributed by baseline **at the branch point**, not at this tree: `census.ts` was checked out at
`fe8a3ce8474f970fdafeef3bb695a86ac020d7c8` so the tree was byte-identical to the pin for every
file `relay.test.ts` reaches, and the same two tests failed with the same assertions. The set
difference against the probe run is exactly the one test the probe was supposed to break, and
nothing else. 209 tests reported against 209 `it(` blocks in the file, so this is not a crashed
worker reporting absence as green.

**Filed as PDM-279, and it was a DUPLICATE — my premise was wrong.** I wrote that the boundary shard
had been reported green in this epic. It has not: phase A's acceptance receipt records it as
1658 passed / 20 failed / 1 skipped / 1 unfinished / 2 errors, and both of my names are already
rows 2 and 3 of PDM-231's roster at
`docs/plans/multi-user-epic/A/A3-3-boundary-shard-red-roster.md:101-102`, with the same assertions
and analysis already written. The roster was on my own branch the whole time. **Grep the roster
before filing an inherited red.**

What survives is not the finding but the confirmation: two of those twenty were re-derived
independently — different phase, different method, byte-identical tree at the pin — and produced
exactly the same names and assertions. That is the roster checked from outside for the first time,
which is what phase A's attribution discipline was for.

## The exposure field is wrong on seven rows, and that is the POD-3900 shape

Asked by the PDM-107 coordinator to check their own two edits rather than assume them. The two
edits are right. Checking whether they were COMPLETE found something bigger.

**What they did.** POD-3900 found `sessions.status` and `sessions.read` gating on the target ISSUE
over the relay where tRPC gated on session OWNERSHIP — a colleague with issue write received the
full payload D13 gives only an owner. Both rows had said `exposure: TRPC`. They are now
`TRPC_RELAY`, and `sessions.recap` was deliberately left `TRPC`.

**Their edit is complete for that family, and that is checked, not assumed.**
`RELAY_ALLOWED.sessions` (`modules/issues/relay-gate.ts:44`) is
`{sendText, resumeAndSend, continue, status, read, title, stop, handoff}`. The only READS in it are
`status` and `read` — exactly the two changed. `recap`, `transcriptRead`, `list` and
`activityHistory` are genuinely absent, so their `TRPC` is right.

**But the same question asked of the whole census finds seven more rows with the same wrong tag.**
Every census row name was matched against `RELAY_ALLOWED` and then against the actual dispatch arms,
because an allowlist entry is permission to route, not proof that anything serves it — a permitted
pair with no arm returns `NO_SUCH_PROCEDURE` and is not served at all. All seven have real arms.

| Row | Declared | Relay arm | Do the two gates agree? |
|---|---|---|---|
| `machines.list` | `TRPC` | `relay-dispatch.ts:220` | **Yes** — calls the SAME `visibleMachinesFor(modules(), capability)` the router calls, inheriting the projection rather than restating it |
| `features.state` | `TRPC` | `:181` | Yes, vacuously — `rowScope: 'instance-wide'`, instance configuration, no rows |
| `quota.summary` | `TRPC` | `:184` | Yes, vacuously — `rowScope: 'instance-wide'`, an instance fact |
| `specs.list` / `specs.get` / `specs.search` | `TRPC` | `:240`, `specs: null` so every proc | Yes, vacuously — `rowScope: 'instance-wide'`, repository material both sides |
| `repos.inferFromPath` | `TRPC` | `dispatcher.ts:87` | Yes, vacuously — `rowScope: 'none'`, answers from its argument |

**Seven wrong tags, zero authorization defects.** Six are `instance-wide` or `none`, where there
are no person-rows for a second transport to leak. The seventh, `machines.list`, is `caller-only` —
the scope where a divergent second gate is exactly the POD-3900 defect — and its relay arm inherits
the same projection, verified by reading it rather than by trusting its comment.

**So why fix a tag that hides no bug?** Because the census's own `sessions.status` rationale now
says it, in the coordinator's words: *"an exposure tag naming one transport makes the other one's
gate unaskable, so record every transport that serves a read even when their gates agree."*
`sessions.status` did not hide a divergent gate because someone chose to hide it. It hid one
because nobody could ask the question — the row said there was only one transport. Six of these
seven agree today. Nothing in the instrument would notice the day one stopped.

**What I changed and what I did not.** `machines.list` is this issue's own row and is corrected here
to `TRPC_RELAY`, with the inheritance recorded. The other six belong to other rows and other
owners, and the coordinator holds the census slot, so they are filed rather than edited.

**The durable fix is not six edits.** `projection-census.test.ts` derives the read population from
`appRouter._def.procedures` — the dispatch table tRPC actually routes on — which is why a missing
row is now unrepresentable. Nothing does the equivalent for the relay: `RELAY_ALLOWED` and the
dispatch arms are a second served surface that no instrument compares against the census. Deriving
`exposure` from those two the way the population is derived from the router would make this whole
class unrepresentable instead of found by hand twice. That is an implementation task, named here,
not built here.

## Evidence

Source SHA for the counterfactual runs below: OSS working tree at
`7dc64bbe20bd5fd62579c8497db6467d6d567622`, cut from `origin/issue/pdm-107-multi-user` at
`fe8a3ce8474f970fdafeef3bb695a86ac020d7c8`. Those runs are NOT re-executed for the re-derive pass
and are not claimed to have been: the eight rows they verified are unchanged in the current census,
and `git log` shows no commit touching this register between `8789a14c2` and
`0716b67b97a1f40c4a86e0cae662b40b0cc53a64`. The re-derive pass re-reads the census and the relay
surface at `0716b67b9` and re-runs the census gate there; that run is recorded separately below.

Selection was DERIVED, not chosen: `packages/commands/src/projections/census.ts` is imported by
exactly one test in the repository, `apps/server/src/projection-census.test.ts` (boundary shard).
A compiler lane is required as well, because this is a typed data table in an L1 package and a
shape error in it is the "type error no test run can see" shape.
`modules/workflows/multi-user.test.ts` (store shard) is run as EVIDENCE FOR THE CLAIM the change
encodes, not as a gate on the change.

| Command | Exit | Result |
|---|---|---|
| `bun run typecheck -- --filter @podium/commands --filter @podium/server --concurrency=1` | 0 | 12 tasks, `@podium/server` a cache MISS that executed |
| `bun run --cwd apps/server test:boundary src/projection-census.test.ts` | 0 | 17 passed / 17 (reconciles with 17 `it(` in the file) |
| `bun run --cwd apps/server test:store src/modules/workflows/multi-user.test.ts` | 0 | 14 passed / 14 (reconciles with 14 `it(` in the file) |

No baseline set-difference is quoted because no test failed at any point in this work; the two
files above were green before the change and after it. No shard-wide or package-wide lane was
run, and no heavy lease was taken.

### The re-derive pass, at `0716b67b9`

Selection derived the same way: `census.ts` is imported by exactly one test, and it is a typed L1
data table so it needs a compiler lane. One row changed (`machines.list` exposure), so no other
lane is justified and none was run.

| Command | Exit | Result |
|---|---|---|
| `bun run --cwd apps/server test:boundary src/projection-census.test.ts` | 0 | 17 passed / 17, reconciling with 17 `it(` in the file |
| `bun run typecheck -- --filter @podium/commands --filter @podium/server --concurrency=1` | 0 | 12/12, `@podium/server` a cache MISS that executed |

Window: load average 4.98, 14 GB available. No heavy lease taken because neither lane is a shard or
a package run.

**What this green does NOT cover, again.** The `machines.list` exposure change is a claim about
which transports serve a read. `projection-census.test.ts` never reads `exposure` — nothing does.
The evidence for that row is `RELAY_ALLOWED.machines` containing `list` and `relay-dispatch.ts:220`
serving it, both read directly, and that is precisely the gap the last paragraph of the exposure
section asks someone to close with an instrument.

### Both instruments proved by deliberate break

A green from an instrument that cannot fail is not evidence, so each was broken on purpose and
restored.

1. **The census gate is live for the kind of edit made here.** `machines.list` was planted back
   into `UNGOVERNED_PROJECTIONS` while also governed. Result: `1 failed | 16 passed`, failing at
   `projection-census.test.ts:364` in `puts every read in exactly one list`, with the read named:
   `expected [ 'machines.list' ] to deeply equal []`.
2. **The compiler lane really sees this file.** `workflows.status` was given
   `roleFloor: 'supervisor'`. Result: `@podium/commands:typecheck` went from cache hit to **cache
   miss, executed**, and reported
   `src/projections/census.ts(832,5): error TS2322: Type '"supervisor"' is not assignable to type 'RoleFloor'`.
   This was done specifically because the first typecheck reported `@podium/commands` as a cache
   HIT, and a cached green over a changed file is worth nothing until it is shown the cache key
   moves.

After both, `git status` was empty against the commit and both lanes were re-run green
(typecheck FULL TURBO 12/12, census 17/17).

### One lane that was abandoned rather than reported

The first attempt ran the whole root `bun run typecheck` (26 packages). Three packages —
`@podium/server`, `@podium/daemon`, `@podium/scripts` — were killed with **exit 137 (SIGKILL,
out of memory)** on a box under load average 23. That is a resource kill, not a type error, and
it is not reported as a failure of this change. It was replaced with the two-package filtered run
above, which is also the narrower lane this change justified in the first place.
