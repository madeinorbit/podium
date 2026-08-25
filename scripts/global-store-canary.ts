/**
 * Opt-in Bun global-store canary.
 *
 * The runner never installs into its source checkout. It creates detached,
 * disposable worktrees, uses run-scoped durable caches, and removes only the
 * worktrees it created. The repository bunfig.toml remains untouched.
 */

import { createHash } from 'node:crypto'
import {
  type BigIntStats,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFullHit, isFullMiss, parseTurboSummary } from './turbo-summary'

const REQUIRED_BUN = '1.3.14'
export const CANDIDATE_BUNFIG = `[install]\nexact = false\nlinker = "isolated"\nglobalStore = true\nlinkWorkspacePackages = true\n`
const LOG_TAIL_BYTES = 24_000

export interface CanaryOptions {
  bun: string
  cacheRoot: string
  currentRef: string
  divergentRef: string
  fleetSize: number
  output: string
  runId: string
  scratchParent: string
  sourceRoot: string
}

export interface CommandResult {
  command: string[]
  cwd: string
  durationMs: number
  exitCode: number
  stderrTail: string
  stdoutTail: string
  timedOut: boolean
}

export interface InstallResult extends CommandResult {
  lockfileAfter: string
  lockfileBefore: string
}

export interface PathUsage {
  allocatedBytes: number
  apparentBytes: number
  entries: number
  sharedAllocatedBytes: number
  uniqueAllocatedBytes: number
}

interface Projection {
  cachePhysicalBytes: number
  fleetPhysicalBytes: number
  fleetSize: number
  sharedCacheWorktreeBytes: number
  worktreeExclusiveBytes: number
}

interface StoreState {
  digest: string
  entries: number
  stagingResidue: string[]
}

interface ResolutionResult {
  errors: string[]
  records: string[]
}

interface LocalInstallClasses {
  globalLinks: number
  localEntries: string[]
}

interface CanaryReport {
  acceptance: Record<string, boolean>
  bun: string
  candidate: {
    brokenSymlinks: string[]
    clean: InstallResult
    localInstallClasses: LocalInstallClasses
    lockfileHash: string
    storeAfterInstall: StoreState
    storeAfterWorkflows: StoreState
    usage: { cache: PathUsage; nodeModules: PathUsage; projection: Projection }
    warm: InstallResult
  }
  candidateConfig: string
  commits: {
    current: string
    currentLockfileBlob: string
    divergent: string
    divergentLockfileBlob: string
  }
  concurrency: {
    current: InstallResult
    divergent: InstallResult
    brokenSymlinks: Record<string, string[]>
    store: StoreState
  }
  defaultBunfig: { after: string; before: string; unchanged: boolean }
  finishedAt: string
  host: string
  hoisted: {
    clean: InstallResult
    lockfileHash: string
    usage: { cache: PathUsage; nodeModules: PathUsage; projection: Projection }
    warm: InstallResult
  }
  paths: { cacheRun: string; sourceRoot: string }
  probes: Record<string, CommandResult>
  resolution: { candidate: ResolutionResult; rollback: ResolutionResult }
  rollback: {
    cleanup: CommandResult
    install: InstallResult
    brokenSymlinks: string[]
    storeAfter: StoreState
    storeBefore: StoreState
  }
  runId: string
  startedAt: string
}

type EntryStat = {
  allocated: number
  apparent: number
  dev: bigint
  ino: bigint
  nlink: number
  regularFile: boolean
}

function usage(): never {
  console.error(`usage: bun scripts/global-store-canary.ts \\
  --cache-root <durable-dedicated-dir> \\
  --scratch-parent <existing-dir> \\
  --divergent-ref <commit> \\
  --fleet-size <installed-worktrees> \\
  --run-id <unique-label> \\
  --output <report.json> [--current-ref <commit>] [--bun <path>]`)
  process.exit(2)
}

