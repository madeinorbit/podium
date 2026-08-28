# M1 — Provenance by Checksum Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web and mobile client dists a pure function of their inputs, and replace the random per-run nonce with checksum-and-commit verification, so the same commit produces byte-identical output that can later be cached.

**Architecture:** `scripts/write-web-build-stamp.ts` stops writing `builtAt` and `buildInvocation` and starts writing `fileCount`. A new `scripts/verify-client-build.ts` owns the post-build check (manifest inventory, per-file SHA-256, source commit, app version, floor) and mints the module-branded `ClientBuildEvidence`. `scripts/build-bun.ts` uses the evidence instead of the nonce. The release path keeps its shape: `beginFreshClientPackagingSession` still runs the client build itself; it just verifies by checksum afterwards.

**Tech Stack:** Bun, TypeScript, vitest (`bun --bun node_modules/vitest/vitest.mjs`), the repo's mutation harness in `scripts/assert-headless-bundle-layout.test.ts` and `scripts/prove-headless-assertions-can-fail.sh`.

**Spec:** `docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md` §4.3, §5, §11 M1.

## Global Constraints

- Never run a repo-wide typecheck or `bun run test:full` on the dev box; scoped only: `bun scripts/typecheck.ts --filter @podium/scripts --concurrency=1` and the named vitest files below.
- Never `git stash`; never `bunx biome`/`bun run format`.
- Commit messages via `git commit -F <file>`; every commit carries the trailer `Podium-Issue: <this sub-issue's ref>`.
- Nothing accepted from a flag, env var, sidecar or the archive as provenance (`assertNoCallerSuppliedClientRootDigest` stays; the new evidence is only ever minted in-process).
- `podium-build.json` stays the LAST file written in a dist (POD-1986).
- `PODIUM_CLIENT_BUILD_INVOCATION` is removed from the codebase entirely.

---

### Task 1: Deterministic stamp — drop `builtAt`, drop `buildInvocation`, add `fileCount`

**Files:**
- Modify: `scripts/write-web-build-stamp.ts:80-96` (types), `:150-166` (`webBuildStamp`), `:207-249` (`clientBuildManifest`), `:251-275` (`writeWebBuildStamp`), `:297-312` (`main`)
- Test: `scripts/write-web-build-stamp.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClientBuildManifest {
    manifestVersion: 2
    sourceCommit: string
    buildStamp: WrittenBuildStamp        // no builtAt
    fileCount: number                    // == Object.keys(files).length
    files: Record<string, string>
  }
  export type WrittenBuildStamp = BuildStamp & { wireSchemaDigest: string; wireVersion: number; appVersion: string }
  export function writeWebBuildStamp(distDir: string, sourceSha?: string, packagedVersion?: string): WrittenBuildStamp
  export function webBuildStamp(indexHtml: string, sourceSha?: string, packagedVersion?: string): WrittenBuildStamp
  ```

- [ ] **Step 1: Write the failing tests**

In `scripts/write-web-build-stamp.test.ts`, replace the `manifests the exact completed files, stamp, and source commit` test body's call and assertions, and add a determinism test:

```ts
it('manifests the exact completed files, stamp, source commit and count — and nothing per-run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-manifest-'))
  writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
  writeFileSync(join(dir, 'asset.txt'), 'console.log("built client")\n')
  const stamp = writeWebBuildStamp(dir, '47a01e3', '0.4.2')
  const manifest = JSON.parse(readFileSync(join(dir, CLIENT_BUILD_MANIFEST_FILE), 'utf8')) as ClientBuildManifest
  expect(manifest.manifestVersion).toBe(2)
  expect(manifest.sourceCommit).toBe('47a01e3')
  expect(manifest.buildStamp).toEqual(stamp)
  expect('builtAt' in manifest.buildStamp).toBe(false)
  expect('buildInvocation' in manifest).toBe(false)
  expect(manifest.fileCount).toBe(3)
  expect(Object.keys(manifest.files).sort()).toEqual(['asset.txt', 'index.html', 'podium-build.json'])
})

it('writes byte-identical output for the same input, run twice', () => {
  const build = () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-stamp-det-'))
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
    writeFileSync(join(dir, 'asset.txt'), 'x\n')
    writeWebBuildStamp(dir, '47a01e3', '0.4.2')
    return ['index.html', 'asset.txt', 'podium-build.json', CLIENT_BUILD_MANIFEST_FILE].map((f) =>
      readFileSync(join(dir, f), 'utf8'),
    )
  }
  expect(build()).toEqual(build())
})
```

