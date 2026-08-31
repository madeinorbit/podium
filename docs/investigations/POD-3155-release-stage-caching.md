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