export function parseCanaryArgs(args: string[], sourceRoot: string): CanaryOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) usage()
    values.set(flag.slice(2), value)
  }
  const required = [
    'cache-root',
    'scratch-parent',
    'divergent-ref',
    'fleet-size',
    'run-id',
    'output',
  ]
  if (required.some((key) => !values.has(key))) usage()
  const fleetSize = Number(values.get('fleet-size'))
  if (!Number.isSafeInteger(fleetSize) || fleetSize < 1)
    throw new Error('--fleet-size must be a positive integer')
  const runId = values.get('run-id') as string
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(runId)) {
    throw new Error('--run-id must be 1-80 portable filename characters')
  }
  const options: CanaryOptions = {
    bun: realpathSync(resolve(values.get('bun') ?? '/home/mgw/.bun/bin/bun')),
    cacheRoot: canonicalizeFuturePath(values.get('cache-root') as string),
    currentRef: values.get('current-ref') ?? 'HEAD',
    divergentRef: values.get('divergent-ref') as string,
    fleetSize,
    output: resolve(values.get('output') as string),
    runId,
    scratchParent: realpathSync(resolve(values.get('scratch-parent') as string)),
    sourceRoot: realpathSync(sourceRoot),
  }
  validateCanaryOptions(options)
  return options
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function canonicalizeFuturePath(path: string): string {
  const existing = existingAncestor(path)
  const suffix: string[] = []
  let cursor = resolve(path)
  while (cursor !== existing) {
    suffix.unshift(basename(cursor))
    cursor = dirname(cursor)
  }
  return join(realpathSync(existing), ...suffix)
}

function existingAncestor(path: string): string {
  let existing = resolve(path)
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  return existing
}

function filesystemDevice(path: string): bigint {
  return statSync(existingAncestor(path), { bigint: true }).dev
}

export function validateStorageDevices(
  cacheRoot: string,
  scratchParent: string,
  deviceOf: (path: string) => bigint = filesystemDevice,
): void {
  if (deviceOf(cacheRoot) !== deviceOf(scratchParent)) {
    throw new Error(
      'dedicated cache and disposable worktrees must share one filesystem for hardlink-valid evidence',
    )
  }
}

export function validateCanaryOptions(options: CanaryOptions): void {
  if (!existsSync(options.bun)) throw new Error(`Bun binary does not exist: ${options.bun}`)
  if (!existsSync(options.scratchParent)) {
    throw new Error(`scratch parent must already exist: ${options.scratchParent}`)
  }
  const sourceRoot = realpathSync(options.sourceRoot)
  const cacheRoot = canonicalizeFuturePath(options.cacheRoot)
  const scratchParent = realpathSync(options.scratchParent)
  const bun = realpathSync(options.bun)
  if (isInside(sourceRoot, cacheRoot)) {
    throw new Error('dedicated cache must be outside the repository checkout')
  }
  if (isInside(sourceRoot, scratchParent)) {
    throw new Error('disposable worktrees must be outside the repository checkout')
  }
  validateStorageDevices(cacheRoot, scratchParent)
  const productionCache = canonicalizeFuturePath(resolve(dirname(dirname(bun)), 'install', 'cache'))
  if (isInside(productionCache, cacheRoot) || isInside(cacheRoot, productionCache)) {
    throw new Error(`refusing production Bun cache path: ${options.cacheRoot}`)
  }
  const runCache = join(cacheRoot, 'runs', options.runId)
  if (existsSync(runCache))
    throw new Error(`run cache already exists; choose a new --run-id: ${runCache}`)
}

function tail(value: string): string {
  return value.length <= LOG_TAIL_BYTES ? value : value.slice(-LOG_TAIL_BYTES)
}

function readPipe(pipe: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (pipe === undefined || typeof pipe === 'number') {
    throw new Error('expected spawned command output to use a readable pipe')
  }
  return new Response(pipe).text()
}

export async function runCommand(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 20 * 60_000,
): Promise<CommandResult> {
  console.log(`[canary] start ${basename(cwd)}: ${command.join(' ')}`)
  const started = performance.now()
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    const result = {
      command,
      cwd,
      durationMs: Math.round(performance.now() - started),
      exitCode: 127,
      stdoutTail: '',
      stderrTail: error instanceof Error ? error.message : String(error),
      timedOut: false,
    }
    console.error(`[canary] FAIL ${basename(cwd)}: ${result.stderrTail}`)
    return result
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readPipe(child.stdout),
    readPipe(child.stderr),
  ])
  clearTimeout(timer)
  const result = {
    command,
    cwd,
    durationMs: Math.round(performance.now() - started),
    exitCode,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    timedOut,
  }
  console.log(
    `[canary] ${exitCode === 0 && !timedOut ? 'pass' : 'FAIL'} ${basename(cwd)} ${result.durationMs}ms`,
  )
  if (exitCode !== 0 || timedOut) {
    console.error(
      result.stderrTail || result.stdoutTail || '[canary] command produced no diagnostic',
    )
  }
  return result
}

