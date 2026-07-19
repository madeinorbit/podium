import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  scanGitRepositories,
  scanGitRepositoriesAtPath,
} from '@podium/agent-bridge'
import type {
  ControlMessage,
  DirectoryEntryWire,
  DirectoryListingWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
} from '@podium/protocol'
import { sampleHostMemory } from '../host-metrics'
import type { MemoryAttribution } from '../memory-breakdown'
import type { ControlHandlers, DaemonContext } from './context'

function repoToWire(r: GitRepositorySummary): GitRepositoryWire {
  return {
    path: r.path,
    kind: r.kind,
    ...(r.branch !== undefined ? { branch: r.branch } : {}),
    ...(r.headSha !== undefined ? { headSha: r.headSha } : {}),
    ...(r.originUrl !== undefined ? { originUrl: r.originUrl } : {}),
    worktrees: (r.worktrees ?? []).map((w) => ({
      path: w.path,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      ...(w.headSha !== undefined ? { headSha: w.headSha } : {}),
      ...(w.locked !== undefined ? { locked: w.locked } : {}),
      ...(w.prunable !== undefined ? { prunable: w.prunable } : {}),
    })),
  }
}

function gitDiagnosticToWire(d: GitDiscoveryDiagnostic): GitDiscoveryDiagnosticWire {
  return { severity: d.severity, path: d.path, message: d.message }
}

async function scan(ctx: DaemonContext, requestId: string): Promise<void> {
  // On-demand (user-triggered) scan requests a FULL snapshot so a manual rescan can
  // recover a cold/reset server index — not just whatever moved since the last tick.
  // It runs on the worker + publishes to all clients; the requester additionally gets
  // a scanResult tagged with its requestId so its pending request resolves. Both carry
  // the (now full-list) changed + removed fields.
  const delta = await ctx.refreshAndPublishConversations(true)
  ctx.send({
    type: 'scanResult',
    requestId,
    conversations: delta.changed,
    removed: delta.removed,
    diagnostics: delta.diagnostics,
  })
}

async function scanRepos(
  ctx: DaemonContext,
  requestId: string,
  roots: string[],
  opts: { includeHome?: boolean; maxDepth?: number } = {},
): Promise<void> {
  const repositories: GitRepositoryWire[] = []
  const diagnostics: GitDiscoveryDiagnosticWire[] = []

  const addResult = (result: Awaited<ReturnType<typeof scanGitRepositories>>): void => {
    for (const repo of result.repositories) repositories.push(repoToWire(repo))
    for (const d of result.diagnostics) diagnostics.push(gitDiagnosticToWire(d))
  }

  try {
    // Prefer live $HOME over the snapshotted agent-home (ctx.homeDir): git repos
    // live under the user's home, and tests isolate discovery by mutating
    // process.env.HOME after the daemon starts. ctx.homeDir stays the fallback
    // when HOME is unset (named-instance agent-home / explicit discovery.homeDir).
    addResult(
      await scanGitRepositories({
        roots,
        homeDir: process.env.HOME ?? ctx.homeDir ?? undefined,
        ...(opts.includeHome === undefined ? {} : { includeHome: opts.includeHome }),
        ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      }),
    )
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      path: '',
      message: err instanceof Error ? err.message : String(err),
    })
  }
  ctx.send({ type: 'scanReposResult', requestId, repositories, diagnostics })
}

/** The daemon's live home. Prefers $HOME over the snapshotted agent-home
 *  (ctx.homeDir) for the same reason scanRepos does: the browse target is the
 *  user's own tree, and tests isolate it by mutating process.env.HOME after the
 *  daemon starts. ctx.homeDir stays the fallback when HOME is unset. */
function browseHomeDir(ctxHomeDir?: string): string {
  return process.env.HOME || ctxHomeDir || homedir()
}

function expandHome(path: string, homePath: string): string {
  if (path === '~') return homePath
  if (path.startsWith('~/')) return join(homePath, path.slice(2))
  return path
}

/** Does this directory contain a `.git` (dir for a normal repo, file for a
 *  worktree/submodule)? The browser's git-repo badge (POD-855) [spec:SP-5eb6].
 *  One stat — deliberately cheaper than a full git probe, since it only drives an
 *  icon; the authoritative repo metadata comes from a scan. */
