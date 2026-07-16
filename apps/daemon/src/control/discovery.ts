import { hostname } from 'node:os'
import {
  type GitDiscoveryDiagnostic,
  type GitRepositorySummary,
  scanGitRepositories,
} from '@podium/agent-bridge'
import type {
  ControlMessage,
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
    addResult(
      await scanGitRepositories({
        roots,
        homeDir: ctx.homeDir ?? process.env.HOME ?? undefined,
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
  'scanRequest' | 'scanReposRequest' | 'memoryBreakdownRequest'
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
  memoryBreakdownRequest: (ctx, msg) => {
    void memoryBreakdown(ctx, msg.requestId, msg.roots)
  },
}
