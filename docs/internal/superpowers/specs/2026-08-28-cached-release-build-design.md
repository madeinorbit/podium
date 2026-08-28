# Cached release build — design

*Issue: POD-2462 (Unified dev/prod update path). Written 2026-08-28 after measuring the
development release path on the publisher host. Supersedes the client-freshness mechanism
introduced by POD-2540 for the reasons in §5; does not touch its bundle-layout gate.*

## 1. Problem

Approving a development release builds the web and mobile client bundles three times
(measured on `0.1.1-dev.14` and `.15`, `dist-bun/release-timing/` in the publisher's source
root):

| step | where | cost |
|---|---|---|
| detached worktree + `bun install --offline` | `dev-build-snapshot.ts` | ~4 s |
| `prepareWebDist` — web `build:dist` + mobile `build:web` | `dev-web-build.ts:68-82` | ~45 s |
| per platform: `package-headless.ts` → `beginFreshClientPackagingSession` → `package:clients` | `dev-bundle.ts:1352`, `build-bun.ts:240-274` | ~45 s × N platforms |
| per platform: abduco, `bun build --compile`, tar, sign | `build-bun.ts` | ~10 s |
| **total, two platforms** | | **~175 s, ~135 s of it client builds** |

Three independent causes:

1. The dev publisher spawns `package-headless.ts` once per fleet platform, and each spawn mints
   its own client session. CI's `prepareHeadlessCross` (`scripts/release.ts:337`) mints one
   session and loops platforms in-process; the dev path never got that shape.
2. No client build is a Turbo task. `turbo.json` defines only `typecheck` and `test`; the client
   builds run through `bun run --filter`, so nothing is ever restored from cache — not across
   approvals, not across worktrees, not between CI and a developer.
3. Even if it were, the output is never the same twice: `write-web-build-stamp.ts` writes a
   wall-clock `builtAt` and the random `PODIUM_CLIENT_BUILD_INVOCATION` nonce into
   `podium-build-manifest.json`, and both are hashed into the client root digest
   (`packages/runtime/src/client-build-provenance.ts:73-84`).

Also duplicated: `apps/desktop/scripts/stage-sidecar.ts:49` runs a whole `package:headless`
(another client build) to obtain a payload; `windows-smoke.yml` and `verify-headless-update.sh`
each build the clients again.

## 2. Goals and non-goals

Goals

- An approval whose web and mobile inputs have not changed builds **zero** client bundles;
  otherwise exactly one per changed client. Target: ~40 s for an unchanged client on two
  platforms, ~85 s with one changed client.
- One build system for CI and the local/dev publisher: the same package scripts, the same
  Turbo tasks, the same coordinator.
- Cache keys that are explicit and auditable (`turbo run --summarize`), covering source, workspace
  dependency sources, lockfile, task scripts, app version, toolchain fingerprint.
- Keep the release ledger (which attempt was validated, signed, published, retained) in the
  Podium state directory, never in Turbo's cache.
- Keep every guarantee POD-2540's gate gives, with one documented change of mechanism (§5).

Non-goals (this pass)

- Remote cache. Designed for (§9) but not wired.
- Changing which platforms a dev approval builds. Host + enrolled fleet headless platforms and a
  fetched standing desktop manifest stay as they are (`devBuildPlatforms`).
- Making the desktop shell (`tauri build`) part of the dev path.
- Caching the compiled headless binaries or tarballs. They are ~10 s per platform and carry the
  version string; not worth a cache entry yet.

## 3. Shape

```
bun run release:prepare  [--platforms …] [--artifact-root …]         (root package.json → scripts/release.ts)
  │
  ├─ 1. snapshot: detached worktree at the approved SHA + bun install --offline   (unchanged)
  ├─ 2. turbo run build --filter=@podium/web --filter=@podium/mobile --summarize
  │        via the cache-admission wrapper (scripts/typecheck.ts turboEnv/readCensus)
  │        ├─ @podium/web#build     → apps/web/dist/**     (cached)
  │        └─ @podium/mobile#build  → apps/mobile/dist/**  (cached)
  ├─ 3. verify restored/built dists (§5) → ClientBuildEvidence
  ├─ 4. package N headless platforms from that one dist, in-process    (prepareHeadlessCross shape)
  ├─ 5. sign
  └─ 6. record: <stateDir>/builds/<buildId>/manifest.json + bundles/ + signatures/   (§6)
        publish / retention read from the record
```

