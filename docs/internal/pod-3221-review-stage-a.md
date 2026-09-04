# POD-3221 Stage A conversion review (V3)

**Verdict: REPLAN. Checkpoint R2 must not proceed.**

The reviewed integration tip is `55039c2cffbbf4c97a4f7650511572d308506cfd`. I reviewed landed
commits and their diffs from the prior review point `885abb89a`, with the Stage A conversion
subrange identified as `75a0d6d6b..55039c2cf`. I did not rely on wave issue claims.

I read the five large repositories in full: `messages.ts` (1,079 lines), `workflows.ts` (752),
`sessions.ts` (1,156), `issues.ts` (1,383), and `shipping.ts` (2,912), 7,282 lines total. I also
read `accounts.ts`, `grants.ts`, `settings.ts`, and `modules/operations/store.ts` in full (968
lines), sampled the other small repositories, inspected every Stage A test-file pre-image, and
read every removed test line before assessing the replacements.

## Findings

### Critical

#### C1. A landed correction reverses an existing assertion instead of preserving it

- **Files/lines:** the pre-image at `dfe57b194:apps/server/src/event-log.test.ts:495-531`, especially
  line 528; replacement at `apps/server/src/event-log.test.ts:496-538`; behavior at
  `apps/server/src/modules/issues/service/crud.ts:664-710` and `:1237-1287`.
- **Concrete problem:** commit `f751f84e0` deletes
  `expect(svc.close(a.id).stage).toBe('done')` from the existing test named “a fanout read error
  after the close persisted does not break close()”. The replacement now requires `close()` to
  throw `PostCommitError`. That changes the public failure contract after the close has committed;
  it is not a setup-only conversion edit. POD-3329 was recorded first and the replacement is a
  strong oracle, but rule 21 also requires notifying the assertion's owning issue. `podium issue
  mail inbox 3397` is empty, and POD-3397's record contains no notification of the reversal.
- **What realistically goes wrong:** a caller that previously treated `close()` as successful now
  receives an error after durable mutation and may retry or report failure even though the issue is
  already closed. More importantly for this checkpoint, allowing a corrected implementation to
  delete the old assertion without completing rule 21 defeats the conversion's “tests do not move”
  guard.
- **Specific change:** either restore the non-throwing contract and its assertion, or record and
  land the contract change through rule 21: notify POD-3397, retain a named assertion for the old
  invariant that still applies (the close is durable), and record the deliberate replacement and
  mutation evidence in the owning issue before R2.
- **Verification:** direct removed-line audit found the deleted assertion. I then changed the final
  rethrow to return success; `event-log.test.ts` failed exactly the two new `PostCommitError`
  assertions (32 passed, 2 failed), proving the replacement pins the new contract. The mutation was
  restored byte-identically.

#### C2. The sync conversion deletes a construction-refusal assertion and adds no replacement

- **Files/lines:** deleted `packages/sync/src/adapters/sqlite/store-executor.test.ts:30-35` at
  `da5df190d^`; the moved guard is now `apps/server/src/store.ts:298-304`; the replacement file
  explicitly acknowledges the removal at
  `packages/sync/src/adapters/sqlite/store-queries.test.ts:10-15`.
- **Concrete problem:** the deleted test asserted that a repository refuses construction when its
  required execution capability is absent. Rule 27b moved the check to `SessionStore`, but no test
  exercises that new refusal. A repository-wide search for the error text and an absent
  `syncQueries` construction found only production code and fixture-side assertions that the
  capability happens to be present. `podium issue mail inbox 3338` and `... 3416` are both empty.
- **What realistically goes wrong:** the composition-root guard can be removed or weakened without
  a red test, allowing a non-bun executor to reach partially constructed store wiring. The precise
  invariant the old test protected is now comment-only.
- **Specific change:** add an executable `SessionStore` composition-root test with an executor whose
  `syncQueries` is absent, assert the construction refusal and message, then mutation-check removal
  of the guard. Record the assertion replacement and notify the old owner under rule 21.
- **Verification:** I compared the deleted file with all current `syncQueries` test references and
  the current `SessionStore` guard. No replacement test invokes the absent-capability branch.

### High

#### H1. The mechanical Stage A exit is unfinished: the legacy field and ledger remain

- **Files/lines:** `apps/server/src/store/executor/executor.ts:67-69`, `:121-126`, `:141-160`, plus
  assignments at `:402` and `:740`; `scripts/check-boundaries.ts:1340-1351`;
  `apps/server/src/store/executor/legacy-handle-probe.ts:1` and
  `apps/server/src/store/executor/bun-driver.ts:275-306`.
- **Concrete problem:** `StoreExecutor.legacy`, its option, helper, driver wiring, and the temporary
  probe still exist. `STAGE_A_UNCONVERTED` still contains exactly two entries:
  `legacy-handle-probe.ts` and `executor.ts`. The method says both are deleted at Stage A exit.
- **What realistically goes wrong:** the principal compiler-backed proof that every repository has
  left the raw-handle path has not fired. The probe also preserves a second raw execution seam that
  later async work can accidentally keep using.
- **Specific change:** complete POD-3326/POD-3267: delete the legacy field, option, helper, probe,
  bun-driver/harness wiring and exports; remove both ledger entries; run the scoped typecheck and
  boundary fixtures again.
- **Verification:** exact-symbol search and direct file read; no converted repository call site
  uses `legacyHandle`, so this is residual transition machinery, not required repository behavior.

#### H2. Stage A exits with three unanswered-marker tokens, not zero

- **Files/lines:** `apps/server/src/modules/accounts/native-login.ts:76` and
  `apps/server/src/relay.ts:1188,1283` (`POD-3365`).
- **Concrete problem:** the exit contract is mechanically zero `// DECISION POD-<n>` markers.
  POD-3365 is already done and rule 46 is in the spec, yet its three application markers remain.
  The new spec text says the grant sites wait until R3, but that directly contradicts the explicit
  Stage A/R2 zero-marker gate being reviewed here.
