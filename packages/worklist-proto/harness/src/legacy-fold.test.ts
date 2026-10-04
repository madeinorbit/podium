// @vitest-environment happy-dom

import { isDeepStrictEqual } from 'node:util'
/**
 * POD-5434 (plan step 10, docs/plans/pod-4286-optimism-and-refusals.md §4.10):
 * the legacy snapshot's whole-array work is paid only by a reader.
 *
 * Per replica batch the legacy engine materialised every changed kind from the
 * replica, rebuilt the session views over every session, repainted the ledger
 * over the whole session and issue lists and, in pool mode, compared the whole
 * session list for topology. The pool reads none of it. This meter runs the
 * real scenario runtime with the pool attached as the web app attaches it (pool
 * runtime work on, the pool owning issue and session optimism, the pool's
 * navigation provider) and counts that work per ordinary batch at 1x and 4x.
 *
 * Arms:
 * - pool, no legacy reader: zero whole-array work per batch.
 * - pool, one legacy reader mounted: the reader pays for what it reads.
 * - legacy control (no pool): the same batches still fold; the counter is armed.
 */
import type { LegacyFoldStats } from '@podium/client-core/engine'
import { COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'
import { POOL_OWNED_KINDS } from '@podium/client-graph/host'
import { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPoolNavigationProvider } from '../../../../apps/web/src/app/pool-navigation-provider'
import {
  armMarkReadRejection,
  remove,
  type ScenarioEngine,
  startScenarioEngine,
  upsert,
  writeArchiveIssue,
  writeBurst50,
  writeClockTick,
  writeEvictIssue,
  writeHeartbeat,
  writeNewIssue,
  writeOptimisticEcho,
  writeOptimisticPress,
  writeParentReassignment,
  writePhaseChange,
  writeRescopeBack,
  writeRescopeGrow,
  writeSelectionClick,
  writeStageMove,
  writeTitleRename,
} from '../../shared/src/scenarios'

afterEach(() => vi.restoreAllMocks())

type Arm = 'pool' | 'pool+reader' | 'legacy'

/** The ordinary batches: a session heartbeat, a phase change, a title rename
 *  and a stage move with its per-user marker, each from the server. */
const BATCHES: readonly [string, (ctx: ScenarioEngine) => Promise<unknown>][] = [
  ['heartbeat', writeHeartbeat],
  ['phase change', writePhaseChange],
  ['title rename', writeTitleRename],
  ['stage move', writeStageMove],
  ['open mission member retitled', (ctx) => writeTitleRename(ctx, openIssueId(ctx))],
  // An issue change used to mark workspace membership dirty for the next session batch.
  ['heartbeat after issue edits', writeHeartbeat],
]

/** The issue of the session the fixture opens: its mission is on screen. */
function openIssueId(ctx: ScenarioEngine): string {
  const row = ctx.cache.read('session', ctx.targets.phaseSessionId)?.value as { issueId?: string }
  if (!row?.issueId) throw new Error('the opened session has no issue')
  return row.issueId
}

/** Open a session in its mission's workspace, as an operator at work has. */
async function openMissionSession(ctx: ScenarioEngine): Promise<void> {
  ctx.engine.getSnapshot().navigateToSession(ctx.targets.phaseSessionId)
  await new Promise((resolve) => setTimeout(resolve, ctx.settleMs))
}

const total = (stats: LegacyFoldStats): number =>
  stats.replicaRowReads + stats.sessionViewBuilds + stats.ledgerFolds + stats.topologyScans

async function measure(scale: 1 | 4, arm: Arm) {
  const ctx = await startScenarioEngine(scale)
  const rt = ctx.engine
  const stops: (() => void)[] = []
  try {
    if (arm !== 'legacy') {
      // The web host's attachment (store-worklist-pool.ts, pool-host.ts).
      rt.enablePoolRuntimeWork()
      const handle = createRuntimeWorklistPool(rt, {
        owns: POOL_OWNED_KINDS,
        summaries: COMMAND_SUMMARIES,
      })
      stops.push(() => handle.dispose())
      for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {
        /* baseline boot */
      }
      rt.setNavigationProvider(createPoolNavigationProvider(handle.pool))
    }
    if (arm !== 'pool') {
      // A legacy screen: useSyncExternalStore reads its lists per publish.
      let rows = 0
      stops.push(
        rt.subscribe(() => {
          const s = rt.getSnapshot()
          rows = s.sessions.length + s.issueProjections.length + s.issueUserStates.length
        }),
      )
      stops.push(() => expect(rows).toBeGreaterThan(0))
    }
    await openMissionSession(ctx)
    expect(Object.keys(rt.getSnapshot().workspaces).some((key) => key.startsWith('mission:'))).toBe(
      true,
    )
    // Settle the boot before the first counted batch.
    await writeHeartbeat(ctx)
    const perBatch: Record<string, LegacyFoldStats> = {}
    for (const [name, write] of BATCHES) {
      const before = rt.legacyFoldStats
      await write(ctx)
      const after = rt.legacyFoldStats
      perBatch[name] = {
        replicaRowReads: after.replicaRowReads - before.replicaRowReads,
        sessionViewBuilds: after.sessionViewBuilds - before.sessionViewBuilds,
        ledgerFolds: after.ledgerFolds - before.ledgerFolds,
        topologyScans: after.topologyScans - before.topologyScans,
      }
    }
    return perBatch
  } finally {
    for (const stop of stops.reverse()) stop()
    rt.destroy()
  }
}

describe('legacy snapshot fold per batch (POD-5434)', () => {
  for (const scale of [1, 4] as const) {
    it(`costs nothing at ${scale}x while no legacy reader is mounted`, async () => {
      const work = await measure(scale, 'pool')
      process.stdout.write(`[legacy fold] ${scale}x pool ${JSON.stringify(work)}\n`)
      for (const [name, stats] of Object.entries(work))
        expect({ name, ...stats }).toEqual({
          name,
          replicaRowReads: 0,
          sessionViewBuilds: 0,
          ledgerFolds: 0,
          topologyScans: 0,
        })
    }, 300_000)

    it(`is paid by a mounted legacy reader at ${scale}x, as in the legacy control`, async () => {
      const reader = await measure(scale, 'pool+reader')
      const control = await measure(scale, 'legacy')
      process.stdout.write(
        `[legacy fold] ${scale}x reader ${JSON.stringify(reader)} control ${JSON.stringify(control)}\n`,
      )
      for (const [name] of BATCHES) {
        expect(total(control[name]!), `control ${name}`).toBeGreaterThan(0)
        expect(total(reader[name]!), `reader ${name}`).toBeGreaterThan(0)
      }
    }, 300_000)
  }
})

// ------------------------------------------------------------------ parity

type Eager = 'eager' | 'lazy, read every step' | 'lazy, read at the end'

/** Everything a legacy reader or the runtime's reactions can see. */
function legacyView(ctx: ScenarioEngine) {
  const s = ctx.engine.getSnapshot()
  return {
    sessions: s.sessions,
    pendingSpawnIds: [...s.pendingSpawnIds],
    pendingSpawnPrompts: [...s.pendingSpawnPrompts],
    issueProjections: s.issueProjections,
    issueUserStates: s.issueUserStates,
    issueDeps: s.issueDeps,
    issueGitStates: s.issueGitStates,
    repoProjections: s.repoProjections,
    issueEvents: s.issueEvents,
    pendingInteractions: s.pendingInteractions,
    messageRecords: s.messageRecords,
    shipOrders: s.shipOrders,
    shipLanes: s.shipLanes,
    conversations: s.conversations,
    automations: s.automations,
    automationRuns: s.automationRuns,
    selectedIssueId: s.selectedIssueId,
    selectedWorktree: s.selectedWorktree,
    workspaces: s.workspaces,
    paneA: s.paneA,
    paneB: s.paneB,
    fileTabs: s.fileTabs,
    view: s.view,
    issueVisitBaseline: s.issueVisitBaseline,
    outboxSize: s.outboxSize,
    // The keyed input a pool adapter would read for the same lists.
    keyedSessions: ctx.engine.readLocal('sessions'),
    keyedIssues: ctx.engine.readLocal('issueProjections'),
  }
}

/** A server write on one session row (kernel truth, as the change generator writes). */
function patchSessionRow(ctx: ScenarioEngine, id: string, patch: Record<string, unknown>): void {
  const current = ctx.cache.read('session', id)?.value as object | undefined
  if (!current) throw new Error(`session ${id} missing`)
  upsert(ctx, 'session', id, { ...current, ...patch })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

/** Two parked twins of one resume ref: the more recent one shows. A heartbeat
 *  on the hidden twin swaps which one the session list keeps. */
function twinIds(ctx: ScenarioEngine): [string, string] {
  const ids = ctx.corpus.sessions
    .map((session) => session.sessionId as string)
    .filter((id) => id !== ctx.targets.heartbeatSessionId && id !== ctx.targets.phaseSessionId)
  return [ids[1]!, ids[2]!]
}

const STEPS: readonly [string, (ctx: ScenarioEngine) => Promise<unknown>][] = [
  ['heartbeat', writeHeartbeat],
  ['phase change', writePhaseChange],
  ['title rename', writeTitleRename],
  ['stage move', writeStageMove],
  ['open a session in its mission', openMissionSession],
  ['open mission member retitled', (ctx) => writeTitleRename(ctx, openIssueId(ctx))],
  ['heartbeat after a member edit', writeHeartbeat],
  // The opened issue leaves its mission: its session's tab is foreign there.
  [
    'open issue moved to another mission',
    (ctx) => writeParentReassignment(ctx, openIssueId(ctx), ctx.targets.reparentToId),
  ],
  ['heartbeat after the move', writeHeartbeat],
  ['selection click', (ctx) => writeSelectionClick(ctx)],
  ['heartbeat after a click', writeHeartbeat],
  ['new issue with its session', (ctx) => writeNewIssue(ctx)],
  [
    'session rehomed to another issue',
    async (ctx) => {
      patchSessionRow(ctx, ctx.targets.phaseSessionId, { issueId: ctx.targets.archiveId })
      await settle()
    },
  ],
  [
    'session moved worktree',
    async (ctx) => {
      patchSessionRow(ctx, ctx.targets.phaseSessionId, { cwd: ctx.targets.newIssueRepo.repoPath })
      await settle()
    },
  ],
  [
    'resume twins parked',
    async (ctx) => {
      const [a, b] = twinIds(ctx)
      const resume = { kind: 'claude-code', value: 'twin-resume' }
      ctx.replica.batch(() => {
        patchSessionRow(ctx, a, {
          resume,
          status: 'hibernated',
          lastActiveAt: '2026-07-01T00:00:01.000Z',
        })
        patchSessionRow(ctx, b, {
          resume,
          status: 'hibernated',
          lastActiveAt: '2026-07-01T00:00:00.000Z',
        })
      })
      await settle()
    },
  ],
  [
    'hidden twin wins on activity',
    async (ctx) => {
      patchSessionRow(ctx, twinIds(ctx)[1], { lastActiveAt: '2026-07-01T00:00:02.000Z' })
      await settle()
    },
  ],
  [
    'session removed',
    async (ctx) => {
      remove(ctx, 'session', twinIds(ctx)[0])
      await settle()
    },
  ],
  ['archive', (ctx) => writeArchiveIssue(ctx)],
  ['parent reassignment', (ctx) => writeParentReassignment(ctx)],
  ['burst of 50 sessions', writeBurst50],
  ['mark-read in flight', (ctx) => writeOptimisticPress(ctx)],
  ['heartbeat while a write awaits truth', writeHeartbeat],
  ['mark-read echo', (ctx) => writeOptimisticEcho(ctx)],
  [
    'refused mark-read rolls back',
    async (ctx) => {
      armMarkReadRejection(ctx)
      await writeOptimisticPress(ctx, ctx.targets.visibleRootId)
    },
  ],
  ['rescope grow', writeRescopeGrow],
  ['rescope back', writeRescopeBack],
  ['evict', (ctx) => writeEvictIssue(ctx)],
  ['clock tick', (ctx) => writeClockTick(ctx)],
]

async function parityArm(arm: Eager, scale: 1 | 4) {
  const ctx = await startScenarioEngine(scale)
  const rt = ctx.engine
  rt.enablePoolRuntimeWork({ lazyLegacyLists: arm !== 'eager' })
  const handle = createRuntimeWorklistPool(rt, {
    owns: POOL_OWNED_KINDS,
    summaries: COMMAND_SUMMARIES,
  })
  for (let turn = 0; turn < 32 && handle.pool.hydrate(); turn++) {
    /* baseline boot */
  }
  rt.setNavigationProvider(createPoolNavigationProvider(handle.pool))
  return {
    ctx,
    dispose() {
      handle.dispose()
      rt.destroy()
    },
  }
}

describe('legacy snapshot parity (POD-5434)', () => {
  for (const scale of [1, 4] as const) {
    it(`builds on read exactly what the eager rebuild publishes, at ${scale}x`, async () => {
      // One frozen wall clock for all arms: every stamp a step mints is equal.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-07-09T12:00:00.000Z') })
      const arms = {
        eager: await parityArm('eager', scale),
        each: await parityArm('lazy, read every step', scale),
        end: await parityArm('lazy, read at the end', scale),
      }
      try {
        const differences: string[] = []
        for (const [name, step] of STEPS) {
          // Lockstep: each arm takes the step at the same frozen instant.
          for (const arm of Object.values(arms)) await step(arm.ctx)
          vi.setSystemTime(Date.now() + 1_000)
          const eager = legacyView(arms.eager.ctx)
          const each = legacyView(arms.each.ctx)
          for (const key of Object.keys(eager) as (keyof typeof eager)[])
            if (!isDeepStrictEqual(eager[key], each[key])) differences.push(`${name}: ${key}`)
        }
        const eager = legacyView(arms.eager.ctx)
        const end = legacyView(arms.end.ctx)
        for (const key of Object.keys(eager) as (keyof typeof eager)[])
          if (!isDeepStrictEqual(eager[key], end[key])) differences.push(`end: ${key}`)
        expect(differences).toEqual([])
        // The steps moved what they meant to: the parity is not two empty lists.
        expect(eager.sessions.some((s) => s.sessionId === 's-i-new')).toBe(true)
        expect(eager.issueProjections.length).toBeGreaterThan(0)
      } finally {
        for (const arm of Object.values(arms)) arm.dispose()
        vi.useRealTimers()
      }
    }, 600_000)
  }
})