The root `package.json` only delegates. `scripts/release.ts` is the one permitted root-level
exception (repository-wide snapshot, manifest, signing, publication); it must not contain web or
mobile build logic. The dev publisher (`dev-bundle.ts`) and the CI release job both invoke
`release:prepare`; they differ only in arguments (platform list, artifact root, channel).

## 4. Turbo tasks

### 4.1 Package scripts

- `@podium/web`: `build` becomes the single production script (today's `build:dist` followed by the
  bundle-budget check). `build:dist` is removed so dev and CI cannot diverge on it; `build:dev`
  stays for local unminified use and is not a Turbo task.
- `@podium/mobile`: `build:web` is renamed `build`. Same shape as web.
- Root `package:clients`, `package:clients:timed` and the root `build` script's manual
  `bun run --filter` chain are deleted. Root `build` becomes `turbo run build`.
- `packages/*` `build` (`tsup`) is registered as the same Turbo task with `outputs: ["dist/**"]`.
  Web and mobile consume packages from **source** (`conditions: ['@podium/source']`,
  `apps/web/vite.config.ts:307`), so they do not depend on `^build`; the package builds are only
  needed by consumers that read `dist` (server tests, `test:integration`).

### 4.2 turbo.json

```jsonc
"build": {
  "dependsOn": ["^build"],
  "inputs": ["$TURBO_DEFAULT$"],
  "outputs": ["dist/**"]
},
"@podium/web#build": {
  "dependsOn": [],
  "env": ["PODIUM_APP_VERSION"],
  "inputs": [
    "$TURBO_DEFAULT$",
    "!dist/**",
    "$TURBO_ROOT$/packages/*/src/**",
    "$TURBO_ROOT$/packages/*/package.json",
    "$TURBO_ROOT$/apps/server/src/**",            // web imports @podium/server types today
    "$TURBO_ROOT$/scripts/archive-web-sourcemaps.ts",
    "$TURBO_ROOT$/scripts/precompress-dist.ts",
    "$TURBO_ROOT$/scripts/write-web-build-stamp.ts",
    "$TURBO_ROOT$/scripts/web-bundle-budget.ts"
  ],
  "outputs": ["dist/**"]
},
"@podium/mobile#build": {
  "dependsOn": [],
  "env": ["PODIUM_APP_VERSION"],
  "inputs": [
    "$TURBO_DEFAULT$",
    "!dist/**",
    "$TURBO_ROOT$/packages/*/src/**",
    "$TURBO_ROOT$/packages/*/package.json",
    "$TURBO_ROOT$/apps/web/src/features/setup/**",  // already an input of mobile#typecheck
    "$TURBO_ROOT$/scripts/precompress-dist.ts",
    "$TURBO_ROOT$/scripts/write-web-build-stamp.ts"
  ],
  "outputs": ["dist/**"]
}
```

Notes

- The exact cross-package input list is derived, not guessed: the implementation runs
  `bun scripts/workspace-import-audit.ts` / the same census `server-test-shards.ts` uses to
  derive test inputs, and a unit test asserts that every workspace package imported by
  `apps/web` and `apps/mobile` has its `src/**` in the task's inputs (the pattern
  `scripts/typecheck.test.ts` already enforces for typecheck). This is the guard against the
  "turbo only follows the graph it can see" failure.
- `globalEnv` already carries `PODIUM_CHECK_ENV_HASH` (bun version, platform, arch, install
  layout, workspace resolution census). `bun.lock`, `package.json`, `turbo.json` are global hash
  inputs by default. Nothing else about the toolchain needs declaring.
- `PODIUM_APP_VERSION` is in `env` because the stamp writes it into `index.html` and the
  manifest. A dev approval sets it to the resolved `0.1.1-dev.N+sha`; two approvals of the same
  commit with the same version are hits, a re-numbered one is a miss (correct: the served page
  reports its version).
