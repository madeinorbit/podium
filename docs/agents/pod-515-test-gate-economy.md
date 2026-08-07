# Package-owned test gate economy review

Date: 2026-08-06  
Reviewed commit: `7f12ff559985ec1e15419a3595f7bac95453a2c2` (`main` when this worktree was cut)  
Scope: read-only review of the default `bun run test` graph, with one independent cold
`@podium/server` profile. No POD-496 source or test files were edited.

## Recommendation in one page

Keep the package-owned Turbo gate, its install fingerprint, hermetic setup, two-worker
shared-host ceiling, package cache boundaries, migration correctness tests, and deterministic
counter-based scale guards. Those controls protect real failure modes and are not the reason
the server miss costs tens of minutes.

The first implementation priority should be a pre-migrated, current-schema database clone for
ordinary server tests. The cold profile applied all 54 migrations 2,341 times. A separate
10-store microbenchmark in the originating worktree took 4,741 ms, or about 474 ms per
`SessionStore(':memory:')`. Multiplying those measurements is not a benchmark-quality causal
estimate because host load differed, but its 18.5 minutes of aggregate work is the same order
as Vitest's 19.9 minutes of aggregate test-body time. Full-chain construction should remain in
the migration and production-boot suites.

The second priority is import amortization. Vitest spent 1,604 s importing 291 isolated files,
more than it spent in the 4,142 test bodies. With `isolate=true`, the installed Vitest pool
terminates each runner rather than returning it to the reusable pool; `pool: 'forks'` and two
workers therefore mean a fresh process/module graph per file, two at a time. Prototype a small
pure-test project with runner reuse only after adding explicit module/global-state reset guards;
do not turn isolation off for the whole server suite.

The third priority is cache granularity. `@podium/server#test` is one cache entry covering the
server plus nine upstream package source trees. Any covered edit replays 291 regular files and,
after they pass, two serialized normalized-wire files. Split the server task into coherently
cached store/migrations, services, composition/router, pure policy/contracts, and
normalized-wire shards while retaining one default aggregate command.

Finally, remove protection that is tautological or fake, and retire migration-era oracles after
transferring unique assertions. This is mostly a maintenance win rather than a runtime win.

## What the default graph does

`scripts/test.ts` invokes `turbo run test --concurrency=1`. The dry graph contained 23 tasks,
all with no task dependency edges and all cold misses after a locked install in this fresh
worktree. Package tasks therefore run serially. Each ordinary Vitest task may use two workers;
the server's normalized-wire project runs later with one worker and no file parallelism.

The largest repository inventories are shown for scale. These are static source inventories,
so they include files excluded from the default unit config and counts before `each` expansion;
they are not executed-test totals.

| Owner | Test files in tree | Declared `it`/`test` cases |
| --- | ---: | ---: |
| `apps/server` | 309 | 3,839 |
| `apps/web` | 237 | 1,870 |
| `packages/client-core` | 84 | 871 |
| `scripts` | 58 | 746 |
| `packages/sync` | 49 | 613 |
| `apps/daemon` | 70 | 597 |

The server's default selection is 291 regular files plus two separately serialized
normalized-wire files. In the originating 4,131-test sample, about 3,826 cases were direct
declarations and only about 305 came from table expansion. Roughly 7% of the count is matrix
fan-out, so “too many `test.each` rows” is not an explanation for the wall time.

The package split is still valuable. It gives cheap packages independent cache entries and
prevents a server miss from automatically executing their tests. The serial policy is also
appropriate on the shared six-core development host: raising package concurrency while leaving
two Vitest workers per task would multiply process and memory pressure. On dedicated CI,
parallelize shards with one or two workers each rather than raising both dimensions at once.

### Cache invalidation pressure

The server cache key includes all server package files plus source trees for commands, harness,
issue-client, model, protocol, runtime, sync, telemetry, and transcript. This is honest but
broad. Narrowing those inputs without changing the tests would create false cache hits; the
safe way to improve hit rate is to split tests by the source they actually consume and keep the
root aggregate exhaustive.

Other broad keys deserve the same treatment over time: the model task intentionally reads
application/package TypeScript across the repository, and web covers every package source plus
daemon source. Architecture/drift checks that really scan globally should remain broad but live
in a clearly global shard rather than widening ordinary behavior-test keys.

## Independent cold server profile

Command:

```text
/usr/bin/time -v bun run test -- --filter @podium/server \
  --uncached-because="POD-515 independent runtime profile"
```

