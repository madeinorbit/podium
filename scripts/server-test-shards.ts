/**
 * The @podium/server test lane, split into independently cached Turbo shards (POD-520).
 *
 * WHY THIS FILE EXISTS AT ALL, rather than five hand-written glob lists in turbo.json:
 * the shard boundary that matters is "what source does this test actually consume",
 * and that is a property of the import graph, not of the directory tree. Measuring it
 * (see docs/agents/pod-520-server-test-cache-shards.md) showed the directory-shaped
 * split the POD-515 review sketched would still replay 88% of the lane on a typical
 * server edit, because 133 of the 309 unit files transitively reach `src/composition`
 * — 87 of them through `src/relay.ts`, which imports nearly every module. Assigning by
 * measured consumption instead gets that to ~63%.
 *
 * THE FAILURE THIS FILE IS BUILT TO PREVENT is a cache hit that is a lie: a shard whose
 * declared Turbo inputs no longer cover the source its tests import, so an edit to that
 * source replays nothing and the lane reports a green it did not earn. So membership AND
 * inputs are both DERIVED here from the real import closure, written to
 * `apps/server/test-shards.json` and `turbo.json` by `--write`, and re-derived and
 * compared on every run of `scripts/server-test-shards.test.ts`. Drift is a failure,
 * never a silent widening.
 *
 * Three structural facts the derivation must respect, each of which would otherwise be a
 * false green:
 *
 *   1. EVERY shard depends on `src/migrations/**`. Not because every test imports it —
 *      most do not — but because `test-pre-migrated-schema.ts` (POD-523's globalSetup)
 *      hashes the migration manifest to build the schema image every store clones. A
 *      changed migration changes what every store test runs against, so migrations are
 *      a lane-level input, added to all five shards by {@link LANE_INPUTS}.
 *   2. Tests that READ repo source from disk (the audit/census suites) have no import
 *      edge to the trees they scan, so closure analysis cannot see their real inputs.
 *      They are pinned to the broad `boundary` shard — see {@link scansRepositorySource}.
 *   3. Type-only imports count. `import type { X } from './y'` is erased at runtime but a
 *      change to './y' can still turn the suite red at transform time, so the scanner
 *      deliberately does not distinguish them.
 *
 * WHAT `bun run test` IN apps/server IS FOR (POD-3531). It is a CONVENIENCE ALIAS: the
 * documented-looking command in the package directory, and it must run the same five shards
 * Turbo runs. It did not. This file was the aggregate task's whole body, and that body only
 * ever verified the roster — correct under Turbo, where `dependsOn` does the running, and a
 * lie by hand, where it printed "445 unit files across 5 shards" and exited 0 in 0.3s.
 *
 * The alternative reading — a deliberately narrow entry point that refuses and points at the
 * shards — was rejected. `test` is the name of the lane in every other package, the shards
 * are an internal caching detail, and an entry point that refuses to do the obvious thing
 * teaches people to stop reading it.
 *
 * So the default now RUNS, and the run ACCOUNTS FOR ITSELF, which is the shape POD-3517
 * landed for typecheck rather than a patch on the script. Every shard writes a Vitest JSON
 * report of the files it executed ({@link SHARD_REPORT_DIR}); {@link reconcile} refuses
 * unless every announced file appears in some shard's report, naming the shard and the files
 * when it does not. Under Turbo the shards run as dependencies and the aggregate reconciles
 * their reports instead of re-running them — see {@link TURBO_TASK_ENV}. `--roster` is the
 * only way to get the list without the lane, and it says out loud that it ran nothing.
 *
 * Regenerate after adding, moving, or deleting an apps/server test file:
 *
 *   bun scripts/server-test-shards.ts --write
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executedTestFiles,
  SHARD_REPORT_DIR,
  SHARD_REPORT_DIR_IN_PACKAGE,
  shardReportDir,
  shardReportPath,
  type VitestJsonReport,
} from '../apps/server/test-shard-report'
import { normalizedWireTests, unitTestExclude } from '../vitest.unit.config'

/**
 * Repository root, resolved from this file rather than from cwd.
 *
 * `import.meta.url`, not Bun's `import.meta.dir`: this module is imported by the drift
 * guard under Vitest, whose transform does not provide the Bun-only form.
 */
export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

export const SERVER_PACKAGE = 'apps/server'
export const MANIFEST_PATH = `${SERVER_PACKAGE}/test-shards.json`

export interface ShardDefinition {
  /** Shard id; also the Turbo task suffix (`@podium/server#test:<id>`) and script name. */
  id: string
  /** One line, shown in the roster the aggregate task prints. */
  title: string
}

/**
 * The five cache units, in the order the aggregate reports them. Names follow the POD-515
 * review's suggested units; MEMBERSHIP follows measured consumption (see {@link shardOf}),
 * because the two disagree and the measurement is the one that governs cache honesty.
 */
