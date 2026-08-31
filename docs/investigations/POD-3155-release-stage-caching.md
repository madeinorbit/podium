# POD-3155 — Should the remaining release stages be cached, or made a build graph?

**Recommendation: no build graph, and almost no new caching.** The measured
non-client release spends its time on work that is either *unique to every
publish* (so a cache can never warm), *required to run* (identity, signing,
digest), or *slow for a reason caching does not address* (single-stream gzip).
Two of the three biggest wins available are not caching at all.

Scope: the non-client stages of the approved development release. The client
lane already goes through Turbo (POD-3053) and is out of scope here except
where it explains the timing.

Evidence base: `~/.podium/builds/20260831T061423Z-f8e38a1/timing.jsonl` —
the real ledger for `0.1.1-dev.30+f8e38a1`, the 45.36 s publish. Compression
and determinism figures were measured on this box against the actual published
`linux-x86_64` bundle from that release. Source read at `f8e38a1`.

---

## 1. What the 45.36 s actually is

`approval-to-publish / approved-development-release` is the outer envelope:
**45.36 s**. The instrumented phases inside it sum to **27.34 s**.

| Phase | Task | linux-x86_64 | darwin-aarch64 | unscoped | total |
|---|---|---:|---:|---:|---:|
| headless-platform-build | archive | 7.03 | 5.09 | | **12.12** |
| checkout | detached-worktree | | | 3.93 | |
| checkout | remove-detached-worktree | | | 1.42 | **5.35** |
| headless-platform-build | compile-cli | 1.85 | 1.60 | | **3.45** |
| dependency-preparation | abduco-helper | 1.11 | 0.75 | | 1.86 |
| dependency-preparation | bun-install | | | 1.64 | **3.50** |
| signing | darwin-cli | | 0.49 | | |
| signing | headless-artifact | 0.29 | 0.21 | | **0.99** |
| artifact-publication | describe-artifact | 0.74 | 0.21 | | |
| artifact-publication | retention | | | 0.02 | **0.97** |
| desktop-work | resolve-standing-shell | | | 0.50 | **0.50** |
| validation | initial + final identity, final inputs | | | 0.21/0.02/0.22 | **0.45** |
| feed-activation | write-feed-manifests | | | 0.01 | **0.01** |
| | | | | **instrumented** | **27.34** |

**18.02 s — 39.7 % of the release — is inside the envelope and attributed to
no phase at all.** That is the single most important number in this report,
and it is larger than every cacheable stage combined. Named contributors, from
reading the code:

- `beginFreshClientPackagingSession` (`scripts/build-bun.ts:223`) — the client
  Turbo lane plus `verifyClientBuild`'s full per-file checksum of both dists.
  Untimed.
- The archive re-extract proof at `scripts/build-bun.ts:826` — `tar -xzf` of
  the finished tarball into a temp dir and a re-digest, per platform.
  **Measured 1.38 s per platform on the real bundle ⇒ ≈2.8 s.** Untimed.
- Child launch: `systemd-run --scope` in the BATCH tier plus a cold `bun`
  start of `scripts/release.ts` (`build-scope.ts`).
- `mkdtemp`/`rm -rf` of the snapshot parent in `withDevBuildSnapshot`'s
  `finally` (the `rm` of the temp parent is outside the timed
  `remove-detached-worktree` span), lock acquire/renew, record writes,
  `stagePrepared` copies.

You cannot honestly choose a caching strategy against a profile with a 40 %
hole in it. **Closing this gap is prerequisite work, and it is cheap** — the
`timeReleaseBuildTask` wrapper already exists and every one of those steps is
a single call site.

### The ledger is keyed by version, not by run

`emitReleaseBuildTiming` names the file `<version>.jsonl`
(`release-build-timing.ts:46,81`). The dev.29 ledger
(`20260830T205814Z-09743a0/timing.jsonl`) contains **two complete build
attempts appended into one file** — `checkout/detached-worktree` appears
twice — under a 29.33 s envelope that covers only the second. Any warm/cold
comparison built by summing that file is wrong. Fix before measuring anything.

---

## 2. Stage-by-stage: pure, must-run, or unique-per-publish

The decisive question is not "is this output a function of its inputs" but
**"does any input change on every publish?"** If it does, the cache is cold
every time and the machinery is pure cost.

