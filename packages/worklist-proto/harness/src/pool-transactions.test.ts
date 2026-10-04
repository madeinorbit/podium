import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
// @vitest-environment happy-dom
/**
 * POD-5431 — the pool's transaction log against the ledger, on one runtime.
 *
 * Two pools ride the same `ClientRuntime` over the scenario corpus, with the
 * production kernel outbox: one as today (the ledger paints, `overlaid` feed),
 * one with `owns` (the pool's log paints those kinds, `pooled` feed). Every
 * write reaches both: a pool change enqueues through the ledger's own enqueue
 * path, and a legacy or other-tab write is adopted from the outbox. After each
 * scripted step the two must show the same thing: every issue and session row,
 * the sidebar, the mission of each touched issue and its issue page. A planted
 * wrong reducer in the pool's log must fail that comparison.
 *
 * The meter at the end counts one pool click's keyed row reads and derivation
 * runs at 1x and 4x; the growth may not exceed the growth of the click's
 * visible neighbourhood (`neighbourhood.ts`).
 */

import { types } from 'node:util'
import { overlaysForOutboxEntry } from '@podium/client-core/command-reducers'
import type { OutboxKinds } from '@podium/client-core/engine'
import { LOADING } from '@podium/client-graph'
import { createWorklistPool, type WorklistPoolHandle } from '@podium/client-graph/create'
import { issuePages } from '@podium/client-graph/issue-page'
import { missions } from '@podium/client-graph/mission'
import type { MobxPool } from '@podium/client-graph/pool'
import { createRuntimeTransactions, createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'
import { createEngineLocals, localsOfEngine } from '@podium/client-graph/shared/engine-locals'
import { type PoolOwnedKind } from '@podium/client-graph/shared/row-source'
import { createRowSource } from '../../shared/src/row-source'
import { createPoolTransactions } from '@podium/client-graph/write/transactions'
import {
  asIssueId,
  asSessionId,
  asUserId,
  issueUserStateRowId,
  sessionUserStateRowId,
} from '@podium/model'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import {
  evict,
  remove,
  type ScenarioEngine,
  type ScenarioServer,
  startScenarioEngine,
  upsert,
  upsertIssue,
  writeRescopeBack,
  writeRescopeGrow,
} from '../../shared/src/scenarios'
import { settlePoolLoads, snapshotPool, tracked, visibleOrderOf } from './adapters/mobx-pool'
import { installMobxWarnTrap } from './mobx-trap'
import { type NeighbourhoodState, neighbourhoodOf } from './neighbourhood'
import { snapshotFromStore } from './oracle'
import { measureWork } from './work-meter'

installMobxWarnTrap()

type Kind = keyof OutboxKinds & string

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A connectivity switch the kernel outbox listens to. */
function network(online: boolean) {
  let state = online
  const listeners = new Set<() => void>()
  return {
    isOnline: () => state,
    onlineEvents: {
      add: (cb: () => void) => listeners.add(cb),
      remove: (cb: () => void) => listeners.delete(cb),
    },
    set(next: boolean) {
      state = next
      if (next) for (const cb of [...listeners]) cb()
    },
  }
}

async function boot(scale: 1 | 4, opts: { online: boolean; server?: ScenarioServer }) {
  const net = network(opts.online)
  const ctx = await startScenarioEngine(scale, {
    outbox: 'kernel',
    network: { isOnline: net.isOnline, onlineEvents: net.onlineEvents },
    ...(opts.server ? { server: opts.server } : {}),
  })
  cleanups.push(() => ctx.engine.destroy())
  return { ctx, net }
}

function pair(ctx: ScenarioEngine, _owns: readonly PoolOwnedKind[]) {
  const transactions = createRuntimeTransactions(ctx.engine)
  const rows = createRowSource(ctx.engine, ctx.replica, { mode: 'pooled', pending: transactions.pending })
  const locals = createEngineLocals(ctx.engine)
  const observer = createWorklistPool(rows.source, locals.source)
  transactions.bind(rows)
  observer.pool.attachTransactions(transactions, true)
  const ledger = { pool: observer.pool, transactions, dispose() { observer.dispose(); transactions.dispose(); locals.dispose(); rows.dispose() } }
  const pooled = createRuntimeWorklistPool(ctx.engine)
  const handles = { ledger, pooled }
  cleanups.push(() => { handles.pooled.dispose(); handles.ledger.dispose() })
  return handles
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = (ctx: ScenarioEngine) => wait(ctx.settleMs)

/** Stable text of a value: keys sorted, unset cells dropped, sets as sorted lists. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Set) return [...v].map(String).sort()
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) out[k] = (v as Record<string, unknown>)[k]
      return out
    }
    return v
  })
}

function settled<T>(pool: MobxPool, read: () => T): T {
  for (let round = 0; round < 20; round += 1) {
    const value = tracked(read)
    if (value !== LOADING) return value
    if (settlePoolLoads(pool) === 0) return value
  }
  return tracked(read)
}

/** Everything the two pools show differently, by row and by screen. */
function differences(
  ctx: ScenarioEngine,
  a: MobxPool,
  b: MobxPool,
  focus: readonly string[] = [],
): string[] {
  const out: string[] = []
  const store = referenceState(ctx.engine)
  const issueIds = new Set<string>([
    ...ctx.replica.rows('issueProjections').map((row) => String(row.id)),
    ...store.issueProjections.map((row) => row.id),
  ])
  const sessionIds = new Set<string>([
    ...ctx.replica.rows('sessions').map((row) => String(row.sessionId)),
    ...store.sessions.map((row) => row.sessionId),
  ])
  for (const [kind, ids] of [
    ['issue', issueIds],
    ['session', sessionIds],
  ] as const) {
    for (const id of ids) {
      const x = canon(tracked(() => a.row(kind, id, 'peek')))
      const y = canon(tracked(() => b.row(kind, id, 'peek')))
      if (x !== y) out.push(`${kind}:${id}\n  ledger ${x}\n  pool   ${y}`)
    }
  }
  const sidebarA = canon(snapshotPool(a))
  const sidebarB = canon(snapshotPool(b))
  if (sidebarA !== sidebarB) out.push(`sidebar\n  ledger ${sidebarA}\n  pool   ${sidebarB}`)
  for (const id of focus) {
    const mission = (pool: MobxPool) =>
      settled(pool, () => {
        const root = missions(pool).rootFor(id)
        return root === LOADING || root === undefined
          ? root
          : { root, members: missions(pool).members(root) }
      })
    const ma = canon(mission(a))
    const mb = canon(mission(b))
    if (ma !== mb) out.push(`mission of ${id}\n  ledger ${ma}\n  pool   ${mb}`)
    const pa = canon(settled(a, () => issuePages(a).data(id)))
    const pb = canon(settled(b, () => issuePages(b).data(id)))
    if (pa !== pb) out.push(`issue page ${id}\n  ledger ${pa}\n  pool   ${pb}`)
  }
  return out
}

function sessionsOf(ctx: ScenarioEngine): string[] {
  return referenceState(ctx.engine)
    .sessions.filter((s) => s.issueId && !s.archived)
    .map((s) => s.sessionId)
}

/**
 * POD-5432: the suite runs once per ownership step: issues owned (plan step 5;
 * the ledger still paints sessions) and both owned (step 6). Each step must
 * show exactly what the ledger shows, row by row and screen by screen.
 */
describe.each([
  ['issues and sessions owned', ['issue', 'session']],
] as const)('pool transactions against the ledger (POD-5431), %s', (_step, owns) => {
  it('paints every painting command kind exactly as the ledger does, queued offline', async () => {
    const { ctx } = await boot(1, { online: false })
    const { ledger, pooled } = pair(ctx, owns)
    const t = ctx.targets
    const [s1, s2] = sessionsOf(ctx)
    expect(s1 && s2).toBeTruthy()
    const session = asSessionId(s1!)
    const other = asSessionId(s2!)
    expect(differences(ctx, ledger.pool, pooled.pool)).toEqual([])
    const steps: [Kind, unknown, string[]][] = [
      ['rename', { sessionId: session, name: '  Renamed session ' }, []],
      ['setArchived', { sessionId: other, archived: true }, []],
      ['setWorkState', { sessionId: session, workState: 'done' }, []],
      ['snoozeSet', { sessionId: session, until: null }, []],
      ['snoozeClear', { sessionId: session }, []],
      ['snoozeSet', { sessionId: other, until: '2026-12-01T00:00:00.000Z' }, []],
      ['sessionMarkRead', { sessionId: session }, []],
      ['sessionMarkUnread', { sessionId: other }, []],
      ['dismissOffer', { sessionId: session, offerCreatedAt: '2026-01-01T00:00:00.000Z' }, []],
      ['resumeAndSend', { sessionId: other, text: 'wake up' }, []],
      ['sendText', { sessionId: session, text: 'hello' }, []],
      ['issueMarkRead', { id: t.markReadId }, [t.markReadId]],
      ['issueMarkUnread', { id: t.visibleRootId }, [t.visibleRootId]],
      ['issueSetTucked', { id: t.stageMoveId, tucked: true }, [t.stageMoveId]],
      [
        'issueUpdate',
        {
          id: t.visibleRootId,
          patch: {
            title: 'Pool title',
            stage: 'review',
            pinned: true,
            description: 'Painted text',
          },
        },
        [t.visibleRootId],
      ],
      ['issueUpdate', { id: t.visibleRootId, patch: { title: 'Second title' } }, [t.visibleRootId]],
      ['issueClose', { id: t.stageMoveId, reason: 'done' }, [t.stageMoveId]],
      ['issueDefer', { id: t.archiveId, until: '2026-12-01' }, [t.archiveId]],
      ['issueUndefer', { id: t.archiveId }, [t.archiveId]],
      ['issueSetLabels', { id: t.markReadId, labels: ['b', ' a ', 'a', ''] }, [t.markReadId]],
      [
        'issueSetPlacement',
        { id: t.reparentId, placement: 'own', originId: t.reparentToId },
        [t.reparentId],
      ],
      [
        'issueSetPlacement',
        { id: t.reparentId, placement: 'mission', originId: t.reparentToId },
        [t.reparentId, t.reparentToId],
      ],
      ['issueArchive', { id: t.archiveId }, [t.archiveId]],
      ['issueDelete', { id: t.evictId }, [t.evictId]],
      ['issueRestore', { id: t.evictId }, [t.evictId]],
    ]
    const painted = new Set<string>()
    for (const [kind, input, focus] of steps) {
      pooled.pool.mutate(kind, input as OutboxKinds[typeof kind])
      painted.add(kind)
      await settle(ctx)
      expect(differences(ctx, ledger.pool, pooled.pool, focus), kind).toEqual([])
    }
    // A model setter is the same write path (`issue.title = x` → `pool.mutate`).
    const model = tracked(() => pooled.pool.issue(t.markReadId))!
    model.title = 'Through the setter'
    expect(tracked(() => pooled.pool.issue(t.markReadId)?.title)).toBe('Through the setter')
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.markReadId])).toEqual([])
    // Every kind the shared reducers paint was driven through the pool.
    const silent = new Set([
      'pinSet',
      'tabSetOrder',
      'layoutSet',
      'layoutClear',
      'settingsUpdatePersonal',
      'sendText',
    ])
    const paintingKinds = [
      'rename',
      'setArchived',
      'setWorkState',
      'snoozeSet',
      'snoozeClear',
      'sessionMarkRead',
      'sessionMarkUnread',
      'dismissOffer',
      'resumeAndSend',
      'issueMarkRead',
      'issueMarkUnread',
      'issueSetTucked',
      'issueUpdate',
      'issueClose',
      'issueDefer',
      'issueUndefer',
      'issueSetLabels',
      'issueSetPlacement',
      'issueArchive',
      'issueDelete',
      'issueRestore',
    ]
    expect(paintingKinds.length + silent.size).toBe(27)
    for (const kind of paintingKinds) expect(painted, kind).toContain(kind)
  }, 120_000)

  it('rebases a refusal in the middle of a chain on the accepted state', async () => {
    const answers: {
      input: { patch: Record<string, unknown> }
      resolve: (v: unknown) => void
      reject: (e: unknown) => void
    }[] = []
    const server: ScenarioServer = {
      issueUpdate: (input) =>
        new Promise((resolve, reject) => answers.push({ input, resolve, reject })),
    }
    const { ctx } = await boot(1, { online: true, server })
    const { ledger, pooled } = pair(ctx, owns)
    const id = ctx.targets.visibleRootId
    const check = () => expect(differences(ctx, ledger.pool, pooled.pool, [id])).toEqual([])
    const refusals: { title: unknown; parked: boolean; shown: unknown }[] = []
    pooled.transactions!.onRejected((rejection) => {
      refusals.push({
        title: (rejection.input as { patch: { title?: string } }).patch.title,
        parked: rejection.parked,
        // Announced after the rebase: the model already shows the accepted title.
        shown: tracked(() => pooled.pool.issue(id)?.title),
      })
    })
    pooled.pool.mutate('issueUpdate', { id, patch: { title: 'A' } })
    // Painted at the press, in the same action, ahead of the durable commit.
    expect(tracked(() => pooled.pool.issue(id)?.title)).toBe('A')
    pooled.pool.mutate('issueUpdate', { id, patch: { title: 'B' } })
    pooled.pool.mutate('issueUpdate', { id, patch: { stage: 'review' } })
    await settle(ctx)
    check()
    expect(tracked(() => pooled.pool.issue(id)?.title)).toBe('B')
    // A lands; its echo follows.
    answers.shift()!.resolve({})
    await settle(ctx)
    check()
    upsertIssue(ctx, id, { title: 'A' }, 5)
    await settle(ctx)
    check()
    // B is refused definitively: it parks (authored text) and the row rebases
    // onto the accepted title with the later stage change still on top.
    const refused = answers.shift()!
    expect(refused.input.patch.title).toBe('B')
    refused.reject(
      Object.assign(new Error('conflict'), { data: { code: 'CONFLICT', httpStatus: 409 } }),
    )
    await settle(ctx)
    check()
    expect(tracked(() => pooled.pool.issue(id)?.title)).toBe('A')
    expect(tracked(() => pooled.pool.issue(id)?.stage)).toBe('review')
    expect(refusals).toEqual([{ title: 'B', parked: true, shown: 'A' }])
    // Nothing waits behind the refusal: the stage change goes, lands, echoes.
    await settle(ctx)
    answers.shift()!.resolve({})
    await settle(ctx)
    check()
    upsertIssue(ctx, id, { stage: 'review' }, 6)
    await settle(ctx)
    check()
    expect(answers).toHaveLength(0)
  }, 120_000)

  it('holds an applied change until truth covers it, and lets a competing write win', async () => {
    const { ctx } = await boot(1, { online: true, server: { issueUpdate: async () => ({}) } })
    const { ledger, pooled } = pair(ctx, owns)
    const t = ctx.targets
    const check = (id: string) =>
      expect(differences(ctx, ledger.pool, pooled.pool, [id])).toEqual([])
    // Applied, echo not here yet: the paint holds (awaiting truth).
    pooled.pool.mutate('issueUpdate', { id: t.visibleRootId, patch: { title: 'Applied' } })
    await settle(ctx)
    expect(ctx.engine.outbox.pending()).toHaveLength(0)
    check(t.visibleRootId)
    expect(tracked(() => pooled.pool.issue(t.visibleRootId)?.title)).toBe('Applied')
    // An unrelated cell moving is not coverage: still held.
    upsertIssue(ctx, t.visibleRootId, { description: 'Unrelated edit' }, 7)
    await settle(ctx)
    check(t.visibleRootId)
    expect(tracked(() => pooled.pool.issue(t.visibleRootId)?.title)).toBe('Applied')
    // Another writer's title wins over the held one (moved past the baseline).
    upsertIssue(ctx, t.visibleRootId, { title: 'Someone else' }, 8)
    await settle(ctx)
    check(t.visibleRootId)
    expect(tracked(() => pooled.pool.issue(t.visibleRootId)?.title)).toBe('Someone else')
    // The plain case: the echo covers it.
    pooled.pool.mutate('issueUpdate', { id: t.markReadId, patch: { title: 'Echoed' } })
    await settle(ctx)
    check(t.markReadId)
    upsertIssue(ctx, t.markReadId, { title: 'Echoed' }, 9)
    await settle(ctx)
    check(t.markReadId)
    expect(tracked(() => pooled.pool.issue(t.markReadId)?.title)).toBe('Echoed')
  }, 120_000)

  it('paints a per-user row the server never wrote (absent means nothing set)', async () => {
    const { ctx } = await boot(1, { online: false })
    const { ledger, pooled } = pair(ctx, owns)
    const t = ctx.targets
    const [s1] = sessionsOf(ctx)
    const user = asUserId('u-bench')
    // The server deletes a per-user row whose markers are all unset.
    remove(ctx, 'issueUserState', issueUserStateRowId(user, asIssueId(t.markReadId)))
    remove(ctx, 'sessionUserState', sessionUserStateRowId(user, asSessionId(s1!)))
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.markReadId])).toEqual([])
    pooled.pool.mutate('issueMarkRead', { id: t.markReadId })
    pooled.pool.mutate('issueSetTucked', { id: t.markReadId, tucked: true })
    pooled.pool.mutate('sessionMarkRead', { sessionId: asSessionId(s1!) })
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.markReadId])).toEqual([])
    expect(
      tracked(
        () => (pooled.pool.row('issue', t.markReadId, 'peek') as { readAt?: unknown })?.readAt,
      ),
    ).toBeTruthy()
  }, 120_000)

  it('repaints the durable queue after an offline reload', async () => {
    const { ctx } = await boot(1, { online: false })
    let handles = pair(ctx, owns)
    const t = ctx.targets
    const [s1] = sessionsOf(ctx)
    handles.pooled.pool.mutate('issueUpdate', {
      id: t.visibleRootId,
      patch: { title: 'Before reload' },
    })
    handles.pooled.pool.mutate('issueMarkRead', { id: t.markReadId })
    handles.pooled.pool.mutate('issueSetTucked', { id: t.stageMoveId, tucked: true })
    handles.pooled.pool.mutate('rename', { sessionId: asSessionId(s1!), name: 'Queued name' })
    await settle(ctx)
    expect(differences(ctx, handles.ledger.pool, handles.pooled.pool, [t.visibleRootId])).toEqual(
      [],
    )
    handles.pooled.dispose()
    handles.ledger.dispose()
    await ctx.reload()
    handles = pair(ctx, owns)
    await settle(ctx)
    expect(
      differences(ctx, handles.ledger.pool, handles.pooled.pool, [t.visibleRootId, t.markReadId]),
    ).toEqual([])
    expect(tracked(() => handles.pooled.pool.issue(t.visibleRootId)?.title)).toBe('Before reload')
  }, 120_000)

  it('adopts spawn placeholders and takes them back after a failed create', async () => {
    const server: ScenarioServer = {
      sessionsCreate: () =>
        Promise.reject(
          Object.assign(new Error('refused'), { data: { code: 'BAD_REQUEST', httpStatus: 400 } }),
        ),
    }
    const { ctx } = await boot(1, { online: true, server })
    const { ledger, pooled } = pair(ctx, owns)
    const repo = ctx.targets.newIssueRepo
    const spawned = referenceState(ctx.engine).spawnDraftAgent({
      target: { path: repo.repoPath, repoPath: repo.repoPath, repoId: repo.repoId as never },
      agentKind: 'claude-code',
      firstPrompt: 'Start here',
    })
    await settle(ctx)
    expect(referenceState(ctx.engine).pendingSpawnIds.has(spawned.sessionId)).toBe(true)
    expect(differences(ctx, ledger.pool, pooled.pool, [spawned.issueId])).toEqual([])
    expect(tracked(() => pooled.pool.row('session', spawned.sessionId, 'peek'))).toBeDefined()
    // POD-5432 step 6: owning sessions, pool screens read the placeholders
    // (adapters 4 and 12) from the log; the ledger's copy answers otherwise.
    const ownsSessions = owns.includes('session' as never)
    // Which map answers is fixed at attachment; only its entries are tracked.
    const placeholders = () => pooled.pool.spawnPlaceholders()
    expect(placeholders() !== null).toBe(ownsSessions)
    if (ownsSessions) {
      expect(tracked(() => placeholders()!.has(spawned.sessionId))).toBe(true)
      expect(tracked(() => placeholders()!.get(spawned.sessionId))).toBe('Start here')
      expect(referenceState(ctx.engine).pendingSpawnPrompts[spawned.sessionId]).toBe('Start here')
    }
    expect(await spawned.settled).toBe(false)
    await settle(ctx)
    expect(referenceState(ctx.engine).pendingSpawnIds.has(spawned.sessionId)).toBe(false)
    if (ownsSessions) expect(tracked(() => placeholders()!.has(spawned.sessionId))).toBe(false)
    expect(differences(ctx, ledger.pool, pooled.pool)).toEqual([])
    expect(tracked(() => pooled.pool.row('session', spawned.sessionId, 'peek'))).toBeUndefined()
  }, 120_000)

  it("adopts another tab's and the legacy screens' writes from the outbox", async () => {
    const { ctx } = await boot(1, { online: false })
    const { ledger, pooled } = pair(ctx, owns)
    const t = ctx.targets
    // Another tab: a record lands in the shared queue without this runtime's paint.
    await ctx.engine.outbox.enqueue('issueSetTucked', { id: t.stageMoveId, tucked: true })
    await ctx.engine.outbox.enqueue('issueUpdate', {
      id: t.visibleRootId,
      patch: { title: 'Other tab' },
    })
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.visibleRootId])).toEqual([])
    expect(tracked(() => pooled.pool.issue(t.visibleRootId)?.title)).toBe('Other tab')
    // A legacy screen: the runtime's own actions.
    await referenceState(ctx.engine).markIssueRead(asIssueId(t.markReadId))
    await ctx.engine.access.updateIssue(asIssueId(t.visibleRootId), { title: 'Runtime action' })
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.visibleRootId, t.markReadId])).toEqual([])
  }, 120_000)

  it('keeps a change on an evicted row and repaints it on readmission, and across a rescope', async () => {
    const { ctx } = await boot(1, { online: false })
    const { ledger, pooled } = pair(ctx, owns)
    const t = ctx.targets
    pooled.pool.mutate('issueUpdate', { id: t.evictId, patch: { title: 'Survives eviction' } })
    pooled.pool.mutate('issueUpdate', { id: t.visibleRootId, patch: { title: 'Survives rescope' } })
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.evictId])).toEqual([])
    const before = ctx.cache.read('issueProjection', t.evictId)!.value
    evict(ctx, 'issueProjection', t.evictId)
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool)).toEqual([])
    upsert(ctx, 'issueProjection', t.evictId, before, 3, true)
    await settle(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.evictId])).toEqual([])
    expect(tracked(() => pooled.pool.issue(t.evictId)?.title)).toBe('Survives eviction')
    await writeRescopeGrow(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.visibleRootId])).toEqual([])
    await writeRescopeBack(ctx)
    expect(differences(ctx, ledger.pool, pooled.pool, [t.visibleRootId])).toEqual([])
    expect(tracked(() => pooled.pool.issue(t.visibleRootId)?.title)).toBe('Survives rescope')
  }, 120_000)

  it('fails the comparison when the pool reduces a command wrongly (planted)', async () => {
    const { ctx } = await boot(1, { online: false })
    const ledger = createRuntimeWorklistPool(ctx.engine)
    cleanups.push(() => ledger.dispose())
    // The production wiring of `owns`, with one wrong reducer.
    const engine = ctx.engine
    const transactions = createPoolTransactions({
      userId: engine.principal.userId,
      outbox: engine.outbox,
      outcomes: engine.subscribeOutboxOutcomes,
      enqueue: async (kind, input, opts) => { await engine.outbox.enqueue(kind, input, opts) },
      addressed: ctx.replica.subscribeAddressedBatch!.bind(ctx.replica),

      reduce: (entry) =>
        overlaysForOutboxEntry(entry).map((o) =>
          o.op === 'patch' && typeof o.patch.title === 'string'
            ? { ...o, patch: { ...o.patch, title: `${o.patch.title}!` } }
            : o,
        ),
    })
    const rows = createRowSource(engine, engine.replica, {
      mode: 'pooled',
      pending: transactions.pending,
      owned: new Set(['issue', 'session']),
    })
    const locals = createEngineLocals(engine)
    const planted: WorklistPoolHandle = createWorklistPool(rows.source, locals.source)
    transactions.bind(rows)
    planted.pool.attachTransactions(transactions)
    cleanups.push(() => {
      planted.dispose()
      transactions.dispose()
      locals.dispose()
      rows.dispose()
    })
    expect(differences(ctx, ledger.pool, planted.pool)).toEqual([])
    planted.pool.mutate('issueUpdate', {
      id: ctx.targets.visibleRootId,
      patch: { title: 'Planted' },
    })
    await settle(ctx)
    const found = differences(ctx, ledger.pool, planted.pool, [ctx.targets.visibleRootId])
    expect(found.some((d) => d.startsWith(`issue:${ctx.targets.visibleRootId}`))).toBe(true)
    expect(found.some((d) => d.startsWith('sidebar'))).toBe(true)
  }, 120_000)

  it('costs a click the same keyed reads and derivations at 1x and 4x (visible neighbourhood bound)', async () => {
    const cell = async (scale: 1 | 4) => {
      const { ctx } = await boot(scale, { online: false })
      // Count the feed's keyed reads: the row source binds `replica.row` when
      // it is built, so the counter goes in first and counts only the click.
      const replica = ctx.replica as unknown as { row: (...args: unknown[]) => unknown }
      const original = replica.row.bind(ctx.replica)
      let counting = false
      let reads = 0
      replica.row = (...args: unknown[]) => {
        if (counting) reads += 1
        return original(...args)
      }
      const pooled = createRuntimeWorklistPool(ctx.engine, { owns })
      cleanups.push(() => pooled.dispose())
      const pool = pooled.pool
      // A mounted sidebar: the layout and each visible row's displayed cells.
      const stop = autorun(() => {
        void pool.groups.layout
        for (const id of visibleOrderOf(pool)) {
          const model = pool.issue(id)
          void model?.title
          void model?.stage
        }
      })
      cleanups.push(stop)
      await settle(ctx)
      const id = ctx.targets.visibleRootId
      const state = (): NeighbourhoodState => {
        const store = referenceState(ctx.engine)
        return {
          issues: store.issueProjections,
          sessions: store.sessions,
          order: snapshotFromStore(store, localsOfEngine(ctx.engine)).order,
        }
      }
      const before = state()
      const { work } = await measureWork(async () => {
        counting = true
        try {
          pool.mutate('issueUpdate', { id, patch: { title: `Clicked at ${scale}x` } })
        } finally {
          counting = false
        }
      })
      await settle(ctx)
      expect(tracked(() => pool.issue(id)?.title)).toBe(`Clicked at ${scale}x`)
      const neighbourhood = neighbourhoodOf(before, state(), [`issue:${id}`], [id]).members.size
      return { reads, derivations: work.derivations, neighbourhood }
    }
    const one = await cell(1)
    const four = await cell(4)
    const ratio = Math.max(1, four.neighbourhood / one.neighbourhood)
    console.info(
      `[POD-5431 meter] one click: 1x ${JSON.stringify(one)}; 4x ${JSON.stringify(four)}`,
    )
    expect(one.reads).toBeGreaterThan(0)
    expect(
      four.reads / one.reads,
      `reads ${one.reads} → ${four.reads}, neighbourhood ×${ratio}`,
    ).toBeLessThanOrEqual(ratio)
    expect(
      four.derivations / Math.max(1, one.derivations),
      `derivations ${one.derivations} → ${four.derivations}, neighbourhood ×${ratio}`,
    ).toBeLessThanOrEqual(ratio)
  }, 240_000)
})

