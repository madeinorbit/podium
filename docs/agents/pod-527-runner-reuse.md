# POD-527 — a reusable Vitest runner for the pure server contracts

`@podium/server`'s `contracts` shard no longer forks a process per test file. 62 of its 70
files now run in one runner, and the shard still runs all 70.

**The result to judge is not the speed.** It is whether a file can leave state behind and
have it land on another file. Three things decide that, and only the first of them is about
performance:

1. `isolate: false` on one project of one shard, which is what makes the pool hand a
   finished runner to the next file;
2. a **derived scan** that demotes any file whose source contains a construct Vitest does
   not undo between files — 8 of the 70 today, still in the shard, still running, just in
   their own forks;
3. an **after-file leak guard** that observes the real process after every reused file and
   fails *that* file, by name, with the key that moved.

Reuse without 2 and 3 is the trade POD-515 refused: wall time for flakiness.

> ## If you are here to repeat this, read this box first
>
> **`--sequence.shuffle.files` is the wrong instrument for stressing runner reuse, and it is
> the first thing you will reach for.**
>
> Vitest's `BaseSequencer` sorts by project name before anything else — "Projects run
> sequential" in its own source. That is what keeps a reused project's files contiguous, and
> the pool only hands a finished runner on when `queue[0]` is another non-isolated file of the
> same project. `--sequence.shuffle.files` swaps in `RandomSequencer`, which replaces that sort
> **entirely** with a shuffle across *all* files. The reused and isolated projects interleave,
> and the chain breaks every time an isolated file lands next.
>
> So a whole-shard shuffled run exercises reuse **less** hard than the default run does. It
> looks like the stronger test and is the weaker one. Five such runs were queued here before
> the sequencer was read; they would have been published as contamination evidence they had
> not actually gathered.
>
> Shuffle the **reused project alone** (`--project <shard>:reused --sequence.shuffle.files`).
> One project means order is randomized with the chain intact.

## The mechanism, and why it is not a config option

The installed Vitest (5.0.0-beta.6) reuses a completed runner in exactly one place —
`ProcessPool.runTask`, after a file finishes:

```js
if (!task.isolate && !runner.isTerminated && !isMemoryLimitReached
    && this.queue[0]?.task.isolate === false && isEqualRunner(runner, this.queue[0].task)) {
  this.sharedRunners.push(runner)
  return this.schedule()
}
```

`isEqualRunner` compares `runner.project !== task.project`, so **projects pool separately**.
That is what lets one shard run a reused project and an isolated project side by side in one
invocation, rather than needing two.

It also means the *file order* decides how much reuse actually happens: the runner is only
handed on when `this.queue[0]` is another non-isolated file of the same project. Vitest's
`BaseSequencer` sorts by project name first — "Projects run sequential" in its own comment —
so under the default order the reused project's 62 files are contiguous and the chain is
maximal. That matters for reading the randomized-order evidence below, because
`RandomSequencer` replaces that sort *entirely* with a shuffle over all files.

What the worker then does *not* do is the point. Its per-file loop:

```js
for (const file of files) {
  if (config.isolate) {
    moduleRunner.mocker?.reset()
    resetModules(workerState.evaluatedModules, true)
  }
  ...
  vi.resetConfig()
  vi.restoreAllMocks()
}
```

The module registry and the mocker are reset **only when isolation is on**. Skipping them is
where the saving comes from — a reused file's import closure is already evaluated — and it
is also precisely what turns a leftover into contamination.

One thing survives that is easy to assume does not: **setup files still run per test file.**
`VitestTestRunner.importFile` invalidates a setup module before importing it —

```js
if (source === 'setup') {
  const moduleNode = this.workerState.evaluatedModules.getModuleById(filepath)
  if (moduleNode) this.workerState.evaluatedModules.invalidateModule(moduleNode)
}
```

— so `test-hermetic-env.ts` is re-evaluated for every file even with isolation off. Its
*module scope* is therefore fresh each time, and everything it had parked on process exit was
not. That distinction is where the real defects were.

## The three defects in the shared hermetic setup

These were not hypothetical. Each was live the moment a process outlived its test file, and
none of them is in a test suite — they are all in the setup every lane shares.

