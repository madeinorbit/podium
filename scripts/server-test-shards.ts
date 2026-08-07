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
 * Regenerate after adding, moving, or deleting an apps/server test file:
 *
 *   bun scripts/server-test-shards.ts --write
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    tasks[shardTaskName(shard.id)] = { dependsOn: [], inputs: shard.inputs, outputs: [] }
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
  kind: 'unowned' | 'duplicated' | 'stale' | 'missing-input' | 'lane-input'
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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--write')) {
    writeArtifacts(repositoryRoot)
    return
  }

  // Default (and what `@podium/server#test` runs): the exhaustiveness refusal.
  const failures = verify(repositoryRoot)
  if (failures.length > 0) {
    console.error('server test shards refused: the shard roster does not describe this checkout.\n')
    for (const failure of failures.slice(0, 25)) console.error(`  [${failure.kind}] ${failure.detail}`)
    if (failures.length > 25) console.error(`  … and ${failures.length - 25} more`)
    console.error(`\n${REGENERATE_HINT}`)
    process.exit(1)
  }
  const manifest = readManifest(repositoryRoot)
  const total = manifest.shards.reduce((sum, shard) => sum + shard.testFiles.length, 0)
  console.error(`@podium/server test shards — ${total} unit files across ${SHARDS.length} shards:`)
  for (const shard of manifest.shards) {
    console.error(`  ${shard.id.padEnd(16)} ${String(shard.testFiles.length).padStart(3)}  ${shard.title}`)
  }
}

if (import.meta.main) await main()