| Stage | Pure? | Key changes per publish? | Verdict |
|---|---|---|---|
| checkout (worktree add/remove) | n/a — filesystem effect | — | Not a cache target. Avoidable only by reusing a snapshot tree, which trades away the isolation guarantee. **Leave it.** |
| validation ×3 (identity, inputs) | no — it *reads* the tree | — | **Must always execute.** These are the fences that make a `dev+<sha>` claim true. 0.45 s total; there is nothing to win and everything to lose. |
| bun-install | effectively pure given `bun.lock` | no | Already `--frozen-lockfile --offline --ignore-scripts` against the global store. 1.64 s is close to the floor for populating a fresh tree. Marginal. |
| abduco-helper | **yes** — `zig cc` of fixed C for a fixed target | **no** | **The one clean cache candidate.** 1.86 s, keyed on (abduco source, zig version, target triple). |
| compile-cli | no | **yes** | `--define process.env.PODIUM_APP_VERSION="<version>"` (`build-bun.ts:586`) bakes the release-unique `dev.N` label into the binary. Two publishes of the *same commit* produce different bytes. **Uncacheable as written** — see §3. |
| archive | **not reproducible as written** | yes | See §4. Member mtimes are fresh every build. Even normalised, its input is the per-publish binary. **Not a cache target; a throughput target.** |
| signing | no — reads a private key | yes | **Must always execute**, and its key material must never enter a cache key. See §5. 0.99 s. |
| describe-artifact (digest, size, meta) | no — it *is* the verification | yes | **Must always execute.** Caching a digest of bytes you did not read defeats the only thing the step does. |
| retention, feed-activation | no — they are the freshness act | — | 0.03 s combined. **Must always execute.** |
| resolve-standing-shell | no — reads the live standing manifest | — | **Must always execute**; freshness is the point. 0.50 s. |

**Total with a plausibly non-zero warm hit rate: 3.50 s** (abduco 1.86 +
install 1.64) — **7.7 % of the 45.36 s wall clock**, and the install half is
already near its floor.

---

## 3. The structural finding: version stamping decides what can be cached

The client lane is cacheable *because of how it was built*: `PODIUM_APP_VERSION`
is deliberately absent from `turbo.json`'s `env` and `globalEnv`, and
`buildClients` (`scripts/build-clients.ts:148`) runs Turbo **unstamped** and
then calls `stampClients` afterwards. Build pure, stamp after. That is the
whole trick, and it is why the client restores across version bumps.

`compile-cli` does the opposite: it bakes the version in at compile time via
`--define`. So the largest remaining compile stage is structurally uncacheable
across publishes, and no amount of Turbo configuration changes that.

This is the correct order of operations for any future work here: **you cannot
usefully cache a stage until its release-unique inputs have been moved
downstream of it.** For `compile-cli` that would mean the compiled binary
reading its version from the bundle rather than from a `--define` — a real
design change to `/version` identity, with its own correctness argument to
make, for a **3.45 s** prize. Not obviously worth it, and certainly not
worth doing as a cache optimisation.

---

## 4. The archive stage: 12.12 s, and caching is the wrong tool

Archiving is **44 % of all instrumented time** and the largest single line item
in the release.

**Reproducibility, measured.** `tar -czf` on this box writes a gzip header with
`MTIME=0`, so the compression layer is deterministic; two runs over an
*unchanged* tree produced byte-identical archives. But `touch`ing one member
changed the output — tar records member mtimes, and every release writes its
members fresh. **Today's archives are not reproducible across builds.** They
could be made so (`--sort=name --mtime=<commit date> --owner=0 --group=0
--numeric-owner`), and that is worth doing on its own merits for the audit
story — but it does not make the archive cacheable, because its *input* (the
version-stamped binary) is unique per publish anyway.

**Throughput, measured** on the real dev.30 `linux-x86_64` bundle contents
(157 MB in, 60.3 MB out), this box, 8 cores, unconstrained:

| Method | Time | Output |
|---|---:|---:|
| `tar -czf` (today) | 9.72 s | 60.3 MB |
| `tar \| pigz -n -p2` | 3.48 s | 60.3 MB |
| `tar \| pigz -n -p8` | 2.20 s | 60.3 MB |
| `tar \| zstd -3 -T2` | 0.51 s | 58.0 MB |
| `tar \| zstd -19 -T2` | 63.88 s | 46.7 MB |

`pigz` is already installed at `/usr/bin/pigz`. The build runs in a transient
scope with `CPUQuota=200%` and `CPUWeight=50` (`build-scope.ts`), so **`-p2` is
the honest comparison**: gzip is single-threaded and cannot use the second core
it has been granted.

Applying the `-p2` ratio (2.79×) to both legs: **12.12 s → ≈4.35 s, a saving of
≈7.8 s, or 17 % of the whole 45.36 s release** — from a one-line change with no
cache, no new failure mode, no retention policy, and a byte-identical gzip
artifact that every existing client can still install.

`zstd` is faster still and smaller, but it changes the artifact format and
therefore the update protocol every deployed daemon implements. Out of scope
here; note it and move on.

A second, independent lever: the two platform legs run in sequence only because
they share the fixed path `dist-bun/abduco.bin` (`scripts/release.ts:399`).
Per-target helper paths would let them overlap — but under a 200 % quota they
would then contend for the same two cores that `pigz -p2` wants. **Take one or
the other, not both**; `pigz` is far the cheaper change.

---

## 5. Risks, if caching were extended anyway

- **Stale artifacts.** The ledger-restore path (`readExistingDevBundle`) is
  already a coarse, safe cache: an exact-HEAD build that still verifies under
  the server's persisted key is reused wholesale. A finer cache adds a second
  restore path that must satisfy the same `assertSourceMatchesHead` fences and
  can disagree with the first. Two answers to "was this built from `f8e38a1`?"
  is strictly worse than one.
