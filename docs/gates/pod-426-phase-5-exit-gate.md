# POD-426 Phase 5 exit gate — host tightening

**Gate run:** 2026-08-02
**Final candidate:** `3b6017e17dd9c921ccdc91f50433aaa7e90c5941` (verified by
`git merge-base --is-ancestor 3b6017e1 HEAD`, not by report)
**Earlier passes:** `c3b8247e`, then `a573534c`. Integration advanced twice mid-run.
Anything labelled **measured-at-`a573534c`** was not re-derived at the final candidate; the
four items that were re-run are marked.
**Verdict:** **PASS — all eight POD-292 criteria met. Phase 7 entry is unblocked.**

The gate was HELD OPEN through two candidates on criterion A8: a Phase 5 child shipped a
durable store on no ownership-matrix entry. POD-1477 closed it at `3b6017e1` by **classifying
the store rather than exempting it**, and this gate verified the classification against the
code rather than accepting a quiet audit. All eight criteria now pass, each on an instrument
proved able to refuse.

Two lane failures remain and **neither falsifies a POD-292 criterion**; both are recorded with
their reasoning under "Reds that do not block" below. They do mean the workspace unit lane
cannot yet be called green — that is a separate claim from the phase verdict, and this
document does not conflate them.

The 48h remote-daemon soak is **excluded** from this gate by the human ruling of
2026-08-02: POD-327's code is merged and closed, and the soak is refiled as POD-1463
under Phase 7 with its precondition (a complete second instance on another box) recorded.
Its absence is not counted as an open Phase 5 item.

## Evidence convention

Per the 2026-07-17 ruling, integrator landing results at the candidate SHA are cited
rather than re-derived. This gate ran the genuinely untested: deliberate-violation probes
against production code, an environment-neutrality check, and the assembled-phase lanes
that no child ran — Phase 5 had been graded only child by child.

Every exit code below is the **real** exit code of an unpiped command.

## Environment neutrality

The worktree arrived uninstalled. `bun run typecheck` **refused** rather than reporting a
cached green:

```text
typecheck refused: node_modules/@podium has no usable workspace links — this checkout is
not installed, and a cached green here would not be evidence (POD-1343). Run `bun install` first.
exit 1
```

This is POD-1343's repair working, and it is the reverse of the POD-425 failure mode. After
`bun install --frozen-lockfile` (1338 packages, exit 0):

```text
bun run typecheck                        # first pass, c3b8247e
 Tasks:    22 successful, 22 total
Cached:    20 cached, 22 total
exit 0

bun run typecheck                        # rebased tip, a573534c
 Tasks:    22 successful, 22 total
Cached:    22 cached, 22 total    >>> FULL TURBO
exit 0
```

## POD-292 acceptance criteria, graded against the tree

| # | Criterion | Verdict |
| --- | --- | --- |
| A1 | SessionBinding owns alias lifecycle with history; crash-recovery + concurrent-reattach tests pass | **PASS** |
| A2 | Zero sync/async twins; corrected harness axiom at error level; one manifest per CLI (audit items zero) | **PASS** |
| A3 | State pipeline consumes source+confidence provider events; needs-attention e2e green for all five agents | **PASS** |
| A4 | Scar tissue relocated verbatim and registered (soak excluded per POD-1463) | **PASS, with no instrument** |
| A5 | SessionBinding carries the delegation triple with history; no rights/capability snapshot on the host | **PASS** |
| A6 | Placement and handoff fail closed against machine use; unauthorized distinguishable from unreachable | **PASS** |
| A7 | Controller identity and PTY input attribution ship via POD-1081, take-control policy decided | **PASS** |
| A8 | Per-machine facts published by this phase are scoped to the machine, not tenant-visible | **PASS** (was FAIL; closed by POD-1477 at `3b6017e1`) |

### A1 — binding lifecycle with history · PASS

Six suites, **87 tests, exit 0** across two vitest projects (5 files / 76 tests in `node`;
`packages/sync/src/conformance/binding.test.ts`, 11 tests, in `normalized-wire` — it does
not run in the `node` project, and a single-project invocation would have silently omitted
it). `apps/daemon/src/binding-store.ts` carries `delegationHistory` and observation history
with explicit `retire` transitions and a `binding-retired` rejection state, so the lifecycle
is a state machine with history rather than a scalar record.

### A2 — zero twins, axiom at error, one manifest per CLI · PASS

