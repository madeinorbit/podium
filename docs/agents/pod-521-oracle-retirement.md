# POD-521 — retiring the cutover oracles

What was retired, what was transferred, what was deliberately left, and the
mutation checks that make the difference believable.

**The one-line result.** The review's premise — that these suites are duplicate
protection and migration-era maintenance — held for two of the five targets and
did not hold for the other three. The two it held for are retired. For the three
it did not, this document says so with measurements, because "we deleted it and
the suite is green" is the expected result of deleting tests and is not evidence
of anything.

---

## The scoreboard

| Target | Premise held? | Outcome |
| --- | --- | --- |
| `modules/issues/registry-metadata.oracle.test.ts` | **yes**, and it was red | retired; 1 of 7 cells transferred |
| source-text audits in the two cutover files | **yes** — wrong package | moved to `scripts`, plus one gap closed |
| `session-cutover.audit.test.ts` temporary pins | **no** — already converted | one stale title corrected; nothing retired |
| `modules/messages/characterization.spawn-await.test.ts` | **partly** | retired; 6 properties transferred |
| `modules/workflows/characterization.test.ts` | **no** — see below | decision pending |
| `modules/messages/characterization.authz.test.ts` | **no** — see below | decision pending |
| `modules/messages/characterization.delivery.test.ts` | frozen by guardrail | untouched |

---

## 1. The registry metadata oracle — the case made itself

`registry-metadata.oracle.test.ts` compared all sixty-eight issue commands, cell
by cell, against `__fixtures__/registry-metadata.pre-pod311.json` — a recording
captured before the contract half of the registry moved into `@podium/commands`.

**It was failing on a clean tree before this issue touched anything.**

```
events.inputKeys: expected [ 'kinds', 'limit', 'repoPath', 'since', 'subject' ]
                  to deeply equal [ 'kinds', 'limit', 'repoPath', 'since' ]
```

POD-532 added a `subject` key to `eventsInput`
(`packages/commands/src/issues/contracts.ts:192`) so that a surface wanting one
issue's activity could ask for it instead of paging the whole log. Correct,
shipped work. The oracle admits legitimate change only through two
hand-maintained allowance tables — `GAINED_EXPECTED_REVISION` and `GAINED_KEYS` —
and nobody edited them, so a recording of the past went red against correct code
and the only repair available was to widen the recording.

That is the cost structure the review attributed to migration-era oracles,
observed rather than argued: **a test whose failure mode is "someone did the
right thing"**, and whose repair carries no new refusing condition.

A caution that belongs beside it, because the inference is easy to over-extend:
*red is an argument for retiring a RECORDING, not for retiring a GUARD.* The
other pre-existing failures in this lane are not retirement candidates —
`server.role`'s is missing coverage, and the two census pins are the
redundant-total case. "It was red" was not the criterion here; the coverage map
below was.

### Where each of the seven cells went

| Cell | Owner after retirement |
| --- | --- |
| `kind` | `issues.expected-revision.test.ts` partitions the table by kind and holds each side to its conflict declaration; `NON_MUTATING_NAMES` in `@podium/commands` pins the same split at compile time, by subtraction |
| `action` | `EXPECTED_PROC_ACTION` in `registry.test.ts`, both directions |
| `scope` | the `policy.resource` biconditional in `registry.test.ts`, both directions |
| `target` | `OLD_SCOPED_TARGET_FIELD` — set equality *and* the input field each extractor reads |
| `inputType` | `contract.test.ts` in `@podium/commands`, which reads through the `.merge()` / `.optional()` wrappers the real tables use |
| `inputKeys` | `handler↔contract schema identity` pins the handler to the contract's schema INSTANCE, so there is no second key set to drift |
| `cli` | **no other owner — transferred** to `registry.test.ts` |

Two of those deserve a note.

`inputType` was **wrong in the oracle**. It asserted a flat `ZodObject` for every
command; `mailInbox`'s input is a `ZodOptional` wrapping one. The oracle passed
only because it compared the recorded typeName rather than asserting a shape. The
live owner in `@podium/commands` reads through wrappers and is correct.

`cli` is the one real transfer: not one issue contract declares CLI presentation
hints, because `@podium/issue-client`'s table is the rendering layer. The failure
it refuses is a second source of truth for the help screen appearing quietly.

### Mutation checks

| Mutant | Result |
| --- | --- |
| `close` flipped `mutation` → `query` | **killed**, by name: `close is a query and must declare 'n/a': expected 'exp-rev' to be 'n/a'` |
| `list` flipped `query` → `mutation` | **killed**, both census assertions (45→46, 25→24) |
| a `cli` hint planted on `issues.linearSearch` | **killed**, by the new test, naming `linearSearch` |

The first two are the important ones: they establish that `kind` — the cell with
the least obvious replacement owner — is genuinely guarded without the recording.

---

## 2. The source-text audits — right check, wrong package

`workflow-cutover.audit.test.ts` and `automation-cutover.audit.test.ts` each ran
their scanner as a `spawnSync` of the real binary, **twice per run** (`--probe`,
then `--json`).