export const SHARDS: readonly ShardDefinition[] = [
  { id: 'contracts', title: 'pure contracts, policies and types-runtime matrices' },
  { id: 'store', title: 'store and migrations' },
  { id: 'services', title: 'issue/session/message/workflow services' },
  { id: 'boundary', title: 'composition, router, gateway, server boundaries and source audits' },
  { id: 'normalized-wire', title: 'normalized-wire and load guards' },
] as const

export type ShardId = (typeof SHARDS)[number]['id']

/**
 * The two normalized-wire files, kept as their own serialized cache unit. This list is the
 * root lane's (`vitest.unit.config.ts`) — imported rather than restated so the shard and
 * the root project can never disagree about which files these are.
 */
export { normalizedWireTests }

/**
 * Inputs every shard gets regardless of what its tests import.
 *
 * `src/migrations/**` is here for the reason in this file's header: POD-523's globalSetup
 * derives the schema image from the migration manifest, so a migration edit changes the
 * database every shard's stores open. Dropping it would be the single easiest false green
 * to introduce here.
 *
 * Note also that `$TURBO_ROOT$/packages/sync/src/**` ends up in every shard, from the
 * closure rather than from this list. That is load-bearing: a sync-system rewrite relies on
 * a sync-source edit replaying the server suite. The constraint is recorded in the POD-515
 * test-gate review — which is where it was written down, not who owns the rewrite. Narrowing
 * it is a conversation to have with whoever owns that rewrite, and
 * `scripts/server-test-shards.test.ts` refuses until then.
 *
 * The rest is the package's own config surface plus the shared hermetic setup. The root
 * `vitest.config.ts`, `vitest.unit.config.ts`, `test-hermetic-*.ts`,
 * `test-pre-migrated-*.ts` and `scripts/package-vitest-config.ts` are already in
 * turbo.json `globalDependencies`, so they invalidate every task in the repo and are not
 * repeated per shard.
 */
export const LANE_INPUTS: readonly string[] = [
  'package.json',
  'tsconfig.json',
  'test-shards.json',
  'vitest.config.ts',
  'vitest.shard.ts',
  'vitest.*.config.ts',
  // The shard/aggregate agreement on where a run records what it executed (POD-3531).
  'test-shard-report.ts',
  'src/migrations/**',
  'src/test-support/**',
  '$TURBO_ROOT$/scripts/server-test-shards.ts',
]

// ---------------------------------------------------------------------------------------
// Import-closure scanner
// ---------------------------------------------------------------------------------------

/** Workspace package name -> directory, read from the manifests rather than assumed. */
function workspacePackages(root: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(root, 'packages', entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    out.set(JSON.parse(readFileSync(manifest, 'utf8')).name, `packages/${entry.name}`)
  }
  return out
}