All three Phase 5 items in `bun run audit:rearch` measure **zero sites**:
`durable-host-sync-async-twins` (POD-324) = 0, `capability-tables` (POD-325) = 0,
`oversized-daemon-composition-root` (POD-327) = 0. Whole-audit result: **exit 0, 32 items /
113 sites, baseline exact.** `@podium/agent-bridge` has **zero** references in the workspace;
`packages/pty` and `packages/harness` both exist.

The manifest registry is `Record<BuiltinHarnessKind, AgentManifest>` over the closed
five-member `HarnessAgent` enum — one manifest per CLI, total at compile time, not by
convention.

`bun run lint:boundaries` is **exit 0**, verdict line `boundaries OK — 6 allowlisted, 0 new`.
The six printed `[agent-host-consumers]` lines are allowlisted warnings, not failures.

### A3 — source+confidence state channels, all five agents · PASS

`tests/e2e/state-channel-attention.e2e.test.ts` is **exit 0**. It iterates the real
`AGENT_MANIFESTS` registry rather than a hardcoded list, drives each provider's declared
`stateChannels[0].source` through `reduceAgentState`, asserts exactly five attention events,
asserts the non-owner received **nothing**, and asserts that a session with unknown ownership
produces no broadcast — attention fails closed to a person, with no ambient operator inbox.

### A4 — scar tissue relocated and registered · PASS, with no instrument

Every row of the `docs/rearchitecture-v3.md` section 7 registry resolves in the tree; the
rows for the relocated hosts were updated from `agent-bridge` to `packages/pty`, which is
the registration the criterion asks for. The verbatim claim checks out under git rename
detection on the extraction commit `85e2f76d`: `abduco-bin.ts` and the backend files moved
with **0 changed lines**, `abduco.ts` with 6 (import paths). The `systemd-run --scope` scar
survives in `packages/pty/src/abduco.ts`.

**Finding — no instrument exists for this criterion.** "Relocated verbatim" is attested by
prose and by each scar's own test; nothing fails if a future move rewrites a scar while
keeping its test green, and nothing fails if a registry row goes stale. One row is already
imprecise: the registry cites `bun-terminal-detect.bun.test.ts` under
`packages/pty/src/backends`, but the file lives at `packages/pty/test/pty-behavior/`. What
would have to exist: a check that every section 7 row resolves to a real file and test path,
run in the lane. This gate verified it by hand; the next one has no reason to.

### A5 — delegation in the binding, no rights snapshot on the host · PASS

`apps/daemon/src/session-binding.ts` serializes the triple — `actor`, `onBehalfOf`,
`grantedScope`, `parentBindingId` — inside the binding boundary. `binding-store.ts` enforces
the no-snapshot rule at **runtime**, not by convention: `assertNoAuthoritySnapshot` walks
every parsed record and throws `BindingStoreAuthoritySnapshotError` on any key matching
`/capabilit|effectiveright|rights?|permission|privileg|entitlement|grant|role|acl/i`, with
`grantedScope` the single permitted exemption because it is the declared left operand of live
authorization rather than its resolved result. The store rejects a planted snapshot **without
rewriting the file's bytes**.

### A6 — placement and handoff fail closed · PASS

`apps/server/src/modules/sessions/oracle-handoff.test.ts` carries MUST-NOT-CHANGE oracles
that are exactly this criterion, and they are better than the criterion asks:

- a caller who may use the source but not the target is refused with
  `you do not have access to run agents on machine 'target'`, **and** the session is asserted
  not to have moved and neither daemon to have received a `handoffImportRequest` — the
  silent-retarget probe;
- invisible and nonexistent machines are refused with the **same** message, asserted as a
  string **equality** between the two paths rather than two independent literal checks that
  could drift apart while both stayed green;
- an authorized-but-offline target answers `target machine is offline`, with only
  reachability differing from the passing case, so unauthorized and unreachable are provably
  different answers rather than one empty list.

### A7 — controller identity, PTY attribution, take-control policy · PASS

POD-1081 landed `session-control-policy.ts` (196 lines), `session-control-identity.test.ts`,
`session-control-policy.test.ts` and `docs/design/session-control-identity.md` — the
take-control policy is decided in a committed document, not defaulted. PTY input attribution
is stamped from the **transport** principal (`inboxPrincipalFromClient(principal)`), and
`session-control-identity.test.ts` carries `payload attribution is inert — transport
principal wins (ADR 3 D7)`, asserting the forged payload identity is not even threaded
through.

### A8 — per-machine facts scoped to the machine · FAIL

