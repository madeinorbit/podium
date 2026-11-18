/**
 * POD-7165: open a flight deck over a large tree (about 1,000 issues, several
 * sessions each) through the real kernel Replica, facade, row source, pool and
 * mission screen, composed as the app composes them (assembly.ts), and count
 * and time the work the opening does. The regression test bounds the counts;
 * `scripts/large-answer-profile.ts` prints them for a CPU profile.
 */
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import {
  CollectionServer,
  issue,
  session,
  WORLD_NOW,
} from '../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../sync/src/conformance/in-memory'
import { CollectionLoader, type LoaderSchedule } from '../../sync/src/replica/loader'
import { Replica } from '../../sync/src/replica/replica'
import type { CachePolicy } from '../../sync/src/replica/types'
import { createWorklistPool } from './create'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'

const ISSUE = 'issueProjection'
const POLICY: CachePolicy = {
  clientType: 'browser',
  steps: [
    { step: 'always', collections: ['session.live'] },
    { step: 'view', collections: [] },
    { step: 'sidebar', collections: ['issueProjection.sidebar'] },
    { step: 'stubs', collections: ['issueProjection.stubs'] },
  ],
  recentDays: 30,
  cacheCap: 1_000,
}

const ticks = async (count = 8): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function manualSchedule(): { schedule: LoaderSchedule; due: () => void } {
  let run: (() => void) | null = null
  return {
    schedule: (fn) => {
      run = fn
      return () => {
        run = null
      }
    },
    due: () => {
      const fn = run
      run = null
      fn?.()
    },
  }
}

const value = (id: string, fields: Record<string, unknown> = {}) =>
  issue(id, { repoPath: '/synthetic', createdAt: '2025-01-01T00:00:00Z', ...fields })

export interface LargeDeckRun {
  readonly members: number
  readonly sessions: number
  readonly ready: boolean
  readonly rows: number
  readonly bootMs: number
  readonly openMs: number
  readonly stages: readonly { readonly stage: string; readonly ms: number }[]
  /** Event bursts the Replica emitted while the deck opened: one per install. */
  readonly bursts: number
  /** Changes the loader told the views while the deck opened. */
  readonly notifications: number
  /** Cache trims while the deck opened. */
  readonly trims: number
  /** Row-source publications while the deck opened. */
  readonly flushes: number
  /** The longest single burst or publication while the deck opened, in ms. */
  readonly longestMs: number
  /** Each publication into the pool while the deck opened, with its reactions, in ms. */
  readonly publications: readonly number[]
  /** Each burst of the Replica's events while the deck opened, with what it ran, in ms. */
  readonly burstMs: readonly number[]
  readonly dispose: () => void
}

