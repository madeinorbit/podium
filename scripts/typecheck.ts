/**
 * Cached-by-default typecheck entry point (POD-1378). `bun run typecheck` lands here.
 *
 * Turbo's cache key covers tracked file content (`$TURBO_DEFAULT$`, bun.lock,
 * tooling/tsconfig) but is blind to the install environment: bunfig.toml and the
 * node_modules layout are never hashed, so a linker flip or a broken install keeps
 * reporting a stale green. This wrapper closes that hole and makes uncached
 * runs deliberate:
 *
 *   1. Resolves every declared workspace edge and every exercised @podium subpath
 *      from its owning workspace, and walks the linked tree for third-party
 *      breakage the workspace census cannot see. Missing, dangling, undeclared, or
 *      external resolutions are refused regardless of the installer's linker topology.
 *   2. Fingerprints the environment (the effective install configuration and the
 *      topology it produced, plus the resolution census) into PODIUM_CHECK_ENV_HASH,
 *      declared in turbo.json `globalEnv`, so any environment drift is an automatic
 *      cache MISS — no --force needed. Fingerprinting the tracked bunfig.toml alone
 *      was not enough: an install driven by an external `--config` leaves that file
 *      untouched, so hoisted and global-store layouts shared one identity (POD-2774).
 *   3. Refuses --force / TURBO_FORCE unless an explicit reason is given via
 *      --uncached-because="<reason>". A forced 22-package run costs ~3m of CPU
 *      (110x the cached 2s) on a host shared with a live Podium instance.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { arch, cpus, freemem, homedir, platform, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type InstallTopology, readInstallTopology } from './install-topology'
import { readWorkspaceResolutionCensus } from './workspace-resolution-census'

export interface ForceDecision {
  forceRequested: boolean
  reason: string | null
  /** args to forward to turbo (reason flag stripped, --force re-added iff allowed) */
  forwardArgs: string[]
  error: string | null
}

const REFUSAL = `\
uncached typecheck refused.

A forced run recomputes every package (24 of them; ~3m14s of CPU when that was
last measured at 22) instead of reusing the cache (~2s) on a host shared with a
live Podium instance.

WHAT THE KEY COVERS: each package's own tracked files; the task hashes of the
packages it depends on; bun.lock and tooling/tsconfig; the effective install
configuration, install topology, and workspace resolution census (via
PODIUM_CHECK_ENV_HASH), so installs, linker changes and base swaps are noticed
automatically; and, for packages that import sources outside their own directory
by relative path, those directories as explicit turbo inputs.

WHAT IT STILL CANNOT SEE (POD-2807). That last clause is hand-maintained in
turbo.json, and the guard that keeps it honest — "keeps every typecheck cache
key over the sources that task actually reads", in scripts/test-configuration.test.ts
— runs under 'bun run test', not here. It reads relative imports statically, so
a package that escapes its directory some other way (a tsconfig "paths" alias, an
"include" glob pointing outside, a computed specifier) is still invisible to it.
This refusal used to claim the key covered source files full stop; it did not,
and a red sat behind a replayed green for three days on the strength of that
sentence. Treat the list above as the limit of what is checked, not as proof
that nothing is missing.

If you still believe the cache is wrong, state why:

  bun run typecheck -- --uncached-because="<what the cache is missing>"

and consider filing the reason as an issue — a real gap in the cache key should
be closed there, not worked around with --force forever.`

/** Pure decision: does this invocation get to skip the cache? */
export function decideForce(
  args: string[],
  env: Record<string, string | undefined>,
): ForceDecision {
  const forward: string[] = []
  let reason: string | null = null
  let forceRequested = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--uncached-because') {
      reason = args[++i] ?? ''
    } else if (a.startsWith('--uncached-because=')) {
      reason = a.slice('--uncached-because='.length)
    } else if (a === '--force' || a.startsWith('--force=')) {
      forceRequested = true
    } else if (a.startsWith('--cache=')) {
      // e.g. --cache=local:w,remote:w — no store readable means --force by another spelling
      const readable = a
        .slice('--cache='.length)
        .split(/[,;]/)
        .some((pair) => (pair.split(':')[1] ?? '').includes('r'))
      if (!readable) forceRequested = true
      else forward.push(a)
    } else {
      forward.push(a)
    }
  }
  if (env.TURBO_FORCE && env.TURBO_FORCE !== '0' && env.TURBO_FORCE !== 'false') {
    forceRequested = true
  }
  if (reason !== null && reason.trim() === '') {
    return {
      forceRequested,
      reason,
      forwardArgs: forward,
      error: 'empty --uncached-because reason',
    }
  }
  if (forceRequested && reason === null) {
    return { forceRequested, reason, forwardArgs: forward, error: REFUSAL }
  }
  if (reason !== null) forward.push('--force')
  return {
    forceRequested: forceRequested || reason !== null,
    reason,
    forwardArgs: forward,
    error: null,
  }
}