The half that passes: the live model catalog is keyed by `machineId`
(`apps/server/src/model-catalog.ts`), per POD-1123, and says so in its header — which models
a harness offers is a fact about a specific machine.

The half that fails: **`bun run audit:durable-classes` is exit 1** at the candidate.

```text
durable-class audit: every check found its planted fixture and spared the clean one
durable-class audit: 1 finding(s)
  write-site-unaccounted  apps/server/src/enrollment-ledger.ts
      This module writes durable bytes (filesystem or database) and appears on no
      DURABLE_STORES entry and in no NON_CLASS_WRITE_SITES entry.
exit 1
```

`apps/server/src/enrollment-ledger.ts` arrived with POD-1114 (pairing durability across
server data loss), a Phase 5 child. It holds per-machine pairing and enrollment facts — the
exact class A8 governs — and it has **no declared visibility class and no declared owner**.
A8 asks that per-machine facts be scoped to the machine; an unclassified durable store has
not been scoped at all, it has been left undeclared. The same landing also regresses the
Phase 1 guarantee POD-423 closed on (every durable store on the matrix or explained).

Note that the audit's own `--probe` pass is **green in the same run** — the instrument found
every planted fixture and spared the clean one. This is a true positive on the real tree, not
a detector defect.

Filed as **POD-1477 (Enrollment ledger off the ownership matrix)**, parented under POD-292,
`discovered-from` POD-426. (First filed bare as POD-1475, which stranded in the Proposed lane
where no agent can close it; the coordinator re-homed it and re-pointed the blocking edge. A
blocking edge into Proposed can never clear — worth knowing before filing another.)

#### How A8 was closed, and why this gate believes it

POD-1477 landed at `3b6017e1` and took the **matrix entry**, not an exemption — the answer
that had to be argued rather than the one that was easy. At the final candidate:

```text
bun run audit:durable-classes
durable-class audit: every check found its planted fixture and spared the clean one
durable-class audit: clean — 91 durable stores, every one on the matrix or explained
exit 0
```

A green audit is not by itself evidence for A8, because A8 is a claim about **which class**,
not about silence — a store classified tenant-visible would also have produced exit 0. So the
gate read the row and checked it against the code:

- `visibility: 'secret'`, `grants: NO_GRANTS_SECRET`, `replication: 'none'`,
  `offline: 'never-enqueue'`, `tombstone: 'never-delete'`. Its answer to "who may read this
  under multi-user" is **nobody** — stricter than A8 requires, so "not tenant-visible" holds
  a fortiori.
- The reasoning is the right one: the file holds the instance **pairing root**, the preimage
  every pairing token is MACed under, so one root compromises every machine rather than one.
  The serials, recorded owner and revocations take the same class **because they share the
  file** — sharing one durability domain with the root is the D19.4a correctness condition,
  so the store takes the strictest class present.
- `owner: { kind: 'none', reason: 'secret' }`, with the note answering this gate's finding
  directly: *"An unclassified store is not a scoped one, so this row is stated rather than
  inferred."* The per-machine facts it records **are** owned — their owner lives on `machine`
  (owned-compute), which this ledger is the durable source of, not a second copy of. Giving
  the ledger its own owner would create a second answer to "who owns this machine."
- **Verified against code, not just declared:** `apps/server/src/enrollment-ledger.ts` writes
  via `appendFileSync(path, line, { mode: 0o600 })`, append-only, at the state-root tier
  outside the server database; `grep` for `enrollment` across `packages/protocol/src` returns
  **zero** hits, so the "excluded from every wire projection" claim is true of the wire types
  and not only of the annotation.

**M9 — the fix's own instrument probed.** The sharpest failure mode here is a classification
that is declared in the audit script but not anchored to a real matrix row: a misspelled row
id resolves `personal` through `visibilityClassOf` and passes every classification test there
is. Pointing the store entry at `enrollment-ledger-no-such-row` produced a **different,
dedicated** check:

```text
store-names-a-row-that-does-not-exist  filesystem:<stateDir>/enrollment.ledger → enrollment-ledger-no-such-row
    The named matrix row is absent from OWNERSHIP_MATRIX_INDEX. A misspelled row id resolves
    `personal` through `visibilityClassOf` and passes every classification test there is;
    only a membership check can see it.
exit 1
```

Reverted, anchor grepped back, restored run clean at 91 stores. So the row is a real row, and
the membership check would have caught a misspelling. A8 is met.

## Instruments proven able to refuse

Every check cited above was mutated in **production** code, watched go red with the measured
quantity, reverted atomically with `git checkout -- <path>`, and grepped back. One mutant per
run; the worktree was verified clean (`git status --short` empty) after each revert, and the
restored run re-confirmed green.