- Package-specific overrides live in the root `turbo.json` for now because the repo already
  keeps every override there; moving to per-package `turbo.json` files is a separate cleanup.
- Cache directory: unchanged — `sharedTurboCacheDir()` keyed on the common git dir, so the
  detached snapshot worktree, the live checkout, every issue worktree and CI (`TURBO_CACHE_DIR`)
  read and write the same cache. `daemon: false` stays.

### 4.3 Determinism of the output

The task output must be a pure function of the declared inputs.

- `podium-build.json`: drop `builtAt`. `appVersion`, `sourceSha`, `bundleVersion`,
  `wireSchemaDigest`, `wireVersion` stay (all content-derived).
- `podium-build-manifest.json`: drop `buildInvocation`. Keep `sourceCommit`, the full stamp, and
  the per-file SHA-256 inventory. Add `fileCount` per site (the inventory floor POD-2540 left
  open).
- `write-web-build-stamp.ts` no longer reads `PODIUM_CLIENT_BUILD_INVOCATION`; the env var is
  removed everywhere.
- Verification step in the implementation: build web and mobile twice from the same commit in two
  fresh worktrees and `diff -r` the dists (including `.br`/`.gz` siblings and source-map archive
  names). Any difference is fixed at its source (e.g. an expo export embedding a timestamp) or, if
  unfixable, excluded from `outputs` and from the manifest. The result of that check is recorded in
  the implementation report; without it the cache is not trusted.

## 5. Freshness and provenance (replaces POD-2540's nonce)

POD-2540 ended on the question "did **our** build write these bytes, **now**?" and answered it
with a random nonce echoed through both manifests inside one process. Its own completion note
records that the nonce proves the stamp step ran, not the build, and that the threat model stops
at "anyone who can edit `package.json` during a release can publish directly".

Under the new updater the two halves of the question are answered by different things:

- **now** — the build runs in a detached worktree created for this approval at the approved SHA,
  with `assertSourceMatchesHead` before and after (unchanged). Pre-existing output cannot exist in
  that tree; the only writers of `apps/*/dist` are the Turbo task or a Turbo cache restore.
- **ours** — a cache restore is an archive keyed on the hash of the sources, lockfile, task
  scripts, env and toolchain fingerprint, written by an earlier `turbo run` under the same user on
  the same host (`~/.cache/podium/turbo/<repo-key>`). Forging it requires write access in the same
  trust domain as editing `package.json`, i.e. outside POD-2540's threat model. Remote cache, when
  added, uses Turbo artifact signing (`remoteCache.signature`) to keep this property across hosts.

What the coordinator verifies after `turbo run build` (`ClientBuildEvidence`, computed in-process
and module-branded exactly as `FreshClientPackagingSession` is today — nothing accepted from a
flag, env var, sidecar or the archive):

1. The run summary (`--summarize`) lists both tasks with status hit or miss and a task hash; the
   hashes are recorded.
2. Each `podium-build-manifest.json` has `sourceCommit == approved SHA` and
   `appVersion == resolved version`.
3. Every file in the inventory exists with the recorded SHA-256; no file outside the inventory is
   present; `fileCount` ≥ the site's floor (web 400, mobile 30 — from today's 510/42, revisited
   when the gate refuses a legitimate build).
4. `clientRootDigest` is computed from the verified sites and carried, as today, into
   `packageHeadlessForFreshClients`, the tarball gate, and `.meta.json`.

What is lost and recorded in the gate's comment: replay resistance against a same-user attacker
who poisons the local cache. What is gained beyond reuse: the stale-dist case (POD-1610,
"yesterday's dist under today's SHA") is now impossible by hash rather than by a check — any
source change is a miss.

`beginFreshClientPackagingSession` is replaced by `verifyClientBuild(summaryPath)`; the
"PATH bun must be the running interpreter" and "no caller-supplied env" refusals stay, moved to the
coordinator entry. The mutation harness (`assert-headless-bundle-layout.test.ts`,
`prove-headless-assertions-can-fail.sh`) is updated so every retired nonce case has a successor
that exercises the new check: forged manifest hash, missing file, extra file, wrong sourceCommit,
count below floor, summary naming a task that did not run.

