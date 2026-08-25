/**
 * Global-store cache admission evidence (POD-2774).
 *
 * The Stage 1 canary shows that a global-store worktree installs, resolves, and builds.
 * It does not show that the results such a worktree caches may be handed to the NEXT
 * worktree — which is the whole reason the fleet would adopt the layout. This lane
 * answers that separately, and cheaply enough to re-run per host before rollout.
 *
 * It creates three detached worktrees of one commit: a hoisted control and two
 * candidates installed INDEPENDENTLY through the same external global-store config.
 * All three share one Turbo cache, chosen by scripts/typecheck.ts from the common git
 * directory — the lane only points XDG_CACHE_HOME at its own run directory so the
 * evidence starts cold and never touches the operator's cache. Then it proves, in order:
 *
 *   1. the three worktrees agree on one cache directory (sharing is real, not assumed);
 *   2. hoisted and candidate have DIFFERENT PODIUM_CHECK_ENV_HASH values while their
 *      tracked bunfig.toml files are byte-identical — the hole POD-2774 closes;
 *   3. a hoisted-warmed cache is a full MISS for a candidate;
 *   4. a candidate-warmed cache is a full HIT for an independently installed candidate,
 *      for typecheck and for one representative package test;
 *   5. editing one source file is a MISS again, so the hit was not indiscriminate;
 *   6. a dangling third-party link is REFUSED before Turbo runs at all.
 *
 * The test proofs run a single package task. Proving reuse must not cost a full suite,
 * and the report records the task count that shows it did not.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANDIDATE_BUNFIG,
  type CommandResult,
  canonicalizeFuturePath,
  commandOutput,
  createWorktree,
  install,
  isInside,
  removeWorktree,
  runCommand,
  runSync,
  runtimeEnv,
  sha256File,
} from './global-store-canary'
import {
  isFullHit,
  isFullMiss,
  parseTurboSummary,
  reusedEverythingCacheable,
  type TurboSummary,
} from './turbo-summary'
import { workspaceDirectories } from './workspace-resolution-census'

const REQUIRED_BUN = '1.3.14'
/**
 * The representative cached test. A leaf package with no workspace dependencies and a
 * green suite: its task hash moves only for its own sources and the global environment,
 * so a hit or a miss here is about the cache identity under test and not about a
 * neighbour's rebuild — or about a failure the cache had no say in.
 */
const REPRESENTATIVE_PACKAGE = '@podium/composer'
/** Never sacrifice a package `bun run typecheck` needs in order to report the refusal. */
const LOAD_BEARING = new Set(['.bin', '.bun', '.cache', 'turbo', 'typescript', 'vitest'])

export interface AdmissionOptions {
  bun: string
  cacheRoot: string
  output: string
  ref: string
  runId: string
  scratchParent: string
  sourceRoot: string
  testPackage: string
}

export interface Probe {
  summary: TurboSummary | null
  durationMs: number
  exitCode: number
  /** Both streams: turbo writes its summary to stdout and tsgo writes errors there too. */
  outputTail: string
}

interface WorktreeIdentity {
  bunfigHash: string
  cacheDir: string
  envHash: string
  admissionErrors: string[]
}

function usage(): never {
  console.error(
    'usage: bun run deps:global-store-cache-admission -- --cache-root <dir> ' +
      '--scratch-parent <dir> --run-id <label> --output <file> [--ref <commit>] [--bun <path>] ' +
      '[--test-package @podium/<name>]',
  )
  process.exit(2)
}

export function parseAdmissionArgs(args: string[], sourceRoot: string): AdmissionOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (!arg.startsWith('--')) usage()
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg.slice(2), args[++index]]
    if (inline === undefined) usage()
    values.set(flag, inline)
  }
  const required = ['cache-root', 'scratch-parent', 'run-id', 'output']
  if (required.some((flag) => !values.get(flag))) usage()
  return {
    bun: values.get('bun') ?? join(process.env.HOME ?? '', '.bun/bin/bun'),
    cacheRoot: canonicalizeFuturePath(values.get('cache-root') as string),
    output: canonicalizeFuturePath(values.get('output') as string),
    ref: values.get('ref') ?? 'HEAD',
    runId: values.get('run-id') as string,
    scratchParent: canonicalizeFuturePath(values.get('scratch-parent') as string),
    sourceRoot,
    testPackage: values.get('test-package') ?? REPRESENTATIVE_PACKAGE,
  }
}