**None of them could bite the lane as it stood, and that is worth saying before the detail,
because "three defects in the hermetic setup" otherwise reads as though something has been
quietly shared all along.** Under `pool: 'forks'` with isolation, a fork evaluates the setup
exactly once and then dies: one exit-handler set, one tmp container anchored to the real host
tmp root, one state root. All three are properties of a *second* evaluation in the same
process, and there was never a second evaluation. They were a landmine for whoever enabled
reuse, not a live bug — which is precisely why reading test files could not have found them,
and why the scan in the previous section could not either.

**There is one exception, it is not vitest, and it is not latent.** `test-hermetic-env.ts` is
also wired as a `bun test` preload (`bunfig.toml`), a bun preload runs once per **process**,
and `bun test` runs every file of an invocation in that one process. So under `bun test` the
files of one invocation share a container and a state root **today** — measured, not inferred:
two throwaway files reported the same pid, the same `TMPDIR` and the same `PODIUM_STATE_DIR`.

Two consequences matter more than the mechanism. A test that passes in those lanes is **weaker
evidence than it looks**, because the per-file isolation it appears to have is not there — a
green can rest on state another file in the same invocation created. And an unreproducible
flake in `test:bun` is now explainable: order-dependent behaviour between files in one
invocation is possible, and would present as a flake that vanishes when the file runs alone.

It is pre-existing and unchanged by this work — the module still evaluates once there, so all
three fixes above are inert — and it is filed as **POD-553 (Bug: bun test files share a state
root)** rather than fixed here. It is not this issue's, and inside a performance change it
would have been invisible. The lanes affected are `test:bun` and `@podium/runtime`'s own test
script; the single-file invocations are unaffected by construction.

The three, in detail.

**1. `PODIUM_STATE_DIR` was minted for the first file only.** The old code read:

```ts
if (!process.env.PODIUM_STATE_DIR) {
  process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-test-'))
}
```

Under isolation the condition is always true — each fork starts from the parent env. Under
reuse it is true once, and every file after the first silently shares file 1's state root.
That is the cross-file contamination this shard exists to prevent, and it was in the guard
rather than in anything guarded. The escape hatch the condition existed for (a suite that
exports its own `PODIUM_STATE_DIR`) still works: the module now remembers the value it
assigned, so a value it did not assign is left alone.

**2. Each file's tmp container nested inside the previous file's.** The container is created
with `mkdtempSync(join(tmpdir(), 'podium-test-run-'))`, and the previous file had already
pointed `TMPDIR` at its own container — so `tmpdir()` returned it. File 2's container lived
inside file 1's and vanished when file 1's was released. The host tmp root is now captured
once, on the first evaluation in the process, and every container is anchored to it.

**3. Exit handlers stacked one set per file.** `process.on('exit', removeAll)` plus three
signal handlers, registered on every re-evaluation. Four listeners per file, one *per event
name*, so a 62-file runner would pass Node's 10-per-event warning threshold at file 11 and
re-run the whole accumulated cleanup once per file on exit — that much is arithmetic from the
code rather than something observed, since the fix landed with the reuse. What *is* observed is
the fixed behaviour: the probe below asserts the count does not grow across three files in one
process. They are installed once per process now, against a container
list that lives on a `globalThis` symbol rather than in module scope — module scope being
exactly what re-evaluation throws away.

Cleanup itself moved off process exit: `releaseHermeticTmpContainer()` runs at the end of
each reused file. Exit remains the backstop.

**Each of the three is guarded by identity, not by existence.** A fix whose only evidence is
a passing reused shard is a fix that gets refactored away silently — a shared state root does
not throw, it just makes two files agree when they should not. So the spawned probe in
`scripts/server-test-reuse.test.ts` records, from inside each of three files running in one
process, its `PODIUM_STATE_DIR`, its `TMPDIR` and `process.listenerCount('exit')`, and asserts
three *distinct* state roots, three *distinct* containers with none nested inside another, and
an exit-listener count that does not grow. Each assertion fails on exactly the defect it
describes.

## Which files may share a runner, and who decides

