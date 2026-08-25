# Global-store cache admission

The canary lane (`docs/agents/global-store-canary.md`) shows that a global-store worktree
installs, resolves, and builds. This lane answers the separate question rollout depends on:
whether the results one worktree caches may be handed to the next, and whether a worktree
that should NOT read them is stopped.

Run it per target host, from a clean checkout:

    bun run deps:global-store-cache-admission -- \
      --cache-root /home/mgw/.cache/podium/global-store-cache-admission \
      --scratch-parent /home/mgw/.cache/podium/global-store-cache-admission-worktrees \
      --run-id <unique-host-and-date-label> \
      --output <path-inside-this-issue-worktree>.json

It creates three detached worktrees of one commit — a hoisted control and two candidates
installed independently through the same external global-store config — and removes them
afterwards. The tracked bunfig.toml is never touched.

## What the cache key now covers

`PODIUM_CHECK_ENV_HASH` used to fingerprint the tracked bunfig.toml. That file states an
intent; it is not a record of what happened. The canary installs its candidate through
`--config` and `--linker=isolated`, neither of which leaves a trace in the checkout, so a
hoisted worktree and a global-store worktree presented **byte-identical bunfig.toml files
and therefore one cache identity**. Nothing stopped a green produced under one linker from
being replayed under the other.

`scripts/install-topology.ts` reads the effective configuration instead — the bunfig files
Bun would consult, and the tree the installer actually left behind. The tree is the
load-bearing half: an install-time `-c/--config` or `--linker=` leaves no trace in the
checkout, so nothing a later `bun run typecheck` can read will tell it apart except the
result.

It records only what the INSTALLER wrote. A node_modules root also accumulates scratch
space — `.cache`, `.vite`, `.vite-temp` appear the first time something builds or tests —
and folding those in would be self-defeating in both directions: a worktree's own second
run would miss because its first run created them, and a freshly installed sibling could
never match a worktree that had already been used. So an entry counts only when it is a
symlink, one of the installer's own containers (`.bin`, `.bun`, an `@scope` directory), or
a directory carrying a package.json. A package directory that has lost its package.json is
skipped by that rule and does not pass silently: nothing there resolves, so the typecheck
goes red on its own rather than green from the cache.

Every record is path-independent by construction: a symlink is recorded by its relative link text where it
has one, otherwise only by the class of its target (inside this checkout, or external). That
is deliberate and load-bearing in both directions. It has to distinguish a hoisted install
(real directories under the root `node_modules`) from an isolated one (links into `.bun` and
the global store), and it must not distinguish two sibling worktrees that were installed the
same way at different paths — otherwise nothing could ever be shared. Which global store a
package came from is not recorded: bun.lock is already a Turbo `globalDependency` and pins
the content, so recording absolute store paths would split the cache per host for no gain.

## What a broken install may not do

The same walk refuses a dangling symlink anywhere in an install root — the checkout root,
each workspace, and, for an isolated install, the `.bun` store and each package link farm
inside it. The refusal runs in `scripts/typecheck.ts`, `scripts/test.ts` and
`scripts/test-affected.ts` before Turbo is spawned, so a broken environment can neither
serve a cached green nor record one.

An **absent** optional package is not a broken one. node-pty is optional, native, and
routinely missing from a worktree whose install skipped it; only a link that points at
nothing is a fault. Conflating the two would refuse healthy installs.

## One durable cache per repository per host

`sharedTurboCacheDir` keys the cache on the common git directory, so every linked worktree
of a repository lands in the same place. It now resolves under `$XDG_CACHE_HOME`, else
`$HOME/.cache`, and only falls back to the temporary directory when there is no usable home.
`TMPDIR` is reminted per agent session and per test file in this repository, so the previous
temporary-directory default silently gave many sessions their own cache and their own cold
start, and did not survive a reboot.

**What this lane does NOT prove: that the default location is writable where agents run.**
The lane pins `XDG_CACHE_HOME` at its own run directory, so what it demonstrates is that
sibling worktrees agree on one directory beneath whatever root is in force and share it.
The production root is `$HOME/.cache`, and reaching it from a spawned agent is a different
contract: the launcher and sandbox have to admit writes there, and the worktree bootstrap
has to give the session a `HOME` that is the operator's rather than an empty or per-session
one. That is POD-1305's ground, it is not settled, and nothing here should be read as
settling it. Until it is, the durable default is proven for the lane's own root only —
treat a host-wide `$HOME/.cache` hit as unverified rather than as a Stage 1 result.

## Recorded proofs

The JSON report exits nonzero if any acceptance field is false:

- `sharedCacheIsOneDirectory` — all three worktrees resolve the same cache directory, and it
  is inside none of them;