const RESOLUTION_CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveOnDisk(base: string): string | null {
  for (const extension of RESOLUTION_CANDIDATES) {
    const candidate = base + extension
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  // NodeNext-style '.js' specifiers that mean the sibling '.ts'.
  if (base.endsWith('.js')) {
    const rewritten = `${base.slice(0, -3)}.ts`
    if (existsSync(rewritten)) return rewritten
  }
  return null
}

/**
 * Static, dynamic, and `vi.mock` specifiers. A regex rather than a real parser because the
 * only thing that matters here is being a SUPERSET of the true edge set: an over-matched
 * specifier that resolves to a real file widens the shard's inputs (safe), while a missed
 * one would narrow them (a false green). Anything that does not resolve is dropped, so
 * over-matching costs nothing.
 */
const SPECIFIER_PATTERNS = [
  /(?:^|[\s;{}(])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bvi\.(?:mock|doMock|importActual|importMock)\(\s*['"]([^'"]+)['"]/g,
]

function specifiersOf(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) found.add(match[1] as string)
  }
  return [...found]
}

export interface Scanner {
  /** Transitive closure of `entry`, as repo-relative paths, excluding `entry` itself. */
  closure(entry: string): Set<string>
}

export function createScanner(root: string): Scanner {
  const packages = workspacePackages(root)
  const sourceCache = new Map<string, string | null>()
  const edgeCache = new Map<string, string[]>()

  const read = (file: string): string | null => {
    let cached = sourceCache.get(file)
    if (cached === undefined) {
      try {
        cached = readFileSync(file, 'utf8')
      } catch {
        cached = null
      }
      sourceCache.set(file, cached)
    }
    return cached
  }

  const resolveSpecifier = (specifier: string, from: string): string | null => {
    if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return null
    if (specifier.startsWith('.')) return resolveOnDisk(resolve(dirname(from), specifier))
    if (specifier.startsWith('@podium/')) {
      for (const [name, dir] of packages) {
        if (specifier === name) return resolveOnDisk(join(root, dir, 'src', 'index'))
        if (specifier.startsWith(`${name}/`)) {
          return resolveOnDisk(join(root, dir, 'src', specifier.slice(name.length + 1)))
        }
      }
    }
    // A bare npm specifier. node_modules is not a cache input: bun.lock already is,
    // via turbo.json globalDependencies.
    return null
  }

  const edges = (file: string): string[] => {
    const cached = edgeCache.get(file)
    if (cached) return cached
    const out: string[] = []
    if (/\.tsx?$/.test(file)) {
      const source = read(file)
      if (source !== null) {
        for (const specifier of specifiersOf(source)) {
          const resolved = resolveSpecifier(specifier, file)
          if (resolved) out.push(resolved)
        }
      }
    }
    edgeCache.set(file, out)
    return out
  }

  return {
    closure(entry: string): Set<string> {
      const absoluteEntry = join(root, entry)
      const seen = new Set<string>()
      const stack = [absoluteEntry]
      while (stack.length > 0) {
        const file = stack.pop() as string
        if (seen.has(file)) continue
        seen.add(file)
        for (const next of edges(file)) stack.push(next)
      }
      seen.delete(absoluteEntry)
      return new Set([...seen].map((file) => relative(root, file)))
    },
  }
}

// ---------------------------------------------------------------------------------------
// Which files the lane collects
// ---------------------------------------------------------------------------------------

const excludeMatchers = unitTestExclude.map((pattern) => new Bun.Glob(pattern))

/** True when the root unit lane would NOT collect this file (integration, PTY, bun, e2e…). */
export function isExcludedFromUnitLane(relativePath: string): boolean {
  return excludeMatchers.some((glob) => glob.match(relativePath))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

/**
 * Every apps/server test file the default unit lane collects, sorted.
 *
 * This is the set the five shards must partition EXACTLY. The aggregate task refuses when
 * it does not (see {@link verify}) — that refusal is what makes "the shards ran" mean the
 * same thing as "the server lane ran".
 */
export function unitLaneTestFiles(root: string): string[] {
  const collected = walk(join(root, SERVER_PACKAGE))
    .map((file) => relative(root, file))
    .filter((file) => /\.test\.tsx?$/.test(file))
    // The normalized-wire pair is in `unitTestExclude` because the root node PROJECT must
    // not collect it — it runs serialized in its own project, and here in its own shard.
    // Excluded from the parallel pool is not the same as outside the lane, so add it back
    // explicitly; dropping it here would silently retire the two load guards POD-515 keeps.
    .filter((file) => normalizedWireTests.includes(file) || !isExcludedFromUnitLane(file))
  return [...new Set(collected)].sort()
}

// ---------------------------------------------------------------------------------------
// Shard assignment
// ---------------------------------------------------------------------------------------

/**
 * Repo-root path literals reached by a file that also touches the filesystem. Such a test
 * READS source it never imports (the audit/census suites), so its true inputs are invisible
 * to closure analysis. Rather than guess at the scanned roots, these are pinned to the
 * broad `boundary` shard, whose inputs already span the repository trees the lane can see.
 */
const REPOSITORY_PATH_LITERAL = /['"`](?:apps|packages|scripts|docs|tooling|tests)\//
const FILESYSTEM_REACH =
  /\breadFileSync\b|\breaddirSync\b|\breadFile\b|\bBun\.Glob\b|\bglobSync\b|\bspawnSync\b|\bBun\.spawn\b|\bexecFileSync\b/

export function scansRepositorySource(root: string, relativePath: string): boolean {
  let source: string
  try {
    source = readFileSync(join(root, relativePath), 'utf8')
  } catch {
    return false
  }
  return REPOSITORY_PATH_LITERAL.test(source) && FILESYSTEM_REACH.test(source)
}

/**
 * Repo paths a test names as a STRING and that exist on disk.
 *
 * These are the inputs no import graph can see, and they are not hypothetical: the old
 * single server key had to list `packages/client-core/src/engine/outbox-coverage.oracle.test.ts`,
 * `scripts/audit-automation-commands.ts` and `scripts/audit-workflow-commands.ts` by hand
 * for exactly this reason — `oracle-tags.test.ts` READS the first with `readFileSync`, and
 * the two cutover audits SPAWN the other two as subprocesses. Deriving inputs from imports
 * alone would have silently dropped all three, which is a false green, not a smaller key.
 *
 * Gated on the file ALSO reaching the filesystem. Without that gate the rule fires on
 * prose and fixtures — a docstring naming a sibling audit, a fake path like 'apps/web/a.ts'
 * used as test data — and drags whole package trees into narrow shards for nothing. With
 * it, the derivation reproduces exactly the three entries the old key had been carrying by
 * hand and adds none of the ~12 prose references, which is the check that it is reading
 * dependency and not mention.
 *
 * A literal that does not resolve on disk is ignored; one that resolves to a directory
 * contributes the whole tree.
 */
const PATH_LITERAL = /['"`]((?:apps|packages|scripts|docs|tooling|tests)\/[\w./-]+)['"`]/g

export function referencedRepositoryPaths(root: string, relativePath: string): string[] {
  let source: string
  try {
    source = readFileSync(join(root, relativePath), 'utf8')
  } catch {
    return []
  }
  if (!FILESYSTEM_REACH.test(source)) return []
  const found = new Set<string>()
  PATH_LITERAL.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_LITERAL.exec(source))) {
    const candidate = match[1] as string
    const absolute = join(root, candidate)
    if (!existsSync(absolute)) continue
    found.add(statSync(absolute).isDirectory() ? `${candidate}/**` : candidate)
  }
  return [...found]
}

const inServerDir = (closure: Set<string>, dir: string): boolean => {
  const prefix = `${SERVER_PACKAGE}/src/${dir}/`
  for (const file of closure) if (file.startsWith(prefix)) return true
  return false
}

/**
 * Assign one test file to one shard.
 *
 * Ordered so that the structural rules (1–3) win over the measured ones (4–6): a
 * normalized-wire file, a source-scanning audit, and a store/migration suite each belong to
 * a named unit regardless of what their imports happen to look like today. Below that,
 * consumption decides, because that is what determines whether an edit can skip the shard.
 */
export function shardOf(root: string, relativePath: string, closure: Set<string>): ShardId {
  // 1. The two serialized wire guards keep their own cache unit (POD-515 Keep item 5).
  if (normalizedWireTests.includes(relativePath)) return 'normalized-wire'
  // 2. Source audits read trees they do not import; only the broad shard can be honest.
  if (scansRepositorySource(root, relativePath)) return 'boundary'
  // 3. The review's "store and migrations" unit, by ownership.
  if (
    relativePath.startsWith(`${SERVER_PACKAGE}/src/store/`) ||
    relativePath.startsWith(`${SERVER_PACKAGE}/src/migrations/`)
  ) {
    return 'store'
  }
  // 4. Everything that builds the composed application pulls in nearly every module, so it
  //    cannot be narrowed; split it by ownership only.
  if (inServerDir(closure, 'composition') || inServerDir(closure, 'application')) {
    return relativePath.startsWith(`${SERVER_PACKAGE}/src/modules/`) ? 'services' : 'boundary'
  }
  // 5. Consumes the store without composing the app.
  if (inServerDir(closure, 'store')) return 'store'
  // 6. Pure contract/policy/types-runtime matrices: the genuinely narrow shard.
  return 'contracts'
}

// ---------------------------------------------------------------------------------------
// Input derivation
// ---------------------------------------------------------------------------------------

/**
 * Turn a closure into Turbo input globs.
 *
 * apps/server files are listed ONE PER FILE, not coarsened to a directory glob, and that
 * is the whole difference between a split worth having and one that is not. Measured on
 * this checkout, over the mean single-file edit under apps/server/src:
 *
 *   file-level inputs   62% of the lane replays   (1,237 globs)
 *   src-root file-level 80%                       (406 globs)
 *   directory globs     85%                       (136 globs)
 *   today, unsharded   100%
 *
 * Directory globs are a safe superset — they over-invalidate, never under — but they give
 * back most of the win, because `src/` is a flat 55-file dump and `src/modules/sessions`
 * holds 48 heterogeneous files that few suites consume together. The verbosity is the
 * price; it is paid in a generated per-package `apps/server/turbo.json` so the root config
 * stays readable.
 *
 * Upstream workspace packages stay at `src/**` granularity: their internal graphs are not
 * measured here, so a whole-package glob is the honest declaration.
 */
export function inputsForClosure(closure: Iterable<string>, shardId?: ShardId): string[] {
  const globs = new Set<string>(LANE_INPUTS)
  // The broad shard owns every source-scanning audit (see shardOf rule 2), and a scanner
  // that walks a directory at runtime depends on files no closure and no path literal can
  // name — `oracle-tags.test.ts` readdir's its own directory, for one. Its measured closure
  // is already 353 of 363 server sources, so declaring the whole tree costs essentially no
  // precision and removes that entire class of hole.
  if (shardId === 'boundary') {
    globs.add('src/**')
    globs.add('test/**')
  }
  for (const file of closure) {
    if (file.startsWith(`${SERVER_PACKAGE}/`)) {
      globs.add(file.slice(SERVER_PACKAGE.length + 1))
      continue
    }
    if (file.endsWith('/**')) {
      globs.add(`$TURBO_ROOT$/${file}`)
      continue
    }
    if (file.startsWith('packages/')) {
      globs.add(`$TURBO_ROOT$/packages/${file.split('/')[1]}/src/**`)
      continue
    }
    if (file.startsWith('apps/')) {
      globs.add(`$TURBO_ROOT$/apps/${file.split('/')[1]}/src/**`)
      continue
    }
    if (file.startsWith('scripts/')) globs.add(`$TURBO_ROOT$/${file}`)
  }
  return [...globs].sort()
}

// ---------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------

export interface ShardPlan {
  id: ShardId
  title: string
  /** The test files this shard runs, sorted. Vitest `include` reads exactly this. */
  testFiles: string[]
  /** Turbo `inputs` for `@podium/server#test:<id>`, sorted. */
  inputs: string[]
}

export interface Manifest {
  /** Regeneration hint carried in the file so a reader of the diff knows what to run. */
  generatedBy: string
  shards: ShardPlan[]
}

export function computePlan(root: string = repositoryRoot): ShardPlan[] {
  const scanner = createScanner(root)
  const files = unitLaneTestFiles(root)
  const members = new Map<ShardId, string[]>(SHARDS.map((shard) => [shard.id, []]))
  const closures = new Map<ShardId, Set<string>>(SHARDS.map((shard) => [shard.id, new Set()]))

  for (const file of files) {
    const closure = scanner.closure(file)
    const id = shardOf(root, file, closure)
    ;(members.get(id) as string[]).push(file)
    const union = closures.get(id) as Set<string>
    // The test file itself is an input too — Turbo must replay a shard when one of its own
    // test files changes, and a test file is not in its own closure.
    union.add(file)
    for (const dependency of closure) union.add(dependency)
    // Paths the test names as a string and reads or spawns rather than imports.
    for (const referenced of referencedRepositoryPaths(root, file)) {
      union.add(referenced)
      // A named .ts file is executed or parsed, so its own imports are inputs too.
      if (/\.tsx?$/.test(referenced)) for (const dep of scanner.closure(referenced)) union.add(dep)
    }
  }

  return SHARDS.map((shard) => ({
    id: shard.id,
    title: shard.title,
    testFiles: (members.get(shard.id) as string[]).sort(),
    inputs: inputsForClosure(closures.get(shard.id) as Set<string>, shard.id),
  }))
}

export function readManifest(root: string = repositoryRoot): Manifest {
  return JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')) as Manifest
}

export function renderManifest(shards: ShardPlan[]): string {
  const manifest: Manifest = {
    generatedBy: 'bun scripts/server-test-shards.ts --write',
    shards,
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

// ---------------------------------------------------------------------------------------
// turbo.json projection
// ---------------------------------------------------------------------------------------

export const shardTaskName = (id: ShardId) => `test:${id}`
export const TURBO_CONFIG_PATH = `${SERVER_PACKAGE}/turbo.json`

/**
 * The `test` aggregate's own inputs. It runs {@link verify}, so it must replay whenever the
 * roster could have changed: a new or deleted test file, or an edited manifest/generator.
 * `$TURBO_DEFAULT$` covers every tracked file in apps/server, which includes both.
 */
export const AGGREGATE_INPUTS: readonly string[] = [
  '$TURBO_DEFAULT$',
  '$TURBO_ROOT$/scripts/server-test-shards.ts',
  '$TURBO_ROOT$/vitest.unit.config.ts',
]

export interface TurboTask {
  dependsOn: string[]
  inputs: string[]
  outputs: string[]
}

/**
 * A shard's Turbo output: the JSON report naming every file it executed (POD-3531).
 *
 * Declared as an output rather than left as a side effect so a CACHE HIT restores it too.
 * Without that, a replayed shard would leave no record, and the aggregate's reconciliation
 * would have to treat every cached green as an unrun shard — which would make the honest
 * check unusable and get it deleted. The report is the shard's evidence; the cache has to
 * carry the evidence with the result.
 */
export const shardReportOutput = (id: ShardId): string =>
  `${SHARD_REPORT_DIR_IN_PACKAGE}/${id}.json`

/**
 * The generated `apps/server/turbo.json` — a Turbo Package Configuration, so the ~1,240
 * file-level input globs live next to the package they describe instead of tripling the
 * root config. Task names are unprefixed here and apply to @podium/server only; a bare
 * name in `dependsOn` means the same package's task, which is exactly the aggregation the
 * root `test` lane needs.
 */
export function turboPackageConfig(shards: ShardPlan[]): Record<string, unknown> {
  const tasks: Record<string, TurboTask> = {
    test: {
      // Every shard hangs off `test`, which is what keeps `bun run test` exhaustive and
      // puts all five in the graph `test:affected` reads.
      dependsOn: SHARDS.map((shard) => shardTaskName(shard.id)),
      inputs: [...AGGREGATE_INPUTS],
      outputs: [],
    },
  }
  for (const shard of shards) {
    tasks[shardTaskName(shard.id)] = {
      dependsOn: [],
      inputs: shard.inputs,
      outputs: [shardReportOutput(shard.id)],
    }
  }
  return {
    $schema: 'https://turbo.build/schema.json',
    extends: ['//'],
    // Generated. See scripts/server-test-shards.ts.
    tasks,
  }
}

// ---------------------------------------------------------------------------------------
// Verification — what the aggregate task actually runs
// ---------------------------------------------------------------------------------------

export interface VerifyFailure {
  kind:
    | 'unowned'
    | 'duplicated'
    | 'stale'
    | 'missing-input'
    | 'lane-input'
    // POD-3531 — the run did not account for the roster it announced.
    | 'unrun'
    | 'short-shard'
    | 'shard-failed'
    | 'roster-mismatch'
  detail: string
}

/**
 * Refuse unless the checked-in manifest still describes this checkout exactly.
 *
 * This is the uncovered-file refusal for the shard split, and it is the reason the split
 * cannot quietly stop testing something: an apps/server test file that no shard claims, a
 * file claimed twice, a manifest that no longer matches the derivation, or a shard whose
 * declared inputs stop covering its measured closure all fail here rather than passing as
 * a green.
 */
export function verify(root: string = repositoryRoot): VerifyFailure[] {
  const failures: VerifyFailure[] = []
  let manifest: Manifest
  try {
    manifest = readManifest(root)
  } catch (error) {
    return [{ kind: 'stale', detail: `${MANIFEST_PATH} is missing or unreadable: ${error}` }]
  }

  const collected = unitLaneTestFiles(root)
  const claimed = new Map<string, string[]>()
  for (const shard of manifest.shards) {
    for (const file of shard.testFiles) {
      const owners = claimed.get(file)
      if (owners) owners.push(shard.id)
      else claimed.set(file, [shard.id])
    }
  }
  for (const file of collected) {
    const owners = claimed.get(file) ?? []
    if (owners.length === 0) {
      failures.push({
        kind: 'unowned',
        detail: `${file} is collected by the unit lane but no shard runs it`,
      })
    } else if (owners.length > 1) {
      failures.push({ kind: 'duplicated', detail: `${file} is claimed by ${owners.join(', ')}` })
    }
  }
  for (const [file] of claimed) {
    if (!collected.includes(file)) {
      failures.push({
        kind: 'stale',
        detail: `${file} is listed in the manifest but the unit lane no longer collects it`,
      })
    }
  }

  // Every shard carries the lane-level inputs, migrations above all (see LANE_INPUTS).
  for (const shard of manifest.shards) {
    for (const required of LANE_INPUTS) {
      if (!shard.inputs.includes(required)) {
        failures.push({
          kind: 'lane-input',
          detail: `shard "${shard.id}" is missing the lane input ${required}`,
        })
      }
    }
  }

  return failures
}

/** The manifest/turbo.json drift check, kept separate because it is the expensive half. */
export function diffAgainstPlan(root: string = repositoryRoot): VerifyFailure[] {
  const expected = computePlan(root)
  const actual = readManifest(root).shards
  const failures: VerifyFailure[] = []
  for (const shard of expected) {
    const current = actual.find((candidate) => candidate.id === shard.id)
    if (!current) {
      failures.push({ kind: 'stale', detail: `shard "${shard.id}" is missing from the manifest` })
      continue
    }
    if (JSON.stringify(current.testFiles) !== JSON.stringify(shard.testFiles)) {
      failures.push({
        kind: 'stale',
        detail: `shard "${shard.id}" membership is out of date`,
      })
    }
    for (const input of shard.inputs) {
      if (!current.inputs.includes(input)) {
        failures.push({
          kind: 'missing-input',
          detail: `shard "${shard.id}" no longer declares ${input}, which its tests import`,
        })
      }
    }
  }
  return failures
}

// ---------------------------------------------------------------------------------------
// Run accounting — what the aggregate does with the roster it announced (POD-3531)
// ---------------------------------------------------------------------------------------

/** What one shard did, as far as the aggregate can establish it. */
export interface ShardOutcome {
  id: string
  /** Exit status of the shard command, or null when Turbo ran the shard as a dependency. */
  exitCode: number | null
  /** Repo-relative files the shard's report says it executed, or null when there is none. */
  executed: string[] | null
  /** Why the report could not be read, when it could not. */
  reportError: string | null
  /** The report's own verdict, or null when there is no readable report. */
  success: boolean | null
}

/** Read one shard's report back off disk and pair it with how the command exited. */
export function readShardOutcome(
  root: string,
  id: string,
  exitCode: number | null,
  env: Record<string, string | undefined> = process.env,
): ShardOutcome {
  const path = shardReportPath(root, id, env)
  let report: VitestJsonReport
  try {
    report = JSON.parse(readFileSync(path, 'utf8')) as VitestJsonReport
  } catch (error) {
    return {
      id,
      exitCode,
      executed: null,
      reportError: `${path} is missing or unreadable: ${error}`,
      success: null,
    }
  }
  return {
    id,
    exitCode,
    executed: executedTestFiles(root, report),
    reportError: null,
    success: typeof report.success === 'boolean' ? report.success : null,
  }
}

const sample = (files: string[], limit = 5): string =>
  files.length <= limit ? files.join(', ') : `${files.slice(0, limit).join(', ')}, … +${files.length - limit} more`

/**
 * Refuse unless the run accounted for every file the roster announced.
 *
 * This is the other half of {@link verify}. `verify` establishes that the roster describes
 * the checkout; this establishes that the roster was RUN. The defect it exists to make
 * impossible is the one POD-3531 found: an aggregate that prints "445 unit files across 5
 * shards" and exits 0 having executed none of them. So the announced number is not a label
 * on the output, it is a claim the process has to discharge — per shard, by name, against
 * each shard's own record of what it collected.
 *
 * Every failure names the shard, both counts and the specific files, because a bare
 * non-zero here would be indistinguishable from a test failure, and the whole point of this
 * check is telling a human something the exit code could not.
 */
export function reconcile(manifest: Manifest, outcomes: ShardOutcome[]): VerifyFailure[] {
  const failures: VerifyFailure[] = []
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
  const executedOverall = new Set<string>()

  for (const shard of manifest.shards) {
    const announced = shard.testFiles.length
    const outcome = byId.get(shard.id)
    if (!outcome) {
      failures.push({
        kind: 'unrun',
        detail: `shard "${shard.id}" announced ${announced} files and was never run`,
      })
      continue
    }
    if (outcome.exitCode !== null && outcome.exitCode !== 0) {
      failures.push({
        kind: 'shard-failed',
        detail: `shard "${shard.id}" exited ${outcome.exitCode}`,
      })
    }
    if (outcome.executed === null) {
      failures.push({
        kind: 'unrun',
        detail:
          `shard "${shard.id}" announced ${announced} files but left no record of running ` +
          `any: ${outcome.reportError}`,
      })
      continue
    }
    for (const file of outcome.executed) executedOverall.add(file)

    const claimed = new Set(shard.testFiles)
    const ran = new Set(outcome.executed)
    const missing = shard.testFiles.filter((file) => !ran.has(file))
    const unclaimed = outcome.executed.filter((file) => !claimed.has(file))
    if (missing.length > 0) {
      failures.push({
        kind: 'short-shard',
        detail:
          `shard "${shard.id}" announced ${announced} files but executed ` +
          `${outcome.executed.length}; did not run: ${sample(missing)}`,
      })
    }
    if (unclaimed.length > 0) {
      failures.push({
        kind: 'roster-mismatch',
        detail: `shard "${shard.id}" executed files it does not claim: ${sample(unclaimed)}`,
      })
    }
    if (outcome.success === false && (outcome.exitCode === null || outcome.exitCode === 0)) {
      failures.push({
        kind: 'shard-failed',
        detail: `shard "${shard.id}" reported failing tests`,
      })
    }
  }

  const announcedTotal = manifest.shards.reduce((sum, shard) => sum + shard.testFiles.length, 0)
  if (executedOverall.size !== announcedTotal) {
    failures.push({
      kind: 'roster-mismatch',
      detail:
        `the roster announced ${announcedTotal} unit files across ${manifest.shards.length} ` +
        `shards; the run executed ${executedOverall.size}`,
    })
  }
  return failures
}

// ---------------------------------------------------------------------------------------
// Running the shards
// ---------------------------------------------------------------------------------------

/**
 * Turbo sets this in every task environment (verified against turbo 2.10.5, whose strict
 * env mode passes a task nothing else it has not declared). Its presence is how the
 * aggregate knows the five shard tasks already ran as its `dependsOn` dependencies and it
 * must not run them a second time.
 */
export const TURBO_TASK_ENV = 'TURBO_HASH'

/**
 * Probe seam: replaces the per-shard command, with the shard id appended as the last
 * argument. Used by `scripts/server-test-shards-run.test.ts` to drive the real CLI against
 * a stub shard without running 445 test files. Nothing in the product reads it.
 */
export const SHARD_COMMAND_ENV = 'PODIUM_SERVER_SHARD_COMMAND'

export interface ShardInvocation {
  command: string[]
  cwd: string
}

/**
 * How the aggregate runs one shard directly: the package's own `test:<id>` script.
 *
 * Deliberately the script and not a hand-rolled Vitest command line. That script is what
 * `@podium/server#test:<id>` runs under Turbo, admission lease and all, so the direct path
 * and the gated path execute the same thing by construction rather than by two command
 * strings somebody has to keep in step.
 */
export function shardInvocation(
  root: string,
  id: string,
  env: Record<string, string | undefined> = process.env,
): ShardInvocation {
  const cwd = join(root, SERVER_PACKAGE)
  const override = env[SHARD_COMMAND_ENV]
  if (override && override.trim() !== '') {
    return { command: [...override.trim().split(/\s+/), id], cwd }
  }
  return { command: ['bun', 'run', shardTaskName(id)], cwd }
}

/**
 * Run all five shards here, in this process's tree, and collect what each one did.
 *
 * Sequential, matching the serial task execution `scripts/test.ts` asks Turbo for: each
 * shard is already capped at two Vitest workers and the host is shared.
 *
 * Every shard runs even after one fails. A fail-fast here would abandon shards while the
 * roster still claimed them, which is precisely the accounting hole POD-3517 closed in the
 * typecheck lane — the run must be able to say what happened to all five, not to the ones
 * before the first red.
 */
export async function runShards(
  root: string,
  manifest: Manifest,
  env: Record<string, string | undefined> = process.env,
): Promise<ShardOutcome[]> {
  // Last run's reports are not this run's evidence. Clear them first, so a shard that fails
  // to start is an absent report rather than a stale one that reads as a pass.
  const reportDir = shardReportDir(root, env)
  rmSync(reportDir, { recursive: true, force: true })
  mkdirSync(reportDir, { recursive: true })

  const outcomes: ShardOutcome[] = []
  for (const shard of manifest.shards) {
    const { command, cwd } = shardInvocation(root, shard.id, env)
    console.error(`\n▸ ${shard.id} — ${shard.testFiles.length} files (${command.join(' ')})`)
    const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
    const exitCode = await child.exited
    outcomes.push(readShardOutcome(root, shard.id, exitCode, env))
  }
  return outcomes
}

export const RECONCILE_HINT =
  'Each shard writes what it executed to ' +
  `${SHARD_REPORT_DIR}/<shard>.json; the aggregate compares those against the roster.\n` +
  'A shard with no report did not run. A short shard ran fewer files than it claims —\n' +
  'regenerate the manifest if the roster is what moved:\n' +
  '  bun scripts/server-test-shards.ts --write'

export const REGENERATE_HINT =
  'Regenerate with:\n  bun scripts/server-test-shards.ts --write\n' +
  'then review the diff — a file moving between shards means its imports changed.'

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function writeArtifacts(root: string): void {
  const shards = computePlan(root)
  writeFileSync(join(root, MANIFEST_PATH), renderManifest(shards))
  writeFileSync(
    join(root, TURBO_CONFIG_PATH),
    `${JSON.stringify(turboPackageConfig(shards), null, 2)}\n`,
  )

  for (const shard of shards) {
    console.error(
      `  ${shard.id.padEnd(16)} ${String(shard.testFiles.length).padStart(3)} files, ` +
        `${String(shard.inputs.length).padStart(4)} input globs`,
    )
  }
  console.error(`\nwrote ${MANIFEST_PATH} and ${TURBO_CONFIG_PATH}`)
}

function reportFailures(headline: string, failures: VerifyFailure[], hint: string): never {
  console.error(`${headline}\n`)
  for (const failure of failures.slice(0, 25)) console.error(`  [${failure.kind}] ${failure.detail}`)
  if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`)
  console.error(`\n${hint}`)
  process.exit(1)
}

function announce(manifest: Manifest): number {
  const total = manifest.shards.reduce((sum, shard) => sum + shard.testFiles.length, 0)
  console.error(`@podium/server test shards — ${total} unit files across ${SHARDS.length} shards:`)
  for (const shard of manifest.shards) {
    console.error(`  ${shard.id.padEnd(16)} ${String(shard.testFiles.length).padStart(3)}  ${shard.title}`)
  }
  return total
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--write')) {
    writeArtifacts(repositoryRoot)
    return
  }

  // The exhaustiveness refusal: does the roster still describe this checkout?
  const failures = verify(repositoryRoot)
  if (failures.length > 0) {
    reportFailures(
      'server test shards refused: the shard roster does not describe this checkout.',
      failures,
      REGENERATE_HINT,
    )
  }

  const manifest = readManifest(repositoryRoot)
  const total = announce(manifest)

  // --roster is the one way to get the list without the lane, and it says so. Everything
  // else runs, because a command that prints 445 files and exits 0 having run none of them
  // is the defect this entry point was rewritten to make impossible (POD-3531).
  if (args.includes('--roster')) {
    console.error(
      `\nROSTER ONLY — no tests were run. Drop --roster to run all ${total} files, ` +
        `or run one shard with: bun run --cwd ${SERVER_PACKAGE} test:<shard>`,
    )
    return
  }

  const delegated = Boolean(process.env[TURBO_TASK_ENV])
  if (delegated) {
    console.error(
      `\nrunning under Turbo (${TURBO_TASK_ENV} set) — the five shard tasks ran as this ` +
        "task's dependencies; reconciling their reports.",
    )
  }
  const outcomes = delegated
    ? manifest.shards.map((shard) => readShardOutcome(repositoryRoot, shard.id, null))
    : await runShards(repositoryRoot, manifest)

  const unaccounted = reconcile(manifest, outcomes)
  if (unaccounted.length > 0) {
    reportFailures(
      `server test lane refused: the run did not account for the ${total} files it announced.`,
      unaccounted,
      RECONCILE_HINT,
    )
  }
  console.error(`\n@podium/server: ${total} unit files announced, ${total} executed across ${SHARDS.length} shards.`)
}

if (import.meta.main) await main()