`apps/server/src/test-support/reuse-plan.ts`. The rule is the asymmetry in the worker loop
above: **anything Vitest undoes between files is allowed, anything it does not is
disqualifying.**

| construct | undone between files? |
| --- | --- |
| `vi.spyOn` | yes — `vi.restoreAllMocks()` |
| `vi.setConfig` | yes — `vi.resetConfig()` |
| `vi.mock` / `vi.doMock` | **no** — the mocker reset is skipped |
| module registry state | **no** — `resetModules` is skipped |
| `vi.useFakeTimers` | **no** |
| `vi.stubEnv` / `vi.stubGlobal` | **no** |
| `process.env` writes | **no** |
| `globalThis.x = …` | **no** |
| `process.on` / `chdir` / `exit` | **no** |

The scan is syntactic and deliberately over-broad. It demotes a file that saves and restores
`process.env.FOO` perfectly correctly, because "it restores correctly" is a reading of the
code and this has to hold without one. A false demotion costs one file its share of a
process; a false promotion costs the lane its determinism.

**Membership is derived on every run, not listed.** Adding `vi.useFakeTimers()` to a reusable
file demotes it on the next run with no manifest to regenerate — the direction that has to be
automatic. That mirrors POD-520's rule for shard membership, and for the same reason: a
hard-coded list drifts silently and then is wrong in the direction that matters.

What the 70 contracts files actually contain:

| verdict | files | why |
| --- | ---: | --- |
| reusable | 62 | nothing on the list above |
| demoted — `fake-timers` | 4 | `auto-continue`, `modules/daemon-request`, `modules/sessions/publish-worker-client`, `title-filter` |
| demoted — `env-write` (+`env-delete`) | 3 | `codex-auth`, `modules/server-transfer/service`, `setup-route` |
| demoted — `global-write` | 1 | `modules/messaging/telegram-send` |

**Zero use `vi.mock`.** That is worth stating: the population POD-520 separated by import
closure turned out to be unusually clean by this second, unrelated measure too — but 8 files
were not, and nothing about the word "pure" in the shard name would have found them.

`vi.spyOn` appears in 5 files and `mkdtemp` in 14; neither demotes, the first because Vitest
restores spies after every file and the second because the container is per file and released
per file.

### The 8 are not misbehaving

Worth being precise about, because "8 files were demoted" invites someone to go and fix them.
There is nothing to fix. On reading, **all eight restore correctly**: the four fake-timer files
pair `useFakeTimers` with `useRealTimers` (two through `beforeEach`/`afterEach`, two through
`try`/`finally`), the three env writers save the prior value and restore or delete it in
`afterEach`, and `telegram-send` captures `globalThis.fetch` and puts it back.

**Measured, not just read.** A throwaway config put all 70 into a single reused runner with the
leak guard armed: 70 files, 701 tests, **zero leak-guard failures**, and the only red was the
pre-existing `daemon-mux` one. One run in one order is stronger evidence here than it would
normally be, because the guard's question is per-file — *did this file leave the process as it
found it* — and a file that restores cannot contaminate any neighbour, whatever the order.

They are demoted because the scan reads **text** and cannot know that a restore runs on every
path. Which is the distinction that generalises past this issue: **the population is bounded by
what a static reader can prove, not by what the code does.** Those are different sets, and the
gap between them is 8 files. Teaching a regex to recognise a paired restore would be the design
refusing its own discipline — and it would be wrong in the direction that matters the first time
a restore sat behind a conditional.

So the ceiling here is 70 rather than 62, and reaching it needs a **per-file opt-in enforced by
the leak guard** — a file declaring itself reuse-safe, with the runtime check as the thing that
holds it to that — not a cleverer scan. That is deliberately not built here: one fork each for
8 files is a fine outcome, and the opt-in is a mechanism worth designing on its own terms rather
than as a rider. Filed as **POD-557 (Per-file opt-in for runner reuse)**, which also carries the
larger question it opens — whether a per-file opt-in is how a well-behaved file in `store` or
`services` could earn reuse without its whole shard doing so.

