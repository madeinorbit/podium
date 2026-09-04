# M2 — Turbo Owns the Client Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@podium/web#build` and `@podium/mobile#build` real Turbo tasks with explicit, test-guarded inputs and `dist/**` outputs, so an unchanged client is restored from the shared cache instead of rebuilt — and every caller (root scripts, `build-bun.ts`, CI) goes through `turbo run build`.

**Architecture:** Package scripts own the build commands; `turbo.json` registers `build` with per-package inputs derived from the workspace import census; a new `scripts/build-clients.ts` is the cache-admission wrapper for the build lane (same shape as `scripts/test.ts`) and returns the run summary path; `build-bun.ts` calls it and hands the summary plus the dists to `verifyClientBuild` (M1). Root `package.json` delegates only.

**Tech Stack:** Turborepo 2.10 (`turbo run … --summarize`), Bun, vitest.

**Spec:** `docs/internal/superpowers/specs/2026-08-28-cached-release-build-design.md` §4, §11 M2. Requires M1 merged.

## Global Constraints

- Root `package.json` scripts never chain package builds with `&&` and never call `bun run --filter … build`; they call `turbo run build`.
- `turbo run`, never bare `turbo <task>`, anywhere in code or CI.
- Every Turbo task that writes files declares `outputs`; the build tasks declare exactly `["dist/**"]`.
- `--force`/`TURBO_FORCE` only with `--uncached-because=<reason>` (existing `decideForce` rule).
- Scoped typecheck only (`--filter`, `--concurrency=1`).
- Commits with `Podium-Issue:` trailer via `git commit -F`.

---

### Task 1: Package scripts — one `build` per client

**Files:**
- Modify: `apps/web/package.json` scripts
- Modify: `apps/mobile/package.json` scripts
- Modify: `apps/server/src/modules/updates/dev-web-build.ts:68-82` (`DEV_WEB_BUILD_STEPS`)
- Test: `scripts/assert-headless-bundle-layout.test.ts:520-545`, `apps/server/src/modules/updates/dev-web-build.test.ts`

- [ ] **Step 1: Write the failing test**

In `scripts/assert-headless-bundle-layout.test.ts`, in the wiring test, replace the `package:clients` expectation with:

```ts
const web = JSON.parse(readFileSync(join(repoRoot, 'apps/web/package.json'), 'utf8')) as { scripts: Record<string, string> }
const mobile = JSON.parse(readFileSync(join(repoRoot, 'apps/mobile/package.json'), 'utf8')) as { scripts: Record<string, string> }
expect(web.scripts.build).toBe('vite build && bun ../../scripts/archive-web-sourcemaps.ts dist && bun ../../scripts/precompress-dist.ts dist && bun --conditions=@podium/source ../../scripts/write-web-build-stamp.ts dist && bun ../../scripts/web-bundle-budget.ts dist --check')
expect(web.scripts['build:dist']).toBeUndefined()
expect(mobile.scripts.build).toBe('expo export -p web && bun scripts/patch-web-html.ts && bun ../../scripts/precompress-dist.ts dist && bun --conditions=@podium/source ../../scripts/write-web-build-stamp.ts dist')
expect(mobile.scripts['build:web']).toBeUndefined()
expect(packageJson).not.toContain('"package:clients"')
```

- [ ] **Step 2: Run to verify it fails** — `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/assert-headless-bundle-layout.test.ts`.

- [ ] **Step 3: Implement**

