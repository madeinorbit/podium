/**
 * Global-store cache admission evidence (POD-2774).
 *
 * The Stage 1 canary shows that a global-store worktree installs, resolves, and builds.
 * It does not show that the results such a worktree caches may be handed to the NEXT
 * worktree — which is the whole reason the fleet would adopt the layout. This lane
 * answers that separately, and cheaply enough to re-run per host before rollout.
 *
 * It creates three detached worktrees of one commit: a hoisted control and two candidates
 * installed INDEPENDENTLY through the exact production snapshot command
 * (`--frozen-lockfile --offline --ignore-scripts`) and tracked isolated configuration.
 * All three share one Turbo cache, chosen by scripts/typecheck.ts from the common git
 * directory — the lane only points XDG_CACHE_HOME at its own run directory so the
 * evidence starts cold and never touches the operator's cache. Then it proves, in order:
 *
 *   1. the three worktrees agree on one cache directory (sharing is real, not assumed);
 *   2. hoisted and candidate have DIFFERENT PODIUM_CHECK_ENV_HASH values while their
 *      tracked bunfig.toml files are byte-identical — the hole POD-2774 closes;
 *   3. independently installed candidates keep one identity and identical web/mobile
 *      dry hashes, while the report preserves each naturally materialized nested set;
 *   4. source, manifest, lockfile, package-link, linker, and root/workspace `.bin`
 *      mutations still move the client hashes;
 *   5. client task command lookup uses root/workspace `.bin`, never a normalized context;
 *   6. a hoisted-warmed cache is a full MISS for a candidate;
 *   7. an independent candidate replays every cacheable typecheck task and fully hits
 *      one representative package test;
 *   8. editing one source file is a MISS again, so the hit was not indiscriminate;
 *   9. dangling third-party/nested links and wrong-target normalized shims are REFUSED
 *      before Turbo runs at all.
 *
 * The test proofs run a single package task. Proving reuse must not cost a full suite,
 * and the report records the task count that shows it did not.
 *
 * The whole lane runs under ONE heavy-test lease, taken by the public
 * `deps:global-store-cache-admission` script rather than by any probe. Running this file
 * directly is REFUSED rather than silently unadmitted — see `unleasedRefusal`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, delimiter, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type CommandResult,
  type InstallResult,
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
import { readInstallTopology } from './install-topology'
import {
  isFullHit,
  isFullMiss,
  parseTurboSummary,
  reusedEverythingCacheable,
  type TurboSummary,
} from './turbo-summary'
import { VALIDATION_HELD_ENV } from './validation-admission'
import { workspaceDirectories } from './workspace-resolution-census'

const REQUIRED_BUN = '1.3.14'
const EXPECTED_TYPECHECK_TASKS = 24
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
  layoutRecords: number
}

const CLIENT_BUILD_TASKS = ['@podium/web#build', '@podium/mobile#build'] as const
type ClientBuildTask = (typeof CLIENT_BUILD_TASKS)[number]

interface ClientBuildDry {
  commands: Record<ClientBuildTask, string>
  hashes: Record<ClientBuildTask, string>
}

interface ClientCommandAudit {
  commands: Record<'mobile' | 'turbo' | 'web', string>
  paths: Record<'mobile' | 'web', string[]>
}

interface NestedShim {
  path: string
  relativePath: string
  linkText: string
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

/**
 * This lane may not run unless something outside it is already holding `test:heavy`.
 *
 * It installs three worktrees and runs several cold full-graph typechecks and package
 * suites, so an unadmitted run is a real load on a shared host — and it is exactly the
 * run that is easiest to start by accident, because `bun scripts/global-store-cache-
 * admission.ts` is the obvious thing to type and looks identical to the safe path from
 * the outside. The public `deps:global-store-cache-admission` script routes through
 * `scripts/validation-admission.ts heavy`, which takes the lease and marks the child
 * environment; entering without that mark means nothing took it.
 *
 * The lane deliberately cannot mark itself. A self-set marker is not evidence of a
 * lease, it is a forgery of one — and it would be a worse outcome than no check at all,
 * because every later probe and every reader of the environment would then see an
 * unleased run wearing an admitted run's badge.
 *
 * The named escape is for the case validation-admission itself supports: an operator
 * holding `test:heavy` manually across several commands. That is a deliberate outer
 * scope stated out loud, not the accident this guard exists for.
 */