- **Signing and secret-bearing outputs.** `PODIUM_UPDATE_SIGNING_KEY` reaches
  the build through the child's environment (`dev-bundle.ts:1066`). Making
  signing a cached task requires the key in the cache key (or a signature
  restored without the key having been present) — both unacceptable. Signing
  stays uncached and unconditional. It costs 0.99 s.
- **Cache poisoning.** A restored `.sig` or a restored digest is a claim about
  bytes nobody read this run. `describe-artifact` exists precisely to refuse an
  unsigned or unhashable bundle *where the reason is still legible*; a cache in
  front of it converts a build-time refusal into a fleet-wide bad install.
- **Cross-platform identity.** `abduco-helper` and `compile-cli` are already
  correctly `target`-labelled in the timing records. Any cache key here must
  carry the target triple, or a darwin bundle silently ships a linux helper —
  the exact failure the shared `dist-bun/abduco.bin` path already invites.
- **Retention and disk pressure.** Each build directory is 110 MB and
  `DEV_BUNDLE_RETAINED` is 2. A Turbo cache over compile/archive outputs would
  add a *second*, differently-governed store of ~60–160 MB per key on a box
  that already has documented disk-pressure incidents. `sweepBuildRecords`
  would not see it.
- **Observability.** The version-keyed ledger (§1) cannot distinguish a warm
  hit from a cold run, or two attempts from one. A cache you cannot measure is
  a cache you cannot defend when a release ships wrong bytes.

---

## 6. Incremental targeted caching vs. a full Turbo graph

**A full Turbo graph is not appropriate here**, on three grounds:

1. **Fit.** Turbo caches task outputs keyed by declared file inputs. Over half
   the remaining stages have no file-input key at all — identity checks read
   git state, signing reads a private key, retention and feed activation are
   deliberate mutations of live state, and `resolve-standing-shell` fetches a
   remote manifest. Modelling those as Turbo tasks means marking most of them
   `"cache": false`, at which point Turbo is an orchestrator you did not need:
   the publisher already sequences them, with fences between.
2. **Yield.** The stages Turbo *could* legitimately own total **3.50 s of
   45.36 s**, and only **1.86 s** of that has a genuinely repeating key.
3. **Cost.** The graph would have to be authored, its inputs kept honest as the
   publisher changes, and its cache retained and swept — against a saving
   smaller than the measurement error the current ledger already has.

**Incremental targeted caching wins**, and the target list is short.

## 7. Recommendation

In priority order, by measured value:

1. **Close the 18 s observability gap** before anything else. Wrap the client
   packaging session, the archive re-extract proof, the child launch and the
   snapshot teardown in `timeReleaseBuildTask`. Prerequisite for every claim
   below being checkable.
2. **Make the timing ledger per-run**, not per-version. Today two attempts at
   one version concatenate silently (dev.29 proves it), so no warm/cold
   comparison from this data is trustworthy.
3. **Replace `tar -czf` with `tar | pigz -n`.** Measured ≈7.8 s (17 % of the
   release) for a one-line change and a byte-identical artifact. This is the
   largest available win and it is not caching.
4. **Normalise the archive** (`--sort=name`, fixed `--mtime`, numeric owner)
   so the tarball is reproducible from an unchanged tree. Do this for the audit
   story, not for a cache.
5. **Cache `abduco-helper` only**, keyed on (source, zig version, target).
   1.86 s, genuinely pure, small blast radius.
6. **Do not cache** compile-cli, archive, signing, describe-artifact,
   validation, retention or feed activation. The first two have per-publish
   keys; the rest must run.
7. **Defer** the compile-cli version-stamp restructuring (§3) and the `zstd`
   artifact format (§4) as separate, independently-argued changes. Neither is a
   caching decision.

Expected outcome if 1–5 land: **45.36 s → ≈35.7 s (−21 %)**, of which caching
contributes ≈1.9 s and compression ≈7.8 s. A full Turbo graph over the same
stages would add ≈1.6 s more, at the cost of a second restore path in front of
the signing and identity fences.

---

*Investigation only; no product code was changed. Figures are from the dev.30
ledger and from measurements taken on this host on 2026-08-31 against the
`f8e38a1` release artifacts. The build runs under `CPUQuota=200%`, so absolute
timings are not comparable to an unconstrained run — the compression table
above is unconstrained and is applied via its `-p2` ratio, not its raw time.*

---

# Addendum — five follow-up questions, answered with measurements

Measured 2026-08-31 on this host (8 cores) against the real `f8e38a1`
artifacts and the live checkout. Two of the answers below **correct** the main
report above; they are called out where they do.

## Q1 — Is `pigz` available everywhere? How do we guarantee it?

**The blast radius is much smaller than it looks.** A release build is
*linux-only by refusal* — `prepareHeadlessCross` throws unless
`process.platform === 'linux'` (`scripts/release.ts:409`). It never runs on a
user's machine, and it is not part of the update path: end users only ever
*extract* the tarball. So the question is not "is pigz on every reasonable
machine", it is **"is pigz on the two or three Linux hosts that cut
releases"**.