Reuse is gated on the **shard id** as well as the scan — `REUSE_ENABLED_SHARDS = ['contracts']`.
`store`, `services` and `boundary` compose the application and hold singletons;
`normalized-wire` is serialized on purpose. A new shard does not opt itself in by looking
clean, and widening the list is a decision that fails a test until it is made deliberately.

## The leak guard

The scan reads text. It cannot see a module-scoped cache inside the *source* a test imports,
or a socket a helper opened. `test-hermetic-reuse-guard.ts` can, because it observes the
process rather than the text — but only after the fact. Neither is sufficient alone.

It snapshots before the test file is imported and compares after the file's last test:

- every `process.env` key — added, deleted, or changed;
- `process.cwd()`;
- every own **data** property of `globalThis`, by identity (accessors are skipped — reading
  one runs its getter, which is a side effect a guard has no business causing). A key-set diff
  alone would miss `globalThis.fetch = vi.fn()`, which is the common shape;
- `vi.isFakeTimers()`;
- `process.listenerCount` per event, growth only;
- `process.getActiveResourcesInfo()` per kind, growth only — a server left listening or an
  interval left running holds the shared process open and keeps doing whatever it does while
  later files run.

It fails the file that leaked, not the file that inherited. A contamination bug that surfaces
two files later and only in one file order is the failure mode POD-515 refused to accept; this
converts it into a local, deterministic, self-naming failure.

## Two projects, one shard, one cache unit

`isolate` is a project-level option, so the shard becomes two Vitest projects rather than two
invocations — one Turbo task, one cache key, one process pool, and no second Vitest boot
(POD-520 measured that at ~3.7 s of CPU).

One trap, found by running it: **a root-level `include` is resolved ahead of each project's
own.** Leaving the shard roster there made both projects collect all 70 files — every test ran
twice, and isolation was decided by whichever project reached the file first, silently. The
roster now lives only in the two project includes, and `scripts/server-test-reuse.test.ts`
checks their union against the manifest.

The demoted files stay in the shard. Reuse is not a reason to stop testing something, and a
shard whose `include` quietly shed 8 files would be the same false green POD-520's split was
built to refuse.

## What is pinned, and the check whose absence looks like success

`scripts/server-test-reuse.test.ts`, in `@podium/scripts` (inputs `apps/**` + `packages/**`,
so it re-derives on any source change):

- the two project includes **partition** the manifest's contracts roster — union equal, no
  duplicates;
- each project's include equals a **freshly recomputed** split, so the config cannot drift
  from the rule;
- `isolate` is false in exactly one project and true everywhere else;
- every disqualifier still matches its own construct (table-driven over the rules), and an
  ordinary contract test trips none of them;
- the `/g` regexes do not carry `lastIndex` between files — without the reset, the *second*
  file with a given construct reads as clean, and only in the order the files happen to be
  scanned;
- **reuse actually happens.** This is the one no other guard can see. If a Vitest upgrade
  changed the pool so a finished runner is never handed on, every test would still pass, every
  guard would stay green, and the only symptom would be that the lane got slower — which is
  indistinguishable from a busy host. So it is asserted against real process ids: three probe
  files write `process.pid`, and the run must produce **one** pid with isolation off and
  **three** with it on;
- **the leak guard refuses.** A guard that never fires is indistinguishable from one that
  cannot fire. A fixture file leaks one env var, passes its own assertion, and the run must go
  red naming the file and the key.

The last two spawn Vitest against a throwaway fixture rather than asserting on config, for the
reason POD-520 gave for its exit-code fixture: the pool's behaviour is not in the config, and
an assertion about the config would not catch a change in the pool. They cost about 11 s.

`scripts/test-configuration.test.ts` was **widened, not loosened**. Its per-shard loop now
also runs over each project inside a shard — a project is where a Vitest option takes effect,
so a shard that kept the hardening at the top and lost it in a project would have passed the
original loop while running unhardened. Every project keeps the hermetic setupFiles, POD-523's
schema-image globalSetup, the 20 s timeout, `retry: 0`, `passWithNoTests: false` and the
two-worker cap. The reused project's only deviation is **one additional setupFile** — the leak
guard, appended to the shared three, never replacing them. `passWithNoTests: false` holds for
every project, which is why the isolated project is emitted only when the scan actually
demoted something rather than being allowed to be empty.

