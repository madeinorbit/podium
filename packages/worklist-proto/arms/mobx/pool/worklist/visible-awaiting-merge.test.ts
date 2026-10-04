import { upsertIssue } from '../../../../shared/src/scenarios'

/**
 * POD-4940 — a finished row whose private branch holds unlanded work stays in
 * the sidebar without limit (`issueAwaitingMerge`).
 *
 * The oracle keeps such a row twice: the sessionless branch takes it
 * (`rows.ts:95-104`: not dropped while awaiting merge or closed-top-level) and
 * `issueVisibleInSidebar` never decays it (`visibility.ts:31-32`), and
 * `rowPendingDecision` reads the merge verdict for phase/asking. The MobX arm
 * used to hard-code that verdict as never true (no slice field spelled
 * branch/git state), so it dropped the row once its sessions decayed and read
 * `queued`/not-asking while they still retained it.
 *
 * Both tests build the shape synthetically on the 1x fixture (no real data)
 * and hold the pool to the oracle: the full visible order and rows, plus the
 * row views' phase/asking for the shaped rows.
 */

import { rowViewOf } from '@podium/client-graph/models'
import { describe, expect, it } from 'vitest'
import {
  harnessMobxPoolArm,
  snapshotPool,
  tracked,
  visibleOrderOf,
} from '../../../../harness/src/adapters/mobx-pool'
import { engineLocals, openFenceFeeds, parityLocals } from '../../../../harness/src/fence-scenarios'
import { installMobxWarnTrap } from '../../../../harness/src/mobx-trap'
import {
  legacyDerivationFromStore,
  rowViewsFromStore,
  snapshotFromStore,
  visibleIssueRows,
} from '../../../../harness/src/oracle/index'
import { diffSnapshots } from '../../../../shared/src/gen/check'
import { type ScenarioEngine, startScenarioEngine, upsert } from '../../../../shared/src/scenarios'

installMobxWarnTrap()

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** A finished agent child with an unlanded private branch, cloned off a live wire row. */
function mergeChild(ctx: ScenarioEngine, parentId: string, id: string, closedMsAgo: number) {
  const now = ctx.engine.access.coarseNow
  const wire = {
    ...(ctx.cache.read('issueProjection', parentId)?.value as Record<string, unknown>),
  }
  const projection = {
    ...(ctx.cache.read('issueProjection', parentId)?.value as Record<string, unknown>),
  }
  const closedAt = new Date(now - closedMsAgo).toISOString()
  const common = {
    id,
    parentId,
    stage: 'done',
    audience: 'agent',
    draft: false,
    archived: false,
    deletedAt: null,
    closedReason: 'done',
    closedAt,
    updatedAt: closedAt,
    createdAt: new Date(now - closedMsAgo - DAY_MS).toISOString(),
    readAt: null,
    pinned: false,
    sortKey: null,
    needsHuman: false,
    blocked: false,
    coordinatorSessionId: null,
    startedBySession: null,
    deps: [],
    worktreePath: null,
    branch: 'task-branch',
    gitState: {
      updatedAt: new Date(now).toISOString(),
      branch: 'task-branch',
      shared: false,
      ahead: 3,
      dirtyFiles: 0,
    },
  }
  ctx.replica.batch(() => {
    upsertIssue(ctx, id, {
      ...wire,
      ...common,
      seq: ctx.corpus.issues.length + 901,
      title: `Synthetic awaiting-merge child ${id}`,
    })
  })
}

/** A recently finished, read session on `issueId`, cloned off a live session row. */
function recentFinishedSession(ctx: ScenarioEngine, sessionId: string, issueId: string) {
  const now = ctx.engine.access.coarseNow
  const anySession = ctx.engine.access.sessions[0] as unknown as Record<string, unknown>
  expect(anySession, 'a template session').toBeDefined()
  const stoppedAt = new Date(now - HOUR_MS).toISOString()
  const { resume: _resume, ...rest } = { ...anySession }
  void _resume
  upsert(ctx, 'session', sessionId, {
    ...rest,
    sessionId,
    issueId,
    agentKind: 'claude-code',
    status: 'hibernated',
    archived: false,
    headless: false,
    lastActiveAt: stoppedAt,
    stoppedAt: null,
    readAt: new Date(now - HOUR_MS / 2).toISOString(),
    unread: false,
    agentState: { phase: 'idle', since: stoppedAt, idle: { kind: 'done' } },
  })
}

/** The oracle's visible order, and the pool held to it plus a full snapshot diff. */
function expectParity(ctx: ScenarioEngine, handle: ReturnType<typeof harnessMobxPoolArm.create>) {
  const snapshot = snapshotPool(handle.pool)
  const locals = parityLocals(ctx)
  const derivation = legacyDerivationFromStore(ctx.engine.access, locals.coarseNow)
  const expected = visibleIssueRows(derivation, locals).map((row) => row.issue.id)
  expect(
    tracked(() => visibleOrderOf(handle.pool)),
    'visible order',
  ).toEqual(expected)
  const diff = diffSnapshots(snapshot, snapshotFromStore(ctx.engine.access, locals))
  expect(diff, 'snapshot rows').toBeNull()
}

function expectViews(
  ctx: ScenarioEngine,
  handle: ReturnType<typeof harnessMobxPoolArm.create>,
  ids: string[],
) {
  const views = rowViewsFromStore(ctx.engine.access, engineLocals(ctx))
  tracked(() => {
    for (const id of ids) {
      const oracle = views[id]
      expect(oracle, `${id} is oracle-visible`).toBeDefined()
      const live = rowViewOf(handle.pool.issue(id))
      expect(live, `${id} is pool-visible`).toBeDefined()
      expect(live!.phase, `${id}.phase`).toBe(oracle!.phase)
      expect(live!.asking, `${id}.asking`).toBe(oracle!.asking)
    }
  })
}

/** A visible open issue to hang the synthetic children under (formal parent edge). */
function openParent(ctx: ScenarioEngine): string {
  const locals = parityLocals(ctx)
  const derivation = legacyDerivationFromStore(ctx.engine.access, locals.coarseNow)
  const parent = visibleIssueRows(derivation, locals).find((row) =>
    ['planning', 'in_progress', 'review'].includes(row.issue.stage),
  )
  expect(parent, 'a visible open parent').toBeDefined()
  return parent!.issue.id
}

describe('awaiting merge keeps a finished row (POD-4940)', () => {
  it('a finished agent child with an unlanded branch stays visible after its sessions decay', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const parent = openParent(ctx)
      mergeChild(ctx, parent, 'i-merge-kept', 8 * DAY_MS)
      feeds.flush()
      expectParity(ctx, handle)
      expectViews(ctx, handle, ['i-merge-kept'])
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)

  it('while its session still retains it, the merge verdict reads waiting/asking', async () => {
    const ctx = await startScenarioEngine(1)
    const feeds = openFenceFeeds(ctx, 'overlaid')
    const handle = harnessMobxPoolArm.create(feeds.rows.source, feeds.locals.source)
    try {
      const parent = openParent(ctx)
      mergeChild(ctx, parent, 'i-merge-live', HOUR_MS)
      recentFinishedSession(ctx, 's-merge-live', 'i-merge-live')
      feeds.flush()
      expectParity(ctx, handle)
      expectViews(ctx, handle, ['i-merge-live'])
    } finally {
      handle.dispose()
      feeds.dispose()
      ctx.engine.destroy()
    }
  }, 120_000)
})