export function runSync(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    )
  }
  return new TextDecoder().decode(result.stdout).trim()
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function installCommand(bun: string, cache: string, config?: string): string[] {
  const command = [bun, 'install', '--frozen-lockfile', `--cache-dir=${cache}`]
  if (config) command.push(`--config=${config}`, '--linker=isolated')
  else command.push('--linker=hoisted')
  return command
}

export async function install(
  bun: string,
  cwd: string,
  cache: string,
  env: NodeJS.ProcessEnv,
  config?: string,
): Promise<InstallResult> {
  const lockfile = join(cwd, 'bun.lock')
  const lockfileBefore = sha256File(lockfile)
  const command = installCommand(bun, cache, config)
  const result = await runCommand(command, cwd, env)
  return { ...result, lockfileBefore, lockfileAfter: sha256File(lockfile) }
}

function walkEntries(root: string, visitor: (path: string, stat: BigIntStats) => void): void {
  if (!existsSync(root)) return
  const visit = (path: string) => {
    const stat = lstatSync(path, { bigint: true })
    visitor(path, stat)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    for (const entry of readdirSync(path)) visit(join(path, entry))
  }
  visit(root)
}

function entryStat(stat: BigIntStats): EntryStat {
  return {
    allocated: Number(stat.blocks) * 512,
    apparent: Number(stat.size),
    dev: stat.dev,
    ino: stat.ino,
    nlink: Number(stat.nlink),
    regularFile: stat.isFile(),
  }
}

function inodeKey(stat: Pick<EntryStat, 'dev' | 'ino'>): string {
  return `${stat.dev}:${stat.ino}`
}

function measurePathsUsage(roots: string[]): PathUsage {
  const result: PathUsage = {
    allocatedBytes: 0,
    apparentBytes: 0,
    entries: 0,
    sharedAllocatedBytes: 0,
    uniqueAllocatedBytes: 0,
  }
  const allocatedInodes = new Set<string>()
  for (const root of roots) {
    walkEntries(root, (_path, raw) => {
      const stat = entryStat(raw)
      result.entries += 1
      result.apparentBytes += stat.apparent
      const key = inodeKey(stat)
      if (allocatedInodes.has(key)) return
      allocatedInodes.add(key)
      result.allocatedBytes += stat.allocated
      if (stat.regularFile && stat.nlink > 1) result.sharedAllocatedBytes += stat.allocated
      else result.uniqueAllocatedBytes += stat.allocated
    })
  }
  return result
}

export function measurePathUsage(root: string): PathUsage {
  return measurePathsUsage([root])
}

function workspaceInstallRoots(root: string): string[] {
  const roots: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.name === 'node_modules' && entry.isDirectory()) {
        roots.push(path)
      } else if (entry.isDirectory()) {
        visit(path)
      }
    }
  }
  visit(root)
  return roots.sort()
}

export function projectFleetUsage(
  cache: string,
  nodeModules: string | string[],
  fleetSize: number,
): Projection {
  const cacheInodes = new Map<string, number>()
  walkEntries(cache, (_path, raw) => {
    const stat = entryStat(raw)
    cacheInodes.set(inodeKey(stat), stat.allocated)
  })
  const worktreeInodes = new Map<string, number>()
  for (const root of typeof nodeModules === 'string' ? [nodeModules] : nodeModules) {
    walkEntries(root, (_path, raw) => {
      const stat = entryStat(raw)
      worktreeInodes.set(inodeKey(stat), stat.allocated)
    })
  }
  const cachePhysicalBytes = [...cacheInodes.values()].reduce((sum, value) => sum + value, 0)
  let sharedCacheWorktreeBytes = 0
  let worktreeExclusiveBytes = 0
  for (const [key, bytes] of worktreeInodes) {
    if (cacheInodes.has(key)) sharedCacheWorktreeBytes += bytes
    else worktreeExclusiveBytes += bytes
  }
  return {
    cachePhysicalBytes,
    fleetPhysicalBytes: cachePhysicalBytes + worktreeExclusiveBytes * fleetSize,
    fleetSize,
    sharedCacheWorktreeBytes,
    worktreeExclusiveBytes,
  }
}