- `trackedBunfigIsIdentical` with `layoutSeparatesCacheIdentity` — the two layouts agree on
  the tracked bunfig and still get different identities. Together these are the POD-2774
  hole and its closure; either alone proves nothing;
- `independentCandidatesShareIdentity` — two separate installs of the same config agree;
- `hoistedProducesCache`, `hoistedToCandidateMiss` — a hoisted-warmed cache is a full miss
  for a candidate;
- `candidateTypecheckHit` — the independently installed reader replayed every task the
  producer was able to cache, recomputed none of them, and attempted the same work: the
  same task total, the same successful count, and the same set of failed tasks;
- `candidateTestHit` — a full hit for one representative package test;
- `sourceChangeMiss` — editing one source file misses again, so the hit was not indiscriminate;
- `brokenInstallRefused` — a dangling third-party link exits nonzero, names the entry, and
  prints no Turbo summary at all, which is how the report knows Turbo never ran;
- `refusalIsRecoverable` — restoring the link restores the hit, so the refusal was the only
  thing that changed;
- `noFullSuiteRequired` — every test proof ran exactly one Turbo task.

Hits and misses are counted from Turbo's own `Tasks:`/`Cached:` lines rather than grepped
for the words "cache hit": a run that prints "cache miss" may still have reused 23 of 24
tasks, and the single-task claim is a statement about the count.

## Why typecheck reuse is counted against the producer, not against a full hit

Turbo caches only SUCCESSFUL tasks. Three packages — `@podium/mobile`, `@podium/scripts`
and `@podium/web` — do not yet typecheck under isolated linking, because they import
third-party packages they never declare and a hoisted install hides that by putting
everything at the checkout root. That is tracked as POD-2781 and is not a cache defect: a
red task is simply never cacheable, so a full hit is unreachable however well the cache
works.

So `candidateTypecheckHit` asks the question that is actually about the cache — did the
reader recompute anything the producer had already cached — by comparing the reader's hit
count against the producer's successful count.

That comparison alone would be easy to satisfy by running LESS. A reader whose filter,
workspace list or task graph had shrunk to exactly the producer's 21 cacheable tasks would
report 21 cached and never attempt the other three, and it would look like the strongest
result in the report. So `reusedEverythingCacheable` pins the universe as well as the hit
count: same total, same successful count, same set of failed tasks — compared as a set,
because Turbo names failures in completion order. Any of those moving means the two runs
are not comparable and the predicate says no rather than handing back a number nobody can
interpret. Growth is refused for the same reason as shrinkage, in both the total and the
successful count. The failing task names are also parsed off Turbo's `Failed:` line, stored
in the report as `typecheckRedTasks`, and logged during the run. When POD-2781 lands and
the tree goes green under isolated linking, the producer baseline moves with it and the
same comparison proves the stronger thing with no change here. The typecheck probes pass
`--continue` for the same reason: without it Turbo stops at the first red package, and a
run that attempted 19 tasks cannot be compared with one that attempted 24.

The representative test defaults to `@podium/composer` — a leaf package with no workspace
dependencies and a green suite, so a hit or a miss there is about the cache identity under
test rather than a neighbour's rebuild or a failure the cache had no say in. Override it
with `--test-package @podium/<name>`; the lane edits that package's `src/index.ts` for the
source-change probe.

The lane points `XDG_CACHE_HOME` at its own run directory. That is the only override: the
cache directory itself is the one `scripts/typecheck.ts` derives, so the sharing under test
is the real mechanism, and the operator's own cache is neither read nor written.

## The lease is taken once, around the whole lane

`deps:global-store-cache-admission` runs through `scripts/validation-admission.ts heavy`, so
a single `test:heavy` lease covers every probe. It has to be there and not per probe: the
probes run in DETACHED worktrees, where `podium lock` cannot resolve a repository to name a
holder in, so an inner acquire would fail rather than wait — and without an outer lease a
routine agent invocation would run several cold full-graph typechecks and a package test
suite with nothing admitting them. That was the state before this lane was leased, and the
host had no way to know it was busy.

`probeEnv` makes the no-nesting half of that intrinsic rather than incidental. It unsets
`PODIUM_SESSION_ID` (no identity, no lease) and sets `PODIUM_VALIDATION_RESOURCE_HELD=heavy`
(this command is already inside a heavy lane), which are the two conditions
`runWithValidationAdmission` branches on. The marker is a Turbo `globalPassThroughEnv`
rather than a `globalEnv`, so it reaches the tasks without entering any cache key. Both are
covered by `scripts/global-store-cache-admission.test.ts`, and the lease itself by the
package.json regression in `scripts/test-configuration.test.ts`.

Running `bun scripts/global-store-cache-admission.ts` directly still works and takes no
lease. Use the package script on a shared host.