/**
 * The same guardrails the canary applies: nothing this lane writes may land in the
 * checkout under test, and a run-id is single-use so an old cache cannot be mistaken
 * for a cold start. Unlike the canary the scratch parent is created rather than
 * required — it holds only worktrees this lane also removes.
 */
export function validateAdmissionOptions(options: AdmissionOptions): void {
  if (!existsSync(options.bun)) throw new Error(`Bun binary does not exist: ${options.bun}`)
  const sourceRoot = realpathSync(options.sourceRoot)
  for (const [label, path] of [
    ['dedicated cache', options.cacheRoot],
    ['disposable worktrees', options.scratchParent],
  ] as const) {
    if (isInside(sourceRoot, path))
      throw new Error(`${label} must be outside the checkout: ${path}`)
  }
  const runCache = join(options.cacheRoot, 'runs', options.runId)
  if (existsSync(runCache)) {
    throw new Error(`run cache already exists; choose a new --run-id: ${runCache}`)
  }
  mkdirSync(options.scratchParent, { recursive: true })
}

function probe(result: CommandResult): Probe {
  return {
    summary: parseTurboSummary(commandOutput(result)),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    outputTail: commandOutput(result).slice(-4000),
  }
}

/** The directory of a workspace package, so the source-change probe knows what to edit. */
export function workspaceSourceFile(root: string, packageName: string): string {
  for (const directory of workspaceDirectories(root)) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: string
    }
    if (manifest.name !== packageName) continue
    const source = join(directory, 'src', 'index.ts')
    if (!existsSync(source)) throw new Error(`${packageName} has no src/index.ts to edit`)
    return source
  }
  throw new Error(`no workspace package named ${packageName}`)
}

/**
 * The identity a worktree would present to Turbo, read from the worktree itself so the
 * lane never reimplements it. `import.meta.main` is false under `-e`, so importing the
 * entry point does not run it.
 */