async function hasGitDir(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

/** At most this many `.git` stats in flight while badging a listing (POD-867).
 *  libuv's fs threadpool is 4, so a handful of workers already saturates it; the
 *  point of the cap is to not hold tens of thousands of pending promises at once
 *  when browsing a directory-heavy path (/nix/store, a giant node_modules). */
const GIT_STAT_CONCURRENCY = 32

/** Map `items` through `fn` with at most `limit` calls in flight, results in input
 *  order. A fixed pool of workers pulls from a shared cursor — no batch barriers,
 *  and never more than `limit` pending promises regardless of input size. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * One directory's sub-directories on THIS machine's disk (POD-814) [spec:SP-3701].
 * Ported from the server's browseDirectories(): the picker used to browse the hub
 * host's own disk, which is the wrong filesystem — the user picks a machine, and a
 * hub in mode=server may have no disk of interest (or no daemon) at all.
 *
 * Directories only (the picker adds repos, and files are never repo roots), hidden
 * ones filtered unless asked for, sorted by name. Throws on an unusable path; the
 * handler turns that into the result's `error` field.
 */
export async function listDirectories(
  path: string | undefined,
  options: { includeHidden?: boolean; homeDir?: string } = {},
): Promise<DirectoryListingWire> {
  const homePath = browseHomeDir(options.homeDir)
  const requested = expandHome(path?.trim() || homePath, homePath)
  if (!isAbsolute(requested)) throw new Error(`directory path must be absolute: ${requested}`)

  let current = requested
  try {
    const s = await stat(current)
    if (!s.isDirectory()) throw new Error('path is not a directory')
    current = await realpath(current)
  } catch (err) {
    throw new Error(
      `Could not open directory ${requested}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let dirs: { name: string; path: string }[]
  try {
    dirs = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => options.includeHidden || !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    throw new Error(
      `Could not read directory ${current}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // `isRepo` uses the SAME cheap `.git` check for every folder — an entry's badge
  // and the current folder's "Add repo" gate must never disagree (a badged subfolder
  // you step into has to still read as a repo). Only the origin — used purely to
  // NAME the add target — comes from a real depth-0 scan, best-effort.
  const [entries, currentIsRepo, selfRepo] = await Promise.all([
    // Bounded fan-out (POD-867): a directory with tens of thousands of subfolders
    // must not spawn that many concurrent stats — cap the in-flight count.
    mapLimit(
      dirs,
      GIT_STAT_CONCURRENCY,
      async (d): Promise<DirectoryEntryWire> => ({ ...d, isRepo: await hasGitDir(d.path) }),
    ),
    hasGitDir(current),
    scanGitRepositoriesAtPath(current, { maxDepth: 0, homeDir: browseHomeDir(options.homeDir) })
      .then((r) => r.repositories.find((repo) => repo.path === current) ?? null)
      .catch(() => null),
  ])

  const parent = dirname(current)
  return {
    path: current,
    homePath,
    parentPath: parent === current ? null : parent,
    entries,
    ...(currentIsRepo ? { isRepo: true } : {}),
    ...(selfRepo?.originUrl ? { originUrl: selfRepo.originUrl } : {}),
  }
}

async function browseDirs(
  ctx: DaemonContext,
  requestId: string,
  opts: { path?: string; includeHidden?: boolean },
): Promise<void> {
  try {
    const listing = await listDirectories(opts.path, {
      ...(opts.includeHidden === undefined ? {} : { includeHidden: opts.includeHidden }),
      ...(ctx.homeDir === undefined ? {} : { homeDir: ctx.homeDir }),
    })
    ctx.send({ type: 'browseDirsResult', requestId, listing })
  } catch (err) {
    // A bad path is a normal outcome of browsing, not a daemon fault: report it
    // so the picker shows the reason instead of hanging until the RPC times out.
    ctx.send({
      type: 'browseDirsResult',
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function memoryBreakdown(
  ctx: DaemonContext,
  requestId: string,
  roots: string[],
): Promise<void> {
  const memory = sampleHostMemory()
  const supported = process.platform === 'linux' // the walk needs /proc
  let agents: MemoryAttribution['agents'] = []
  let projects: MemoryAttribution['projects'] = []
  if (supported) {
    try {
      const result = (await ctx.workerClient.runJob('memoryBreakdown', {
        sessions: [...ctx.bridges.entries()].map(([sessionId, session]) => ({
          sessionId,
          label: `podium-${sessionId}`,
          pid: session.pid,
        })),
        roots,
        selfPid: process.pid,
      })) as MemoryAttribution
      agents = result.agents
      projects = result.projects
    } catch (err) {
      console.warn(
        `[podium:daemon] memoryBreakdown job failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  const attributed =
    agents.reduce((sum, a) => sum + a.bytes, 0) + projects.reduce((sum, p) => sum + p.bytes, 0)
  const usedBytes = Math.max(0, memory.totalBytes - memory.availableBytes)
  ctx.send({
    type: 'memoryBreakdownResult',
    requestId,
    hostname: hostname(),
    sampledAt: new Date().toISOString(),
    supported,
    memory,
    agents,
    projects,
    otherBytes: Math.max(0, usedBytes - attributed),
  })
}

export const discoveryHandlers: Pick<
  ControlHandlers,
  'scanRequest' | 'scanReposRequest' | 'browseDirsRequest' | 'memoryBreakdownRequest'
> = {
  scanRequest: (ctx, msg) => {
    void scan(ctx, msg.requestId)
  },
  scanReposRequest: (ctx, msg: Extract<ControlMessage, { type: 'scanReposRequest' }>) => {
    void scanRepos(ctx, msg.requestId, msg.roots, {
      ...(msg.includeHome === undefined ? {} : { includeHome: msg.includeHome }),
      ...(msg.maxDepth === undefined ? {} : { maxDepth: msg.maxDepth }),
    })
  },
  browseDirsRequest: (ctx, msg: Extract<ControlMessage, { type: 'browseDirsRequest' }>) => {
    void browseDirs(ctx, msg.requestId, {
      ...(msg.path === undefined ? {} : { path: msg.path }),
      ...(msg.includeHidden === undefined ? {} : { includeHidden: msg.includeHidden }),
    })
  },
  memoryBreakdownRequest: (ctx, msg) => {
    void memoryBreakdown(ctx, msg.requestId, msg.roots)
  },
}