## What it cost, measured

### How it was measured, because the host makes that the first question

This is a shared six-core host that normally runs several agents at once. Across the
measurement block `/proc/loadavg` sampled every 10s read **26 to 43** — 3× to 5× oversubscribed
— and a neighbour separately observed a **peak of 94** twenty minutes before the block started.
That peak is *not* the condition these numbers ran under and is quoted only so nobody mistakes
it for one.

Absolute seconds on such a host are noise. The evidence is built to survive that:

- **Paired and alternating.** reuse, isolated, reuse, isolated, reuse, isolated — same config,
  one CLI flag apart (`--isolate` forces isolation back on for every project) — so drift over
  the block hits both arms rather than one.
- **Within-run phase ratios, not wall clock.** Vitest reports import/collect separately from
  transform and from test bodies, and a ratio taken inside one run is immune to what the host
  was doing in a way wall clock is not.

How much that mattered: **pair 2's *reused* arm is slower in wall clock than pair 1's *isolated*
arm.** Anyone reporting absolute seconds from this block would have published whichever direction
the dice fell.

### The A/B — three pairs, six runs

| pair | host load | import/collect | setup | process CPU |
| --- | --- | --- | --- | --- |
| 1 | ~27 | 224.90 s → 119.05 s (**−47.1%**) | 45.03 → 29.35 s | 153.24 → 88.06 s (−42.5%) |
| 2 | ~42 | 534.78 s → 325.50 s (**−39.1%**) | 102.35 → 89.51 s | 216.15 → 133.91 s (−38.0%) |
| 3 | ~38 | 236.54 s → 151.46 s (**−36.0%**) | 40.88 → 40.84 s | 131.40 → 70.07 s (−46.7%) |

**All six runs identical**: 70 files, 701 tests, one failure — `gateway/daemon-mux.test.ts`,
which is one of the three POD-515 documented on main before this chain started. It fails inside
the *reused* project, which is worth stating plainly: the reused runner reports a genuine
pre-existing failure rather than swallowing it.

(701, not POD-520's 698: `static-web.test.ts` gained 3 tests on main between POD-520's branch
point and here. Not this change.)

### The whole lane

`bun run test -- --filter @podium/server`, all five shards, contracts reused:

| shard | files | tests | failed | import/collect |
| --- | ---: | ---: | ---: | ---: |
| `boundary` | 71 | 1,119 | 1 | 599.78 s |
| `services` | 47 | 570 | 1 | 501.60 s |
| `store` | 105 | 1,771 | 0 | 417.52 s |
| `contracts` (reused) | 70 | 701 | 1 | 113.75 s |
| `normalized-wire` | 2 | 8 | 0 | 77.57 s |
| **total** | **295** | **4,169** | **3** | **1,710.22 s** |

**The three known failures are still exactly three, the same three by name**, in three different
shards. `derived-family.runtime.test.ts` did *not* start passing despite changing on main — the
chain's identical-results anchor is intact. **No leak-guard failure anywhere in the lane.**

### Order-randomized runs

Contamination that depends on file order is the failure mode, so the order was randomized.
**How** matters more than the count, and getting it wrong would have made the evidence weaker
while looking stronger.

Vitest's `BaseSequencer` sorts by project name first, so the default order keeps the reused
project's 62 files contiguous and the reuse chain maximal. `--sequence.shuffle.files` swaps in
`RandomSequencer`, which replaces that sort *entirely* with a shuffle over **all** files — so the
reused and isolated projects interleave and the pool drops the chain every time an isolated file
lands next in the queue. **A whole-shard shuffled run therefore exercises reuse *less* hard than
the default**, which is the opposite of what this evidence is for.

So the primary runs shuffle the **reused project alone** (`--project server:contracts:reused`):
one project means order is randomized while the chain stays unbroken.

| run | files | tests | failed | leak-guard failures |
| --- | ---: | ---: | ---: | ---: |
| reused-only, seed 1 | 62 | 650 | 1 | **0** |
| reused-only, seed 20260807 | 62 | 650 | 1 | **0** |
| reused-only, seed 424242 | 62 | 650 | 1 | **0** |
| reused-only, seed 7 | 62 | 650 | 1 | **0** |
| reused-only, seed 99991 | 62 | 650 | 1 | **0** |
| whole shard, seed 31337 | 70 | 701 | 1 | **0** |