**It is not installed by default** on a minimal Debian/Ubuntu (or on most base
images) — it is a separate package, not part of any base set. It is present on
this host at `/usr/bin/pigz`. So it cannot simply be assumed.

**The guarantee should be a fallback, not a dependency**, because the output is
interchangeable. Measured:

- A `pigz -n` tarball extracts with plain `tar -xzf`, and the extracted
  `podium-cli` is byte-identical to the original. It is ordinary gzip.
- `pigz -n` is **deterministic across runs**, and — importantly — **produces
  identical bytes at `-p8` and `-p2`**. The artifact does not depend on how
  many cores the host had, so a host with pigz and a host without still differ
  only in *speed*, and two pigz hosts with different core counts agree exactly.

Given that, the right shape is the one this repo already uses for external
build tools: `resolveZig()` / `resolveRcodesign()` are
`findTool('PODIUM_ZIG', 'zig', [fallback])` (`scripts/abduco-cross.ts:171`).
Follow it with **one difference** — zig is mandatory and throws; pigz is an
optimisation and must **fall back to `gzip` when absent**, logging which
compressor it used. Implementation is a single `tar --use-compress-program`
argument (verified working), with `PODIUM_PIGZ` as the override.

Optionally add pigz to the machine provisioning notes so release hosts get the
fast path — but nothing should *break* without it.

## Q2 — Why is only 60 % attributed? What is missing?

Every untimed step in the release path was identified and measured. The
accounting against the **18.02 s** gap:

| Untimed step | Where | Measured |
|---|---|---:|
| **Pre-snapshot `assertSourceMatchesHead` on the LIVE checkout** | `dev-bundle.ts` `admit()`, before `withDevBuildSnapshot` | **0.8 s warm / 18.7 s cold** |
| Client Turbo lane + `stampClients` (warm restore) | `beginFreshClientPackagingSession` → `buildClients` | 3.51 s |
| Archive re-extract proof, ×2 platforms | `build-bun.ts:826` | 2.76 s |
| Bundle assembly: `syncBundleWeb` ×2 + 108 MB binary copy, ×2 platforms | `build-bun.ts:710,726` | ≈1.7 s |
| `stagePrepared` — second copy of both tarballs (111 MB) | `release.ts:297` | 0.62 s |
| `verifyClientBuild` (per-file hash of both dists) | `verify-client-build.ts:107` | 0.13 s |
| Child launch: `systemd-run --user --scope` + `bun` start | `build-scope.ts` | 0.06 s |
| `import` of `scripts/release.ts`'s module graph from source | — | 0.05 s |
| **Sum, with the guard warm** | | **≈9.6 s** |

**The dominant term, and the answer to the question, is the first row.** The
publisher runs `git ls-files -z --others --ignored --exclude-standard` over
`apps packages scripts tooling` on the **live checkout** before it takes the
snapshot, and that call is untimed. Measured on the live checkout:

- **cold: 18.66 s**
- warm (runs 2–4): 0.74 / 0.81 / 0.80 s

It enumerates only 235 files, but to do so it must walk every ignored tree the
pathspecs exclude — `node_modules`, `dist`, `.turbo`, `target` — and on a cold
page cache that walk is tens of seconds. Its snapshot-side twin
(`final-source-inputs`, timed) costs 0.22 s precisely because a fresh worktree
has almost nothing ignored in it.

That single call has a **23× dynamic range** and is the only untimed step that
does. It is the prime suspect for the whole gap, and dev.30's 18.02 s sits
inside its measured range. It cannot be *confirmed* without instrumenting it —
which is exactly the point.

**Getting to 100 % attribution** is nine `timeReleaseBuildTask` wrappers at the
call sites in the table, and the wrapper already exists. Suggested labels:

- `validation / live-source-inputs` ← **do this one first**
- `client-preparation / turbo-lane`, `client-preparation / stamp`,
  `client-preparation / verify`
- `headless-platform-build / assemble-bundle` (per target)
- `validation / archive-proof` (per target)
- `artifact-publication / stage`
- `checkout / snapshot-teardown`

With those in place the phase sum should reach the envelope to within tenths.

### Correction to §1 of the main report

The main report listed the client lane first among the gap's contributors. That
is wrong: **the client lane is a warm Turbo restore costing 3.51 s.** Measured
in an isolated worktree of this repo:

- cold (cache MISS, both clients): **53.69 s** — more than the entire release,
  which is itself proof dev.30 must have been a hit
- warm (cache HIT, dists deleted first): **3.51 s**, of which Turbo itself is
  **453 ms (FULL TURBO)**; the remaining ≈3 s is `stampClients` spawning two
  `bun` processes that import `@podium/model`

The restore works from the snapshot because the Turbo cache is **not** in the
checkout: `turboEnv` sets `TURBO_CACHE_DIR` to
`~/.cache/podium/turbo/<projectKey>` and `projectCacheIdentity` keys on the
**common git dir** (`scripts/typecheck.ts:177–222`), so a detached worktree in
`/tmp` shares the parent repository's cache. That design is the model for Q4.