## 6. State directory as the ledger

```
<stateDir>/builds/<buildId>/
  manifest.json      approvedSha, version, platforms, turbo task hashes + hit/miss,
                     clientRootDigest, per-platform artifact digests, signing key fingerprint,
                     timings, outcome (validated | signed | published | failed:<step>)
  bundles/           podium-headless-<version>-<platform>.tar.gz
  signatures/        .sig and .meta.json
```

- `buildId` is minted by the coordinator **after** step 3, never before, and never enters any
  cached path or file.
- `dist-bun/` in the live checkout stops being the artifact root; the publisher's
  `artifactRoot` becomes `<stateDir>/builds/<buildId>/bundles`. Retention (`dev-bundle.ts:483-641`)
  keeps its manifest-reference rule but walks `builds/*/manifest.json` instead of file names.
- `dev-publisher-state.json` gains `lastBuildId`; the feed publisher reads the record, not the
  checkout.
- Release-build timing records move to `<stateDir>/builds/<buildId>/timing.jsonl` and gain the
  Turbo hit/miss per task, so the next optimisation round has evidence.
- CI writes the same record shape under its workspace and uploads it as the job artifact.

## 7. Callers

| caller | today | after |
|---|---|---|
| dev publisher approve | `prepareWebDist` + N × `package-headless.ts` | one `scripts/release.ts --prepare-cross` child with a `--platform`/`--artifact` pair per fleet platform |
| `scripts/release.ts --prepare-cross` (CI release) | one session, four platforms | `bun run release:prepare -- --channel …` (all four) |
| `apps/desktop/scripts/stage-sidecar.ts` | `bun run package:headless` | unchanged: `package-headless.ts` (native host; shares `buildClients`) |
| `windows-smoke.yml`, `verify-headless-update.sh` | `package:headless` | unchanged: `package-headless.ts` (native host; shares `buildClients`) |
| `bun run package:headless` (human) | `package-headless.ts` | unchanged: the native single-platform entry |
| `test:integration` / `test:e2e` `bun run build` | manual chain | `turbo run build` |

`package-headless.ts` and `build-bun.ts` keep their compile/tar/sign responsibilities and lose the
client build; direct invocation without evidence still refuses.

**Correction to this table, made in M3 (POD-3054).** It originally said the three native callers
would switch to `release:prepare` too. They cannot: `prepareHeadlessCross` refuses a non-Linux host
because the zig/rcodesign evidence trail is Linux-only, and `stage-sidecar`, `windows-smoke` and
`verify-headless-update.sh` run on macOS and Windows runners. They stay on `package-headless.ts`,
which shares `beginFreshClientPackagingSession` → `buildClients` with the coordinator — so they
already restore the clients from the same Turbo cache, which is what switching them was for. The
"one entry" claim is therefore about the two callers that produce a RELEASE (the development
publisher and CI), not about every caller that packages a bundle.

**A consequence worth stating, also M3.** Because the release build now runs entirely inside the
approved commit's snapshot and never writes the live `apps/web/dist`, preparing no longer makes the
served website current as a side effect. The update operation's `web` step does that work instead
of usually finding it already done. It is not a second client build: `prepare` filled the Turbo
cache for this commit's clients, so the step restores.

## 8. Error handling

- Turbo miss on a task whose inputs are unchanged is not an error but is logged with the
  `--summarize` diff hint, so cache decay is visible.
- Any verification failure in §5 aborts before packaging and records `failed:verify` in the build
  record with the reason; nothing is signed.
- The admission wrapper refusal (`admissionRefusal`) applies to the build lane exactly as it does
  to typecheck: a broken install produces no cached result and no release.
- A crashed coordinator leaves `builds/<buildId>/manifest.json` at its last outcome; the retention
  sweep treats `failed:*` records as deletable after the usual window.

## 9. Remote cache (deferred)

`turbo.json` gets no `remoteCache` block now. When wired: self-hosted endpoint via `TURBO_API`,
`remoteCache.signature: true`, key in CI secrets and the publisher's environment; §5 point 2
already assumes signed artifacts. No coordinator change is needed.