- `apps/web/package.json`: `build` = the string above (inline `build:dist` + budget check); delete `build:dist`; keep `build:dev`; update the `//build` comment: "The stamp is written before the budget check, which reads dist and writes nothing."
- `apps/mobile/package.json`: rename `build:web` → `build`; rename the `//build:web` comment key to `//build`.
- `dev-web-build.ts` `DEV_WEB_BUILD_STEPS`: web args `['run', '--filter', '@podium/web', 'build']`, mobile args `['run', '--filter', '@podium/mobile', 'build']`. Update the comment: the ratchet is now part of `build`; a red ratchet is a red build (the dest-rebuild exemption ends here — the ratchet floor lives in `scripts/web-bundle-budget.ts` and is raised by that script's own process, not bypassed).
- Grep the repo for `build:web` and `build:dist` (`grep -rn "build:web\|build:dist" --include='*.ts' --include='*.json' --include='*.yml' --include='*.md' --include='*.sh' . | grep -v node_modules`) and update every hit (docs included).

- [ ] **Step 4: Run tests** — the file above plus `apps/server/src/modules/updates/dev-web-build.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** — "build: one build script per client".

---

### Task 2: `turbo.json` build tasks with derived inputs, and the guard test

**Files:**
- Modify: `turbo.json` (add `build`, `@podium/web#build`, `@podium/mobile#build`)
- Create: `scripts/client-build-inputs.ts`
- Test: `scripts/client-build-inputs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // scripts/client-build-inputs.ts
  export function workspaceImportsOf(root: string, app: 'apps/web' | 'apps/mobile'): string[]   // sorted package dirs, e.g. ['packages/client-core', 'packages/model', 'apps/server']
  export function requiredBuildInputs(root: string, app: 'apps/web' | 'apps/mobile'): string[]  // the $TURBO_ROOT$ globs turbo.json must contain
  export function declaredBuildInputs(root: string, task: '@podium/web#build' | '@podium/mobile#build'): string[]
  ```

- [ ] **Step 1: Write the failing test**

```ts
// scripts/client-build-inputs.test.ts
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredBuildInputs, requiredBuildInputs } from './client-build-inputs'

const root = join(import.meta.dir, '..')

describe.each(['apps/web', 'apps/mobile'] as const)('%s build inputs', (app) => {
  const task = app === 'apps/web' ? '@podium/web#build' : '@podium/mobile#build'
  it('declares every workspace package the app imports, and the scripts the build runs', () => {
    const declared = new Set(declaredBuildInputs(root, task))
    const missing = requiredBuildInputs(root, app).filter((glob) => !declared.has(glob))
    expect(missing).toEqual([])
  })
  it('excludes its own dist so a restored output cannot feed the next hash', () => {
    expect(declaredBuildInputs(root, task)).toContain('!dist/**')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — module missing.

- [ ] **Step 3: Implement `scripts/client-build-inputs.ts`**

```ts
/**
 * Derive the cross-package inputs of the client build tasks from what the apps
 * actually import, so turbo.json cannot silently fall behind the import graph
 * (the "turbo only follows the graph it can see" failure, spec §4.2).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const IMPORT_RE = /from\s+['"](@podium\/[a-z-]+)(?:\/[^'"]*)?['"]|import\s*\(\s*['"](@podium\/[a-z-]+)/g
const SOURCE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.expo') continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (SOURCE_RE.test(entry.name)) out.push(p)
  }
}

function packageDirByName(root: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(root, group))) {
      const pkg = join(root, group, name, 'package.json')
      try {
        const { name: pkgName } = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }
        if (pkgName) map.set(pkgName, `${group}/${name}`)
      } catch {}
    }
  }
  return map
}

export function workspaceImportsOf(root: string, app: 'apps/web' | 'apps/mobile'): string[] {
  const byName = packageDirByName(root)
  const files: string[] = []
  walk(join(root, app), files)
  const found = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT_RE)) {
      const name = m[1] ?? m[2]
      const dir = name && byName.get(name)
      if (dir && dir !== app) found.add(dir)
    }
  }
  return [...found].sort()
}

const SCRIPTS = {
  'apps/web': ['scripts/archive-web-sourcemaps.ts', 'scripts/precompress-dist.ts', 'scripts/write-web-build-stamp.ts', 'scripts/web-bundle-budget.ts'],
  'apps/mobile': ['scripts/precompress-dist.ts', 'scripts/write-web-build-stamp.ts'],
} as const

export function requiredBuildInputs(root: string, app: 'apps/web' | 'apps/mobile'): string[] {
  const packages = workspaceImportsOf(root, app).flatMap((dir) => [`$TURBO_ROOT$/${dir}/src/**`, `$TURBO_ROOT$/${dir}/package.json`])
  return [...packages, ...SCRIPTS[app].map((s) => `$TURBO_ROOT$/${s}`)].sort()
}

export function declaredBuildInputs(root: string, task: string): string[] {
  const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) as { tasks: Record<string, { inputs?: string[] }> }
  return turbo.tasks[task]?.inputs ?? []
}
```

- [ ] **Step 4: Print the required lists and write `turbo.json`**

Run: `bun -e 'import{requiredBuildInputs}from"./scripts/client-build-inputs.ts";for(const a of["apps/web","apps/mobile"])console.log(a,JSON.stringify(requiredBuildInputs(".",a),null,1))'`

Add to `turbo.json` `tasks`:

```jsonc
"build": { "dependsOn": ["^build"], "inputs": ["$TURBO_DEFAULT$", "!dist/**"], "outputs": ["dist/**"] },
"@podium/web#build": {
  "dependsOn": [],
  "env": ["PODIUM_APP_VERSION"],
  "inputs": ["$TURBO_DEFAULT$", "!dist/**", "!.sourcemaps/**", /* every glob the command printed for apps/web */],
  "outputs": ["dist/**"]
},
"@podium/mobile#build": {
  "dependsOn": [],
  "env": ["PODIUM_APP_VERSION"],
  "inputs": ["$TURBO_DEFAULT$", "!dist/**", "!.expo/**", /* every glob the command printed for apps/mobile */],
  "outputs": ["dist/**"]
}
```

Note `apps/web/src/features/setup/**` is already an input of `@podium/mobile#typecheck`; the import walker finds `@podium/web` imports and emits `$TURBO_ROOT$/apps/web/src/**` if mobile imports it by package name — if mobile imports it by relative path instead, add `$TURBO_ROOT$/apps/web/src/features/setup/**` by hand and extend `SCRIPTS['apps/mobile']` with it so the test covers it.

- [ ] **Step 5: Run the guard test** — expected PASS. Also `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/typecheck.test.ts` still green (turbo.json is a global dependency of every task).

- [ ] **Step 6: Commit** — "build: turbo build tasks with derived inputs".

---

### Task 3: `scripts/build-clients.ts` — the admission-wrapped build lane

**Files:**
- Create: `scripts/build-clients.ts`
- Modify: `package.json` scripts (`build`, `package:clients`, `package:clients:timed`)
- Test: `scripts/build-clients.test.ts`

**Interfaces:**
- Consumes: `readCensus`, `admissionRefusal`, `decideForce`, `turboEnv` from `./typecheck`.
- Produces:
  ```ts
  export interface ClientBuildRun { summaryPath: string; tasks: Record<'@podium/web#build' | '@podium/mobile#build', { hash: string; cache: 'HIT' | 'MISS' }> }
  export function buildClients(root: string, args?: readonly string[], env?: NodeJS.ProcessEnv): Promise<ClientBuildRun>   // throws on refusal or non-zero turbo exit
  export function readRunSummary(root: string, summaryPath: string): ClientBuildRun['tasks']
  ```

- [ ] **Step 1: Write the failing test**

```ts
// scripts/build-clients.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRunSummary, turboBuildCommand } from './build-clients'

describe('readRunSummary', () => {
  it('extracts hash and cache status for both client tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-run-summary-'))
    mkdirSync(join(root, '.turbo', 'runs'), { recursive: true })
    const path = join(root, '.turbo', 'runs', 'r1.json')
    writeFileSync(path, JSON.stringify({ tasks: [
      { taskId: '@podium/web#build', hash: 'aaa', cache: { status: 'HIT', source: 'LOCAL' } },
      { taskId: '@podium/mobile#build', hash: 'bbb', cache: { status: 'MISS' } },
    ] }))
    expect(readRunSummary(root, path)).toEqual({
      '@podium/web#build': { hash: 'aaa', cache: 'HIT' },
      '@podium/mobile#build': { hash: 'bbb', cache: 'MISS' },
    })
  })
  it('refuses a summary that does not name both tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-run-summary-'))
    mkdirSync(join(root, '.turbo', 'runs'), { recursive: true })
    const path = join(root, '.turbo', 'runs', 'r2.json')
    writeFileSync(path, JSON.stringify({ tasks: [{ taskId: '@podium/web#build', hash: 'aaa', cache: { status: 'HIT' } }] }))
    expect(() => readRunSummary(root, path)).toThrow(/@podium\/mobile#build did not run/)
  })
})

describe('turboBuildCommand', () => {
  it('is turbo run build, both client filters, summarize, no force', () => {
    expect(turboBuildCommand('/r', [])).toEqual(['/r/node_modules/.bin/turbo', 'run', 'build', '--filter=@podium/web', '--filter=@podium/mobile', '--summarize', '--concurrency=1'])
  })
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `scripts/build-clients.ts`**

```ts
/**
 * THE CLIENT BUILD LANE. Same admission rule as typecheck/test (POD-1343, POD-2774): a
 * broken install may neither produce nor replay a cached client. Turbo owns reuse; this
 * wrapper owns admission, the summary, and the refusal of unexplained --force.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { admissionRefusal, decideForce, readCensus, turboEnv } from './typecheck'

export const CLIENT_BUILD_TASKS = ['@podium/web#build', '@podium/mobile#build'] as const
export type ClientBuildTask = (typeof CLIENT_BUILD_TASKS)[number]
export interface ClientBuildRun { summaryPath: string; tasks: Record<ClientBuildTask, { hash: string; cache: 'HIT' | 'MISS' }> }

export function turboBuildCommand(root: string, forward: readonly string[]): string[] {
  return [join(root, 'node_modules', '.bin', 'turbo'), 'run', 'build', '--filter=@podium/web', '--filter=@podium/mobile', '--summarize', '--concurrency=1', ...forward]
}

export function readRunSummary(root: string, summaryPath: string): ClientBuildRun['tasks'] {
  const raw = JSON.parse(readFileSync(summaryPath, 'utf8')) as { tasks?: Array<{ taskId?: string; hash?: string; cache?: { status?: string } }> }
  const out = {} as ClientBuildRun['tasks']
  for (const task of CLIENT_BUILD_TASKS) {
    const entry = raw.tasks?.find((t) => t.taskId === task)
    if (!entry || typeof entry.hash !== 'string' || (entry.cache?.status !== 'HIT' && entry.cache?.status !== 'MISS')) {
      throw new Error(`build-clients: ${task} did not run in ${summaryPath}`)
    }
    out[task] = { hash: entry.hash, cache: entry.cache.status }
  }
  return out
}

function newestSummary(root: string, since: number): string {
  const dir = join(root, '.turbo', 'runs')
  const candidates = readdirSync(dir).map((f) => join(dir, f)).filter((p) => statSync(p).mtimeMs >= since)
  if (candidates.length !== 1) throw new Error(`build-clients: expected exactly one new run summary in ${dir}, found ${candidates.length}`)
  return candidates[0] as string
}

export async function buildClients(root: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<ClientBuildRun> {
  const census = readCensus(root)
  const refusal = admissionRefusal(census, 'build')
  if (refusal) throw new Error(refusal)
  const decision = decideForce([...args], env as Record<string, string | undefined>)
  if (decision.error) throw new Error(decision.error)
  if (decision.reason) console.error(`uncached client build, reason: ${decision.reason}`)
  const started = Date.now()
  const proc = Bun.spawn(turboBuildCommand(root, decision.forwardArgs), { cwd: root, env: { ...turboEnv(root, census), ...(env.PODIUM_APP_VERSION ? { PODIUM_APP_VERSION: env.PODIUM_APP_VERSION } : {}) }, stdio: ['inherit', 'inherit', 'inherit'] })
  const code = await proc.exited
  if (code !== 0) throw new Error(`build-clients: turbo run build exited ${code}`)
  const summaryPath = newestSummary(root, started)
  return { summaryPath, tasks: readRunSummary(root, summaryPath) }
}

if (import.meta.main) {
  const run = await buildClients(join(import.meta.dir, '..'), process.argv.slice(2))
  for (const [task, { cache, hash }] of Object.entries(run.tasks)) console.log(`[build-clients] ${task} ${cache} ${hash}`)
}
```

Note: `turboEnv` spreads `process.env`, so `PODIUM_APP_VERSION` from the caller's env already passes through; the explicit spread above is for callers that pass a custom `env`. `PODIUM_APP_VERSION` is in the task's `env` list so it is hashed, not filtered, under strict env mode.

- [ ] **Step 4: Root `package.json`**

- `"build": "turbo run build"` (replaces the `--filter './packages/*' build && … @podium/web build` chain; the `//build` comment is rewritten: "Every package's build is a Turbo task; this only delegates. `apps/desktop` and the mobile native shells remain separate.")
- Delete `package:clients` and `package:clients:timed`.
- Add `"build:clients": "bun scripts/build-clients.ts"`.
- In `turbo.json`, `packages/*` `build` is covered by the generic `build` task (tsup → `dist/**`); no per-package entries needed.

- [ ] **Step 5: Run tests and a real warm/cold cycle**

Run: `bun --bun node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts --project node scripts/build-clients.test.ts`
Run: `PODIUM_APP_VERSION=0.0.0-m2 bun run build:clients` twice. Expected: first prints `MISS` for both, second prints `HIT` for both and no `vite`/`expo` output.

- [ ] **Step 6: Commit** — "build: admission-wrapped client build lane over turbo".

---

### Task 4: `build-bun.ts` builds the clients through Turbo

**Files:**
- Modify: `scripts/build-bun.ts` (`beginFreshClientPackagingSession`)
- Modify: `scripts/verify-client-build.ts` (`verifyClientBuild` accepts the run)
- Test: `scripts/assert-headless-bundle-layout.test.ts` wiring test; `scripts/verify-client-build.test.ts`

**Interfaces:**
- `verifyClientBuild(input: VerifyClientBuildInput & { run?: ClientBuildRun })` — when `run` is given, the evidence carries `taskHashes: Record<ClientBuildTask, string>` and `cache: Record<ClientBuildTask, 'HIT'|'MISS'>`.
- `beginFreshClientPackagingSession` becomes `async` (returns `Promise<FreshClientPackagingSession>`); `scripts/release.ts` `prepareHeadlessCross`/`prepareHeadlessArchitecture` become `async` and `main` awaits them; `scripts/package-headless.ts` awaits.

- [ ] **Step 1: Failing test** — in the wiring test replace `expect(buildBun).toContain("execFileSync(process.execPath, ['run', packageClients]")` and the `packageClients` line with `expect(buildBun).toContain('await buildClients(root')` and `expect(buildBun).not.toContain('package:clients')`. In `verify-client-build.test.ts` add: evidence minted with a `run` exposes `taskHashes['@podium/web#build']`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

In `beginFreshClientPackagingSession`: replace the `execFileSync(... 'run', packageClients ...)` block with
```ts
const run = await buildClients(root, [], { ...process.env, PODIUM_APP_VERSION: version })
```
and pass `run` into `verifyClientBuild`. Remove the `releaseBuildTimingEnabled` import if now unused (timing for the client build comes from Turbo's summary `execution` durations; M4 records them).

In `verify-client-build.ts`, extend `ClientBuildEvidence` with `taskHashes` and `cache` (both optional), filled from `input.run.tasks` when present.

- [ ] **Step 4: Make the callers async** — `release.ts` (`prepareHeadlessCross`, `prepareHeadlessArchitecture`, `main`), `package-headless.ts`. Scoped typecheck: `bun scripts/typecheck.ts --filter @podium/scripts --concurrency=1`.

- [ ] **Step 5: Run** the wiring test, `release.test.ts`, `verify-client-build.test.ts`. Then `bun run package:headless` twice; the second run's `[build-clients]` lines say `HIT` and the packaging completes.

- [ ] **Step 6: Commit** — "build: package-headless restores clients from the turbo cache".

---

### Task 5: CI and remaining callers use `turbo run build`

**Files:**
- Modify: `package.json` (`test:integration`, `test:e2e` already call `bun run build` — now Turbo; verify nothing else called `package:clients`)
- Modify: `.github/workflows/release.yml:42-57`, `.github/workflows/ci.yml` (the determinism job from M1 calls the package scripts directly — switch it to `bun run build:clients` in each worktree, and add `TURBO_CACHE_DIR` cache steps mirroring the `typecheck` job with key prefix `turbo-…-build-`)

- [ ] **Step 1:** In `release.yml`, before "Build four signed headless bundles", add the two cache steps (`TURBO_CACHE_DIR: /tmp/podium-cache/podium/turbo`, `actions/cache` keyed `turbo-${{ runner.os }}-bun-1.3.14-${{ hashFiles('bun.lock') }}-build-${{ github.sha }}` with restore-key prefix). `release.ts --prepare-cross` now restores clients when CI has already built them for this SHA.
- [ ] **Step 2:** Grep `package:clients` across the repo; expected: none.
- [ ] **Step 3:** Commit — "ci: share the turbo build cache".

---

### Task 6: Integration proof — second approval restores

**Files:**
- Modify: `scripts/named-dev-release.integration.bun.test.ts`

- [ ] **Step 1:** Add a test after `resolves a persisted development release immediately after restart`: build the fixture instance twice for the same commit; assert the second build's stdout contains `@podium/web#build HIT` and `@podium/mobile#build HIT` (the `[build-clients]` lines) and that `ps`-style evidence — a marker file the test writes into `apps/web/vite.config.ts`'s `build.rollupOptions.onLog` is overkill; instead assert the second run's `web-packaging` phase in the timing JSONL is under 10 s while the first was over 20 s. Use `PODIUM_RELEASE_BUILD_TIMING=1` and `PODIUM_RELEASE_TIMING_DIR` on the fixture.
- [ ] **Step 2:** Run `bun scripts/test-heavy.ts -- bun test --conditions=@podium/source scripts/named-dev-release.integration.bun.test.ts` (takes the heavy lease). Expected: PASS.
- [ ] **Step 3:** Commit — "test: a second dev approval restores the clients".

---

### Task 7: Verification and handoff

- [ ] `bun scripts/typecheck.ts --filter @podium/scripts --filter @podium/server --concurrency=1` green.
- [ ] `bun run test:web` and `bun run test:mobile` green (cache-safe wrapper).
- [ ] Read the latest `dist-bun/release-timing/*.jsonl` on the publisher after one approval of an unchanged commit: `web-packaging` per platform ≤ 10 s.
- [ ] `podium issue update --stage review` + offer with the timing lines as evidence.