export async function openLargeDeck(
  options: {
    readonly members?: number
    readonly sessionsPerIssue?: number
    readonly chunkRows?: number
    /** Compose the loader's burst (the app does); false reproduces the old wiring. */
    readonly loaderBatch?: boolean
    readonly log?: (line: string) => void
  } = {},
): Promise<LargeDeckRun> {
  const memberCount = options.members ?? 1_000
  const perIssue = options.sessionsPerIssue ?? 7
  const log = options.log ?? (() => {})
  const t0 = performance.now()
  const server = new CollectionServer()
  server.policy = POLICY
  server.chunkRows = options.chunkRows ?? 500
  server.put(ISSUE, 'R', value('R', { stage: 'in_progress' }))
  let sessions = 0
  const ids: string[] = []
  // A tree three levels deep: 10 children of the root, 10 under each, the rest below.
  for (let n = 0; n < memberCount; n += 1) {
    const id = `M${n + 1}`
    const parentId = n < 10 ? 'R' : n < 110 ? ids[(n - 10) % 10]! : ids[10 + ((n - 110) % 100)]!
    ids.push(id)
    server.put(
      ISSUE,
      id,
      value(id, {
        parentId,
        stage: n % 3 === 0 ? 'in_progress' : 'done',
        closedReason: n % 3 === 0 ? null : 'completed',
      }),
    )
    for (let s = 0; s < perIssue; s += 1) {
      server.put(
        'session',
        `S-${id}-${s}`,
        session(`S-${id}-${s}`, { issueId: id, status: 'ended', cwd: '/synthetic' }),
      )
      sessions += 1
    }
  }
  const storage = await inMemoryInstantiation.open()
  const { cache } = storage.viewFor('u-ada')
  const timer = manualSchedule()
  let loader: CollectionLoader | undefined
  let replica: Replica | undefined
  const facade = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
    exits: (entity, id) => replica?.exitKind(entity, id),
    collections: () => replica,
    loader: () => loader,
  })
  const stages: { stage: string; ms: number }[] = []
  let bursts = 0
  let opening = false
  const burstMs: number[] = []
  let longestMs = 0
  replica = new Replica({
    store: cache,
    authority: server,
    now: () => WORLD_NOW,
    view: () => loader?.takeView() ?? [],
    request: (specs) => loader?.request(specs),
    onEvent: (event) => {
      facade.onKernelEvent(event)
      loader?.onEvent(event)
    },
    batchEvents: (emit) => {
      bursts += 1
      const at = performance.now()
      // The app's composition (assembly.ts); without the loader's burst on request.
      const batch = options.loaderBatch === false ? undefined : loader?.batch?.bind(loader)
      if (batch === undefined) facade.batch(emit)
      else batch(() => facade.batch(emit))
      const ms = performance.now() - at
      if (opening) {
        longestMs = Math.max(longestMs, ms)
        burstMs.push(ms)
      }
      if (ms > 50) {
        stages.push({ stage: 'batch', ms })
        log(`batch ${ms.toFixed(0)} ms`)
      }
    },
  })
  loader = new CollectionLoader({ replica, schedule: timer.schedule })
  const rows = createRowSource({ principal: { userId: 'u-ada' } }, facade, {
    pending: { byRow: () => new Map() },
  })
  const locals = fixedLocals({ selectedIssueId: null, coarseNow: WORLD_NOW })
  const handle = createWorklistPool(rows.source, locals.source, { schedule: () => () => {} })
  // Each publication into the pool, and the reactions it runs, timed.
  const applyPool = handle.pool.apply.bind(handle.pool)
  const publications: number[] = []
  handle.pool.apply = (event) => {
    const at = performance.now()
    applyPool(event)
    if (opening) publications.push(performance.now() - at)
  }
  const kernel = replica
  const timed = (stage: string, fn: () => void) => {
    const at = performance.now()
    fn()
    const ms = performance.now() - at
    if (opening) longestMs = Math.max(longestMs, ms)
    if (ms > 50) {
      stages.push({ stage, ms })
      log(`${stage} ${ms.toFixed(0)} ms`)
    }
  }
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await kernel.settled()
      await ticks()
      timed('loader.due', () => timer.due())
      await loader!.flush()
      await kernel.settled()
      await ticks()
      timed('rows.flush', () => rows.flush())
      timed('pool.hydrate', () => handle.pool.hydrate())
    }
  }
  kernel.connect()
  await settle()
  const bootMs = performance.now() - t0
  log(`boot ${bootMs.toFixed(0)} ms`)
  attachMissionTestPreferences(handle.pool)
  const t1 = performance.now()
  opening = true
  const burstsBefore = bursts
  const notificationsBefore = loader!.stats.notifications
  const flushesBefore = rows.stats.flushes
  const trimsBefore = kernel.stats().trims
  const screen = new MissionScreen(handle.pool, 'R', { sessionName: (s) => s.name ?? '' })
  let shown = 0
  const stop = autorun(() => {
    if (!screen.ready) return
    shown = screen.rows.length
  })
  for (let round = 0; round < 6 && !screen.ready; round += 1) await settle()
  const openMs = performance.now() - t1
  opening = false
  const flushes = rows.stats.flushes - flushesBefore
  log(`open ${openMs.toFixed(0)} ms ready=${screen.ready} rows=${shown}`)
  return {
    members: memberCount,
    sessions,
    ready: screen.ready,
    rows: shown,
    bootMs,
    openMs,
    stages,
    bursts: bursts - burstsBefore,
    notifications: loader!.stats.notifications - notificationsBefore,
    flushes,
    trims: kernel.stats().trims - trimsBefore,
    longestMs,
    publications,
    burstMs,
    dispose: () => {
      stop()
      screen.close()
      replica?.disconnect()
      rows.dispose()
      locals.dispose()
      handle.dispose()
    },
  }
}