| # | Criterion | Mutation | Red result | Restored |
| --- | --- | --- | --- | --- |
| M1 | A2 twins | Added `gateProbeListSessions` + `…Async` to `packages/pty/src/abduco.ts` | `audit:rearch` **exit 1** — `durable-host-sync-async-twins … baseline 0 → now 1`, site named `abduco.ts:559` | exit 0, baseline exact |
| M2 | A2 axiom | Added `if (agentKind === 'codex')` to `apps/server/src/relay.ts` | `lint:boundaries` **exit 1** — `NEW architecture-manifest violations (1): [harness-branching] apps/server/src/relay.ts:2168`, explicitly bypassing the allowlist | `boundaries OK — 6 allowlisted, 0 new`, exit 0 |
| M3 | A5 no-snapshot | Exempted `effectiveRights` in `assertNoAuthoritySnapshot` | `binding-store.test.ts` **exit 1** — `fails closed on a planted authority snapshot without rewriting its bytes` | 14/14, exit 0 |
| M4 | A3 attention routing | `this.deps.clients(ownerUserId)` → `this.deps.clients()` in `notify/service.ts` | attention e2e **exit 1** — owner/non-owner sets no longer disjoint | 1/1, exit 0 |
| M5 | A6 machine use | `verbs.has(verb)` → `verbs.has(verb) \|\| verbs.has('see')` in `machine-access.ts` | **exit 1 — 9 failed / 44 passed** across `oracle-handoff.test.ts` + `machine-access.test.ts` | 53/53, exit 0 |
| M6 | A7 PTY attribution | Dropped the `attribution` field from the daemon input frame in `sessions/terminal.ts` | **exit 1** — `session.test.ts > attributes accepted PTY input live and stamps it on the daemon frame` | 513/513, exit 0 |
| M7 | A8 machine keying | `snapshots.get(machineId)` → `snapshots.get('shared')` in `model-catalog.ts` | **exit 1 — 5 failed / 10 passed** | 15/15, exit 0 |
| M8 | A1 delegation retirement | `latest && !latest.retired ? latest : null` → `latest ?? null` in `binding-store.ts` | **exit 1 — 2 failed / 63 passed** across the binding suites | 65/65, exit 0 |

**M6 is the one to read twice.** POD-1081's own two suites — `session-control-identity` and
`session-control-policy` — stayed **green (22/22, exit 0)** with the attribution stripped from
the daemon frame. Only the full directory run caught it, in a third file. A reviewer who ran
"the tests POD-1081 added" would have certified a guard that was not holding. This is the
coordinator's warning about running the full `apps/server/src/modules/sessions/` directory,
reproduced under controlled conditions.

## Assembled-phase lanes

Phase 5 had never been run as an assembled thing. Both results below are new.

Every row below was run twice — once at `c3b8247e`, once on the rebased tip `a573534c` — with
identical results unless noted.

| Lane | Result | Exit |
| --- | --- | ---: |
| `apps/server/src/modules/sessions/` (full directory) | 45 files, **513 tests passed** | 0 |
| `bun run test:unit` (workspace) | 671 files, **9640 passed, 5 failed, 20 skipped** — the same three files both passes | **1** |
| `bun run test:bun:unit` (what CI invokes) | 14 passed | 0 |
| `bun run audit:rearch` | 32 items / 113 sites, baseline exact | 0 |
| `bun scripts/audit-ambient-principals.ts` | `FIRST_ADMIN_USER_ID: 41 usage sites (baseline 41)`, no drift | 0 |
| `bun run audit:machine-grants` | probe + repo clean | 0 |
| `bun run lint:boundaries` | `boundaries OK — 6 allowlisted, 0 new` | 0 |
| `bun run audit:durable-classes` | **1 finding** | **1** |
| `bun run audit:god-objects` | **1 item** on the rebased tip (2 at `c3b8247e`) | **1** |

### The three unit-lane failures

1. **`audit-durable-classes.test.ts`** — `enrollment-ledger.ts` off the matrix. Phase 5
   defect. **POD-1477.** Blocks this gate. Still open.
2. **`audit-god-objects.test.ts`** — `machines/service.ts` at 929 physical past its reviewed
   budget of 800. **POD-1458**, since closed by POD-1467 at `b9c6b79f`. See the verdict below.