`stampClients`'s ≈3 s is a real, separable target — two Bun process starts that
each pay for the `@podium/model` graph — but it is client-lane work and out of
scope here.

## Q3 — Should `compile-cli` stamp the version afterwards so it can be cached?

**The step costs 3.45 s** — 1.85 s `linux-x86_64` + 1.60 s `darwin-aarch64`
(dev.30). That is the entire prize.

**Moving the version stamp out is necessary but not sufficient, and on its own
buys nothing.** `build-bun.ts:585–592` bakes *two* values with `--define`:

```
process.env.PODIUM_APP_VERSION  = "0.1.1-dev.30+f8e38a1"   // per-publish
process.env.PODIUM_SOURCE_SHA   = "f8e38a1"                // per-commit
```

Remove the first and the second still changes on **every commit**, so the hit
rate stays ~0 for any release that follows a code change — which is every
release. And even with both removed, the compile's real inputs are the whole
`apps/server` + `apps/daemon` + `packages/**` TypeScript graph, which also
changes on most commits. The only scenario that warms is **re-publishing a
commit that was already published**, and the publisher already handles that
case, better and at coarser grain, through `readExistingDevBundle`'s
ledger restore.

There is a third obstacle: on the dev channel `compiledSourceMapArgs(version)`
adds `--sourcemap=inline`, so the version does not only key the output, it
changes what is compiled.

Making it work would mean the compiled binary learning its identity from the
bundle at runtime rather than from `--define`. That is feasible in principle —
`headless/VERSION` already ships beside the binary and
`installed-restart.ts:143` already reads `installedVersionOnDisk(env)` — but it
touches ~10 runtime read sites (`server.ts`, `features.ts`, `telemetry.ts`,
`build-version.ts`, `frame-guards.ts`, `server-transfer.ts`, …), several of
which carry comments explicitly requiring the *literal*
`process.env.PODIUM_APP_VERSION` text so `--define` can inline it. It changes
`/version` identity semantics, which is the fleet's answer to "what am I
running".

**Recommendation: no.** A high-risk change to build identity, across ten
runtime sites, for **3.45 s at a hit rate near zero**. If it is ever done, do
it because runtime version identity *should* come from the bundle — not as a
caching optimisation. File it as a deferred design question, not as work.

## Q4 — Cache abduco; simple change?

**Yes — and simpler than expected, because the cache already exists.** This
corrects the main report, which recommended "cache abduco-helper" as new work.

`crossBuildAbduco` is already content-addressed: the key is the sha256 of the
vendored `abduco.c`, entries live at
`<root>/dist-bun/abduco-cache/<platform>-<hash16>`, writes are staged to a
pid-suffixed path and `mv`'d into place so concurrent builds cannot embed a
half-written helper, and a hit is logged and free
(`scripts/abduco-cross.ts:136–230`).

**It never hits during a release for one reason: the cache lives inside the
checkout, and the release checkout is a throwaway `/tmp` worktree.**
`build-bun.ts:550` calls `crossBuildAbduco(spec.platform, { root })` with the
packaging root, which under `withDevBuildSnapshot` is the detached snapshot.
`dist-bun/` is gitignored and untracked, so `git worktree add` creates it
empty. Every release therefore pays two `zig cc` compiles (plus an `rcodesign`
ad-hoc sign for darwin) that the cache was built to avoid — the measured
**1.11 s + 0.75 s = 1.86 s**.

**The fix is to relocate the cache, not to build one**: default `abducoCacheDir`
to a durable per-host, per-repository path — exactly the
`~/.cache/podium/<...>/<projectKey>` shape `sharedTurboCacheDir` already
establishes — with a `PODIUM_ABDUCO_CACHE_DIR` override and the existing
`{ root }` argument retained for tests. Content addressing, atomicity and race
safety all carry over untouched; the correctness surface does not change,
because a hit is only ever returned for a byte-identical source hash.

Two callers reference the literal path and must move with it:
`scripts/assert-headless-bundle.sh:292` and
`scripts/prove-headless-assertions-can-fail.sh:36–37`.

**Saving ≈1.86 s (4 % of the release) for what is essentially a path change.**
This is the cheapest real win after pigz, and yes — it is wasteful not to.

## Q5 — How big is keying the ledger by run?

**Small, with one wrinkle that decides the shape.**

Today the *destination* is already per-build:
`builds/<buildId>/timing.jsonl` (`build-record.ts:119`). Only the **staging
filename** is version-keyed — `emitReleaseBuildTiming` picks
`record.version ?? record.sourceSha ?? 'development-release'`
(`release-build-timing.ts:81`) — and `finalizeTimingIntoRecord` renames
`<version>.jsonl` into place (`dev-bundle.ts:1242`). Two attempts at one
version append to one staging file, and whichever finalizes moves the
concatenation. That is exactly the dev.29 ledger.