export function metadataDigest(root: string): StoreState {
  const rows: string[] = []
  const stagingResidue: string[] = []
  walkEntries(root, (path, stat) => {
    const rel = relative(root, path).split(sep).join('/') || '.'
    const type = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : 'o'
    const link = stat.isSymbolicLink() ? readlinkSync(path) : ''
    rows.push(`${rel}\0${type}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${link}`)
    if (stat.isDirectory() && /^(\.tmp|\.staging|staging)([-.]|$)/i.test(basename(path))) {
      stagingResidue.push(rel)
    }
  })
  rows.sort()
  return {
    digest: createHash('sha256').update(rows.join('\n')).digest('hex'),
    entries: rows.length,
    stagingResidue: stagingResidue.sort(),
  }
}

export function brokenSymlinks(root: string): string[] {
  const broken: string[] = []
  walkEntries(root, (path, stat) => {
    if (!stat.isSymbolicLink()) return
    try {
      statSync(path)
    } catch {
      broken.push(relative(root, path).split(sep).join('/'))
    }
  })
  return broken.sort()
}

function localInstallClasses(root: string, cache: string): LocalInstallClasses {
  const localEntries: string[] = []
  let globalLinks = 0
  walkEntries(join(root, 'node_modules'), (path, stat) => {
    if (!stat.isSymbolicLink()) return
    let target: string
    try {
      target = realpathSync(path)
    } catch {
      return
    }
    if (isInside(cache, target)) globalLinks += 1
  })
  const visit = (directory: string) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.name === '.git') continue
      if (entry.name === '.bun' && entry.isDirectory()) {
        for (const child of readdirSync(path, { withFileTypes: true })) {
          if (child.isDirectory())
            localEntries.push(relative(root, join(path, child.name)).split(sep).join('/'))
        }
        continue
      }
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return { globalLinks, localEntries: localEntries.sort() }
}