export interface EnvCensus {
  /** effective install configuration and the topology it produced */
  install: InstallTopology
  /** sorted owner/specifier/relative-realpath records */
  resolutions: string[]
  /** every reason this environment may not serve or produce a cached result */
  admissionErrors: string[]
  runtime: {
    bun: string
    platform: string
    arch: string
  }
}

/** Environment fingerprint: hashed into the turbo cache key via globalEnv. */
export function fingerprint(census: EnvCensus): string {
  return createHash('sha256')
    .update(census.install.config.join('\0'))
    .update('\0')
    .update(census.install.layout.join('\0'))
    .update('\0')
    .update(census.resolutions.join('\0'))
    .update('\0')
    .update(`${census.runtime.bun}:${census.runtime.platform}:${census.runtime.arch}`)
    .digest('hex')
}

export function readCensus(root: string): EnvCensus {
  const install = readInstallTopology(root)
  const resolution = readWorkspaceResolutionCensus(root)
  return {
    install,
    resolutions: resolution.records,
    admissionErrors: [...resolution.errors, ...install.errors],
    runtime: {
      bun: Bun.version,
      platform: platform(),
      arch: arch(),
    },
  }
}

/**
 * One refusal for every cached entry point. A cached green is a claim about an
 * environment; if the environment is already broken the claim is not evidence,
 * so this has to run before turbo can serve or record a hit.
 */
export function admissionRefusal(census: EnvCensus, lane: string): string | null {
  if (census.admissionErrors.length === 0) return null
  return (
    `${lane} refused: this install cannot produce or replay a trustworthy cached ` +
    `result (POD-1343, POD-2774).\n- ${census.admissionErrors.join('\n- ')}`
  )
}

function projectCacheIdentity(root: string): string {
  const dotGit = join(root, '.git')
  if (!existsSync(dotGit)) return realpathSync(root)
  const stat = statSync(dotGit)
  const statTarget = stat.isFile() ? readFileSync(dotGit, 'utf8') : ''
  const match = statTarget.match(/^gitdir: (.+)$/m)
  const gitDir = match ? (match[1] ?? '') : dotGit
  const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(root, gitDir)
  // A linked worktree's gitfile points at <common-git-dir>/worktrees/<name>.
  // Resolve this structurally instead of looking for a literal `worktrees` path segment:
  // bare repositories and Windows path separators are both legitimate.
  const worktreesParent = resolve(absoluteGitDir, '..', '..')
  if (
    stat.isFile() &&
    absoluteGitDir !== worktreesParent &&
    resolve(absoluteGitDir, '..').endsWith(`${sep}worktrees`)
  ) {
    return realpathSync(worktreesParent)
  }
  return realpathSync(absoluteGitDir)
}

/**
 * One durable cache per repository per host, shared by every sibling worktree.
 *
 * The key is the common git directory, so linked worktrees of one repository land in
 * the same place and a result produced in one is readable from the next — that sharing
 * is the whole return on the cache. Two things used to threaten it. TMPDIR is reminted
 * per agent session and per test file in this repository, so an XDG-less host silently
 * gave every session its own cache and its own cold start; and /tmp does not survive a
 * reboot. $HOME/.cache — the XDG default — is stable for both, so it is preferred over
 * the temporary directory, which now only catches a host with no usable home.
 */
export function sharedTurboCacheDir(root: string, env = process.env, home = homedir()): string {
  const projectKey = createHash('sha256')
    .update(projectCacheIdentity(root))
    .digest('hex')
    .slice(0, 16)
  // Each candidate is only valid when absolute. A relative value is treated as unset:
  // resolving it against each worktree would silently produce separate caches.
  const cacheBase =
    [env.XDG_CACHE_HOME, home && join(home, '.cache')].find(
      (candidate): candidate is string => !!candidate && isAbsolute(candidate),
    ) ?? join(tmpdir(), 'podium-cache')
  return join(cacheBase, 'podium', 'turbo', projectKey)
}

/** Peak RSS of one tsgo, rounded up from 817MB measured on this repo. The cap is
 *  built on this number rather than on core count because RAM, not CPU, is what
 *  runs out first: a 28-task graph at turbo's default of 10 wants ~8GB. */
const COMPILER_MB = 900