Spawning was the right call when it was written: importing would make
`apps/server` (L4) import UP into `scripts` (L5), which `check-boundaries`
refuses. But it put a scanner whose source and whose repository-wide inputs both
belong to `scripts` inside the *server's* cache key, so every server edit
replayed it and paid two Bun process starts for it on a shared host.
`audit-superagent-commands.test.ts` had already reached this conclusion and named
the workflow file as its counterexample.

Moved to the package that owns them:

- `scripts/audit-workflow-commands.test.ts`
- `scripts/audit-automation-commands.test.ts`
- `scripts/audit-session-commands.test.ts` — **new coverage, not a move**

`probe()` is now exported from each scanner and asserted as a whole rather than
reached through a process exit code, so a check added to a scanner is covered by
the lane from the moment it exists rather than when someone remembers to copy a
fixture across.

The third file closes a gap rather than moving anything.
`audit-session-commands.ts` was reachable only through `bun run audit:sessions` —
a command someone has to remember. `workflow-cutover.audit.test.ts` said so in as
many words when it chose to spawn instead: keeping the halves separate "gives up"
having the gate in `bun run test`. Once the workflow and automation scanners
moved, that gap was an omission rather than a design choice.

**Cost:** the two moved scanners run in ~2 s in the scripts lane instead of inside
a ~65 s server boundary shard.

**Mutation check:** a hand-written `.mutation(` planted at the end of the
`workflows:` router literal fails the scripts test naming
`apps/server/src/router.ts:486`. The gate still refuses, from its new home.

The runtime halves stay in `apps/server`, where the running objects are. Neither
half can replace the other: a scanner that saw an empty router literal would
report a serene zero hand-written mutations, and a runtime check cannot read
source text that has not been built.

### Census pins removed

`toHaveLength(11)` / `toHaveLength(7)` (workflows) and `toHaveLength(4)` /
`toHaveLength(2)` (automations). Both files already assert the served set EQUALS
the declared set in both directions and then check every declared name's verb
individually, so a remembered total carried no refusing condition those checks
lack. Replaced with non-vacuity on both arms.

---

## 3. The messages router census — the replacement found something

`modules/messages/cutover.test.ts` pinned `expect(derived).toHaveLength(9)` twice.
Unlike the two above, this count had a real job: proving the regex that extracts
the router's procedures had not silently matched nothing.

Set equality against the contract table does that job **and** closes the direction
nothing asserted — a mail command declared `trpc` and served by no router at all.

Writing it that way immediately surfaced `mail.ask`: exposed on tRPC, absent from
the messages router, served as `sessions.ask`. POD-382 gave it a command-plane
contract, POD-729 landed first with it cut over to the mail table, and the merge
left the contract in one family and the procedure in the other. **Not a bug** — it
is still built by `mailMutation('ask')`, so it is derived, just derived elsewhere.
But nothing recorded it, and the census that was nominally watching this surface
could not have. It is now named in `MOUNTED_ON_ANOTHER_ROUTER` with the reason, so
a *second* mail command going missing fails here.

---

## 4. The session cutover audit — the premise had already expired

The review named "one remaining singleton" as a pin to remove once the migration
was irreversible. POD-1076 had already done the migration and rewritten the body
into its positive form — a per-principal read marker measured against storage,
plus the property a column could not express (a different principal has no marker
at all). It did not retitle, so the name went on saying "still on the session row"
three lines above the assertion that the column is gone.

Title corrected. Body untouched. **Nothing retired**, because what is left is a
live invariant, not a temporary pin.

### Left in place deliberately

**AC8, under the sync guardrail.** Its two assertions read `REPLICA_TRANSITIONS`
from `@podium/sync` and pin that no session command yet carries a rescope/evict op
the client could mis-reduce. The second is a textbook pre-cutover absence pin and
the review would have had it removed. It guards a replication seam while the sync
rewrite is in flight, so it stays exactly as it is.

**AC2's runtime absence pin** (`SessionLifecycle` has no `withMutation`, on the
instance or its prototype). Not temporary — a second idempotency implementation
can regrow at any time — and it carries a positive control. The new scripts test
adds the textual half beside it, which sees source before anything is built.

---

## 5. The messages spawn/await characterization suite — retired

735 lines, 30 tests. `gate-agent.test.ts` now owns the surface and owns it more
thoroughly: 15 await cases against this suite's 6, covering the same
gone/blocked/done classification plus stale-ack freshness, sticky retirement and
the optional-dependency path. Sections S1 (spawn resolution), S4 (await) and S6
(spawn-on-wake) were duplicates.

Six properties had no other owner and moved to `gate-agent.test.ts`:

- the budget is taken **before** the spawn seam runs, so a failed spawn is still
  charged — and the charge is in-memory only, so a restart forgives it;
- an operator spawn records **no** `budgetIssue`, so the durable reconstruction
  after a restart does not count it either;