Update every other call in the file that passes a `Date` as the second argument to the new 3-argument form (grep `new Date(` in the test file).

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/write-web-build-stamp.test.ts`
Expected: FAIL — `manifestVersion` is 1, `builtAt` present, `fileCount` undefined, TypeScript arity errors.

- [ ] **Step 3: Implement**

In `scripts/write-web-build-stamp.ts`:
- `ClientBuildManifest`: `manifestVersion: 2`, remove `buildInvocation`, add `fileCount: number`.
- `WrittenBuildStamp`: remove `builtAt`.
- `webBuildStamp(indexHtml, sourceSha?, packagedVersion?)`: remove the `now` parameter and the `builtAt` field.
- `clientBuildManifest(distDir, stamp, stampBytes)`: remove `buildInvocation`; after building `files`, return `{ manifestVersion: 2, sourceCommit, buildStamp: stamp, fileCount: Object.keys(files).length, files: sorted }`.
- `writeWebBuildStamp(distDir, sourceSha?, packagedVersion?)`: drop `now` and `buildInvocation`.
- `main()`: call `writeWebBuildStamp(distDir, resolveWebSourceSha(repoRoot), process.env.PODIUM_APP_VERSION)`.
- Update the header comment: remove the "opaque nonce" sentence; add "Deterministic: the same dist bytes, source commit and version produce identical stamp and manifest bytes, which is what lets a build system reuse them (spec 2026-08-28-cached-release-build-design §4.3)."

- [ ] **Step 4: Fix the readers of `manifestVersion`**

`packages/runtime/src/client-build-provenance.ts:33` checks `manifest.manifestVersion !== 1`. Change to `!== 2`. Add to that file's test (`packages/runtime/src/client-build-provenance.test.ts`, or create it beside the module if absent) a case that a v1 manifest is refused with `has no v2 file inventory` and update the message string accordingly.

- [ ] **Step 5: Run tests**

Run: `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/write-web-build-stamp.test.ts packages/runtime/src/client-build-provenance.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/write-web-build-stamp.ts scripts/write-web-build-stamp.test.ts packages/runtime/src/client-build-provenance.ts packages/runtime/src/client-build-provenance.test.ts
git commit -F msg   # "build: deterministic client stamp and manifest v2" + Podium-Issue trailer
```

---

### Task 2: `verifyClientBuild` — the checksum evidence module

**Files:**
- Create: `scripts/verify-client-build.ts`
- Test: `scripts/verify-client-build.test.ts`

**Interfaces:**
- Consumes: `clientBuildRootDigestFromSites` from `./client-build-root-digest`; `CLIENT_BUILD_MANIFEST_FILE`, `ClientBuildManifest` from `./write-web-build-stamp`.
- Produces:
  ```ts
  export const CLIENT_FILE_FLOOR = { web: 400, mobile: 30 } as const
  export type ClientBuildEvidence = Readonly<{ clientRootDigest: string; version: string; sourceCommit: string; sites: { web: string; mobile: string } }>
  export interface VerifyClientBuildInput { web: string; mobile: string; sourceCommit: string; version: string }
  export function verifyClientBuild(input: VerifyClientBuildInput): ClientBuildEvidence   // throws on any mismatch
  export function isClientBuildEvidence(value: unknown): value is ClientBuildEvidence   // WeakSet brand, true only for objects minted here
  ```

- [ ] **Step 1: Write the failing tests**

`scripts/verify-client-build.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeWebBuildStamp } from './write-web-build-stamp'
import { CLIENT_FILE_FLOOR, isClientBuildEvidence, verifyClientBuild } from './verify-client-build'

const BUILT_INDEX = '<!doctype html><html><head></head><body><script type="module" src="/assets/index-abc12345.js"></script></body></html>'

function site(count: number, sha = '47a01e3', version = '0.4.2'): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-verify-site-'))
  writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
  mkdirSync(join(dir, 'assets'))
  for (let i = 0; i < count - 2; i++) writeFileSync(join(dir, 'assets', `f${i}.js`), `// ${i}\n`)
  writeWebBuildStamp(dir, sha, version)
  return dir
}