- **What realistically goes wrong:** R2 would certify a store with unresolved security-path and
  authorization-path application work moved into the phase the gate was meant to protect from it.
- **Specific change:** apply rule 46 at all three grant sites and remove those markers. If the
  coordinator intends to move that obligation to R3, amend the checkpoint contract explicitly and
  obtain the human decision before calling R2.
- **Verification:** exact production marker inventory and `podium issue show 3365/3403/3406`.
  POD-3403 and POD-3406 are now resolved and their former markers are shape-checked permanent
  tokens; neither appears in the final marker inventory.

#### H3. Branded IDs re-enter through mapper casts instead of flowing from schema `$type`

- **Files/lines:** `apps/server/src/store/messages.ts:101,103,109,127` against schema
  `apps/server/src/migrations/schema.ts:2065-2071,2084`; `issues.ts:418,446,476,494`;
  `sessions.ts:1111`; and the redundant cast in `workflows.ts:179` even though
  `schema.ts:2333` already declares `$type<UserId>()`. Additional clear sites include
  `machines.ts:136`, `superagent.ts:307`, `telegram-bindings.ts:92`, and
  `packages/sync/src/adapters/sqlite/sync-repository.ts:583`.
- **Concrete problem:** comments call these “serialization edges”, but Stage A's rule is the
  opposite: the schema is the source of truth and brands must flow from `$type`; mapper re-entry
  casts that existed because raw rows were unknown are removed. Several columns remain plain text
  and are cast in mappers, while others are already branded in schema and are redundantly recast.
- **What realistically goes wrong:** the compiler cannot distinguish a session, issue, or user ID
  at the persistence boundary. A swapped column or projection can be blessed locally and propagate
  into message routing, issue attribution, or authorization without a type error.