## 10. Testing

- Unit: task-input derivation test (§4.2), determinism test (§4.3, run in the heavy lane),
  `verifyClientBuild` mutation cases (§5), build-record schema and retention walk (§6).
- Integration: `named-dev-release.integration.bun.test.ts` extended with a second approval of the
  same commit asserting both tasks report `cache hit` and no `vite`/`expo` process ran; and a
  changed-web approval asserting web miss, mobile hit.
- CI: the release job runs `release:prepare --platforms all` and the existing bundle gates,
  unchanged; the `.turbo/runs/*.json` summary is uploaded with the artifacts.

## 11. Milestones

Each milestone lands on its own, is green on its own, and leaves the release path working.
Later milestones depend on earlier ones as noted; nothing is reordered.

### M1 — Provenance by checksum (foundation, no speed change)

Scope: §4.3 determinism + §5 verification. Strip `builtAt` and the nonce from the stamp and
manifest, add `fileCount`, replace `beginFreshClientPackagingSession` with `verifyClientBuild`
(manifest `sourceCommit`/`appVersion`, per-file SHA-256, inventory floor, module-branded
evidence), retire every nonce mutation case with a successor. `build-bun.ts` still runs the
client build itself — via the existing package scripts — so the release path is unchanged in
shape.
Gate: two builds of one commit in two fresh worktrees are byte-identical (`diff -r`, including
`.br`/`.gz`); mutation harness refuses each new case for the right reason;
`prove-headless-assertions-can-fail.sh` green; CI release job green.
Why first: nothing can be cached while the output differs per run, and the gate change is the
one piece that needs review on its own terms (§5) rather than mixed into a build-system change.

### M2 — Turbo owns the client build (first speed win)

Scope: §4.1–4.2. `@podium/web#build` and `@podium/mobile#build` as Turbo tasks with derived,
test-guarded inputs; root `build`/`package:clients` replaced by `turbo run build`; `packages/*`
`build` registered; `build-bun.ts` invokes `turbo run build --filter … --summarize` through the
admission wrapper and feeds the summary to `verifyClientBuild` (M1).
Effect on the dev path without any publisher change: the three per-approval builds become one
build plus two cache restores (~175 s → ~95 s), and a second approval of an unchanged client
restores all three (~50 s). Every issue worktree and CI share the cache.
Gate: input-derivation test; `test:integration`/`test:e2e` on `turbo run build`; a warm second
run reports `cache hit` for both tasks and no `vite`/`expo` process; CI release green.
Depends on M1.

### M3 — One coordinator for dev and CI (zero builds when unchanged)

Scope: §3 + §7. `bun run release:prepare` as the single entry; `scripts/release.ts` becomes the
coordinator (snapshot, one `turbo run build`, verify, N platforms in-process, sign); the dev
publisher spawns one child instead of `prepareWebDist` + N × `package-headless`;
`stage-sidecar`, `windows-smoke`, `verify-headless-update` and the human `package:headless`
switch to it. `prepareWebDist` and the per-platform session are deleted.
Effect: unchanged client → 0 builds (~40 s for two platforms); changed client → 1 build.
Gate: `named-dev-release` integration test with the two-approval hit/miss assertions (§10); CI
release job runs the same entry with `--platforms all`; desktop release workflow green.
Depends on M2.

### M4 — State-directory build ledger

Scope: §6 + timing. `<stateDir>/builds/<buildId>/` records, `buildId` minted after verification,
artifact root moved off `dist-bun/`, retention walks the records, timing records carry Turbo
hit/miss, CI uploads the record.
Effect: durable, machine-independent evidence of what was validated and published; `dist-bun/`
retired as an artifact root.
Gate: record schema test; retention walk test; a failed-verify approval leaves a
`failed:verify` record and no signature; feed publisher reads the record.
Depends on M3 (the coordinator is the only writer).

### M5 — Remote cache (deferred, §9)

Signed self-hosted cache; no coordinator change. Not scheduled.

Suggested tracking: one sub-issue per milestone under this issue; M1 and M2 may be worked by one
agent back-to-back, M3 by a second once M2 is merged, M4 after M3.