The regular server run failed three drift assertions, so the package script's `&&` did not run
the two normalized-wire files. The profile is nevertheless complete for the expensive regular
project and the failures themselves are review evidence. The originating run was about 17m36s
for 4,131 tests. This main-based run selected 4,142 tests and took 25m25.6s in Turbo / 25m29.1s
wall on a loaded shared host.

| Result | Measurement |
| --- | ---: |
| Test files | 291 (288 passed, 3 failed) |
| Tests | 4,142 (4,138 passed, 3 failed, 1 skipped) |
| Vitest duration | 1,522.56 s |
| User / system CPU | 1,796.06 s / 569.52 s |
| Peak RSS | 733,448 KiB |
| Captured log | 6,071,696 bytes; 2,405 stdout blocks; 68 stderr blocks |
| Full migration applications | 2,341 × 54 migrations |

The host-dependent difference from 17m36s should not be interpreted as a regression percentage.
It does show that this deterministic lane is CPU/process/bootstrap-bound and sensitive to shared
host contention; it is not waiting on a real network service.

### Transform, setup, import, and test time

Vitest's phase numbers are aggregate worker work and overlap across two workers, so they must
not be added to wall time. Their proportions do identify where CPU/process time goes.

| Phase | Aggregate time | Share of phase work |
| --- | ---: | ---: |
| Transform | 152.37 s | 5.1% |
| Setup | 45.75 s | 1.5% |
| Import/collect | 1,604.32 s | 53.5% |
| Test bodies | 1,193.45 s | 39.8% |
| Environment | 0.339 s | <0.1% |

Framework/module overhead is therefore 60.2% of the aggregate phase work, and imports alone
average 5.51 aggregate seconds per selected file. This is the dominant result of the review:
deleting hundreds of individually cheap assertions cannot recover most of the cold wall time if
the lane still starts and imports 291 isolated server graphs.

The installed Vitest pool makes the mechanism explicit: a completed runner is reusable only
when `task.isolate` is false; otherwise it is stopped. The repository leaves isolation at its
default and explicitly chooses `pool: 'forks'`. This is safe but expensive.

### Slowest test bodies

File durations exclude their transform/import/setup cost.

| File | Tests | Test-body time |
| --- | ---: | ---: |
| `modules/messages/service.test.ts` | 160 | 109.3 s |
| `issues.test.ts` | 238 | 83.6 s |
| `relay.test.ts` | 154 | 62.4 s |
| `modules/workflows/characterization.test.ts` | 95 | 57.9 s |
| `steward.test.ts` | 68 | 45.5 s |
| `store.test.ts` | 59 | 38.8 s |
| `modules/sessions/oracle-handoff.test.ts` | 26 | 32.2 s |
| `sessions.ledger.test.ts` | 30 | 24.6 s |
| `modules/messages/gate-agent.test.ts` | 46 | 24.4 s |
| `modules/messages/characterization.delivery.test.ts` | 36 | 20.4 s |

The five slowest files account for 30.2% of aggregate test-body time; the ten slowest account
for 42.0%. They do not account for the 60.2% framework/module overhead.

The contrast between slow and fast suites distinguishes count from mechanism:

- `authz-matrix.test.ts`: 60 tests in 0.459 s.
- `issue-commands.test.ts`: 48 tests in 0.552 s.
- `modules/sessions/session.test.ts`: 57 tests in 0.212 s.
- `modules/messages/service.test.ts`: 160 tests in 109.3 s.
- `store.test.ts`: 59 tests in 38.8 s.

Fast, table-driven policy matrices are economical and should remain. Store/registry-backed
cases repeatedly construct current state through the historical migration path. The source has
384 explicit `new SessionStore(...)` sites in 95 test files, before counting expanded helpers;
the runtime log observed 2,341 actual applications.

## Keep

1. **Package ownership and honest Turbo keys.** A cached green against the wrong source or
   install is worse than a miss. Preserve the install fingerprint and missing-link refusal.
2. **Hermetic state and process ceilings.** The setup files prevent tests from reaching the live
   Podium instance and contain temporary state. Keep two workers on shared hosts.
3. **Migration correctness in the default gate.** Upgrade safety is high-risk and the migration
   files are not the main cost. Only ordinary behavior tests should use a current-schema clone.
4. **Fast exhaustive policy/contract matrices.** Their assertion count is high but their runtime
   and fixture cost are low, and they fail with precise ownership context.
