# M3 — One Release Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dev publisher and the CI release job run the same entry — `scripts/release.ts --prepare-cross` — which builds (or restores) the clients once and packages every requested platform in-process; `prepareWebDist` and the per-platform `package-headless` spawn are deleted. An approval of an unchanged client builds nothing.

**Architecture:** `release.ts --prepare-cross` gains `--artifact <platform>=<path>` so a caller that owns artifact lifecycle (the dev publisher) can name each output; `packageHeadlessForFreshClients` reads that instead of `PODIUM_BUNDLE_ARTIFACT`. `dev-bundle.ts` spawns ONE low-tier child for the whole platform list. `package-headless.ts` remains the native single-platform entry for non-Linux hosts (desktop `stage-sidecar`, windows-smoke, `verify-headless-update.sh`) — it already restores clients from the Turbo cache after M2, so it needs no change.

**Tech Stack:** Bun, TypeScript, vitest, `bun test` integration lane.

**Spec:** `docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md` §3, §7, §11 M3. Requires M2 merged.

## Global Constraints

- Platform selection stays as it is: dev = host + enrolled fleet headless platforms (`devBuildPlatforms`), CI = all four. No desktop shells on the dev path.
- Host platform is built first (the error names the platform that failed, and the host's bundle exists even if a later one fails).
- The compile runs in the batch-tier transient scope (`runLowTierBuild`), never as a bare child of the server.
- No provenance from flags/env: `--artifact` names an OUTPUT path only.
- Scoped typecheck; commits with `Podium-Issue:` trailer.

## Deviation from the spec recorded here

Spec §7 said `stage-sidecar`, `windows-smoke` and `verify-headless-update` switch to `release:prepare`. `prepareHeadlessCross` refuses non-Linux hosts (the zig/rcodesign evidence trail is Linux-only), and those three run on macOS/Windows runners. They keep `package-headless.ts`, which shares `beginFreshClientPackagingSession` → `buildClients` with the coordinator, so they already get cached clients. Update spec §7 in Task 6.

---

### Task 1: `--artifact <platform>=<path>` on the coordinator

**Files:**
- Modify: `scripts/release.ts:160-200` (`RELEASE_OPTIONS`), `:322-360` (`prepareHeadlessCross`), `:665-700` (`main`)
- Modify: `scripts/build-bun.ts` (`updateArtifactPath`, `packageHeadlessForFreshClients`)
- Test: `scripts/release.test.ts`, `scripts/build-bun-artifact.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // release.ts
  export function parseArtifactOverrides(values: readonly string[]): Map<HeadlessPlatform, string>   // "linux-x86_64=/abs/path" → map; refuses unknown platform, relative path, duplicate
  export async function prepareHeadlessCross(platforms?: readonly HeadlessPlatform[], outDir?: string, artifacts?: ReadonlyMap<HeadlessPlatform, string>): Promise<PreparedHeadless[]>
  // build-bun.ts
  export function updateArtifactPath(out: string, version: string, argv: readonly string[], env?: Record<string, string | undefined>): string  // --artifact=<path> in argv wins, then PODIUM_BUNDLE_ARTIFACT, then default
  ```

- [ ] **Step 1: Failing tests**

`scripts/release.test.ts`:
```ts
describe('parseArtifactOverrides', () => {
  it('maps platform to absolute path', () => {
    expect(parseArtifactOverrides(['linux-x86_64=/tmp/a.tar.gz'])).toEqual(new Map([['linux-x86_64', '/tmp/a.tar.gz']]))
  })
  it('refuses an unknown platform, a relative path, and a duplicate', () => {
    expect(() => parseArtifactOverrides(['plan9-mips=/tmp/a'])).toThrow(/unknown headless platform 'plan9-mips'/)
    expect(() => parseArtifactOverrides(['linux-x86_64=rel/a'])).toThrow(/must be absolute/)
    expect(() => parseArtifactOverrides(['linux-x86_64=/a', 'linux-x86_64=/b'])).toThrow(/given twice/)
  })
})
```
`scripts/build-bun-artifact.test.ts`:
```ts
it('--artifact= in argv names the tarball ahead of the env and the default', () => {
  expect(updateArtifactPath('/out', '1.0.0', ['--artifact=/x/y.tar.gz'], { PODIUM_BUNDLE_ARTIFACT: '/env.tar.gz' })).toBe('/x/y.tar.gz')
  expect(updateArtifactPath('/out', '1.0.0', [], { PODIUM_BUNDLE_ARTIFACT: '/env.tar.gz' })).toBe('/env.tar.gz')
  expect(updateArtifactPath('/out', '1.0.0', [], {})).toBe('/out/podium-headless-1.0.0.tar.gz')
})
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`release.ts`: add `'--artifact': 'repeated'` to `RELEASE_OPTIONS`. Implement `parseArtifactOverrides` (split on the first `=`, `isHeadlessPlatform` check, `isAbsolute` check, duplicate check). In `prepareHeadlessCross`, pass `[`--target=${target}`, ...(artifacts?.get(platform) ? [`--artifact=${artifacts.get(platform)}`] : [])]` to `packageHeadlessForFreshClients`. In `main`, `prepareHeadlessCross(platformsOrAll, undefined, parseArtifactOverrides(args.repeated('--artifact')))`.

`build-bun.ts`: `updateArtifactPath(out, version, argv, env = process.env)` — read `argv.find(a => a.startsWith('--artifact='))?.slice(11)?.trim()` first; then the env; then the default. Update its single call site inside `packageHeadlessForFreshClients` to pass `argv`.

- [ ] **Step 4: Run** both test files + scoped typecheck. **Step 5: Commit** — "release: --artifact names each platform's output".

---

### Task 2: Root script and the dev publisher's single spawn

**Files:**
- Modify: `package.json` (`"release:prepare": "bun scripts/release.ts --prepare-cross"`)
- Modify: `apps/server/src/modules/updates/dev-bundle.ts:766-790` (`DevBuildSpawnContext`), `:1070-1100` (`defaultSpawnBuild`), `:1340-1440` (the platform loop in `buildDevBundle`)
- Test: `apps/server/src/modules/updates/dev-bundle.test.ts` (every `spawnBuild:` stub, lines ~868–1174)

**Interfaces:**
- Produces:
  ```ts
  export interface DevBuildSpawnContext {
    root: string
    version: string
    /** One entry per platform, host first. */
    artifacts: ReadonlyArray<{ platform: string; bunTarget: string; artifactPath: string }>
    signingKey?: string
    instanceId?: string
    timingEnv?: NodeJS.ProcessEnv
  }
  export type DevBuildSpawnResult = undefined | ReadonlyArray<{ platform: string; path?: string; signature?: string }>
  ```

- [ ] **Step 1: Failing tests**

In `dev-bundle.test.ts`, change every `spawnBuild: async ({ artifactPath }) => { …write artifactPath… }` stub to `spawnBuild: async ({ artifacts }) => { for (const a of artifacts) …write a.artifactPath… }`. Add one test:

```ts
it('spawns the build once for every platform, host first', async () => {
  const calls: string[][] = []
  await buildDevBundle({ ...baseDeps, platforms: ['linux-x86_64', 'darwin-aarch64'], spawnBuild: async ({ artifacts }) => { calls.push(artifacts.map((a) => a.platform)); for (const a of artifacts) writeSigned(a.artifactPath) } })
  expect(calls).toEqual([['linux-x86_64', 'darwin-aarch64']])
})
```
(`baseDeps`/`writeSigned` are whatever helpers the file already uses for lock/fs/signing — reuse the ones the neighbouring tests use.)

- [ ] **Step 2: Run to verify they fail** — `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts apps/server/src/modules/updates/dev-bundle.test.ts`.

- [ ] **Step 3: Implement**

`defaultSpawnBuild`:
```ts
await runLowTierBuild({
  unit: devBuildScopeUnit(DEV_BUNDLE_BUILD_ROLE, ctx.instanceId ?? resolveInstanceId()),
  description: `Podium development release build (${ctx.version}, ${ctx.artifacts.map((a) => a.platform).join(', ')})`,
  command: devBuildCommand(process.env),
  args: [
    'scripts/release.ts', '--prepare-cross',
    ...ctx.artifacts.flatMap((a) => ['--platform', a.platform, '--artifact', `${a.platform}=${a.artifactPath}`]),
  ],
  cwd: ctx.root,
  env: { ...process.env, ...ctx.timingEnv, PODIUM_APP_VERSION: ctx.version, PODIUM_UPDATE_SIGNING_KEY: signingKey },
})
```
(`PODIUM_BUNDLE_ARTIFACT` is no longer set.)

`buildDevBundle`: build `artifacts` from `platforms`/`artifactNames`, call `spawnBuild` ONCE before the loop, then keep the per-platform `describe-artifact` loop reading `result?.find((r) => r.platform === platform)?.path ?? requestedPath` for the path and signature. The doc comment "Host first, then whatever else the fleet needs" moves onto the `artifacts` array construction and keeps its reasoning.

`release.ts prepareHeadlessCross` already packages in the order given; the dev publisher passes host first.

- [ ] **Step 4: Run** the test file + `bun scripts/typecheck.ts --filter @podium/server --concurrency=1`. **Step 5: Commit** — "updates: one release child per approval".

---

### Task 3: Delete `prepareWebDist` from the publisher

**Files:**
- Modify: `apps/server/src/modules/updates/dev-bundle.ts:2046-2064` (remove the `prepare-web-dist` timed call and the `prepareWebDist` dep), `DevBundlePublisherDeps` type
- Modify: `apps/server/src/modules/updates/dev-publisher-wiring.ts:313-357` (remove the `prepareWebDist` callback and `decideWebDist` import if now unused)
- Modify: `apps/server/src/modules/updates/dev-web-build.ts` — keep `createDevWebBuilder`, `requestRebuild`, `decideWebDist`; delete only what the removed callback alone used (grep after removal).
- Test: `apps/server/src/modules/updates/dev-bundle.test.ts` (tests naming `prepareWebDist`), `dev-publisher-wiring.test.ts`, `dev-web-build.test.ts`

- [ ] **Step 1:** Grep `prepareWebDist` in `apps/server/src`; list every hit.
- [ ] **Step 2:** Remove the dep, the timed call, and the wiring callback. Tests that asserted "prepareWebDist ran before the build" become "the release child was spawned with both platforms" (Task 2's test covers it) — delete them, do not keep a stub.
- [ ] **Step 3:** The `refuse`/`ready` `decideWebDist` logic protected the LIVE dist from a rebuild during a `/version` poll. The release build no longer touches the live dist at all (it builds in the snapshot and restores from cache), so the poll path needs no equivalent; `requestRebuild` (Update panel button) still owns live-dist rebuilds via `createDevWebBuilder`.
- [ ] **Step 4:** Run the three test files + scoped server typecheck. **Step 5:** Commit — "updates: the release child owns the client build".

---

### Task 4: CI release job on the same entry

**Files:**
- Modify: `.github/workflows/release.yml:57` — already `bun scripts/release.ts --channel … --prepare-cross`; change to `bun run release:prepare -- --channel "$PODIUM_RELEASE_CHANNEL"` so the one root script is the documented entry. Confirm `bun run <script> -- <args>` forwards args (it does for Bun ≥ 1.1).
- Modify: `docs/internal/headless-cross-compilation.md` "Building" section: `bun run release:prepare` for all four; `bun run release:prepare -- --platform linux-x86_64 --artifact linux-x86_64=/abs/out.tar.gz` for one named output; `bun run package:headless` stays for the native host build.

- [ ] Commit — "ci: release job runs release:prepare".

---

### Task 5: Integration proof — unchanged client builds nothing

**Files:**
- Modify: `scripts/named-dev-release.integration.bun.test.ts` (extend the M2 test)

- [ ] **Step 1:** In the two-approval test from M2, additionally assert that the second approval's timing JSONL has NO `prepare-web-dist` task and that the whole `approved-development-release` duration is under 60 s on the fixture (the fixture's compile is small; the bound catches a reintroduced client build, which is ≥ 40 s).
- [ ] **Step 2:** Run under the heavy lease. **Step 3:** Commit — "test: an unchanged client builds nothing on approval".

---

### Task 6: Spec §7 correction and handoff

- [ ] Edit spec §7 table: `stage-sidecar`, `windows-smoke`, `verify-headless-update`, human `package:headless` → "unchanged: `package-headless.ts` (native host; shares `buildClients`)"; dev publisher → "one `release:prepare` child with `--platform`/`--artifact` per fleet platform"; CI release → "`bun run release:prepare -- --channel …`". Commit.
- [ ] Scoped typechecks (`@podium/scripts`, `@podium/server`), `bun run test:web`, the unit files above.
- [ ] After merge and a real approval on the publisher: read `dist-bun/release-timing/<version>.jsonl` — expect no `prepare-web-dist`, `[build-clients] … HIT` for both, total ≤ 60 s for two platforms. Attach the JSONL as the issue artifact.
- [ ] `podium issue update --stage review` + offer.