async function readIdentity(
  bun: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<WorktreeIdentity> {
  const script =
    'const t = await import(process.cwd() + "/scripts/typecheck.ts");' +
    'const c = t.readCensus(process.cwd());' +
    'process.stdout.write(JSON.stringify({ envHash: t.fingerprint(c),' +
    ' cacheDir: t.sharedTurboCacheDir(process.cwd()), admissionErrors: c.admissionErrors }))'
  const result = await runCommand([bun, '-e', script], root, env, 5 * 60_000)
  if (result.exitCode !== 0) {
    throw new Error(`could not read the cache identity of ${basename(root)}: ${result.stderrTail}`)
  }
  return {
    ...(JSON.parse(result.stdoutTail) as Omit<WorktreeIdentity, 'bunfigHash'>),
    bunfigHash: sha256File(join(root, 'bunfig.toml')),
  }
}

// `--continue` so every task runs and the counts stay comparable between worktrees.
// Without it turbo stops at the first red package, and a run that attempted 19 tasks
// cannot be compared with one that attempted 24.
const typecheckCommand = (bun: string) => [bun, 'run', 'typecheck', '--', '--continue']

// scripts/test.ts directly: the root `test` script is a four-file smoke lane, and
// `test:cached` reserves --shared-admission for the web/mobile pair.
const packageTestCommand = (bun: string, packageName: string) => [
  bun,
  'scripts/test.ts',
  '--filter',
  packageName,
]

/**
 * Pick a third-party package to break. node-pty is the case that motivated this lane —
 * it is optional, native, and routinely half-installed — so prefer it when it is there
 * and otherwise take the first entry that `bun run typecheck` does not itself need.
 */
export function breakableEntry(entries: string[]): string | null {
  const eligible = entries
    .filter((name) => !name.startsWith('@') && !name.startsWith('.') && !LOAD_BEARING.has(name))
    .sort()
  if (entries.includes('node-pty')) return 'node-pty'
  return eligible[0] ?? null
}

async function main(): Promise<void> {
  const sourceRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
  const options = parseAdmissionArgs(process.argv.slice(2), sourceRoot)
  const startedAt = new Date().toISOString()
  if (runSync(['git', 'status', '--porcelain'], sourceRoot)) {
    throw new Error('source checkout must be clean before creating disposable worktrees')
  }
  const bunVersion = runSync([options.bun, '--version'], sourceRoot)
  if (bunVersion !== REQUIRED_BUN) {
    throw new Error(`requires Bun ${REQUIRED_BUN}, found ${bunVersion}`)
  }
  validateAdmissionOptions(options)
  const commit = runSync(['git', 'rev-parse', `${options.ref}^{commit}`], sourceRoot)

  const runCache = join(options.cacheRoot, 'runs', options.runId)
  const hoistedCache = join(runCache, 'hoisted')
  const globalStore = join(runCache, 'global-store')
  // One XDG root for every probe: scripts/typecheck.ts derives the durable Turbo cache
  // from the common git directory beneath it, so the three worktrees share one cache
  // without being told to, and the operator's own cache is neither read nor written.
  const xdgCacheHome = join(runCache, 'xdg')
  for (const path of [hoistedCache, globalStore, xdgCacheHome]) mkdirSync(path, { recursive: true })
  const runRoot = mkdtempSync(
    join(realpathSync(options.scratchParent), `podium-cache-admission-${options.runId}-`),
  )
  const candidateConfig = join(runRoot, 'global-store.bunfig.toml')
  writeFileSync(candidateConfig, CANDIDATE_BUNFIG)
  const env = runtimeEnv(options.bun, {
    XDG_CACHE_HOME: xdgCacheHome,
    // The cache directory must be the one scripts/typecheck.ts derives, or this lane
    // would prove nothing about how sibling worktrees find each other's results.
    TURBO_CACHE_DIR: undefined,
    // One heavy-test lease is taken around the whole lane by whoever runs it. Letting
    // each probe take its own would queue the lane behind itself, and the lock cannot
    // name a holder from a detached worktree anyway.
    PODIUM_SESSION_ID: undefined,
  })
  const worktrees: string[] = []

  try {
    const hoisted = createWorktree(sourceRoot, runRoot, 'hoisted', commit)
    worktrees.push(hoisted)
    const producer = createWorktree(sourceRoot, runRoot, 'candidate-producer', commit)
    worktrees.push(producer)
    const reader = createWorktree(sourceRoot, runRoot, 'candidate-reader', commit)
    worktrees.push(reader)

    const installs = {
      hoisted: await install(options.bun, hoisted, hoistedCache, env),
      producer: await install(options.bun, producer, globalStore, env, candidateConfig),
      // Independent: its own `bun install`, into the same host store the producer used.
      reader: await install(options.bun, reader, globalStore, env, candidateConfig),
    }
    for (const [name, result] of Object.entries(installs)) {
      if (result.exitCode !== 0) throw new Error(`${name} install failed`)
    }

    const identity = {
      hoisted: await readIdentity(options.bun, hoisted, env),
      producer: await readIdentity(options.bun, producer, env),
      reader: await readIdentity(options.bun, reader, env),
    }

    console.log('[cache-admission] hoisted control warms the shared cache')
    const hoistedTypecheck = probe(await runCommand(typecheckCommand(options.bun), hoisted, env))
    console.log('[cache-admission] candidate must not read the hoisted control cache')
    const candidateTypecheckCold = probe(
      await runCommand(typecheckCommand(options.bun), producer, env),
    )
    const candidateTestCold = probe(
      await runCommand(packageTestCommand(options.bun, options.testPackage), producer, env),
    )

    console.log('[cache-admission] an independently installed candidate reads both')
    const readerTypecheck = probe(await runCommand(typecheckCommand(options.bun), reader, env))
    const readerTest = probe(
      await runCommand(packageTestCommand(options.bun, options.testPackage), reader, env),
    )

    console.log('[cache-admission] one edited source file must be a miss again')
    const sourcePath = workspaceSourceFile(reader, options.testPackage)
    const sourceRelative = relative(reader, sourcePath)
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// POD-2774 cache probe\n`)
    const changedTypecheck = probe(await runCommand(typecheckCommand(options.bun), reader, env))
    const changedTest = probe(
      await runCommand(packageTestCommand(options.bun, options.testPackage), reader, env),
    )
    runSync(['git', 'checkout', '--', sourceRelative], reader)

    console.log('[cache-admission] a dangling third-party link must be refused')
    const modules = join(reader, 'node_modules')
    const broken = breakableEntry(readdirSync(modules))
    if (!broken) throw new Error('found no third-party package to break')
    const brokenPath = join(modules, broken)
    const saved = join(runRoot, `saved-${broken}`)
    renameSync(brokenPath, saved)
    symlinkSync(join('.evaporated', broken), brokenPath)
    const refusal = await runCommand(typecheckCommand(options.bun), reader, env)
    rmSync(brokenPath, { force: true })
    renameSync(saved, brokenPath)
    const restored = probe(await runCommand(typecheckCommand(options.bun), reader, env))

    const report = {
      acceptance: {} as Record<string, boolean>,
      bun: bunVersion,
      brokenEntry: broken,
      candidateConfig: CANDIDATE_BUNFIG,
      commit,
      finishedAt: new Date().toISOString(),
      host: hostname(),
      identity,
      installs,
      paths: { globalStore, hoistedCache, runCache, sourceRoot, xdgCacheHome },
      probes: {
        hoistedTypecheck,
        candidateTypecheckCold,
        candidateTestCold,
        readerTypecheck,
        readerTest,
        changedTypecheck,
        changedTest,
        refusal: probe(refusal),
        restored,
      },
      refusalStderr: refusal.stderrTail.slice(-4000),
      representativePackage: options.testPackage,
      representativeSource: sourceRelative,
      typecheckRedTasks: candidateTypecheckCold.summary?.failed ?? [],
      runId: options.runId,
      startedAt,
    }
    report.acceptance = {
      // One durable cache, shared: every worktree resolves the same directory, and it is
      // not inside any of them.
      sharedCacheIsOneDirectory:
        identity.hoisted.cacheDir === identity.producer.cacheDir &&
        identity.producer.cacheDir === identity.reader.cacheDir &&
        identity.hoisted.cacheDir.startsWith(xdgCacheHome),
      // The POD-2774 hole: identical tracked bunfig, different effective install.
      trackedBunfigIsIdentical: identity.hoisted.bunfigHash === identity.producer.bunfigHash,
      layoutSeparatesCacheIdentity: identity.hoisted.envHash !== identity.producer.envHash,
      independentCandidatesShareIdentity: identity.producer.envHash === identity.reader.envHash,
      installsGreen: Object.values(installs).every(
        (result) => result.exitCode === 0 && result.lockfileBefore === result.lockfileAfter,
      ),
      // The typecheck proofs are counted, not exit-coded. Turbo caches only successful
      // tasks, and three packages are still red under isolated linking (POD-2781), so a
      // green tree is not available to assert on. Whether a cache was read is a question
      // about the counts, and the red task names ride along in the report.
      hoistedProducesCache: isFullMiss(hoistedTypecheck.summary),
      hoistedToCandidateMiss: isFullMiss(candidateTypecheckCold.summary),
      candidateTypecheckHit: reusedEverythingCacheable(
        candidateTypecheckCold.summary,
        readerTypecheck.summary,
      ),
      // The representative test is a green package, so here a hit does mean a green hit.
      candidateTestHit: readerTest.exitCode === 0 && isFullHit(readerTest.summary),
      sourceChangeMiss:
        (changedTypecheck.summary?.cached ?? Number.NaN) <
          (readerTypecheck.summary?.cached ?? -1) &&
        changedTest.exitCode === 0 &&
        isFullMiss(changedTest.summary),
      // Refused, and refused BEFORE turbo: a run that reached turbo prints a summary.
      brokenInstallRefused:
        refusal.exitCode !== 0 &&
        parseTurboSummary(commandOutput(refusal)) === null &&
        /dangling symlink/.test(commandOutput(refusal)) &&
        commandOutput(refusal).includes(broken),
      refusalIsRecoverable: reusedEverythingCacheable(
        candidateTypecheckCold.summary,
        restored.summary,
      ),
      // Proving reuse cost one package task, not a suite.
      noFullSuiteRequired:
        candidateTestCold.summary?.total === 1 &&
        readerTest.summary?.total === 1 &&
        changedTest.summary?.total === 1,
    }
    const red = candidateTypecheckCold.summary?.failed ?? []
    if (red.length > 0) {
      console.log(
        `[cache-admission] ${red.length} typecheck task(s) red under isolated linking and so ` +
          `never cacheable, tracked separately: ${red.join(', ')}`,
      )
    }
    mkdirSync(dirname(options.output), { recursive: true })
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[cache-admission] report ${options.output}`)
    const failures = Object.entries(report.acceptance).filter(([, passed]) => !passed)
    if (failures.length > 0) {
      throw new Error(`acceptance failed: ${failures.map(([name]) => name).join(', ')}`)
    }
  } finally {
    for (const path of worktrees.reverse()) removeWorktree(sourceRoot, path)
    rmSync(runRoot, { recursive: true, force: true })
    runSync(['git', 'worktree', 'prune'], sourceRoot)
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[cache-admission] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