Six runs, six orders, **one distinct failure across all of them** — `daemon-mux`, the
pre-existing one, in every run. No leak guard fired in any of them.

Two tooling notes, both of which cost time here and neither of which is inferable:

- **`bun run test` takes the heavy lease itself** (`scripts/test.ts` wraps itself in
  `runWithHeavyTestLease`), and an acquire by an identity that already holds it *renews*
  rather than erroring — so the inner release closes an outer hold, silently. If you take the
  lease and then run `bun run test`, you are not holding what you think afterwards. Filed as
  POD-561.
- **A `pgrep -f` guard matches its own command line.** Chaining a second script with
  `while pgrep -f 'scripts/measure.sh'; do sleep 5; done` never terminates, because the
  wrapper's own `bash -c` string contains that pattern. It waited 50 minutes on itself here,
  and the shared test lease got blamed twice before the real cause was found.

### The @podium/scripts lane

The guards live there, so it was run whole: **49 files, 809 tests, 6 failures across 4 files.**

All four are in the set POD-531 (*Bug: guardrail audits fail on main*) documents on a clean main
— `rearch-audit` (3 cases), `audit-god-objects`, `audit-durable-classes`, and
`test-configuration`'s pre-existing mobile `setupFiles` case. A strict subset of the 7-across-6
POD-520 recorded, with no new file. `server-test-reuse.test.ts` and `server-test-shards.test.ts`
both pass, and every case this change adds to `test-configuration.test.ts` passes.

### The share of the cost this actually addresses

POD-515's review measured import/collect at 53.5% of aggregate phase work and named it the
dominant cost. Two findings, and the second is a correction the first does not soften.

**The review understated it.** In this lane import/collect is **66.4%** of aggregate phase work
(1,710.22 s of 2,574.99 s across transform, setup, import and bodies). POD-523 moved migration
replay out of test bodies, which raised import's share rather than lowering it. Import/collect
is now two thirds of the lane.

**And runner reuse reaches about 4% of it.** Scaling the contracts shard back to isolated by the
three measured ratios (1.562, 1.643, 1.889):

| | contracts isolated | saved | baseline lane import | **share addressed** |
| --- | ---: | ---: | ---: | ---: |
| lowest ratio | 177.6 s | 63.9 s | 1,774.1 s | **3.60%** |
| median ratio | 186.9 s | 73.1 s | 1,783.4 s | **4.10%** |
| highest ratio | 214.9 s | 101.1 s | 1,811.4 s | **5.58%** |

The reason is structural and was visible from the start: **`contracts` is 10.5% of baseline lane
import.** `boundary` and `services` together are **61.8%** — and they are exactly where reuse is
not safe, because they compose the application and hold singletons. `store` is another 23.4%.

So the review was right that import/collect dominates, and more right than it knew. It was wrong
that runner reuse is the lever for it. Reuse is safe precisely where the cost is smallest; the
lever for the other 85% would have to reach shards that compose the application, and nothing
here shows that is safe. A 40% cut on a tenth of the cost is a real result and a small one, and
publishing it as a ratio on `contracts` alone would have been the same mistake POD-520 named
when it caught itself reading 64% as a lane number.

Caveat on the share, stated rather than buried: the lane runs its shards concurrently, so every
shard's import phase is inflated by the others. The inflation is roughly uniform, which is why a
*share* survives it where absolute seconds do not.

## What this does not do

It does not touch `packages/sync` or the `relay.*.test.ts` family, which stay in the default
gate at full isolation while the sync rewrite is in flight. `packages/sync` remains in all
five shard cache keys.

It does not reduce **transform** time, which is main-process work and identical in both arms.
The saving is import/collect and setup — the 53.5% share POD-515 measured — and it is bounded
by how many files are reuse-eligible.

It does not make the other four shards faster. Whether any of them can follow is a question
for a mutation run and an order-randomized run on that shard's own population, not an
inference from this one.