3. **`terminal-view.scheme-notify.test.ts`** (3 tests) — all three die with the same
   `TypeError: undefined is not an object (evaluating 'this.dimensions.device')` inside
   `@xterm/addon-webgl`, raised from `setAppearance` before any assertion runs, so these
   tests currently assert nothing. Deterministic in isolation, so not the load-flake class.
   **Not attributable to Phase 5** — the WebGL usage, `forceRepaint` and `setAppearance` all
   predate the phase, and the test file's last three commits are transport refactors. Filed
   as **POD-1478**; does not block Phase 5 exit, but does keep the lane red.

## Verdict on POD-1458

**It does not block Phase 5 exit on its own merits, but it must close before the unit lane
is green.** Both halves matter, so stating them separately:

- Not a Phase 5 blocker: module size is a **Phase 4** criterion (the god-object audit under
  POD-291/POD-425), not one of POD-292's eight. The growth is additive enrollment work from
  POD-1114, the module's cohesion argument is unchanged in kind, and the item is already
  filed and triaged. Holding Phase 5 on a Phase 4 ratchet would be grading against the wrong
  criterion.
- But it is a red gate: `audit-god-objects.test.ts` fails on it inside `bun run test:unit`.
  Any claim that the workspace lane is green requires it closed. It must not be resolved by
  raising the budget silently — the ledger's own header says growth past a budget voids the
  review argument.

**Resolved after this gate ran, and resolved the right way.** The coordinator reports POD-1467
landed as `b9c6b79f`: `machines/service.ts` 929 → 695, with the credential lifecycle cut out
to `enrollment.ts` behind an `EnrollmentHost` port and the **budget left at 800** — decomposed,
not re-baselined. `bun run audit:god-objects` is reported **exit 0 with zero items** for the
first time. That is their measurement at `b9c6b79f`, not this gate's at `a573534c`; it removes
one of the three unit-lane failures below and will be re-derived at the re-gate SHA.

## Two evidence hazards this run found

**`bun run audit:god-objects` and the god-object unit test are not the same check.** The unit
test at `audit-god-objects.test.ts:196` explicitly filters `unexplained-god-object` out before
asserting, so the lane can only ever fail on `review-budget-exceeded`. The CLI reports both
kinds. Anyone citing "the god-object test passes" is not citing the CLI, and vice versa —
worth writing down, because this run caught the divergence live.

