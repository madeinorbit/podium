# POD-520 — @podium/server test cache shards

The `@podium/server` test lane was one Turbo hash over the server package plus nine upstream
package trees, replaying all 295 unit files on any edit to any of them. It is now five
independently cached shards behind one aggregate task.

**Two results, in order of importance.**

**1. The old cache key was already lying.** It listed neither `apps/cli/src/**` nor
`apps/daemon/src/**`, and server tests import both. Changes to CLI and daemon source were being
served past from cache — a false green that predates every issue in this chain. Deriving the
inputs instead of maintaining them by hand is what surfaced it, and the new keys declare both.

**2. One shard of 70 files now goes quiet on three edits out of four.** The `contracts` shard —
the pure policy/contract/types-runtime matrices — replays on only 25% of `apps/server/src`
edits. That is the win. The lane-wide number is 295 → a mean 189 files replayed (100% → 64%),
but reading that as the headline gets the result backwards: the other four shards mostly
demonstrate that an honestly-composed application is honestly entangled, and no cache
configuration can pretend otherwise. What was bought is `contracts`; what could not follow, and
why, is in "Why the split is not directory-shaped" below.

The deliverable is a cache split, so the thing to judge is not how much faster it is. It is
whether every shard's declared inputs still cover the source its tests actually consume. A
shard that goes green against source it did not hash is worse than the lane it replaced.

> **`apps/server/test-shards.json` and `apps/server/turbo.json` are generated. Do not hand-edit
> them.** Both are derived from the import graph by `scripts/server-test-shards.ts --write`. The
> file-level input globs are exactly the kind of thing a later hand-edit coarsens "for
> readability" — and coarsening them to directories costs most of the benefit (85% replay
> instead of 62%; see the table below). `scripts/server-test-shards.test.ts` recomputes both and
> fails on any difference. It runs in the default unit lane, which CI runs at
> `.github/workflows/ci.yml` (`bun run test`), so a hand-edit cannot reach main quietly.

## What changed

| | Before | After |
| --- | --- | --- |
| Turbo tasks | `@podium/server#test` | `test` + `test:contracts`, `test:store`, `test:services`, `test:boundary`, `test:normalized-wire` |
| Where inputs are declared | root `turbo.json`, hand-written | `apps/server/turbo.json`, generated |
| Granularity of server inputs | whole package (`$TURBO_DEFAULT$`) | per file, derived from the import closure |
| Membership | two globs (regular, normalized-wire) | explicit per-shard file list in `apps/server/test-shards.json` |
| `bun run test` | runs the lane | runs all five shards, then the exhaustiveness refusal |

`apps/server/turbo.json` is a Turbo Package Configuration (`extends: ["//"]`), so its 1,582
generated input globs sit next to the package they describe instead of quadrupling the root
config. `@podium/server#test` no longer appears in the root `turbo.json`.

One change outside the server package was forced by the split: `scripts/test.ts` now passes
`--continue=dependencies-successful`. Without it Turbo stops at the first failing shard, so a
red in `contracts` hides whatever `store`, `services` and `boundary` would have said — the
single server task used to report all of its failures in one run, and that had to be preserved.

Both generated files come from `scripts/server-test-shards.ts`:

```
bun scripts/server-test-shards.ts --write     # regenerate manifest + apps/server/turbo.json
bun scripts/server-test-shards.ts             # what `@podium/server#test` runs: the refusal
```

## Why the split is not directory-shaped

The POD-515 review suggested five units by directory. Measured against the real import graph,
that split does almost nothing — because the server's module graph is a hairball, not a tree.

Of 311 apps/server test files, **133 transitively reach `src/composition` or `src/application`**,
and for **87 of them the first hop out of the test file is `src/relay.ts`** — 1,739 lines that
import `composition/reactions` and roughly forty module services. Anything that composes the
application honestly depends on nearly every module in it.

So a shard whose members compose the app cannot be narrowed, whatever it is called:

| Partition | Mean test files replayed per `apps/server/src` edit |
| --- | ---: |
| Today, unsharded | 295 / 295 (100%) |
| By directory, as the review sketched | 274 / 311 (88%) |
| By measured consumption (shipped) | 189 / 295 (64%) |

Membership is therefore assigned by what a test consumes, not by where it lives — which is what
the review's own "Cache invalidation pressure" section asks for ("split tests by the source they
actually consume"). The five names are kept; the boundaries under them are measured.

Input granularity mattered just as much. Coarsening the generated globs to one per directory
would have given back most of the win:

| Input granularity | Mean replay | Server input globs |
| --- | ---: | ---: |
| One glob per file (shipped) | 62% | 1,237 |
| File-level at `src/` root, directories below | 80% | 406 |
| One glob per directory | 85% | 136 |

Directory globs are a safe superset — they over-invalidate, never under — but `src/` is a flat
55-file dump and `src/modules/sessions` holds 48 heterogeneous files, so few suites consume a
whole directory. The verbosity is the price of the split being worth making.

## The shards

| Shard | Files | Replays on … of `apps/server/src` edits |
| --- | ---: | ---: |
| `contracts` — pure contracts, policies, types-runtime matrices | 70 | 25% |
| `store` — store and migrations | 105 | 55% |
| `services` — issue/session/message/workflow services | 47 | 89% |
| `boundary` — composition, router, gateway, server, and every source audit | 71 | 100% |
| `normalized-wire` — the two serialized load guards | 2 | 68% |

`contracts` is where the benefit is: three quarters of server edits never touch it.
`boundary` replays always, by design — see the scanner rule below.

Assignment (`shardOf`) is ordered so structural rules beat measured ones:

1. the two normalized-wire files → `normalized-wire`;
2. anything that reads or spawns repo source → `boundary`;
3. `src/store/**`, `src/migrations/**` → `store`;
4. reaches `composition`/`application` → `services` if it lives under `src/modules/`, else `boundary`;
5. reaches `store` without composing the app → `store`;
6. otherwise → `contracts`.

## The three false-green traps this had to close

**1. Every shard depends on the migration tree.** Most shards import nothing under
`src/migrations`. They depend on it anyway: POD-523's `test-pre-migrated-schema.ts` globalSetup
hashes the migration manifest to build the schema image that every store in every shard clones.
A changed migration changes the database all five shards run against. `src/migrations/**` is a
lane-level input on all of them, and `scripts/server-test-shards.test.ts` fails if one drops it.

**2. Tests that read or spawn what they never import.** The old single key carried three
hand-written entries whose reason was not recorded next to them —
`packages/client-core/src/engine/outbox-coverage.oracle.test.ts` and two `scripts/audit-*.ts`.
They are there because `oracle-tags.test.ts` reads the first with `readFileSync` and the two
cutover audits *spawn* their scripts as subprocesses. A purely import-derived key would have
dropped all three and cached straight past a change to any of them.

The generator now derives them: it extracts repo-root path literals from a test file, but only
when that file also reaches the filesystem (`readFileSync`, `readdirSync`, `spawnSync`, …).
That gate is what separates dependency from mention — without it the rule also fired on about
a dozen docstrings naming a sibling audit and on fixtures like `'apps/web/a.ts'`, dragging whole
package trees into narrow shards. **With the gate, the derivation reproduces exactly the three
entries the old key carried by hand and adds none of the prose references.** That agreement is
the evidence that the rule reads dependency, not text.

**3. Scanners that walk a directory at runtime.** A test doing `readdirSync(here)` depends on
files no closure and no path literal can name. All such tests are pinned to `boundary` (rule 2
above), and `boundary` declares `src/**` and `test/**` whole. Its measured closure is already
353 of 363 server sources, so the coarsening costs essentially no precision and removes the
class.

## What did not change, and one thing that widened

**`packages/sync` still triggers the whole server lane.** It is in all five shard keys, exactly
as it was in the single key. A sync-source change replays all 295 files. The in-flight sync
rewrite's feedback loop is untouched, and `scripts/server-test-shards.test.ts` asserts it, so
narrowing it later has to be a deliberate decision rather than a side effect of regenerating.

Per upstream package, after the split:

| Package | Shards replayed | Files replayed |
| --- | ---: | ---: |
| commands, harness, issue-client, model, protocol, runtime, sync, transcript | 5 / 5 | 295 / 295 |
| telemetry | 3 / 5 | 223 / 295 |
| client-core | 1 / 5 | 71 / 295 |

**The key widened in one place, closing the pre-existing hole from the top of this document.**
`apps/cli/src/**` (boundary) and `apps/daemon/src/**` (store, boundary) are now declared by the
shards whose tests import them. The old `@podium/server#test` key listed neither.

## The A/B: the sharded lane runs the same suite

`bun run test -- --filter @podium/server`, cold, on this branch:

| Shard | Files | Tests | Failed | Duration |
| --- | ---: | ---: | ---: | ---: |
| `contracts` | 70 | 698 | 1 | 94.3 s |
| `store` | 105 | 1,771 | 0 | 261.8 s |
| `services` | 47 | 570 | 1 | 188.1 s |
| `boundary` | 71 | 1,119 | 1 | 496.8 s |
| `normalized-wire` | 2 | 8 | 0 | 119.0 s |
| **Total** | **295** | **4,166** | **3** | 17m30s wall |

295 files is 293 regular + the 2 normalized-wire, which is what the unsharded lane collects
(POD-523 measured 293 regular; POD-515's profile reached 291 before its `&&` truncated the run).

**The three failures are the same three, by name** — `server.role.test.ts`'s hub-off contract
coverage, `gateway/daemon-mux.test.ts` 24→25, and `modules/derived-family.runtime.test.ts`
23→24. They are the three POD-515 documented on main before this chain started and POD-523
reproduced in both arms of its own A/B. This change touches none of those files or their
sources; they now land in three different shards (`boundary`, `contracts`, `services`), which is
also what proves `--continue` is doing its job — before it, the first one hid the other two.

`@podium/server#test` itself produced no output: with three shards red,
`--continue=dependencies-successful` skipped the aggregate rather than letting the roster check
report on a lane that did not finish. That is the intended behaviour, observed.

### What the split costs

Sharding turns two Vitest invocations into five. It does **not** duplicate per-file work: the
lane runs `pool: 'forks'` with isolation, so every test file already gets its own process and
builds its own module graph — that cost is per file, not per invocation. The only duplicated
cost is the main process, measured directly here by running one shard config against a single
trivial file (twice, warm):

```
wall 2.96 s   user 2.59 s   sys 1.35 s
wall 3.13 s   user 2.72 s   sys 1.28 s
```

So a whole invocation — Vitest boot, config load, and POD-523's `ensureSchemaImage` globalSetup
(a manifest-hash cache hit on a warm checkout) — costs about **3.7 s of CPU**. Three extra
invocations is therefore **roughly 11 s of CPU against the 1,339.92 s POD-523 measured for this
lane: under 1%.** That is the price of the split, and it is paid only on a cold run.

## What this does not do

Sharding improves *miss frequency* and makes CI distribution possible. It does not reduce total
cold CPU: a cold `bun run test --filter @podium/server` runs the same 295 files it did before,
in five processes instead of two. The 1.78× suite-CPU cut and the 2,337 → 12 migration-chain
reduction belong to POD-523, which this branch is stacked on; nothing here adds to them.

`services` and `boundary` have nearly identical input sets today, so they miss together. They
are separate units for ownership and for CI distribution, and because decomposing `src/relay.ts`
(POD-548) would let them diverge with no further Turbo change — the inputs are derived, so they
narrow by themselves.

## How it is kept honest

`scripts/server-test-shards.test.ts` lives in `@podium/scripts`, whose Turbo inputs are
`apps/**` and `packages/**`, so it re-derives on any source change in the repository. A guard
served from cache while the graph moved underneath it would be no guard.

It fails when:

- an apps/server unit test file is claimed by no shard, or by two;
- the manifest lists a file the unit lane no longer collects;
- **any of the 672 files under apps/server is matched by no shard's globs** — the complement
  of the refusal above. That one asks "does every test file run?"; this asks "can a server file
  change without a single shard noticing?", which is the failure that looks most like success;
- a shard's declared inputs no longer cover its re-derived closure;
- `apps/server/turbo.json` differs from the derivation;
- `test` stops depending on all five shards (which is also how `test:affected` sees them);
- any shard drops a lane input, `src/migrations/**` above all;
- a `packages/sync` change would stop replaying the whole server suite — asserted as that
  conclusion, with the shard names and file counts in the failure message, because whoever
  sees it red will be mid-narrowing and needs to be told what they are about to break;
- the normalized-wire shard stops holding exactly the two wire files.

On `--continue`: nothing can report a green on top of a failure. `dependencies-successful`
(never `always`) means a task whose dependency failed is skipped, so a dead shard skips the
aggregate's roster check rather than letting it report on a lane that did not finish. And no
package's `test` task depends on another package's — the only dependency edges among test tasks
are `@podium/server#test` → its own five shards. `scripts/test-configuration.test.ts` asserts
both halves.

`scripts/test-configuration.test.ts` separately asserts each shard keeps the hermetic env
scrubber, POD-523's store fixture and schema image, `retry: 0`, `passWithNoTests: false`, and
the two-worker cap — one-worker for `normalized-wire`, which stays serialized.

The aggregate task (`bun ../../scripts/server-test-shards.ts`) is the cheap half of the same
refusal: it runs on every `bun run test` and exits non-zero if the roster does not describe the
checkout. `apps/server/vitest.config.ts` is retained unsharded as `test:unsharded`, for A/B
runs and ad-hoc use.

## Maintenance

Adding an apps/server test file makes the guard fail until the manifest is regenerated. That is
deliberate: the diff shows which shard the file joined, and a file moving between shards means
its imports changed. Regenerate with `bun scripts/server-test-shards.ts --write`.