5. **Normalized-wire and scaling guards that assert exact operation counts.** The current
   60×40 fixtures use counters rather than wall-clock thresholds. Keep them in the default gate;
   they are already separately serialized and sized to the detector.
6. **One real behavior check at every critical boundary.** A source audit cannot prove the
   runtime object exists, and a runtime check cannot detect forbidden source reintroduction.
   Preserve both kinds, but give each one owner and avoid historical duplicates.

## Consolidate or delete

### Delete now, subject to normal change review

- **`modules/issues/id-schema-drift.test.ts` (5 tests, 0.149 s):** both the “Model” and “Protocol”
  aliases are imported from `@podium/model`. Every runtime and type comparison is an object/type
  compared with itself. It cannot detect model/protocol drift.
- **The runtime case in `modules/derived-family.types.test.ts` (1 test, 0.012 s):** the file says
  Vitest cannot enforce its compile-time assertions and executes `expect(true).toBe(true)` merely
  to make the count non-zero. Keep the `@ts-expect-error`/type assertions under typecheck and
  stop collecting it as a runtime test.
- **Opaque literal totals already covered by exact set checks:** remove the `23` pin in
  `modules/derived-family.runtime.test.ts` and the `24` RPC-frame pin in
  `gateway/daemon-mux.test.ts`. Both suites immediately iterate the derived sets and assert every
  member's behavior. A non-empty control plus bidirectional set equality protects the claim
  without updating a historical census on every legitimate addition.

### Retire after transferring unique behavior

- **`modules/issues/registry-metadata.oracle.test.ts` (12 tests, 0.086 s):** this is a historical
  POD-311 zero-change recording. Current `registry.test.ts`, field-drift checks, and runtime CLI
  surface checks now own the live invariants. Delete the recorded parity oracle after confirming
  no unique cell/policy assertion is lost.
- **`modules/workflows/characterization.test.ts` (3,942 lines, 95 tests, 57.9 s):** it was added as
  the pre-POD-731/732 mutation oracle and still contains migration-era artifact/pin language.
  Current workflow service, multi-user, CLI, and runtime surface suites should receive any unique
  behavior; then remove the characterization duplicate. This is the largest concrete deletion
  candidate, but it should be mutation-checked rather than removed wholesale.
- **The three `modules/messages/characterization.*.test.ts` suites:** they were added to pin the
  vertical before POD-728/729. Current `service.test.ts`, `gate-agent.test.ts`, multi-user, and
  cutover suites overlap their authz, delivery, and spawn/await claims. Transfer unique edge cases
  into those owners and delete the migration oracles.
- **Cutover-only pins in `session-cutover.audit.test.ts` and message/workflow/automation cutover
  files:** keep enduring bidirectional surface and authorization assertions, but remove temporary
  “one remaining singleton”, fixed-count, and pre-cutover absence pins once the migration is no
  longer reversible.

The risk in this group is subtle behavioral parity loss. Require a before/after coverage map,
targeted mutation checks on the moved seams, and one focused run per owner. Line-count reduction
or a green suite alone is not sufficient evidence.

## Move to narrower lanes or owners

- **Source-text subprocess audits** in `automation-cutover.audit.test.ts` and
  `workflow-cutover.audit.test.ts` should run under the scripts package, where their scanner source
  and repository-wide inputs are owned. Keep the runtime router/schema/gate assertions in server.
  This improves cache ownership more than raw runtime (their bodies were only 0.247 s and 0.604 s).
- **Type-only files** should be named/configured as typecheck inputs, not fake Vitest suites.
- **Real server/port tests** (`server.role.test.ts`, `issue-client.test.ts`,
  `wsServer.origin.test.ts`, and `wsServer.client-auth.test.ts`) should move to the existing
  integration lane, matching the repository's own unit-lane convention. Together their test
  bodies cost about 12.2 s. Retain pure role resolution and protocol policy as unit tests.
- **Git-shell behavior** in `modules/files/queries.search.test.ts` should be split: keep injected
  command/result logic in unit, and move one real-git proof to integration. It is cheap today
  (0.351 s), so this is lane correctness, not an economy claim.

Do not move migration correctness or deterministic operation-count guards out of the default
gate merely because they touch SQLite or carry “bench/scaling” in the filename. Their failures
are high-impact and their detectors are deterministic.