/** Headroom this gate refuses to spend. The daemon, every other agent session and
 *  any live Podium instance share this machine, and a typecheck that takes the box
 *  to the edge kills them rather than itself. 1.5GB is the floor below which work
 *  on this host has been measured going bad — starved vitest runs taking minutes of
 *  wall time for seconds of CPU, and tsgo dying with exit 144 and an empty log. */
const RESERVE_MB = 1500

/** MemAvailable, which is what the kernel thinks is obtainable without swapping —
 *  `freemem()` undercounts badly because it ignores reclaimable page cache, and a
 *  cap built on it would serialise a machine that is actually fine. */
export function availableMb(meminfo?: string): number {
  const text = meminfo ?? (existsSync('/proc/meminfo') ? readFileSync('/proc/meminfo', 'utf8') : '')
  const match = text.match(/^MemAvailable:\s+(\d+) kB$/m)
  if (match?.[1]) return Math.floor(Number(match[1]) / 1024)
  return Math.floor(freemem() / 1024 / 1024)
}

/**
 * How many compilers this machine can run at once, right now.
 *
 * Nothing capped this before. Turbo's default is 10, the graph has 28 tasks, and
 * each tsgo peaks near a gigabyte — on a six-core box with 12GB shared between the
 * daemon, every agent session and any live instance, that is how the machine dies.
 * Two at 817MB and 739MB were measured together while the host sat at load 90 with
 * 859MB free.
 *
 * The alternative that does NOT work is telling agents to check free memory and
 * wait: nothing schedules them, so the outcome is an idle machine and work that
 * never starts. The tool has the numbers, so the tool decides.
 *
 * An explicit `--concurrency` from the caller always wins — this only fills in a
 * default that was never sensible.
 */
export function decideConcurrency(args: string[], env: { cores: number; availableMb: number }) {
  if (args.some((a) => a === '--concurrency' || a.startsWith('--concurrency='))) {
    return { cap: null as number | null, reason: 'caller set --concurrency' }
  }
  const byMemory = Math.floor(Math.max(0, env.availableMb - RESERVE_MB) / COMPILER_MB)
  // Leave a core for the daemon and whatever else is live; never propose zero,
  // because refusing to run at all is the failure mode we are avoiding, not a
  // safety feature. One at a time is slow; it still finishes.
  const byCores = Math.max(1, env.cores - 1)
  const cap = Math.max(1, Math.min(byCores, byMemory))
  return {
    cap,
    reason:
      `${env.cores} cores, ${env.availableMb}MB available, ` +
      `~${COMPILER_MB}MB per compiler, ${RESERVE_MB}MB reserved`,
  }
}

export function turboEnv(root: string, census: EnvCensus): NodeJS.ProcessEnv {
  const cacheDir = process.env.TURBO_CACHE_DIR ?? sharedTurboCacheDir(root)
  const existed = existsSync(cacheDir)
  mkdirSync(cacheDir, { recursive: true })
  // Say it once, and require NOTHING of the reader. A cold cache is not a
  // decision anyone has to make — turbo computes and fills it, which is correct
  // and needs no help. The line exists only because the alternative is an agent
  // watching an unusually slow run, inferring the cache is broken, and acting on
  // it: re-running, forcing, or writing "a fresh worktree is a cold start" into a
  // brief. That inference is what cost this epic time, not the run.
  if (!existed || readdirSync(cacheDir).length === 0) {
    console.error(
      `cache at ${cacheDir} is empty — this run fills it. Nothing to do; the next run is fast.`,
    )
  }
  return {
    ...process.env,
    PODIUM_CHECK_ENV_HASH: fingerprint(census),
    TURBO_CACHE_DIR: cacheDir,
    TURBO_FORCE: undefined,
  }
}

async function main() {
  const root = join(import.meta.dir, '..')
  const census = readCensus(root)
  const refusal = admissionRefusal(census, 'typecheck')
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const decision = decideForce(
    process.argv.slice(2),
    process.env as Record<string, string | undefined>,
  )
  if (decision.error) {
    console.error(decision.error)
    process.exit(1)
  }
  if (decision.reason) console.error(`uncached run, reason: ${decision.reason}`)
  const limit = decideConcurrency(decision.forwardArgs, {
    cores: cpus().length,
    availableMb: availableMb(),
  })
  const concurrencyArgs = limit.cap === null ? [] : [`--concurrency=${limit.cap}`]
  if (limit.cap !== null) console.error(`typecheck concurrency ${limit.cap} (${limit.reason})`)
  const proc = Bun.spawn(
    [
      join(root, 'node_modules', '.bin', 'turbo'),
      'run',
      'typecheck',
      ...concurrencyArgs,
      ...decision.forwardArgs,
    ],
    {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: turboEnv(root, census),
    },
  )
  process.exit(await proc.exited)
}

if (import.meta.main) await main()