- the budget rolls over per **UTC day**, not per elapsed 24 h;
- `--new` needs `--repo` when the caller has no issue scope to inherit one from;
- `agentId` defaults to the session id when the spawn seam names none;
- `ask` is clamped like any other send — a peer asking twice is not exempt from
  the wake cooldown.

### Mutation checks

| Mutant | Result |
| --- | --- |
| budget consumed → merely peeked | **killed** — 3 tests, including the transferred ordering case by its own assertion (`expected 1 to be 2`) |
| wake cooldown disarmed (`isWakeHot` always false) | **killed** — the transferred ask-clamp case is the ONLY test in the file that fails |

The second is the one worth reading twice. Without that transfer, disarming
brake 1 would have passed the entire suite.

### One assertion deliberately not carried over

"Keeps a spawned child listed so the parent can await it" was true of
`mailHarness`, whose fake `spawnSession` registers the session, and says nothing
about the gate — the real registration belongs to the session service. It failed
on transfer, which is how the difference surfaced. **Transferring by running
rather than by reading is why that is a note here instead of a false green.**

`characterization-support.ts` stays: it is a shared harness imported by
`multi-user.test.ts` and `cutover.test.ts` as well as by the frozen delivery
suite. Its name is now the only migration-era thing about it.

---

## 6. The two suites where the premise did not hold

### `modules/workflows/characterization.test.ts`

The review calls this "the largest concrete deletion candidate" at **3,942 lines,
95 tests, 57.9 s**.

**The runtime figure no longer holds.** Measured on the post-POD-523 lane:

```
Tests  95 passed (95)
Duration 43.54s (transform 30.44s, setup 1.40s, import 35.62s, tests 5.10s)
```

Test **bodies are 5.10 s**, not 57.9 s. POD-523's pre-migrated store clone took
roughly 11× out of it. What remains of the wall time is transform and import,
which this issue was explicitly told is not its win to claim.

**The duplication premise does not hold either.** The current owners are
`service.test.ts` (10 tests) and `multi-user.test.ts` (13). Mapping all 95:

- **~18 are genuinely duplicated** — revision immutability and binding precedence,
  the global-scope approval brake, task-scope read filtering, missing-profile
  warnings, profile-snapshot immutability, `prepareStart` pinning, adopt
  validation ordering, duplicate step ids, cross-member isolation, machine
  authorization, the attribution pair, the ownership port.
- **~77 are the only coverage that exists.** Whole sections have no other owner:
  duplicate delivery and mutation-id replay, out-of-order step attempts, adopt
  validation and scope, the three-way error-shape existence leakage, relay
  exposure being default-closed per declaration, and run durability across a full
  store close and reopen.

Retiring it as specified would trade **77 behavioural assertions for ~5 s of body
time**.

### `modules/messages/characterization.authz.test.ts`

800 lines, ~25 tests, mapped the same way against `service.test.ts` (160 tests),
`gate-agent.test.ts`, `multi-user.test.ts` and `cutover.test.ts`. About 8 are
duplicated. The rest have no other owner, including: `--outside-scope` crosses
scope only and never elevates the clamp matrix; the spawn-on-wake seam sitting
downstream of the same access check; superagent wake cooldowns keyed by their
accountable user; `replyTarget` falling back to the operator box for superagent,
operator and system senders; and three of the four POD-463 legacy raw-ref
resolution arms.

### The recommendation

Neither file should be deleted. Both should be **stripped rather than retired**:
remove the tests their current owners already hold, delete the migration-era
framing (the "ORACLE FOR A MIGRATION, NOT A SPECIFICATION OF THE TARGET" header
and the per-test `PIN` / `ARTEFACT` / `BUG` vocabulary), and rename to what they
protect. That removes the maintenance surface the issue is actually aimed at —
the thing that makes a reader treat a live suite as a historical artefact — while
keeping every assertion that still refuses something.

Held for the human's decision rather than taken unilaterally, because the brief
says "retire" and the measurements say the reason for retiring has expired.

---

## Guardrail compliance

`modules/messages/characterization.delivery.test.ts` is **untouched** — not
retired, not thinned, not moved out of the default package gate.

`packages/sync` and the `relay.*.test.ts` family are untouched.

Two suites were left in place *because* they turned out to be sync guards, and
both are named above rather than quietly skipped: AC8 in
`session-cutover.audit.test.ts`, and everything in `modules/messages/cutover.test.ts`
downstream of the router derivation (the delivery-caller allowlist, the
session-command-plane absence check, the composed-pair queued-send rejection, and
the send/delivery/reply e2e).

---

## What this issue does NOT claim

It does not claim an import-cost win. POD-527 measured import/collect at 66.4% of
the lane and showed runner reuse reaches 3.6–5.6% of it; nothing here changes the
module graph. The wins are **maintenance surface** — one red recording gone, four
census pins gone, three scanners in the package that owns them — and a small
amount of body time.

The one genuine runtime change is the scanner move: ~2 s in the scripts lane
instead of two subprocess spawns inside a ~65 s server shard, on every server
edit.