async function readResolution(
  bun: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<ResolutionResult> {
  const command = [
    bun,
    '--conditions=@podium/source',
    'scripts/workspace-resolution-census.ts',
    '--worker',
    root,
  ]
  console.log(`[canary] start ${basename(root)}: workspace resolution census`)
  const result = Bun.spawnSync(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  if (result.exitCode !== 0) return { records: [], errors: [stderr || stdout] }
  try {
    return JSON.parse(stdout) as ResolutionResult
  } catch (error) {
    return { records: [], errors: [`could not decode resolution census: ${String(error)}`] }
  }
}

export function createWorktree(
  sourceRoot: string,
  runRoot: string,
  name: string,
  commit: string,
): string {
  const path = join(runRoot, name)
  runSync(['git', 'worktree', 'add', '--detach', path, commit], sourceRoot)
  return path
}

export function removeWorktree(sourceRoot: string, path: string): void {
  const result = Bun.spawnSync(['git', 'worktree', 'remove', '--force', path], {
    cwd: sourceRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    console.error(
      `[canary] could not remove ${path}: ${new TextDecoder().decode(result.stderr).trim()}`,
    )
  }
}

export function runtimeEnv(
  bun: string,
  extra: NodeJS.ProcessEnv = {},
  cargoBin = join(homedir(), '.cargo', 'bin'),
): NodeJS.ProcessEnv {
  const inheritedPath = extra.PATH ?? process.env.PATH ?? ''
  const path = [dirname(bun)]
  if (existsSync(join(cargoBin, 'cargo')) && !inheritedPath.split(':').includes(cargoBin)) {
    path.push(cargoBin)
  }
  if (inheritedPath) path.push(inheritedPath)
  return {
    ...process.env,
    ...extra,
    PATH: path.join(':'),
  }
}

function allCommandsGreen(probes: Record<string, CommandResult>): boolean {
  return Object.values(probes).every((result) => result.exitCode === 0 && !result.timedOut)
}

/** Combined output: turbo writes its run summary to stdout, its task logs to both. */
export function commandOutput(result: CommandResult): string {
  return `${result.stdoutTail}\n${result.stderrTail}`
}

function turboReused(cold: CommandResult, warm: CommandResult): boolean {
  return (
    cold.exitCode === 0 &&
    warm.exitCode === 0 &&
    isFullMiss(parseTurboSummary(commandOutput(cold))) &&
    isFullHit(parseTurboSummary(commandOutput(warm)))
  )
}

async function main(): Promise<void> {
  const sourceRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
  const options = parseCanaryArgs(process.argv.slice(2), sourceRoot)
  const startedAt = new Date().toISOString()
  const status = runSync(['git', 'status', '--porcelain'], sourceRoot)
  if (status)
    throw new Error('source checkout must be clean before creating disposable canary worktrees')
  const bunVersion = runSync([options.bun, '--version'], sourceRoot)
  if (bunVersion !== REQUIRED_BUN)
    throw new Error(`requires Bun ${REQUIRED_BUN}, found ${bunVersion}`)
  const current = runSync(['git', 'rev-parse', `${options.currentRef}^{commit}`], sourceRoot)
  const divergent = runSync(['git', 'rev-parse', `${options.divergentRef}^{commit}`], sourceRoot)
  const currentLockfileBlob = runSync(['git', 'rev-parse', `${current}:bun.lock`], sourceRoot)
  const divergentLockfileBlob = runSync(['git', 'rev-parse', `${divergent}:bun.lock`], sourceRoot)
  if (currentLockfileBlob === divergentLockfileBlob) {
    throw new Error('--divergent-ref must select a different bun.lock blob')
  }
  const defaultBunfigBefore = sha256File(join(sourceRoot, 'bunfig.toml'))
  const env = runtimeEnv(options.bun)

  const cacheRun = join(options.cacheRoot, 'runs', options.runId)
  const hoistedCache = join(cacheRun, 'hoisted')
  const candidateCache = join(cacheRun, 'global-store')
  const concurrentCache = join(cacheRun, 'concurrent-global-store')
  for (const path of [hoistedCache, candidateCache, concurrentCache])
    mkdirSync(path, { recursive: true })
  const runRoot = mkdtempSync(
    join(realpathSync(options.scratchParent), `podium-global-store-${options.runId}-`),
  )
  const candidateConfig = join(runRoot, 'global-store.bunfig.toml')
  writeFileSync(candidateConfig, CANDIDATE_BUNFIG)
  const worktrees: string[] = []

  try {
    const hoistedRoot = createWorktree(sourceRoot, runRoot, 'hoisted', current)
    worktrees.push(hoistedRoot)
    const candidateRoot = createWorktree(sourceRoot, runRoot, 'candidate', current)
    worktrees.push(candidateRoot)
    const concurrentCurrentRoot = createWorktree(sourceRoot, runRoot, 'concurrent-current', current)
    worktrees.push(concurrentCurrentRoot)
    const concurrentDivergentRoot = createWorktree(
      sourceRoot,
      runRoot,
      'concurrent-divergent',
      divergent,
    )
    worktrees.push(concurrentDivergentRoot)

    const hoistedClean = await install(options.bun, hoistedRoot, hoistedCache, env)
    const hoistedCleanup = await runCommand(
      [options.bun, 'run', 'deps:clean-local-installs'],
      hoistedRoot,
      env,
    )
    if (hoistedCleanup.exitCode !== 0) throw new Error('hoisted warm-reinstall cleanup failed')
    const hoistedWarm = await install(options.bun, hoistedRoot, hoistedCache, env)
    const hoistedInstallRoots = workspaceInstallRoots(hoistedRoot)
    const hoistedUsage = {
      cache: measurePathUsage(hoistedCache),
      nodeModules: measurePathsUsage(hoistedInstallRoots),
      projection: projectFleetUsage(hoistedCache, hoistedInstallRoots, options.fleetSize),
    }

    const candidateClean = await install(
      options.bun,
      candidateRoot,
      candidateCache,
      env,
      candidateConfig,
    )
    const candidateCleanup = await runCommand(
      [options.bun, 'run', 'deps:clean-local-installs'],
      candidateRoot,
      env,
    )
    if (candidateCleanup.exitCode !== 0) throw new Error('candidate warm-reinstall cleanup failed')
    const candidateWarm = await install(
      options.bun,
      candidateRoot,
      candidateCache,
      env,
      candidateConfig,
    )
    const candidateStoreAfterInstall = metadataDigest(candidateCache)
    const candidateInstallRoots = workspaceInstallRoots(candidateRoot)
    const candidateUsage = {
      cache: measurePathUsage(candidateCache),
      nodeModules: measurePathsUsage(candidateInstallRoots),
      projection: projectFleetUsage(candidateCache, candidateInstallRoots, options.fleetSize),
    }
    const candidateResolution = await readResolution(options.bun, candidateRoot, env)
    const localClasses = localInstallClasses(candidateRoot, candidateCache)

    const probes: Record<string, CommandResult> = {}
    const turboCache = join(runRoot, 'turbo')
    probes.turboCold = await runCommand(
      [options.bun, 'run', 'typecheck'],
      candidateRoot,
      runtimeEnv(options.bun, { TURBO_CACHE_DIR: turboCache }),
    )
    probes.turboWarm = await runCommand(
      [options.bun, 'run', 'typecheck'],
      candidateRoot,
      runtimeEnv(options.bun, { TURBO_CACHE_DIR: turboCache }),
    )
    probes.normalTest = await runCommand(
      [options.bun, 'run', 'test'],
      candidateRoot,
      runtimeEnv(options.bun, { TURBO_CACHE_DIR: turboCache }),
    )
    probes.runtimeResolution = await runCommand(
      [
        options.bun,
        '--bun',
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.integration.config.ts',
        '--maxWorkers=1',
        'scripts/runtime-resolution.integration.test.ts',
      ],
      candidateRoot,
      env,
    )
    probes.rootScript = await runCommand([options.bun, 'run', 'systemd:diff'], candidateRoot, env)
    probes.webBuild = await runCommand(
      [options.bun, 'run', '--filter', '@podium/web', 'build'],
      candidateRoot,
      env,
    )
    probes.expoWeb = await runCommand(
      [options.bun, 'run', '--cwd=apps/mobile', 'build:web'],
      candidateRoot,
      env,
      30 * 60_000,
    )
    probes.tauriPreflight = await runCommand(
      [options.bun, 'run', '--cwd=apps/desktop', 'preflight'],
      candidateRoot,
      env,
    )
    probes.tauriInfo = await runCommand(
      [join(candidateRoot, 'apps', 'desktop', 'node_modules', '.bin', 'tauri'), 'info'],
      join(candidateRoot, 'apps', 'desktop'),
      env,
      5 * 60_000,
    )
    const candidateStoreAfterWorkflows = metadataDigest(candidateCache)
    const candidateBroken = brokenSymlinks(candidateRoot)

    const [concurrentCurrent, concurrentDivergent] = await Promise.all([
      install(options.bun, concurrentCurrentRoot, concurrentCache, env, candidateConfig),
      install(options.bun, concurrentDivergentRoot, concurrentCache, env, candidateConfig),
    ])
    const concurrencyBroken = {
      current: brokenSymlinks(concurrentCurrentRoot),
      divergent: brokenSymlinks(concurrentDivergentRoot),
    }
    const concurrentStore = metadataDigest(concurrentCache)

    const rollbackStoreBefore = metadataDigest(candidateCache)
    const rollbackCleanup = await runCommand(
      [options.bun, 'run', 'deps:clean-local-installs'],
      candidateRoot,
      env,
    )
    const rollbackInstall = await install(options.bun, candidateRoot, hoistedCache, env)
    const rollbackResolution = await readResolution(options.bun, candidateRoot, env)
    const rollbackBroken = brokenSymlinks(candidateRoot)
    const rollbackStoreAfter = metadataDigest(candidateCache)

    const defaultBunfigAfter = sha256File(join(sourceRoot, 'bunfig.toml'))
    const report: CanaryReport = {
      acceptance: {},
      bun: bunVersion,
      candidate: {
        brokenSymlinks: candidateBroken,
        clean: candidateClean,
        localInstallClasses: localClasses,
        lockfileHash: candidateWarm.lockfileAfter,
        storeAfterInstall: candidateStoreAfterInstall,
        storeAfterWorkflows: candidateStoreAfterWorkflows,
        usage: candidateUsage,
        warm: candidateWarm,
      },
      candidateConfig: CANDIDATE_BUNFIG,
      commits: { current, currentLockfileBlob, divergent, divergentLockfileBlob },
      concurrency: {
        current: concurrentCurrent,
        divergent: concurrentDivergent,
        brokenSymlinks: concurrencyBroken,
        store: concurrentStore,
      },
      defaultBunfig: {
        after: defaultBunfigAfter,
        before: defaultBunfigBefore,
        unchanged: defaultBunfigAfter === defaultBunfigBefore,
      },
      finishedAt: new Date().toISOString(),
      host: hostname(),
      hoisted: {
        clean: hoistedClean,
        lockfileHash: hoistedWarm.lockfileAfter,
        usage: hoistedUsage,
        warm: hoistedWarm,
      },
      paths: { cacheRun, sourceRoot },
      probes,
      resolution: { candidate: candidateResolution, rollback: rollbackResolution },
      rollback: {
        cleanup: rollbackCleanup,
        install: rollbackInstall,
        brokenSymlinks: rollbackBroken,
        storeAfter: rollbackStoreAfter,
        storeBefore: rollbackStoreBefore,
      },
      runId: options.runId,
      startedAt,
    }
    report.acceptance = {
      bunPinned: bunVersion === REQUIRED_BUN,
      candidateLinksHealthy: candidateBroken.length === 0,
      candidateInstallsGreen:
        candidateClean.exitCode === 0 &&
        candidateWarm.exitCode === 0 &&
        candidateClean.lockfileBefore === candidateClean.lockfileAfter &&
        candidateWarm.lockfileBefore === candidateWarm.lockfileAfter,
      concurrencySafe:
        concurrentCurrent.exitCode === 0 &&
        concurrentDivergent.exitCode === 0 &&
        concurrentCurrent.lockfileBefore === concurrentCurrent.lockfileAfter &&
        concurrentDivergent.lockfileBefore === concurrentDivergent.lockfileAfter &&
        concurrencyBroken.current.length === 0 &&
        concurrencyBroken.divergent.length === 0 &&
        concurrentCurrent.lockfileBefore !== concurrentDivergent.lockfileBefore &&
        concurrentStore.stagingResidue.length === 0,
      defaultUnchanged: report.defaultBunfig.unchanged,
      fleetPhysicalWin:
        candidateUsage.projection.fleetPhysicalBytes < hoistedUsage.projection.fleetPhysicalBytes,
      hoistedInstallsGreen:
        hoistedClean.exitCode === 0 &&
        hoistedWarm.exitCode === 0 &&
        hoistedClean.lockfileBefore === hoistedClean.lockfileAfter &&
        hoistedWarm.lockfileBefore === hoistedWarm.lockfileAfter &&
        hoistedClean.lockfileBefore === hoistedWarm.lockfileBefore,
      probesGreen: allCommandsGreen(probes),
      resolutionLocal:
        candidateResolution.errors.length === 0 && candidateResolution.records.length > 0,
      rollbackGreen:
        rollbackCleanup.exitCode === 0 &&
        rollbackInstall.exitCode === 0 &&
        rollbackInstall.lockfileBefore === rollbackInstall.lockfileAfter &&
        rollbackResolution.errors.length === 0 &&
        rollbackBroken.length === 0 &&
        rollbackStoreBefore.digest === rollbackStoreAfter.digest,
      storeReadOnly:
        candidateStoreAfterInstall.digest === candidateStoreAfterWorkflows.digest &&
        candidateStoreAfterWorkflows.stagingResidue.length === 0,
      turboColdWarmReuse: turboReused(probes.turboCold, probes.turboWarm),
      warmWithinBaseline: candidateWarm.durationMs <= Math.round(hoistedWarm.durationMs * 1.2),
    }
    mkdirSync(dirname(options.output), { recursive: true })
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`)
    const failures = Object.entries(report.acceptance).filter(([, passed]) => !passed)
    console.log(`[canary] report ${options.output}`)
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
    console.error(`[canary] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