export function unleasedRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env[VALIDATION_HELD_ENV] === 'heavy') return null
  return (
    'refusing to run outside a heavy-test lease: this lane installs three worktrees and ' +
    'runs several cold full-graph typechecks, and nothing is holding test:heavy. Use ' +
    '`bun run deps:global-store-cache-admission -- ...`, which leases the whole lane. If ' +
    `you are already holding test:heavy yourself, say so with ${VALIDATION_HELD_ENV}=heavy.`
  )
}

/**
 * The environment every probe runs under.
 *
 * The heavy-test lease is taken ONCE, around the whole lane, and no probe may take a
 * second one — a probe that queued for it would queue behind the lane's own holder and
 * never start. `PODIUM_SESSION_ID` is unset because the probes run in DETACHED
 * worktrees, where `podium lock` cannot resolve a repository to name a holder in, so an
 * inner acquire would fail rather than wait.
 *
 * The held marker is INHERITED, never minted here: `unleasedRefusal` has already
 * established that the environment carries it, and `runtimeEnv` copies it through. Do
 * not set it in this function. Writing it here would make the lane able to manufacture
 * the proof it is checked against, which is the whole reason the check is at the entry
 * point and not in this file's own environment. Turbo carries the marker as a
 * pass-through variable rather than a global one, so forwarding it reaches the tasks
 * without entering any cache key.
 */
export function probeEnv(bun: string, xdgCacheHome: string): NodeJS.ProcessEnv {
  return runtimeEnv(bun, {
    XDG_CACHE_HOME: xdgCacheHome,
    // The cache directory must be the one scripts/typecheck.ts derives, or this lane
    // would prove nothing about how sibling worktrees find each other's results.
    TURBO_CACHE_DIR: undefined,
    PODIUM_SESSION_ID: undefined,
  })
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
    ' cacheDir: t.sharedTurboCacheDir(process.cwd()), admissionErrors: c.admissionErrors,' +
    ' layoutRecords: c.install.layout.length }))'
  const result = await runCommand([bun, '-e', script], root, env, 5 * 60_000)
  if (result.exitCode !== 0) {
    throw new Error(`could not read the cache identity of ${basename(root)}: ${result.stderrTail}`)
  }
  return {
    ...(JSON.parse(result.stdoutTail) as Omit<WorktreeIdentity, 'bunfigHash'>),
    bunfigHash: sha256File(join(root, 'bunfig.toml')),
  }
}