The wrinkle: the staging sink is deliberately version-keyed **because it spans
more than the bundle build**. `finalizeReleaseTiming`'s own comment
(`dev-publisher-wiring.ts:317–322`) records that moving it inside the build
"strands every later snapshot, publication, and outer approval record". The
`buildId` is minted *mid-flight* (`mintBuildId`, `dev-bundle.ts`), so keying
directly on it would strand every line emitted before that point — including
the `approval-to-publish` envelope.

So the correct change is **mint a run id at the approval boundary**, where the
envelope starts, and carry it down:

1. `ReleaseBuildTimingRecord` gains `runId?: string` — **`version`,
   `sourceSha` and `channel` all stay**, so nothing is lost from the record.
2. New `PODIUM_RELEASE_TIMING_RUN` env, added to
   `releaseBuildTimingEnvironment` alongside the version and sha it already
   passes to child processes.
3. `emitReleaseBuildTiming`'s identity becomes
   `record.runId ?? record.version ?? record.sourceSha ?? …` — one line, and
   `releaseBuildTimingFileName` needs no signature change since it already
   takes an arbitrary identity.
4. `finalizeTimingIntoRecord` renames `<runId>.jsonl`; it already receives the
   `buildId` for the destination.
5. The publisher mints the run id where it opens the `approval-to-publish`
   span and threads it into `releaseTiming`.

Then `buildDevBundle`'s `timingEnv` — currently computed before `mintBuildId`
— simply inherits the run id, so no reordering is required.

**Size: one optional record field, one env var, five call sites, no data
loss, no behaviour change outside the evidence sink.** Roughly a day with the
tests (`release-build-timing.test.ts`, `dev-bundle.test.ts:740`,
`artifact-route.test.ts:441` all assert the version-keyed staging name and
would be updated to the run key).

Worth doing **before** any of the performance changes: it is what makes a
before/after comparison honest, and every claim in this report currently rests
on a ledger that can silently merge two runs.

## Summary of the five

| | Answer | Value | Size |
|---|---|---:|---|
| Q1 pigz | Linux release hosts only; not default-installed; resolve like zig but **fall back to gzip**. Output is plain gzip, deterministic, thread-count-independent. | ≈7.8 s | small |
| Q2 attribution | Nine untimed steps identified and measured; the dominant one is the **untimed live-checkout ignored-source scan, 0.8 s warm / 18.7 s cold**. Client lane is only 3.5 s (warm restore). | — | 9 wrappers |
| Q3 compile-cli stamp | **No.** 3.45 s, hit rate ~0 even after the change (`PODIUM_SOURCE_SHA` also baked), ~10 runtime sites, changes `/version` identity. | 3.45 s at ~0 % hit | large, risky |
| Q4 abduco | Cache **already exists and is correct**; it just lives in the throwaway snapshot. Relocate it. | ≈1.86 s | very small |
| Q5 run-keyed ledger | Mint a run id at the approval boundary; version stays on every record. | correctness | ≈1 day |

Recommended order: **Q5 → Q2 → Q1 → Q4**, and file Q3 as deferred.

---

# Addendum 2 — parent review's two qualifications, tested

The parent review raised two objections to the pigz recommendation. **Both were
right to raise; one was right, one was wrong, and the net effect is that the
headline saving drops from ≈7.8 s (17 %) to ≈6.8 s (15 %).**

## "pigz is gzip-format compatible, not necessarily byte-identical"

**Correct.** Measured on the same tar stream from the real dev.30 bundle:

| | bytes |
|---|---:|
| `gzip -n` | 63,245,574 |
| `pigz -n` | 63,212,332 |

Not identical — pigz is marginally *smaller*. (The gzip figure is also an
independent confirmation that this reconstruction is faithful: 63,245,574 is
exactly the size of the published `linux-x86_64` artifact.)

But the specific mechanism the review worried about — parallel deflate block
partitioning varying the output — **does not occur**. `pigz -n` at `-p1`,
`-p2`, `-p4` and `-p8` produced the *same* sha256. Partitioning is fixed by
input, not by thread count.

**Consequence for the recommendation.** A gzip-fallback (Q1) is safe *today*,
because each release signs whatever bytes it produced and every client can
extract either. But it is incompatible with the reproducible-archive goal in
§4: two release hosts, one with pigz and one without, would produce different
digests for identical input. **So if archive reproducibility is ever adopted,
the compressor must be pinned rather than fallen back on.** Ship the fallback
now; make pigz a hard requirement at the same time as `--sort`/`--mtime`.

## "The 7.8 s is extrapolated from unconstrained measurements"

**Correct, and it mattered.** Re-measured inside the actual production cgroup
shape — `systemd-run --user --scope -p CPUQuota=200% -p CPUWeight=50`, the
values `build-scope.ts` sets — on the real bundle contents:

| Run | `tar -czf` (gzip) | `tar \| pigz -n -p2` |
|---|---:|---:|
| 1 | 9.08 s | 4.04 s |
| 2 | 7.61 s | 4.00 s |
| 3 | 9.71 s | 3.61 s |
| **mean** | **8.80 s** | **3.88 s** |

**Measured ratio under the real quota: 2.27×**, against the 2.79× extrapolated
from unconstrained numbers in §4. Applying it to the production archive time:

> **12.12 s → ≈5.34 s, saving ≈6.8 s = 15 % of the 45.36 s release.**

Still the largest single win available, and still not caching — but 15 %, not
17 %. §4's table and the §7 arithmetic should be read with this ratio.

Two cautions the numbers make visible:

- **A first quota run measured only 1.25×** (7.02 s) while the box was at load
  23. Under `CPUWeight=50` a release competes with everything else on the host,
  so the *realised* saving on a busy box is variable and can approach zero. The
  three-run figures above were taken at comparable load.
- **Thread count must be pinned to the quota.** Under the 200 % cap, default
  `pigz` (`-p8`, oversubscribed) measured 8.35 s versus 7.02 s for `-p2` in the
  same conditions — oversubscription costs real time. At 400 %/`-p4` the same
  archive takes 2.03 s and at 800 %/`-p8` 1.99 s, so the quota, not pigz, is
  the binding constraint. **Do not raise the quota**: capping the build is the
  deliberate POD-1966 decision that a build must not slow the box. Set
  `-p2` explicitly to match it.

## Revised summary line

| Change | Saving | Basis |
|---|---:|---|
| pigz `-p2` for the archives | **≈6.8 s (15 %)** | measured under `CPUQuota=200%` |
| relocate the abduco cache | ≈1.9 s (4 %) | measured, dev.30 ledger |
| everything else caching could buy | ≈1.6 s | estimated, ~0 % hit rate |

Unconditional regardless: signing, digesting, the identity fences, retention,
standing-shell resolution and feed activation.

---

# Addendum 3 — pre-filing questions

## Q1 (again) — how does `pigz` actually get onto the machines?

**It is a build-host tool, so it does not go through `install.sh`.** That
installer's prerequisite pass (apt/apk/dnf/yum/zypper/pacman, already installing
`tar gzip`) is for *end-user runtime* tools on a machine that only ever extracts
a bundle. A release build never runs there.

**There is already a table for exactly this**, and pigz is a fourth row in it —
`docs/internal/headless-cross-compilation.md` §Prerequisites:

| Where | Needs | How |
|---|---|---|
| CI release job | zig 0.16, rcodesign 0.29 | `mlugg/setup-zig`, `scripts/ci-install-rcodesign.sh` |
| CI published-smoke | zig, rcodesign | same |
| The dev host (ludovico) | zig, rcodesign | on PATH, or `PODIUM_ZIG` / `PODIUM_RCODESIGN` |
| **→ add: any release host** | **pigz (optional)** | **package manager, or `PODIUM_PIGZ`; falls back to `gzip`** |

So concretely, three places:

1. **Dev hosts** — `apt-get install -y pigz` once, documented in that table. No
   bootstrap script exists to hook into, and inventing one for a single optional
   package is not worth it.
2. **CI** — one step in `.github/workflows/release.yml` beside the existing
   `mlugg/setup-zig` and `scripts/ci-install-rcodesign.sh` steps. The CI runner
   is `blacksmith-4vcpu-ubuntu-2204` and builds **four** platforms rather than
   the dev host's two, so the saving there is roughly double.
3. **Code** — `resolvePigz()` following `resolveZig`'s `findTool` shape
   (`PODIUM_PIGZ` → PATH → fallback), except that where `findTool` **throws**
   for zig, pigz **returns `undefined` and the archive step uses `gzip`**,
   logging which compressor ran.

The point of the fallback is that nothing breaks on a host that never got the
package — it is just slower. That is the whole reason to prefer a fallback over
a hard prerequisite here, and it is why this does not need a provisioning story
at all.

*(Reminder from Addendum 2: the fallback is only safe while archives are not
required to be reproducible. pigz and gzip produce different bytes. If §4's
reproducible-archive work is ever done, pigz must become a hard requirement.)*

## Q2 (again) — what is the `git ls-files` step, and do we cache it?

**No. It is not a build step and it must never be cached** — but it also should
not be slow, and the slowness is a one-line bug rather than a fact of life.

**What it is for.** It is half of `assertSourceMatchesHead`, an *identity
fence*. It asks one question:

> Is there a gitignored-but-importable file — `.ts .tsx .js .json .wasm`, … —
> under `apps packages scripts tooling` that a bundler could pull into a
> `dev+<sha>` bundle even though it is not part of commit `<sha>`?

The other half is `git status --porcelain` (uncommitted *tracked* changes,
0.03 s). Together they are what makes a `dev+<sha>` label true. Caching the
answer would be caching a freshness check — the result is only meaningful for
the working tree as it is *right now*, and a cached "clean" is exactly the lie
the fence exists to prevent.

**Why it is slow: the pathspecs filter, they do not prune.** The call passes
`:(exclude)**/node_modules/**`, `:(exclude)**/dist/**`, … but git applies those
*after* walking. Measured on the live checkout: git emits **18,045 paths** to
yield **227** after exclusion, having descended into every `node_modules`,
`dist`, `.turbo` and `target` tree on disk. Cold, that walk is 18–29 s.

