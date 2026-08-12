/**
 * Cached-by-default typecheck entry point (POD-1378). `bun run typecheck` lands here.
 *
 * Turbo's cache key covers tracked file content (`$TURBO_DEFAULT$`, bun.lock,
 * tooling/tsconfig) but is blind to the install environment: bunfig.toml and the
 * node_modules layout are never hashed, so a linker flip or a broken install keeps
 * reporting a stale green (POD-1343 saw 22/22 cached green with zero
 * node_modules/@podium links). This wrapper closes that hole and makes uncached
 * runs deliberate:
 *
 *   1. Refuses to run when node_modules/@podium has no usable links or points
 *      outside this checkout — a cached green in that environment is not evidence.
 *      A dangling link left behind for a deleted workspace is inert and remains in
 *      the fingerprint; Bun does not remove those links on a frozen install.
 *   2. Fingerprints the environment (bunfig.toml content + @podium link census)
 *      into PODIUM_CHECK_ENV_HASH, declared in turbo.json `globalEnv`, so any
 *      environment drift is an automatic cache MISS — no --force needed.
 *   3. Refuses --force / TURBO_FORCE unless an explicit reason is given via
 *      --uncached-because="<reason>". A forced 22-package run costs ~3m of CPU
 *      (110x the cached 2s) on a host shared with a live Podium instance.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface ForceDecision {
  forceRequested: boolean
  reason: string | null
  /** args to forward to turbo (reason flag stripped, --force re-added iff allowed) */
  forwardArgs: string[]
  error: string | null
}

const REFUSAL = `\
uncached typecheck refused.

A forced run recomputes all 22 packages (~3m14s of CPU, measured) instead of
reusing the cache (~2s) — 110x — on a host shared with a live Podium instance.
The cache key already covers source files, bun.lock, tooling/tsconfig, and the
install environment (bunfig.toml + node_modules/@podium census via
PODIUM_CHECK_ENV_HASH), so installs, linker changes, and base swaps are
noticed automatically.

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
  bunfig: string
  /** sorted "name:relative-target" or "name!DANGLING" entries under node_modules/@podium */
  links: string[]
  runtime: {
    bun: string
    platform: string
    arch: string
  }
}

export interface WorkspaceLinksHealth {
  healthy: string[]
  dangling: string[]
  external: string[]
  error: string | null
}

/**
 * External targets are unsafe because their contents can change without moving
 * this fingerprint. Dangling targets cannot provide code and are safe to retain
 * in the fingerprint when at least one real in-checkout workspace link exists.
 */
export function assessWorkspaceLinks(links: string[]): WorkspaceLinksHealth {
  const healthy = links.filter((link) => !link.includes('!'))
  const dangling = links.filter((link) => link.endsWith('!DANGLING'))
  const external = links.filter((link) => link.endsWith('!EXTERNAL'))
  const error =
    healthy.length === 0
      ? 'node_modules/@podium has no usable in-checkout workspace links'
      : external.length > 0
        ? `node_modules/@podium points outside this checkout: ${external.join(', ')}`
        : null
  return { healthy, dangling, external, error }
}

/** Environment fingerprint: hashed into the turbo cache key via globalEnv. */
export function fingerprint(census: EnvCensus): string {
  return createHash('sha256')
    .update(census.bunfig)
    .update('\0')
    .update(census.links.join(','))
    .update('\0')
    .update(`${census.runtime.bun}:${census.runtime.platform}:${census.runtime.arch}`)
    .digest('hex')
}

export function readCensus(root: string): EnvCensus {
  const bunfig = existsSync(join(root, 'bunfig.toml'))
    ? readFileSync(join(root, 'bunfig.toml'), 'utf8')
    : ''
  const dir = join(root, 'node_modules', '@podium')
  let links: string[] = []
  if (existsSync(dir)) {
    links = readdirSync(dir)
      .sort()
      .map((name) => {
        const packageJson = join(dir, name, 'package.json')
        if (!existsSync(packageJson)) return `${name}!DANGLING`
        const target = realpathSync(join(dir, name))
        const rel = relative(realpathSync(root), target)
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          return `${name}!EXTERNAL`
        }
        return `${name}:${rel}`
      })
  }
  return {
    bunfig,
    links,
    runtime: {
      bun: Bun.version,
      platform: platform(),
      arch: arch(),
    },
  }
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

export function sharedTurboCacheDir(root: string): string {
  const projectKey = createHash('sha256')
    .update(projectCacheIdentity(root))
    .digest('hex')
    .slice(0, 16)
  const configuredBase = process.env.XDG_CACHE_HOME
  // XDG_CACHE_HOME is only valid when absolute. Treat a relative value as unset;
  // resolving it against each worktree would silently produce separate caches.
  const cacheBase =
    configuredBase && isAbsolute(configuredBase) ? configuredBase : join(tmpdir(), 'podium-cache')
  return join(cacheBase, 'podium', 'turbo', projectKey)
}

export function turboEnv(root: string, census: EnvCensus): NodeJS.ProcessEnv {
  const cacheDir = process.env.TURBO_CACHE_DIR ?? sharedTurboCacheDir(root)
  mkdirSync(cacheDir, { recursive: true })
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
  const links = assessWorkspaceLinks(census.links)
  if (links.error) {
    console.error(
      `typecheck refused: ${links.error}; a cached green there would be unsafe (POD-1343). ` +
        'Run `bun install` first.',
    )
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
  const proc = Bun.spawn(
    [join(root, 'node_modules', '.bin', 'turbo'), 'run', 'typecheck', ...decision.forwardArgs],
    {
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
      env: turboEnv(root, census),
    },
  )
  process.exit(await proc.exited)
}

if (import.meta.main) await main()