At the first-pass candidate `c3b8247e` the CLI reported **two** items: the budget breach plus
`unexplained-god-object` on `apps/server/src/modules/sessions/lifecycle.ts` (2510 physical /
1737 code, never any ledger entry). The unit lane showed only the first. On the rebased tip
the CLI reports **one**: POD-1396's `6001786a refactor(POD-1396): lifecycle under 600 after
teardown cut and further seams` landed mid-run and cleared it. The decomposition ran
2955 → 2510 → under 600 across the run. Recorded because it explains why two honest observers
minutes apart would have counted differently, not because it blocks anything — no POD-292
criterion bounds module size.

**`bun run test:bun` is not in CI and is red.** CI runs `test:bun:unit`; `ci.yml:132` records
that `test:bun` (compiled-daemon + lifecycle integration) stays out deliberately. Worth
naming in a host-tightening phase specifically, because `apps/daemon/test` — including the
real Bun-terminal PTY backend tests — is inside the excluded half. Its failures under a
hermetic `PODIUM_STATE_DIR` are a harness-isolation problem in that lane, not a Phase 5
regression, but the phase's own PTY backend has less automated cover than the lane list
suggests.

## POD-426's own named evidence

- `tests/e2e/browser/codex-identity-real.browser.e2e.ts` (POD-565) is present at the
  candidate. Not executed by this gate — it is a real-browser lane.
- Receipts crash durability (POD-737): `apps/daemon/src/binding-receipt-crash.integration.test.ts`
  is green inside the A1 run, and `binding-store.ts` retains unacked receipts in observation
  history with owner-scoped replay.
- POD-1081 (assertion 7) **landed** — evidenced under A7, not deferred.
- Instance isolation (assertion 8) is kept separate from per-user scoping throughout, per the
  KEEP-OUT: `scripts/multi-instance-runtime.integration.bun.test.ts` is the deployment-partition
  instrument, and nothing in the A5–A8 gradings cites it.
- The 48h soak is excluded by ruling and tracked at POD-1463.

## The re-run at the final candidate

Four items, as agreed. Everything else stays measured-at-`a573534c`.

| Check | Result | Exit |
| --- | --- | ---: |
| `bun run audit:durable-classes` | **clean — 91 durable stores**, probe green in the same run | **0** |
| `bun run audit:god-objects` | **clean — 26 modules**, every one carrying a reviewed exception | **0** |
| `apps/server/src/modules/sessions/` (full directory) | 45 files, **513 tests passed** | **0** |
| `bun run test:unit` | 673 files, **9654 passed, 11 failed, 20 skipped** | **1** |

The sessions directory result matters beyond its own criterion: POD-330 landed a machines
slice in this batch, so the gate checked whether it touched A6's surfaces
(`git diff --name-only a573534c..3b6017e1` filtered for `machine-access|handoff|oracle`
returned **nothing**), and `oracle-handoff.test.ts` is inside the green 513. A6 is therefore
**re-covered at the final candidate** rather than carried forward on trust.

## Reds that do not block the phase verdict

`bun run test:unit` is exit 1 with eleven failures in four files. None falsifies a POD-292
criterion. Graded individually, against the phase's literal acceptance text:

**1. `scripts/rearch-audit.test.ts` — 5 failures — THE MACHINE, not a defect.** These spawn
the CLI as a subprocess and assert its exit codes, so they are timing-shaped by construction.
Box load was 47–79 during the lane. Re-run in isolation twice: **1 failure, then 76/76 passed
at exit 0.** A 5 → 1 → 0 progression as load fell is the signature. Corroborated
independently: `bun run audit:rearch` invoked directly is **exit 0, 32 items / 113 sites,
baseline exact** — the audit's actual state is green, and only its subprocess harness
flickers. Attributed to load per the standing rule, and not counted against the phase.

**2. `scripts/visibility-mutability-inventory.test.ts` — 2 failures — REAL, and new.**
POD-1477 added the `enrollment-ledger` matrix row without regenerating
`docs/rearch-visibility-mutability-inventory.md`. The committed document still says
`45 of 78 classes` and contains **zero** occurrences of `enrollment-ledger`; the matrix now
has 79. Deterministic — the isolated run finishes in **1.2s** and fails both cases every
time, which is the opposite signature to item 1 and is why the two are attributed differently
rather than lumped as "lane noise". Filed **POD-1485** under POD-292.

*Why it does not block A8:* the failure is in a **generated document derived from** the
matrix, not in the matrix classification the criterion turns on. The row itself is correct,
anchored, and proven by M9. A8 asks that per-machine facts be scoped; they are. A stale
derived artifact is a real defect that must close, but it does not make the store
tenant-visible.

**3. `packages/terminal-client/src/terminal-view.scheme-notify.test.ts` — 3 failures —
pre-existing, not Phase 5's.** Established at the first candidate and unchanged: all three
die on a `TypeError` inside `@xterm/addon-webgl` raised from `setAppearance` **before any
assertion runs**, and every module in the stack predates the phase. Filed **POD-1478**.

### The ruling, stated plainly

POD-292's eight criteria are met. None of them says "the workspace unit lane is green" — they
name specific tests, specific audits at zero, and specific structural properties, and each of
those is satisfied and mutation-proved. Holding Phase 5 on POD-1485 or POD-1478 would be
grading against text the phase does not contain, which is the same error in the opposite
direction as passing a phase that did not deliver.

This is the identical reasoning applied to POD-1458 earlier in this gate and adopted by the
coordinator, now applied consistently to two items it happens to favour rather than only to
one it did not.

**Two claims, kept apart:** *Phase 5 delivered what POD-292 says it would* — **yes**.
*The workspace unit lane is green* — **no**, and it will not be until POD-1485 and POD-1478
close. Anyone quoting this gate as evidence for the second claim is misquoting it.

## What should close next

1. **POD-1485** — regenerate the visibility-mutability inventory. Mechanical, and it is
   Phase 5 fallout, so it should close before Phase 7 work builds on the matrix.
2. **POD-1478** — restore the colour-scheme tests to actually asserting. Not Phase 5's.
3. **POD-1481 / POD-1482** — the two instrument gaps this gate found (below).
4. ~~**POD-1458**~~, ~~**POD-1477**~~ — closed.

## Gaps filed rather than left in prose

- **POD-1481** (parent 1348) — the A4 lane check: assert every section 7 scar-registry row
  resolves to a real file and test path, with a `--probe` mode that plants a stale row and
  requires the check to fire. A criterion whose only instrument is a human reading carefully
  is not enforced.
- **POD-1482** (parent 1349) — `test:bun` red and out of CI, leaving the daemon's real
  Bun-terminal PTY cases uncovered in a host-tightening phase.