**The tempting fix is wrong.** `--directory`, which collapses a fully-ignored
directory into one entry, takes the same query from 29.16 s to **0.02 s**
— and **blinds the fence.** Constructed repro, in a throwaway repo with
`apps/secret/` gitignored:

```
without --directory:  apps/secret/sneaky.ts     ← fence sees it
with    --directory:  apps/secret/              ← sneaky.ts collapsed away
```

`apps/secret/` has no file extension, so `classifyIgnoredSourceInputs` skips it
and an ignored `.ts` sails through the exact check built to catch it.

**The safe fix is two-step:** collapse with `--directory`, then descend *only*
into collapsed directories whose basename is not a known non-source tree
(`DEV_BUNDLE_NON_SOURCE_TREES`, which the classifier already knows). Prototyped
against the live checkout: **same verdict as today (zero offending files)**, and
the collapsed listing itself costs 0.02 s. On this repo every collapsed
directory is on the allowlist, so nothing is descended into and the walk simply
never happens — while a `apps/secret/` would still be opened and caught.

**A second, orthogonal question worth answering before filing.** The expensive
call runs on the **live checkout**, before the snapshot is taken. But the build
happens *in the snapshot* — a fresh `git worktree add --detach`, which by
construction cannot contain the live checkout's untracked-ignored files — and
the snapshot's own copy of this fence (`validation / final-source-inputs`,
0.22 s) is what actually gates publication. So the live-root call looks like a
pre-flight UX gate: it refuses early, legibly, before spending 45 s.

If that is all it is, it could simply be dropped in favour of the cheap
`git status` and the snapshot check. **Do not assume that.** The Turbo cache is
shared between the live checkout and the snapshot
(`~/.cache/podium/turbo/<projectKey>`, keyed on the common git dir), and Turbo
does not hash gitignored files — so a client build produced *in the live
checkout* could in principle have been influenced by an ignored source file
without that file changing the cache key, and the poisoned entry would then
restore into the snapshot. That would make the live-root check genuinely
load-bearing against cache poisoning. **This is the one thing to check before
touching the call site.**

**So the answer to "cache it or instrument the build?" is: instrument the
build** — nine wrappers, cheap, and it is what turns every number in this report
from an inference into a measurement — **and separately fix this call with the
two-step pathspec change.** Neither is caching, and the fence keeps firing.

## Q4 (again) — is abduco doing its own content addressing? Should it use Turbo?

**Yes, it is its own — and it should stay its own.** Switching to Turbo would
make the cache *less* correct, not cleaner.

`abducoCachePath` keys on exactly one thing: the sha256 of
`packages/pty/vendor/abduco/abduco.c`, plus the platform
(`scripts/abduco-cross.ts:136–155`). That is the complete and precise input set
— a single C translation unit compiled by `zig cc` for a fixed target triple.

A Turbo task would inherit `turbo.json`'s **`globalDependencies`**:

```
tooling/tsconfig/**, package.json, bun.lock, vitest.config.ts,
vitest.unit.config.ts, vitest.smoke-requirements.ts, test-hermetic-*.ts,
scripts/package-vitest-config.ts
```

plus `globalEnv: [PODIUM_CHECK_ENV_HASH]`. **Bumping any npm dependency, or
editing a vitest config, would invalidate the abduco helper** — a C file that
depends on none of them. The bespoke key is strictly narrower and strictly more
honest, and its narrowness is load-bearing: the header comment states that a
touched `abduco.c` must invalidate all four platforms at once and that a
restored CI cache "can never serve a helper built from different source". A
coarser key does not break that guarantee, but it does destroy the hit rate the
guarantee was bought for.

Two smaller objections to Turbo here as well:

- **Fit.** Turbo caches *workspace task outputs*, relative to the package
  directory. The helper is consumed at the fixed repo-root path
  `dist-bun/abduco.bin` (a static `with { type: 'file' }` import in the compiled
  binary), and is built mid-packaging from `scripts/build-bun.ts`, not from a
  workspace `build` script.
- **Cost.** Entering Turbo means spawning it during packaging. The client lane's
  entire *warm* Turbo run measured 453 ms; against 1.86 s of `zig cc` the margin
  would be thin, where the existing cache's hit path is a single `existsSync`.

**The actual bug is one line of path.** The cache is correct, atomic
(pid-staged then `mv`) and race-safe; it just lives at
`<root>/dist-bun/abduco-cache`, and the release `<root>` is a throwaway `/tmp`
worktree where gitignored `dist-bun/` is created empty. Default
`abducoCacheDir` to the durable per-host, per-repository path instead — the very
`~/.cache/podium/<…>/<projectKey>` shape `sharedTurboCacheDir` already
establishes, and the reason the client lane restores from the snapshot at all —
with a `PODIUM_ABDUCO_CACHE_DIR` override, keeping the `{ root }` argument for
tests.

**That gets the one thing Turbo would have given (sharing across checkouts)
without inheriting a cache key that has nothing to do with C.** Two shell
callers reference the literal path and move with it:
`scripts/assert-headless-bundle.sh:292` and
`scripts/prove-headless-assertions-can-fail.sh:36–37`.