## Fix fixture and runner economics before deleting broad coverage

### 1. Pre-migrated database clone

Build one current-schema empty database per test run (or a versioned serialized image) and clone
it for ordinary `SessionStore` fixtures. Preserve a fresh database, independent connections,
per-test cleanup, and foreign-key/pragma initialization. Tests under `migrations/**`, explicit
boot/upgrade tests, and any assertion about the migration log must continue through the real
constructor.

Acceptance evidence should include:

- identical ordinary-suite results against old and cloned fixtures;
- the clone invalidating automatically when the migration manifest/schema changes;
- a proof that state cannot cross test cases;
- migration suites demonstrating the full 54-step path still executes;
- cold server phase timing before and after.

### 2. Curated reusable-runner shard

Start with fast pure policy/contract files that do not mutate process environment, fake timers,
module registries, global mocks, or SQLite state. Run that shard with runner reuse and an explicit
after-file leak guard. The current hermetic setup assumes process-exit cleanup, so it must be
adapted before reuse. Keep isolated forks for store, server, composition, and singleton-heavy
suites until mutation and order-randomization runs prove reuse safe.

### 3. Server Turbo shards

Suggested cache units:

1. pure contracts/policies/types-runtime;
2. store and migrations;
3. issue/session/message/workflow services;
4. composition/router/gateway/server boundaries;
5. normalized-wire/load guards.

The root `test` task must depend on all five, `test:affected` must see every shard, and every shard
must inherit the install fingerprint and hermetic setup. Sharding improves miss frequency and
allows dedicated CI distribution; it does not reduce total cold CPU by itself.

## The three failures from this profile

One new `machines.transferServer` surface produced three failures:

1. `server.role.test.ts` found that the new hub contract lacks explicit hub-off behavioral
   coverage. This is useful protection; make the coverage table-driven rather than weakening it.
2. `modules/derived-family.runtime.test.ts` failed only because a redundant total changed 23→24;
   its exact per-family served-vs-declared cases already cover the new command.
3. `gateway/daemon-mux.test.ts` failed only because a redundant RPC-frame total changed 24→25;
   the following loop already routes every derived RPC frame through the correlator.

This is a concrete example of why test value cannot be inferred from failure count. One failure
identified missing behavior coverage; two restated censuses created update work without adding a
new refusing condition.

## Ordered implementation plan and risk

| Order | Change | Expected benefit | Main risk |
| --- | --- | --- | --- |
| 1 | Pre-migrated ordinary-test databases | Removes thousands of 54-step bootstraps; largest test-body saving | A stale fixture or shared state could hide migration/schema defects |
| 2 | Server Turbo shards | Avoids replaying all 291 files for most covered edits; enables CI distribution | Incorrect inputs could create false cache hits |
| 3 | Curated reusable-runner pure shard | Targets the measured 53.5% import share | Cross-file module/global/env contamination |
| 4 | Retire characterization/oracle residue | Reduces 4k-line maintenance surfaces and up to several minutes of body work | Loss of subtle parity cases if removed without mapping |
| 5 | Lane ownership and tautology cleanup | Clearer failures, smaller default scope, less census churn | Rare boundary regressions if behavior is moved but not retained |
| 6 | Quiet expected application logs in tests | Avoids 6 MB cold logs and cache replay noise | Hiding diagnostics; keep failure logs and runner summaries |

Do not lead with blanket assertion deletion, global `isolate=false`, a higher timeout, or a wider
shared-host worker count. Those changes either miss the measured cause or trade wall time for
flakiness and host contention.

## Durable follow-ups

- POD-523 (Pre-migrated server test databases)
- POD-520 (Server test cache shards)
- POD-521 (Cutover oracle retirement)
- POD-522 (Test lane ownership cleanup)

All are proposed discoveries from this review; none was claimed or implemented here.

## Evidence and reproducibility notes

- Dry graph: `bun run test -- --dry=json` after `bun install --frozen-lockfile`.
- Static inventory: `find` plus anchored `rg` counts; dynamic test totals come from Vitest.
- Cold server run: command shown above, default two workers, shared host, Turbo force justified
  through the repository's `--uncached-because` escape hatch.
- Source configuration inspected: `scripts/test.ts`, `turbo.json`, `vitest.config.ts`,
  `vitest.unit.config.ts`, `scripts/package-vitest-config.ts`, server package/config files, and
  the installed Vitest pool implementation.