async function productionSnapshotInstall(
  bun: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<InstallResult> {
  const lockfile = join(root, 'bun.lock')
  const lockfileBefore = sha256File(lockfile)
  // Exact default path in withDevBuildSnapshot: no external config and no alternate
  // linker flags. This is the install whose repeated identity release builds depend on.
  const result = await runCommand(
    [bun, 'install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
    root,
    env,
  )
  return { ...result, lockfileBefore, lockfileAfter: sha256File(lockfile) }
}

function spawnText(
  command: string[],
  root: string,
  env: NodeJS.ProcessEnv,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

function clientBuildDry(
  root: string,
  identity: WorktreeIdentity,
  env: NodeJS.ProcessEnv,
): ClientBuildDry {
  const result = spawnText(
    [
      join(root, 'node_modules/.bin/turbo'),
      'run',
      'build',
      '--filter=@podium/web',
      '--filter=@podium/mobile',
      '--concurrency=1',
      '--dry=json',
    ],
    root,
    {
      ...env,
      PODIUM_CHECK_ENV_HASH: identity.envHash,
      TURBO_CACHE_DIR: identity.cacheDir,
      TURBO_FORCE: undefined,
    },
  )
  if (result.exitCode !== 0) throw new Error(`client build dry run failed: ${result.stderr}`)
  const dry = JSON.parse(result.stdout) as {
    tasks?: Array<{ taskId?: string; hash?: string; command?: string }>
  }
  const hashes = {} as ClientBuildDry['hashes']
  const commands = {} as ClientBuildDry['commands']
  for (const task of CLIENT_BUILD_TASKS) {
    const found = dry.tasks?.find(({ taskId }) => taskId === task)
    if (!found?.hash || !found.command) throw new Error(`client dry run omitted ${task}`)
    hashes[task] = found.hash
    commands[task] = found.command
  }
  return { commands, hashes }
}

async function fileMutationDry(
  root: string,
  bun: string,
  env: NodeJS.ProcessEnv,
  path: string,
  suffix: string,
): Promise<{ dry: ClientBuildDry; identity: WorktreeIdentity }> {
  const original = readFileSync(path)
  writeFileSync(path, Buffer.concat([original, Buffer.from(suffix)]))
  try {
    const identity = await readIdentity(bun, root, env)
    return { dry: clientBuildDry(root, identity, env), identity }
  } finally {
    writeFileSync(path, original)
  }
}

async function replacedSymlinkDry(
  root: string,
  bun: string,
  env: NodeJS.ProcessEnv,
  path: string,
  replacement: string,
): Promise<{ dry: ClientBuildDry; identity: WorktreeIdentity }> {
  const original = readlinkSync(path)
  rmSync(path)
  symlinkSync(replacement, path, 'dir')
  try {
    const identity = await readIdentity(bun, root, env)
    return { dry: clientBuildDry(root, identity, env), identity }
  } finally {
    rmSync(path)
    symlinkSync(original, path, 'dir')
  }
}

async function addedSymlinkDry(
  root: string,
  bun: string,
  env: NodeJS.ProcessEnv,
  path: string,
  target: string,
): Promise<{ dry: ClientBuildDry; identity: WorktreeIdentity }> {
  symlinkSync(target, path)
  try {
    const identity = await readIdentity(bun, root, env)
    return { dry: clientBuildDry(root, identity, env), identity }
  } finally {
    rmSync(path)
  }
}

function hashesDiffer(
  left: ClientBuildDry,
  right: ClientBuildDry,
  tasks: readonly ClientBuildTask[] = CLIENT_BUILD_TASKS,
): boolean {
  return tasks.every((task) => left.hashes[task] !== right.hashes[task])
}

function refusedBeforeTurbo(result: CommandResult, sentence: RegExp): boolean {
  const output = commandOutput(result)
  return result.exitCode !== 0 && parseTurboSummary(output) === null && sentence.test(output)
}

function findNormalizedNestedShim(root: string): NestedShim {
  const layout = readInstallTopology(root).layout
  const store = join(root, 'node_modules/.bun')
  for (const context of readdirSync(store).sort()) {
    if (!/\+[0-9a-f]{16}$/.test(context)) continue
    const bin = join(store, context, 'node_modules/.bin')
    if (!existsSync(bin)) continue
    for (const command of readdirSync(bin).sort()) {
      const path = join(bin, command)
      if (!lstatSync(path).isSymbolicLink()) continue
      const record = `node_modules/.bun/${context}/node_modules\t.bin/${command}\tl\t`
      if (layout.some((entry) => entry.startsWith(record))) continue
      const stat = statSync(path)
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue
      const relativePath = relative(root, path)
      return { path, relativePath, linkText: readlinkSync(path) }
    }
  }
  throw new Error('found no package-metadata-validated nested executable shim')
}

function peerNestedShimSet(root: string): string[] {
  const result: string[] = []
  const store = join(root, 'node_modules/.bun')
  for (const context of readdirSync(store).sort()) {
    if (!/\+[0-9a-f]{16}$/.test(context)) continue
    const bin = join(store, context, 'node_modules/.bin')
    if (!existsSync(bin)) continue
    for (const command of readdirSync(bin).sort()) {
      const path = join(bin, command)
      if (lstatSync(path).isSymbolicLink()) result.push(relative(root, path))
    }
  }
  return result.sort()
}

function packageScriptPath(
  bun: string,
  root: string,
  workspace: 'apps/mobile' | 'apps/web',
  command: string,
  env: NodeJS.ProcessEnv,
): { entries: string[]; resolved: string } {
  const result = spawnText([bun, 'run', '--cwd', workspace, 'env'], root, env)
  if (result.exitCode !== 0) throw new Error(`${workspace} environment failed: ${result.stderr}`)
  const path = result.stdout.match(/^PATH=(.*)$/m)?.[1]
  if (!path) throw new Error(`${workspace} environment omitted PATH`)
  const entries = path.split(delimiter)
  const resolved = entries.map((entry) => join(entry, command)).find(existsSync)
  if (!resolved) throw new Error(`${workspace} cannot resolve ${command}`)
  return { entries, resolved }
}

function clientCommandAudit(bun: string, root: string, env: NodeJS.ProcessEnv): ClientCommandAudit {
  const web = packageScriptPath(bun, root, 'apps/web', 'vite', env)
  const mobile = packageScriptPath(bun, root, 'apps/mobile', 'expo', env)
  return {
    commands: {
      turbo: join(root, 'node_modules/.bin/turbo'),
      web: web.resolved,
      mobile: mobile.resolved,
    },
    paths: { web: web.entries, mobile: mobile.entries },
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

/** Pick a deterministic third-party package that `bun run typecheck` does not itself need. */
export function breakableEntry(entries: string[]): string | null {
  const eligible = entries
    .filter((name) => !name.startsWith('@') && !name.startsWith('.') && !LOAD_BEARING.has(name))
    .sort()
  return eligible[0] ?? null
}

async function main(): Promise<void> {
  // First, before argv, before git, and long before anything is installed: an unleased
  // run must not get as far as doing work it would then have to be stopped in the
  // middle of.
  const refusal = unleasedRefusal(process.env)
  if (refusal) throw new Error(refusal)
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
  // One XDG root for every probe: scripts/typecheck.ts derives the durable Turbo cache
  // from the common git directory beneath it, so the three worktrees share one cache
  // without being told to, and the operator's own cache is neither read nor written.
  const xdgCacheHome = join(runCache, 'xdg')
  for (const path of [hoistedCache, xdgCacheHome]) mkdirSync(path, { recursive: true })
  const runRoot = mkdtempSync(
    join(realpathSync(options.scratchParent), `podium-cache-admission-${options.runId}-`),
  )
  const env = probeEnv(options.bun, xdgCacheHome)
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
      producer: await productionSnapshotInstall(options.bun, producer, env),
      // Independent, exact production snapshot command against the same configured store.
      reader: await productionSnapshotInstall(options.bun, reader, env),
    }
    for (const [name, result] of Object.entries(installs)) {
      if (result.exitCode !== 0) throw new Error(`${name} install failed`)
    }

    // Record what the two exact production installs naturally materialized. The lane is
    // read-only with respect to Bun's store; the hermetic unit fixture supplies the
    // guaranteed add/remove discriminator for a validated nested shim.
    const productionNestedShimSets = {
      producer: peerNestedShimSet(producer),
      reader: peerNestedShimSet(reader),
    }

    const identity = {
      hoisted: await readIdentity(options.bun, hoisted, env),
      producer: await readIdentity(options.bun, producer, env),
      reader: await readIdentity(options.bun, reader, env),
    }
    const clientDry = {
      producer: clientBuildDry(producer, identity.producer, env),
      reader: clientBuildDry(reader, identity.reader, env),
    }
    const clientCommands = clientCommandAudit(options.bun, reader, env)

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

    console.log('[cache-admission] client dry hashes discriminate every retained input class')
    const dryMutations = {
      source: await fileMutationDry(
        reader,
        options.bun,
        env,
        join(reader, 'apps/web/src/app/main.tsx'),
        '\n// cache identity source probe\n',
      ),
      packageManifest: await fileMutationDry(
        reader,
        options.bun,
        env,
        join(reader, 'apps/web/package.json'),
        '\n ',
      ),
      lockfile: await fileMutationDry(reader, options.bun, env, join(reader, 'bun.lock'), '\n'),
      linkerConfig: await fileMutationDry(
        reader,
        options.bun,
        env,
        join(reader, 'bunfig.toml'),
        '\n# cache identity linker probe\n',
      ),
      packageLink: await replacedSymlinkDry(
        reader,
        options.bun,
        env,
        join(reader, 'apps/web/node_modules/@podium/model'),
        realpathSync(join(reader, 'apps/web/node_modules/@podium/model')),
      ),
      rootBin: await addedSymlinkDry(
        reader,
        options.bun,
        env,
        join(reader, 'node_modules/.bin/podium-census-root-probe'),
        realpathSync(join(reader, 'node_modules/.bin/turbo')),
      ),
      workspaceBin: await addedSymlinkDry(
        reader,
        options.bun,
        env,
        join(reader, 'apps/web/node_modules/.bin/podium-census-web-probe'),
        realpathSync(join(reader, 'apps/web/node_modules/.bin/vite')),
      ),
    }

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

    console.log('[cache-admission] nested normalized shims still fail closed')
    const normalizedReaderShim = findNormalizedNestedShim(reader)
    rmSync(normalizedReaderShim.path)
    symlinkSync(`.evaporated-${basename(normalizedReaderShim.path)}`, normalizedReaderShim.path)
    const nestedDanglingRefusal = await runCommand(typecheckCommand(options.bun), reader, env)
    rmSync(normalizedReaderShim.path)
    symlinkSync(realpathSync(join(reader, 'node_modules/.bin/turbo')), normalizedReaderShim.path)
    const nestedWrongTargetRefusal = await runCommand(typecheckCommand(options.bun), reader, env)
    rmSync(normalizedReaderShim.path)
    symlinkSync(normalizedReaderShim.linkText, normalizedReaderShim.path)
    const nestedRestoredIdentity = await readIdentity(options.bun, reader, env)

    const report = {
      acceptance: {} as Record<string, boolean>,
      bun: bunVersion,
      brokenEntry: broken,
      clientCommands,
      clientDry,
      commit,
      dryMutations,
      finishedAt: new Date().toISOString(),
      host: hostname(),
      identity,
      productionNestedShimSets,
      installs,
      normalizedRefusalShim: normalizedReaderShim,
      paths: { hoistedCache, runCache, sourceRoot, xdgCacheHome },
      probes: {
        hoistedTypecheck,
        candidateTypecheckCold,
        candidateTestCold,
        readerTypecheck,
        readerTest,
        changedTypecheck,
        changedTest,
        refusal: probe(refusal),
        nestedDanglingRefusal: probe(nestedDanglingRefusal),
        nestedWrongTargetRefusal: probe(nestedWrongTargetRefusal),
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
      independentClientDryHashesMatch: CLIENT_BUILD_TASKS.every(
        (task) => clientDry.producer.hashes[task] === clientDry.reader.hashes[task],
      ),
      productionSnapshotInstallIsExact: (['producer', 'reader'] as const).every(
        (name) =>
          JSON.stringify(installs[name].command) ===
          JSON.stringify([
            options.bun,
            'install',
            '--frozen-lockfile',
            '--offline',
            '--ignore-scripts',
          ]),
      ),
      sourceInvalidatesWebBuild: hashesDiffer(clientDry.reader, dryMutations.source.dry, [
        '@podium/web#build',
      ]),
      packageManifestInvalidatesWebBuild: hashesDiffer(
        clientDry.reader,
        dryMutations.packageManifest.dry,
        ['@podium/web#build'],
      ),
      lockfileInvalidatesClientBuilds: hashesDiffer(clientDry.reader, dryMutations.lockfile.dry),
      linkerConfigInvalidatesClientBuilds:
        dryMutations.linkerConfig.identity.envHash !== identity.reader.envHash &&
        hashesDiffer(clientDry.reader, dryMutations.linkerConfig.dry),
      packageLinkInvalidatesClientBuilds:
        dryMutations.packageLink.identity.admissionErrors.length === 0 &&
        dryMutations.packageLink.identity.envHash !== identity.reader.envHash &&
        hashesDiffer(clientDry.reader, dryMutations.packageLink.dry),
      rootBinInvalidatesClientBuilds:
        dryMutations.rootBin.identity.admissionErrors.length === 0 &&
        dryMutations.rootBin.identity.envHash !== identity.reader.envHash &&
        hashesDiffer(clientDry.reader, dryMutations.rootBin.dry),
      workspaceBinInvalidatesClientBuilds:
        dryMutations.workspaceBin.identity.admissionErrors.length === 0 &&
        dryMutations.workspaceBin.identity.envHash !== identity.reader.envHash &&
        hashesDiffer(clientDry.reader, dryMutations.workspaceBin.dry),
      clientCommandsAvoidNestedShims:
        clientCommands.commands.turbo === join(reader, 'node_modules/.bin/turbo') &&
        clientCommands.commands.web === join(reader, 'apps/web/node_modules/.bin/vite') &&
        clientCommands.commands.mobile === join(reader, 'apps/mobile/node_modules/.bin/expo') &&
        [...clientCommands.paths.web, ...clientCommands.paths.mobile].every(
          (entry) => !entry.includes(`${join('node_modules', '.bun')}${sep}`),
        ) &&
        clientDry.reader.commands['@podium/web#build'].startsWith('vite build') &&
        clientDry.reader.commands['@podium/mobile#build'].startsWith('expo export'),
      installsGreen: Object.values(installs).every(
        (result) => result.exitCode === 0 && result.lockfileBefore === result.lockfileAfter,
      ),
      // Pin the whole graph even while the known isolated mobile task is red. Cache
      // reuse below is measured against the producer's successful (cacheable) tasks.
      isolatedTypecheckGraphComplete:
        candidateTypecheckCold.summary?.total === EXPECTED_TYPECHECK_TASKS &&
        candidateTypecheckCold.summary.successful + candidateTypecheckCold.summary.failed.length ===
          EXPECTED_TYPECHECK_TASKS,
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
      nestedDanglingShimRefused: refusedBeforeTurbo(nestedDanglingRefusal, /dangling symlink/),
      nestedWrongTargetShimRefused: refusedBeforeTurbo(
        nestedWrongTargetRefusal,
        /points to the wrong executable/,
      ),
      nestedShimRefusalIsRecoverable: nestedRestoredIdentity.envHash === identity.reader.envHash,
      refusalRestoresAdmission: restored.summary !== null,
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