- **Specific change:** add the correct `$type<...>()` or `brandedRef` declaration to each branded
  schema column (and the injected sync table type), then remove the mapper `as`/`asXId` re-entry
  casts. Keep only genuine polymorphic or external-input decoding decisions, explicitly named.
- **Verification:** full mapper reads for the five large repositories plus a repository-wide brand
  cast inventory cross-checked against `schema.ts`.

#### H4. Three golden-test sets were not written before their conversions

- **Files/lines/commits:** `apps/server/src/store/machines.ts:1` converted in `475462dc8`, while
  `machines.golden.test.ts:1` first appears in later commit `eccf64b25`;
  `packages/sync/src/adapters/sqlite/sync-repository.ts:1` and
  `sync-repository-golden.test.ts:1` first change together in `da5df190d`;
  `apps/server/src/modules/operations/store.ts:1` and added assertions in `store.test.ts:1` land
  together in `aa5d3675f`.
- **Concrete problem:** the method requires golden tests to run green against the synchronous
  implementation before conversion. A later or same-commit oracle cannot establish that history.
  The five large repositories did meet the ordering rule; these three did not.
- **What realistically goes wrong:** a test authored against the converted implementation can
  encode its new behavior and still pass, hiding a parity regression the “golden first” sequence
  exists to catch.
- **Specific change:** produce reproducible control evidence by applying each golden test unchanged
  to its pre-conversion parent and recording the named green results, plus a named mutation that
  makes it red. If an unchanged test cannot run on the pre-conversion parent, replan rather than
  treating the present green result as historical evidence.
- **Verification:** per-file `git log --reverse` establishes the ordering. Current tests are green,
  but that does not repair the missing pre-conversion arm.

### Medium

#### M1. Rule 31b's permanent lint exception has no permanent fixture

- **Files/lines:** `scripts/check-boundaries.ts:1232-1244,1660-1692`; the raw-statement fixtures in
  `scripts/check-boundaries.test.ts:1100-1178` contain no `REPLACE-STATEMENT POD-3403` case.
- **Concrete problem:** the new auth exception depends on three simultaneous conditions (exact
  path, marker, and `INSERT OR REPLACE` shape), but the boundary fixture does not pin any of them.
  The merge message records a one-off canary; future edits to the checker can widen the exception
  while its permanent suite stays green.
- **What realistically goes wrong:** a copied token, changed path check, or broadened SQL matcher
  can make a new destructive `OR REPLACE` statement invisible to rule 13.
- **Specific change:** add a table-driven fixture proving the intended auth site passes and that
  missing marker, wrong statement shape, and the same token/statement in another repository each
  produce one `store-raw-handle` violation.
- **Verification:** source/test search found no such fixture. I independently invoked
  `checkStoreRawHandles`: accepted site `0`; missing token `1`; wrong shape `1`; wrong path `1`, so
  the current implementation is correct but unguarded.

## Stage A checklist