- The attempt to time all 22 non-server tasks was cancelled while queued behind another issue's
  heavy-test lease. No non-server runtime figures are presented as measured results.
- The profile log stayed in `/tmp` and was not attached because it is 6 MB of repetitive expected
  application output. The exact summary, phase figures, slow-file table, failure details, and
  resource usage needed for review are preserved above.

---

## Correction, 2026-08-07: import/collect was understated, and runner reuse is not its lever

This review claimed import/collect was 53.5% of aggregate phase work and recommended a curated
reusable-runner shard (ordered-plan item 3) as the way to attack it. Both halves need correcting,
in opposite directions. Measured by the POD-527 implementor on the post-POD-523, post-POD-520 lane.

**Import/collect is larger than measured, not smaller: 66.4%** — 1,710.22 s of 2,574.99 s across
transform, setup, import and bodies. POD-523 moved migration replay out of test *bodies*, which
raised import's share rather than lowering it. The review's central claim got stronger.

**Runner reuse reaches about 4% of the lane.** Scaling the measured contracts ratios
(1.562 / 1.643 / 1.889) back to isolated gives 63.9 s / 73.1 s / 101.1 s saved against a
~1,780 s baseline: **3.60% – 5.58%**.

Where the import cost actually sits:

| Shard | Share of lane import | Reuse safe? |
| --- | ---: | --- |
| contracts | 10.5% | yes — the only place |
| boundary + services | 61.8% | no — compose the application, hold singletons |
| store | 23.4% | no |
| normalized-wire | 4.3% | n/a |

**Reuse is safe precisely where the cost is smallest, and that is structural rather than an
artifact of where POD-520 drew its shard lines.** The property that makes a file cheap to import —
its closure reaches neither `store` nor `composition` — is the same property that makes it safe to
share a process. Cheapness and safety have a common cause, so this correlation will hold for anyone
who attempts this again.