/**
 * POD-5432 — what owning a kind adds on top of the comparison above: the
 * runtime's actions (every screen's write) paint the pool's rows in the press's
 * tick through the log, an owned kind never asks the ledger, a refusal rewinds
 * once, and a row is one plain object, the same on every read.
 */
describe.each([
  ['issues and sessions owned', ['issue', 'session']],
] as const)('pool-owned kinds on pool screens (POD-5432), %s', (_step, owns) => {
  it('paints a runtime action in the press tick through the log; legacy screens still see it', async () => {
    const { ctx } = await boot(1, { online: false })
    const { ledger, pooled } = pair(ctx, owns)
    const t = ctx.targets
    const [s1] = sessionsOf(ctx)
    const store = referenceState(ctx.engine)
    void store.updateIssue(asIssueId(t.visibleRootId), { title: 'Routed' } as never)
    void store.renameSession(asSessionId(s1!), 'Routed session')
    // The same tick: nothing is durable yet, the log already painted.
    expect(tracked(() => pooled.pool.issue(t.visibleRootId)?.title)).toBe('Routed')
    expect(pooled.transactions!.size()).toBe(2)
    await settle(ctx)
    // One record per press: the log enqueued through the ledger, never twice.
    expect(ctx.engine.outbox.pending().map((e) => e.kind)).toEqual(['issueUpdate', 'rename'])
    const legacy = referenceState(ctx.engine)
    expect(legacy.issueProjections.find((row) => row.id === t.visibleRootId)?.title).toBe('Routed')
    expect(legacy.sessions.find((row) => row.sessionId === s1)?.name).toBe('Routed session')
    expect(differences(ctx, ledger.pool, pooled.pool, [t.visibleRootId])).toEqual([])
  }, 120_000)

  it('refuses a write until its pool transaction owner is attached', async () => {
    const { ctx } = await boot(1, { online: false })
    const engine = ctx.engine
    // The production wiring of `owns`, minus `attachPoolWriter`.
    const transactions = createPoolTransactions({
      userId: engine.principal.userId,
      outbox: engine.outbox,
      outcomes: engine.subscribeOutboxOutcomes,
      enqueue: async (kind, input, opts) => { await engine.outbox.enqueue(kind, input, opts) },
      addressed: ctx.replica.subscribeAddressedBatch!.bind(ctx.replica),

    })
    const rows = createRowSource(engine, engine.replica, {
      mode: 'pooled',
      pending: transactions.pending,
      owned: new Set(['issue', 'session']),
    })
    const locals = createEngineLocals(engine)
    const planted = createWorklistPool(rows.source, locals.source)
    transactions.bind(rows)
    planted.pool.attachTransactions(transactions)
    cleanups.push(() => {
      planted.dispose()
      transactions.dispose()
      locals.dispose()
      rows.dispose()
    })
    const id = ctx.targets.visibleRootId
    const before = tracked(() => planted.pool.issue(id)?.title)
    await expect(engine.access.updateIssue(asIssueId(id), { title: 'Routed' } as never)).rejects.toThrow('pool')
    expect(tracked(() => planted.pool.issue(id)?.title)).toBe(before)
    expect(engine.outbox.pending()).toEqual([])
  }, 120_000)

  it('rewinds a refusal once, and serves one plain row object per value', async () => {
    const answers: { reject: (e: unknown) => void }[] = []
    const server: ScenarioServer = {
      issueUpdate: () => new Promise((_resolve, reject) => answers.push({ reject })),
    }
    const { ctx } = await boot(1, { online: true, server })
    const { ledger, pooled } = pair(ctx, owns)
    const id = ctx.targets.visibleRootId
    const original = tracked(() => pooled.pool.issue(id)?.title)
    const seen: unknown[] = []
    const stop = autorun(() => {
      seen.push(pooled.pool.row('issue', id))
    })
    cleanups.push(stop)
    void referenceState(ctx.engine).updateIssue(asIssueId(id), { title: 'Refused' } as never)
    const painted = tracked(() => pooled.pool.row('issue', id))
    // One plain object, the table's own, on every read: no read-time overlay.
    expect(tracked(() => pooled.pool.row('issue', id))).toBe(painted)
    expect(types.isProxy(painted)).toBe(false)
    expect((painted as { title: string }).title).toBe('Refused')
    await settle(ctx)
    expect(tracked(() => pooled.pool.row('issue', id))).toBe(painted)
    const runs = seen.length
    answers
      .shift()!
      .reject(Object.assign(new Error('conflict'), { data: { code: 'CONFLICT', httpStatus: 409 } }))
    await settle(ctx)
    expect(tracked(() => pooled.pool.issue(id)?.title)).toBe(original)
    // Exactly one rewind: one new row object after the refusal, never a
    // second fold of the same refusal from the ledger.
    expect(seen.length - runs).toBe(1)
    expect(differences(ctx, ledger.pool, pooled.pool, [id])).toEqual([])
  }, 120_000)

  it('costs a runtime action the same keyed reads and derivations at 1x and 4x', async () => {
    const cell = async (scale: 1 | 4) => {
      const { ctx } = await boot(scale, { online: false })
      const replica = ctx.replica as unknown as { row: (...args: unknown[]) => unknown }
      const original = replica.row.bind(ctx.replica)
      let counting = false
      let reads = 0
      replica.row = (...args: unknown[]) => {
        if (counting) reads += 1
        return original(...args)
      }
      const pooled = createRuntimeWorklistPool(ctx.engine, { owns })
      cleanups.push(() => pooled.dispose())
      const pool = pooled.pool
      const stop = autorun(() => {
        void pool.groups.layout
        for (const id of visibleOrderOf(pool)) {
          const model = pool.issue(id)
          void model?.title
          void model?.stage
        }
      })
      cleanups.push(stop)
      await settle(ctx)
      const id = ctx.targets.visibleRootId
      const state = (): NeighbourhoodState => {
        const store = referenceState(ctx.engine)
        return {
          issues: store.issueProjections,
          sessions: store.sessions,
          order: snapshotFromStore(store, localsOfEngine(ctx.engine)).order,
        }
      }
      const before = state()
      const { work } = await measureWork(async () => {
        counting = true
        try {
          void referenceState(ctx.engine)
            .updateIssue(asIssueId(id), { title: `Action at ${scale}x` } as never)
        } finally {
          counting = false
        }
      })
      await settle(ctx)
      expect(tracked(() => pool.issue(id)?.title)).toBe(`Action at ${scale}x`)
      const neighbourhood = neighbourhoodOf(before, state(), [`issue:${id}`], [id]).members.size
      return { reads, derivations: work.derivations, neighbourhood }
    }
    const one = await cell(1)
    const four = await cell(4)
    const ratio = Math.max(1, four.neighbourhood / one.neighbourhood)
    console.info(
      `[POD-5432 meter ${owns.join('+')}] one action: 1x ${JSON.stringify(one)}; 4x ${JSON.stringify(four)}`,
    )
    expect(one.reads).toBeGreaterThan(0)
    expect(four.reads / one.reads, `reads ${one.reads} → ${four.reads}`).toBeLessThanOrEqual(ratio)
    expect(
      four.derivations / Math.max(1, one.derivations),
      `derivations ${one.derivations} → ${four.derivations}`,
    ).toBeLessThanOrEqual(ratio)
  }, 240_000)
})