| Check | Result | Evidence |
|---|---|---|
| Rule 6 mapper decisions preserved; unknown-only guards removed | Pass | Full reads of all five large mappers; semantic empty/corrupt/fail-closed decisions remain, raw `typeof` guards were removed. |
| Every converted OR REPLACE names all columns | Pass | Converted builder sites name full insert/update sets. Rule 31b deliberately retains auth's atomic raw statement, which explicitly names all ten columns; its multi-constraint replacement test is 6/6 green. |
| JSON behavior matches the per-column oracle | Pass | Correct oracle: 1 file, 59/59. Demoting `ship_steps.input_fence` from JSON mode made the named classification test fail; restored. |
| Brands flow from `$type`, no mapper re-entry casts | **Fail** | H3. |
| Transaction count/boundaries and immediate mode preserved | Pass | Workflows 2→2, issues 2→2, shipping 19→19; messages/sessions 0→0. All route through `createOrJoinTransaction`; top-level runtime helper uses `BEGIN IMMEDIATE`, nested calls use savepoints. Runtime lane 15/15. |
| No repository PRAGMA/sqlite_master/ATTACH | Pass | Hits in repository files are explanatory comments only; executable hits are migration/spike/executor infrastructure, not repository queries. |
| Golden tests precede conversion | **Fail** | H4. |
| No existing assertion changed/deleted | **Fail** | C1 and C2. Census: 43 modified existing test files, 22 added test files, one deleted test file. All removed lines were read; normalized setup/helper rewrites preserve their assertions except the two findings. |
| Zero DECISION markers | **Fail** | H2: three markers, all pointing at already decided POD-3365. |
| Executor legacy field and Stage A ledger deleted | **Fail** | H1: field present and ledger length is two. |
| Escape hatches absent | Pass, one fixture gap | No added `as any`, `@ts-expect-error`, `biome-ignore`, `TODO`, `sql.raw` of user input, or temporary second path. The sole production `sql.raw(statement)` is the constant-identifier scan in `machines.ts:246`, tied to decided POD-3404 and built from source constants. Rule 31b and POD-3406 are explicit, shape-limited raw-statement rules; M1 covers rule 31b's missing fixture. |

## Commands and observed output

All commands below were run in this review worktree. The first attempted JSON-oracle filename did
not collect a test and is not counted as evidence; I resolved the actual file and reran it.

```text
boundary fixture: Test Files 1 passed (1); Tests 144 passed (144); exit 0
statement intent:  Test Files 47 passed (47); Tests 660 passed (660); exit 0
                   Statements examined 205; writes 171; reads 34; ungraded 0;
                   fatal read-declared writes 0; overdeclared reads 0
four-package typecheck: Tasks 17 successful / 17 total; 16 cached; exit 0
auth rule 31b:      Test Files 1 passed (1); Tests 6 passed (6); exit 0
JSON oracle:        Test Files 1 passed (1); Tests 59 passed (59); exit 0
large/late goldens: Test Files 7 passed (7); Tests 167 passed (167); exit 0
sync goldens/port:  Test Files 2 passed (2); Tests 37 passed (37); exit 0
late fanout/span:   Test Files 2 passed (2); Tests 53 passed (53); exit 0
runtime SQLite:     15 pass, 0 fail; exit 0
```

`bun run lint:boundaries` itself exits 1 with 26 architecture-manifest and 53 dependency-boundary
failures. The documented control at `f910e2671` was run independently and has the same 26/53
`(rule,file)` name set; the final tip adds zero names, so the method's corrected delta gate is
green. This does not override the Stage A-owned absolute gates: the two-entry ledger and three
decision markers are red.

The final-tip measurement output was:

```text
feedBootstrap.queriesPerRequest     44 (control 1)   baseline 44
issueFrameReads.queriesPerRequest  253 (control 80)  baseline 253
distinctStatementTexts              17               baseline observation 17
rssBytesAfterBootstrap      229,011,456               baseline observation 219,910,144
bootReconcile.framesPerBurst          1 (control 60)  baseline 1
bindStorm.framesPerBurst              2 (control 50)  baseline 2
hot-path budget held (queries); hot-path budget held (frames); both exit 0
```

RSS is 9,101,312 bytes (+4.14%) above the recorded observation; RSS is recorded, not a budgeted
metric. Statement-cache cardinality is unchanged at 17. The query gate was defeat-tested with an
`issueFrameReads` baseline of 252 and exited 1 with `252 -> 253 — increased`; the temporary baseline
was not retained.

Golden-test defeat checks were also run and restored: reversing message high-water ordering failed
1 named test; removing workflow correlation failed 1; forcing session archived false failed 1;
forcing issue archived false failed 2; forcing shipping lookup empty failed 2. The JSON-mode and
fanout-error mutations described above also went red. Rule 31b's current implementation was
defeat-checked on all three conditions without changing source. `git status --short` was clean after
every production/test mutation was restored and before this uncommitted report was created.