**What that means for anyone continuing this work.** Import/collect dominates the gate and
dominates it harder than this review measured, but runner reuse is not the lever for it — it is a
lever for the tenth of it that was already cheap. The other ~85% sits behind `boundary`, `services`
and `store`. Reaching it means either making application-composing suites safe to share a process
(unproven; this review's refusal of a global `isolate=false` stands) or attacking import cost
directly rather than amortising it: fewer modules per test, or a cheaper module graph. POD-548
(`relay.ts` fan-out) is the concrete instance of the latter — and note that `relay.ts` imports
`@podium/sync` directly, so it should be coordinated with the sync-system rewrite rather than
raced against it.

Do not read the 36–47% import reduction measured on `contracts` as a lane number. A ratio on the
cheapest shard is exactly the error POD-520 caught itself making with its 64% replay figure.

### The method note worth carrying forward

The correction above exists because the denominator was fixed *before* the numerator was known.
POD-527 was told to report the share of **lane** import/collect its shard addressed, and to state
what remained unaddressed, in its opening brief — before it had measured anything. Having done the
work, the available headline was "36–47% import reduction", which is true of `contracts` and
meaningless about the gate. The instruction that prevented it was given when there was still
nothing to be tempted by.

Two issues in this chain caught the same error class in themselves unprompted (POD-520 with its 64%
replay figure, POD-527 with this), which suggests the failure is not carelessness but the ordinary
gravity of an improvement measured against the thing it improved. Ask for the denominator up front.

---

## Addendum, 2026-08-07: the registry oracle made the retirement case itself

The "Retire after transferring unique behavior" section named
`modules/issues/registry-metadata.oracle.test.ts` (12 tests, 0.086 s) as a historical POD-311
zero-change recording whose live invariants are now owned elsewhere. While scoping POD-521, that
suite was found failing on a clean tree — a **fourth** pre-existing failure, alongside the three
this review documented.

The mechanism is the argument. POD-532 legitimately added a `subject` key to `eventsInput`
(`packages/commands/src/issues/contracts.ts:192`). The oracle compares every issue command against
a fixture recorded before the POD-311 split, and admits legitimate change only through two
hand-maintained allowance tables, `GAINED_EXPECTED_REVISION` and `GAINED_KEYS`. Nobody edited them
for POD-532, so the recording is now red against shipped, correct code, and the only repair
available is to widen the recording.

This is the cost structure the review attributed to migration-era oracles, observed rather than
predicted: a recording of the past charges every future correct change an edit, and the edit
carries no new refusing condition. It belongs with the two census pins (derived-family 23→24,
daemon-mux 24→25) as maintenance work generated by a test that cannot fail for a reason anyone
wants to hear about. Unlike those two, it is already in POD-521's scope.

POD-521 is treating it as evidence rather than repairing the allowance table. That is the right
call: fixing it would erase the demonstration and buy back 0.086 s of runtime.

---

## Correction, 2026-08-07: the largest deletion candidate was wrong twice

This review named `modules/workflows/characterization.test.ts` (3,942 lines, 95 tests, 57.9 s)
"the largest concrete deletion candidate". Both halves of the case for it have since failed, for
different reasons and with different lessons. Measured by POD-521 on the post-POD-523 lane.
**Do not start POD-522 from the 57.9 s figure.**

**The runtime half was consumed, not mistaken.** 57.9 s was correct when measured. On the
post-POD-523 lane the same 95 tests spend **5.10 s** in their bodies — the pre-migrated clone took
roughly 11× out of it, and what remains of the wall time is transform and import, which is not
this file's to give up. The review's own ordered plan ranked the pre-migrated fixture first and
oracle retirement fourth. Executing in that order destroyed the runtime case for the fourth item,
which is what a correct ordering is supposed to do. The lesson is not that the number was wrong;
it is that **a deletion justified by runtime must be re-measured after any fixture change that
ranked above it**, and this review shipped its ordering without saying so.

**The duplication half was asserted and never mapped.** The review said current workflow service,
multi-user, CLI and runtime surface suites "should receive any unique behavior" — the word *any*
carrying an unexamined assumption that little was unique. POD-521 mapped all 95 cases against the
named owners (`service.test.ts`, 9 tests, 539 lines; `multi-user.test.ts`, 11 tests, 789 lines).
About **18 are genuinely duplicated; about 77 are the only coverage that exists** — duplicate
delivery and mutation-id replay, out-of-order step attempts, adopt validation, three-way
error-shape leakage, relay exposure defaulting closed per declaration, and run durability across a
store close and reopen. Retiring the file as written would have traded 77 behavioural assertions
for about five seconds.

The line-count asymmetry was visible without running anything: 3,942 lines against 1,328 in both
named owners combined. A file cannot have been absorbed by suites a third its size. This review
had that arithmetic available and did not do it, which is the same failure it warns about
elsewhere — reading a label (`characterization`, migration-era framing, artifact titles) instead
of the thing.

**What survives.** The maintenance argument is untouched: the file still carries migration-era
artifact and pin language describing a cutover that completed, and that framing should go. What
does not survive is deleting it, or relocating 3,000 lines into two small suites to satisfy the
brief literally. POD-521 has put the fork to the human and recommends stripping the framing and
the 18 duplicates while keeping the file and its coverage. That is the right call and this review
withdraws its own recommendation in favour of it.

### The second method note: an ordered plan can invalidate its own later items

The ordered plan at the end of this review ranked six changes by expected benefit against a
baseline measured once, before any of them ran. Item 1 changed that baseline. Item 4's case was
still expressed in the old one, and nothing in the plan said to recompute it. Anyone working the
list in order would have arrived at item 4 holding a justification that item 1 had already spent.

The general caution — **re-derive the case for every later item after each earlier one lands** —
is worth stating, but there is a sharper test available, because this was not bad luck about
ordering. The two items shared a cause. `characterization.test.ts` was expensive *because* it was
store-backed; POD-523 targeted store-backed cost. The deletion candidate and the fixture fix were
competing for the same seconds, so a plan that counted both was counting one saving twice.

So the test is not "re-measure everything each round" but:

> **An item whose cost has the same cause as an earlier item's fix is not additive with it.**
> Its case has to be recomputed *before* it is acted on — and the two should never have been
> presented as independent wins in the first place.

This review contains two instances of that shape. The other is in the POD-527 correction above:
runner reuse turned out to be safe precisely where import cost was smallest, because the property
that makes a file cheap to import (its closure reaches neither `store` nor `composition`) is the
same property that makes it safe to share a process. Cheapness and safety had a common cause, so
the shard where reuse was permitted was the shard where it bought least.

Both times, two figures looked additive and were the same figure seen from two directions. A
review that produces a ranked plan should therefore state, for each item, *what would have to
remain true for this to still be worth doing* — and name any earlier item that could make it
false. That is a sentence per item, written while the causes are still in view, and it is cheaper
than the two corrections above.