describe('verifyClientBuild', () => {
  it('mints branded evidence for two intact sites', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5)
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    const evidence = verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })
    expect(isClientBuildEvidence(evidence)).toBe(true)
    expect(evidence.sourceCommit).toBe('47a01e3')
    expect(evidence.clientRootDigest).toMatch(/^[0-9a-f]{64}$/)
  })
  it('a structurally identical object is not evidence', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5)
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    const real = verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })
    expect(isClientBuildEvidence({ ...real })).toBe(false)
  })
  it('refuses a site whose sourceCommit is not the approved commit', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5, 'deadbee')
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    expect(() => verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })).toThrow(/web.*built from deadbee, not 47a01e3/)
  })
  it('refuses a site stamped with another version', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5, '47a01e3', '0.4.1')
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    expect(() => verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })).toThrow(/web.*stamped 0\.4\.1, not 0\.4\.2/)
  })
  it('refuses a file whose bytes changed after the manifest', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5)
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    writeFileSync(join(web, 'assets', 'f0.js'), '// tampered\n')
    expect(() => verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })).toThrow(/hash does not match assets\/f0\.js/)
  })
  it('refuses an extra file the manifest never inventoried', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5)
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    writeFileSync(join(mobile, 'extra.txt'), 'x')
    expect(() => verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })).toThrow(/does not exactly inventory/)
  })
  it('refuses a site below the file floor even when internally consistent', () => {
    const web = site(CLIENT_FILE_FLOOR.web - 1)
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    expect(() => verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })).toThrow(new RegExp(`web has ${CLIENT_FILE_FLOOR.web - 1} files, floor is ${CLIENT_FILE_FLOOR.web}`))
  })
  it('refuses a manifest whose fileCount disagrees with its own inventory', () => {
    const web = site(CLIENT_FILE_FLOOR.web + 5)
    const mobile = site(CLIENT_FILE_FLOOR.mobile + 5)
    const path = join(web, 'podium-build-manifest.json')
    const m = JSON.parse(readFileSync(path, 'utf8'))
    m.fileCount = m.fileCount + 1
    writeFileSync(path, JSON.stringify(m))
    expect(() => verifyClientBuild({ web, mobile, sourceCommit: '47a01e3', version: '0.4.2' })).toThrow(/fileCount/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/verify-client-build.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/verify-client-build.ts`**

```ts
/**
 * CLIENT BUILD EVIDENCE — what packaging trusts about apps/web/dist and apps/mobile/dist.
 *
 * Replaces the POD-2540 nonce. That nonce answered "did OUR build write these bytes NOW?"
 * for a build that ran in a live checkout with a persistent dist. Under the snapshot
 * updater "now" is answered by the fresh worktree at the approved commit, and "ours" by
 * the build task (or, from M2 on, a Turbo cache restore keyed on the inputs). What this
 * module proves: the inventory is exact, every byte matches its recorded hash, the site
 * names the approved commit and version, and the site is not a stub. What it does NOT
 * prove, recorded rather than buried: a same-user attacker who can write the local
 * cache directory could plant a consistent dist — the same trust domain as editing
 * package.json, which POD-2540 already placed outside its threat model.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clientBuildRootDigestFromSites } from './client-build-root-digest'
import { CLIENT_BUILD_MANIFEST_FILE, type ClientBuildManifest } from './write-web-build-stamp'

/** From today's builds (510 web / 42 mobile). Revisit when a genuine build trips it. */
export const CLIENT_FILE_FLOOR = { web: 400, mobile: 30 } as const

export type ClientBuildEvidence = Readonly<{
  clientRootDigest: string
  version: string
  sourceCommit: string
  sites: { web: string; mobile: string }
}>

export interface VerifyClientBuildInput {
  web: string
  mobile: string
  sourceCommit: string
  version: string
}

const minted = new WeakSet<object>()

export function isClientBuildEvidence(value: unknown): value is ClientBuildEvidence {
  return typeof value === 'object' && value !== null && minted.has(value)
}

function readManifest(site: string, label: string): ClientBuildManifest {
  let manifest: ClientBuildManifest
  try {
    manifest = JSON.parse(readFileSync(join(site, CLIENT_BUILD_MANIFEST_FILE), 'utf8'))
  } catch (error) {
    throw new Error(`verify-client-build: ${label} has no readable ${CLIENT_BUILD_MANIFEST_FILE}: ${String(error)}`)
  }
  if (manifest.manifestVersion !== 2) throw new Error(`verify-client-build: ${label} manifest is not v2`)
  if (manifest.fileCount !== Object.keys(manifest.files).length) {
    throw new Error(`verify-client-build: ${label} manifest fileCount ${manifest.fileCount} disagrees with its inventory of ${Object.keys(manifest.files).length}`)
  }
  return manifest
}

function checkSite(site: string, label: 'web' | 'mobile', input: VerifyClientBuildInput): void {
  const manifest = readManifest(site, label)
  if (manifest.sourceCommit !== input.sourceCommit) {
    throw new Error(`verify-client-build: ${label} was built from ${manifest.sourceCommit}, not ${input.sourceCommit}`)
  }
  if (manifest.buildStamp.appVersion !== input.version) {
    throw new Error(`verify-client-build: ${label} is stamped ${manifest.buildStamp.appVersion}, not ${input.version}`)
  }
  if (manifest.fileCount < CLIENT_FILE_FLOOR[label]) {
    throw new Error(`verify-client-build: ${label} has ${manifest.fileCount} files, floor is ${CLIENT_FILE_FLOOR[label]}`)
  }
}

export function verifyClientBuild(input: VerifyClientBuildInput): ClientBuildEvidence {
  checkSite(input.web, 'web', input)
  checkSite(input.mobile, 'mobile', input)
  // Exact inventory + per-file hash check lives in clientBuildRootDigestFromSites
  // (packages/runtime/src/client-build-provenance.ts); it throws on any drift.
  const clientRootDigest = clientBuildRootDigestFromSites({ web: input.web, mobile: input.mobile })
  const evidence: ClientBuildEvidence = Object.freeze({
    clientRootDigest,
    version: input.version,
    sourceCommit: input.sourceCommit,
    sites: { web: input.web, mobile: input.mobile },
  })
  minted.add(evidence)
  return evidence
}
```

- [ ] **Step 4: Run tests**

Run the same vitest command. Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-client-build.ts scripts/verify-client-build.test.ts
git commit -F msg   # "build: verifyClientBuild mints checksum evidence" + trailer
```

---

### Task 3: `build-bun.ts` packages on evidence, not on a nonce

**Files:**
- Modify: `scripts/build-bun.ts:214-274` (delete `assertClientBuildInvocation`; rewrite `beginFreshClientPackagingSession`), `:427-548` (`packageHeadlessForFreshClients`)
- Modify: `scripts/release.ts:337`, `:381` (callers, type names)
- Modify: `scripts/package-headless.ts`
- Test: `scripts/assert-headless-bundle-layout.test.ts:303-312`, `:520-545`

**Interfaces:**
- Consumes: `verifyClientBuild`, `isClientBuildEvidence`, `ClientBuildEvidence` from `./verify-client-build`.
- Produces:
  ```ts
  export type FreshClientPackagingSession = ClientBuildEvidence   // type alias kept so release.ts compiles unchanged
  export function beginFreshClientPackagingSession(argv?: readonly string[]): FreshClientPackagingSession
  export function packageHeadlessForFreshClients(session: FreshClientPackagingSession, argv?: readonly string[]): PackagedHeadlessBundle
  ```

- [ ] **Step 1: Rewrite the tests that pin the nonce**

In `scripts/assert-headless-bundle-layout.test.ts`:
- Delete the test `requires a manifest nonce written by this packaging invocation` (`:303-312`) and the import of `assertClientBuildInvocation`.
- Add, in the same `describe`:
  ```ts
  it('packaging accepts only evidence minted by verifyClientBuild', () => {
    const forged = { clientRootDigest: 'a'.repeat(64), version: '0.4.2', sourceCommit: '47a01e3', sites: { web: '/x', mobile: '/y' } }
    expect(() => packageHeadlessForFreshClients(forged as never, [])).toThrow(/requires client build evidence minted by this invocation/)
  })
  ```
- In `keeps fresh-build session branding wired into every production packaging path` (`:520-545`) replace the three `PODIUM_CLIENT_BUILD_INVOCATION` / `assertClientBuildInvocation` expectations with:
  ```ts
  expect(buildBun).toContain('verifyClientBuild({')
  expect(buildBun).toContain('isClientBuildEvidence(session)')
  expect(buildBun).not.toContain('PODIUM_CLIENT_BUILD_INVOCATION')
  ```
  Keep every other expectation in that test as it is (package:clients string included — M2 changes it).

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/assert-headless-bundle-layout.test.ts`
Expected: FAIL on the three new expectations.

- [ ] **Step 3: Implement in `scripts/build-bun.ts`**

- Remove `assertClientBuildInvocation` and the `randomBytes` import.
- Remove `freshClientPackagingSessions` WeakSet; import `{ verifyClientBuild, isClientBuildEvidence, type ClientBuildEvidence } from './verify-client-build'` and `{ developmentSourceSha } from '../packages/runtime/src/source-version'`.
- `export type FreshClientPackagingSession = ClientBuildEvidence`.
- `beginFreshClientPackagingSession(argv = [])`:
  ```ts
  if (arguments.length > 1) throw new Error('build-bun: caller-supplied environment is forbidden for client freshness')
  assertNoCallerSuppliedClientRootDigest(argv)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pathBun = Bun.which('bun', { PATH: process.env.PATH })
  if (!pathBun || realpathSync(pathBun) !== realpathSync(process.execPath)) throw new Error(`build-bun: PATH resolves bun to ${pathBun ?? 'nothing'}, not the running interpreter ${process.execPath}`)
  const version = packageVersion(root)
  const packageClients = releaseBuildTimingEnabled() ? 'package:clients:timed' : 'package:clients'
  execFileSync(process.execPath, ['run', packageClients], { cwd: root, stdio: 'inherit', env: { ...process.env, PODIUM_APP_VERSION: version } })
  const sourceCommit = developmentSourceSha(root)
  if (!sourceCommit) throw new Error('build-bun: cannot name HEAD, so the client build cannot be verified')
  return verifyClientBuild({ web: `${root}apps/web/dist`, mobile: `${root}apps/mobile/dist`, sourceCommit, version })
  ```
- In `packageHeadlessForFreshClients`, replace `if (!freshClientPackagingSessions.has(session))` with `if (!isClientBuildEvidence(session))` and the message with `'build-bun: headless packaging requires client build evidence minted by this invocation'`. Keep the later `currentClientRootDigest !== session.clientRootDigest` re-check exactly as it is (it is what catches bytes changing between verify and package).
- Update the doc comment above `beginFreshClientPackagingSession` to the §5 wording ("exact inventory + hash + commit + version + floor; not a nonce").

- [ ] **Step 4: Scoped typecheck and tests**

Run: `bun scripts/typecheck.ts --filter @podium/scripts --concurrency=1`
Run: `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/assert-headless-bundle-layout.test.ts scripts/build-bun-artifact.test.ts scripts/release.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-bun.ts scripts/assert-headless-bundle-layout.test.ts scripts/release.ts scripts/package-headless.ts
git commit -F msg   # "build: package on checksum evidence, retire the nonce" + trailer
```

---

### Task 4: Remove every other reader of the nonce and the timestamp

**Files:**
- Modify: `apps/server/src/modules/updates/dev-web-build.ts` (grep `builtAt`, none expected — confirm), `apps/server/src/web-bundle-stamp.ts` (grep `builtAt`), `packages/protocol/src` (grep `builtAt`), `docs/internal/headless-cross-compilation.md:140-150`
- Test: whichever test references `builtAt` (grep)

- [ ] **Step 1: Find them**

Run: `grep -rn "builtAt\|buildInvocation\|PODIUM_CLIENT_BUILD_INVOCATION" apps packages scripts docs --include='*.ts' --include='*.tsx' --include='*.md' --include='*.sh' -l | grep -v node_modules`
Expected: a short list. For each `.ts` hit: if it merely displays `builtAt`, make the field optional in the reader and stop displaying it; if a test fixture writes it, remove it from the fixture.

- [ ] **Step 2: Docs**

In `docs/internal/headless-cross-compilation.md` replace the paragraph starting "Client continuity is checked by the packaging entry point itself" with: "Client provenance is checked by `scripts/verify-client-build.ts`: the exact inventory and per-file SHA-256 in each site's manifest, the manifest's source commit and version against the packaging invocation's, and a file-count floor. The result is a module-branded evidence object; packaging refuses anything else. Under the snapshot updater freshness comes from the detached worktree, not from a per-run nonce (spec 2026-08-28-cached-release-build-design §5)."

- [ ] **Step 3: Verify nothing references the removed names**

Run the grep again. Expected: only the spec and this plan.

- [ ] **Step 4: Commit**

```bash
git add -A apps packages scripts docs
git commit -F msg   # "build: remove nonce and builtAt readers" + trailer
```

---

### Task 5: Mutation harness successors and the shell gate

**Files:**
- Modify: `scripts/prove-headless-assertions-can-fail.sh` (grep `buildInvocation` / `nonce`)
- Modify: `scripts/assert-headless-bundle.sh` if it reads `manifestVersion`
- Test: run the shell harness

- [ ] **Step 1: Read the harness**

Run: `grep -n "buildInvocation\|manifestVersion\|nonce" scripts/prove-headless-assertions-can-fail.sh scripts/assert-headless-bundle.sh`

- [ ] **Step 2: Update**

Any case that mutates `buildInvocation` becomes a case that (a) flips one byte of a file under `web/assets/` and expects `hash does not match`, and (b) rewrites `fileCount` and expects `fileCount`. `manifestVersion` checks become `2`.

- [ ] **Step 3: Run the harness on a real bundle**

Run: `bun run package:headless && bash scripts/prove-headless-assertions-can-fail.sh dist-bun/podium-headless-*.tar.gz`
Expected: every case refused for its stated reason; exit 0.

- [ ] **Step 4: Commit**

---

### Task 6: Byte-identical rebuild proof (the M1 gate)

**Files:**
- Create: `scripts/prove-client-build-deterministic.sh`
- Modify: `.github/workflows/ci.yml` (new job `client-build-determinism`, after `headless-update`)

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Two fresh worktrees of the same commit must produce byte-identical apps/web/dist and
# apps/mobile/dist. This is the precondition for caching them (spec §4.3).
set -euo pipefail
sha="$(git rev-parse HEAD)"
tmp="$(mktemp -d)"
trap 'git worktree remove --force "$tmp/a" 2>/dev/null; git worktree remove --force "$tmp/b" 2>/dev/null; rm -rf "$tmp"' EXIT
for w in a b; do
  git worktree add --detach --force "$tmp/$w" "$sha"
  ( cd "$tmp/$w" && bun install --frozen-lockfile --offline --ignore-scripts \
    && PODIUM_APP_VERSION=0.0.0-determinism bun run --filter @podium/web build \
    && PODIUM_APP_VERSION=0.0.0-determinism bun run --filter @podium/mobile build:web )
done
diff -r "$tmp/a/apps/web/dist" "$tmp/b/apps/web/dist"
diff -r "$tmp/a/apps/mobile/dist" "$tmp/b/apps/mobile/dist"
echo "client builds are byte-identical at $sha"
```

- [ ] **Step 2: Run it locally**

Run: `bash scripts/prove-client-build-deterministic.sh`
Expected: prints the success line. If `diff` reports differences, fix the source of nondeterminism (likely candidates: `.sourcemaps` archive names in `scripts/archive-web-sourcemaps.ts`, expo's `metadata.json`, brotli output), rerun. Do not exclude files from the manifest without recording why in the script header.

- [ ] **Step 3: Add the CI job**

In `.github/workflows/ci.yml` add a job identical in setup to `headless-update` (checkout, setup-bun 1.3.14, bun cache, `bun install --frozen-lockfile --ignore-scripts`) whose step is `bash scripts/prove-client-build-deterministic.sh`.

- [ ] **Step 4: Commit**

```bash
git add scripts/prove-client-build-deterministic.sh .github/workflows/ci.yml
git commit -F msg   # "ci: prove client builds are byte-identical" + trailer
```

---

### Task 7: Verification and handoff

- [ ] Run `bun scripts/typecheck.ts --filter @podium/scripts --filter @podium/runtime --filter @podium/server --concurrency=1` → all green.
- [ ] Run the four vitest files from Tasks 1–3 together → green.
- [ ] Run `bash scripts/prove-client-build-deterministic.sh` once more from a clean tree → success line.
- [ ] `podium issue update --id <sub-issue> --stage review`, then `podium offer` with "merge" / "send back" actions and the determinism output as evidence.
