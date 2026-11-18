/**
 * POD-7165: open a flight deck over a large tree (about 1,000 issues, several
 * sessions each) through the real kernel Replica, facade, row source, pool and
 * mission screen, composed as the app composes them (assembly.ts), and count
 * and time the work the opening does. The regression test bounds the counts;
 * `scripts/large-answer-profile.ts` prints them for a CPU profile.
 */

import { readFile } from 'node:fs/promises'
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import {
  CollectionServer,
  issue,
  LONG_AGO,
  session,
  WORLD_NOW,
} from '../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../sync/src/conformance/in-memory'
import { TEST_BUDGETS } from '../../sync/src/conformance/test-budgets'
import { CollectionLoader, type LoaderSchedule } from '../../sync/src/replica/loader'
import { Replica } from '../../sync/src/replica/replica'
import type { CachePolicy } from '../../sync/src/replica/types'
import { createWorklistPool } from './create'
import { LOADING } from './loading'
import { MissionScreen } from './mission-screen'
import { attachMissionTestPreferences } from './mission-screen.test.fixture'
import type { MobxPool } from './pool'
import { fixedLocals } from './shared/locals-source'
import { createRowSource } from './shared/row-source'
import { worklistView } from './worklist/view-model'

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
  cacheCap: TEST_BUDGETS.cacheCap,
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
  /**
   * Load hops while the deck opened: the longest chain of fetches each asked
   * for only after an earlier one's answer arrived (POD-7168). The tree is
   * one, what its records come with is the second.
   */
  readonly hops: number
  /** Tree issues with an unmet blocker outside the tree, and those blockers. */
  readonly unmetOutside: readonly (readonly [string, readonly string[]])[]
  /** Every fetch while the deck opened: its hop and the collections it named. */
  readonly fetches: readonly { readonly hop: number; readonly collections: readonly string[] }[]
  /** With `holdLoadCommit`: the deck was ready while the first download's commit was still held. */
  readonly readyWhileCommitHeld: boolean
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
    /**
     * Tree issues blocked by an issue outside the tree, one each: half of
     * the blockers are proposed (unmet), half done (met). Neither is in the
     * sidebar, so the device holds them as stubs only (POD-7168).
     */
    readonly outsideBlockers?: number
    /** The server answers what records come with in the same answer, as the real route does. */
    readonly serverComesWith?: boolean
    /**
     * Hold the first download's last (durable) commit while the deck opens, as
     * a large first download still being written to IndexedDB does (POD-7168).
     * It is released once the deck has opened, or failed to.
     */
    readonly holdLoadCommit?: boolean
    /**
     * POD-7173: every member is a direct child of the root, one in twenty open,
     * as the operator's 970-issue deck is (969 children of one root, 922 done).
     */
    readonly flat?: boolean
    /**
     * POD-7173: serve a measurement corpus (`.artifacts/old-vs-new/corpus-*.json`,
     * apps/web/harness) instead of the synthetic tree, its clock moved to the
     * server's, and open the deck of its measurement tree of `tree` issues.
     */
    readonly corpus?: { readonly file: string; readonly tree: number }
    /** POD-7173: the desktop sidebar is drawn while the deck opens (its rows and their roll-ups). */
    readonly sidebar?: boolean
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
  server.answerComesWith = options.serverComesWith ?? false
  const corpus = options.corpus === undefined ? undefined : await loadCorpus(options.corpus)
  if (corpus !== undefined) {
    for (const row of corpus.issues) server.put(ISSUE, String(row['id']), row)
    for (const row of corpus.sessions) server.put('session', String(row['sessionId']), row)
    for (const row of corpus.deps) server.put('issueDep', String(row['id']), row)
  }
  const rootId = corpus?.root ?? 'R'
  if (corpus === undefined)
    server.put(
      ISSUE,
      'R',
      value('R', {
        stage: 'in_progress',
        ...(options.flat
          ? { audience: 'human', updatedAt: new Date(WORLD_NOW).toISOString() }
          : {}),
      }),
    )
  let sessions = 0
  const ids: string[] = []
  const blockers = options.outsideBlockers ?? 0
  const every = blockers > 0 ? Math.max(3, Math.floor(memberCount / blockers / 3) * 3) : 0
  // A tree three levels deep: 10 children of the root, 10 under each, the rest
  // below; or, flat, every member a child of the root.
  // Flat mirrors the operator corpus's 970-issue tree (`measurement-corpus.ts`):
  // the root and its first 47 children open, the 922 others closed long ago.
  const open = (n: number) => (options.flat ? n < 47 : n % 3 === 0)
  for (let n = 0; corpus === undefined && n < memberCount; n += 1) {
    const id = `M${n + 1}`
    const parentId = options.flat
      ? 'R'
      : n < 10
        ? 'R'
        : n < 110
          ? ids[(n - 10) % 10]!
          : ids[10 + ((n - 110) % 100)]!
    ids.push(id)
    server.put(
      ISSUE,
      id,
      value(id, {
        parentId,
        stage: open(n) ? 'in_progress' : 'done',
        closedReason: open(n) ? null : 'completed',
        ...(options.flat
          ? {
              closedAt: open(n) ? null : LONG_AGO,
              updatedAt: open(n) ? new Date(WORLD_NOW).toISOString() : LONG_AGO,
              sortKey: String(n + 1).padStart(38, '0'),
              audience: 'human',
            }
          : {}),
      }),
    )
    if (every > 0 && n % every === 0 && n / every < blockers) {
      // An open member (n % 3 === 0) blocked by an issue outside the tree.
      const outside = `X${n / every + 1}`
      const met = (n / every) % 2 === 1
      server.put(
        ISSUE,
        outside,
        value(outside, met ? { stage: 'done', closedReason: 'completed' } : { stage: 'proposed' }),
      )
      server.put('issueDep', `D-${id}`, {
        id: `D-${id}`,
        fromId: id,
        toId: outside,
        type: 'blocked-by',
      })
    }
    for (let s = 0; s < perIssue; s += 1) {
      server.put(
        'session',
        `S-${id}-${s}`,
        session(`S-${id}-${s}`, { issueId: id, status: 'ended', cwd: '/synthetic' }),
      )
      sessions += 1
    }
  }
  // Each fetch's hop: one more than the deepest fetch whose answer had
  // arrived when it was asked for. Parallel fetches share a hop.
  let answeredHop = 0
  const fetches: { hop: number; collections: string[] }[] = []
  const answer = server.collections.bind(server)
  server.collections = (instances) => {
    const hop = answeredHop + 1
    if (opening)
      fetches.push({ hop, collections: [...new Set(instances.map((i) => i.collection))] })
    const chunks = answer(instances)
    return (async function* () {
      try {
        yield* chunks
      } finally {
        answeredHop = Math.max(answeredHop, hop)
      }
    })()
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
  // The first download's last commit, held until the deck has opened.
  let releaseCommit = () => {}
  const held = options.holdLoadCommit
    ? new Promise<void>((resolve) => {
        releaseCommit = resolve
      })
    : undefined
  let holding = held !== undefined
  let loadInstalled = false
  replica = new Replica({
    ...(held === undefined
      ? {}
      : {
          unitOfWork: {
            transact: (body) => storage.unitOfWork.transact(body),
            // The first download's chunks still being written (IndexedDB's lanes).
            durable: async () => {
              await held
              await storage.unitOfWork.durable?.()
            },
          },
        }),
    store: cache,
    authority: server,
    now: () => WORLD_NOW,
    view: () => loader?.takeView() ?? [],
    request: (specs) => loader?.request(specs),
    onEvent: (event) => {
      if (event.type === 'load-installed') loadInstalled = true
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
  // The sidebar is drawn from the first paint, before any deck opens.
  const sidebar = options.sidebar ? drawSidebar(handle.pool, rootId) : undefined
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
  // While the commit is held the kernel never settles: wait for tasks instead.
  const quiet = async () => {
    if (!holding) await kernel.settled()
    await ticks()
  }
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await quiet()
      timed('loader.due', () => timer.due())
      await loader!.flush()
      await quiet()
      timed('rows.flush', () => rows.flush())
      timed('pool.hydrate', () => handle.pool.hydrate())
    }
  }
  kernel.connect()
  await settle()
  if (holding && !loadInstalled) throw new Error('the first download never opened the views')
  const bootMs = performance.now() - t0
  log(`boot ${bootMs.toFixed(0)} ms`)
  attachMissionTestPreferences(handle.pool)
  const t1 = performance.now()
  opening = true
  answeredHop = 0
  const burstsBefore = bursts
  const notificationsBefore = loader!.stats.notifications
  const flushesBefore = rows.stats.flushes
  const trimsBefore = kernel.stats().trims
  const screen = new MissionScreen(handle.pool, rootId, { sessionName: (s) => s.name ?? '' })
  let shown = 0
  // What the Full view draws once it has settled: its rows and their words.
  const ready = () => screen.ready && screen.full.ready
  const stop = autorun(() => {
    if (!ready()) return
    shown = screen.rows.length
    for (const id of screen.full.rowIds) void screen.full.task(id).word
  })
  for (let round = 0; round < 6 && !ready(); round += 1) await settle()
  const readyWhileCommitHeld = holding && ready() && kernel.posture === 'bootstrapping'
  if (holding) {
    holding = false
    releaseCommit()
    await settle()
  }
  const openMs = performance.now() - t1
  opening = false
  const flushes = rows.stats.flushes - flushesBefore
  const unmetOutside = (ready() ? screen.full.rowIds : []).flatMap((id): [string, string[]][] => {
    const outside = screen.full.task(id).externalUnmetIds
    return outside.length > 0 ? [[id, [...outside]]] : []
  })
  log(`open ${openMs.toFixed(0)} ms ready=${screen.ready} rows=${shown}`)
  if (sidebar !== undefined) log(sidebar.drawn())
  return {
    members: corpus?.members ?? memberCount,
    sessions,
    ready: ready(),
    rows: shown,
    hops: Math.max(0, ...fetches.map((fetch) => fetch.hop)),
    readyWhileCommitHeld,
    unmetOutside,
    fetches,
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
      sidebar?.stop()
      screen.close()
      replica?.disconnect()
      rows.dispose()
      locals.dispose()
      handle.dispose()
    },
  }
}

/**
 * POD-7173: what the desktop sidebar reads while it is drawn, one observer per
 * row as the web rows are (`pool-sidebar.tsx`, `sidebarExitSnapshot`): the
 * sections and each band's rows, and on each row its ready answer and the
 * fields its paint reads, the roll-ups included.
 */
export function drawSidebar(
  pool: MobxPool,
  rootId: string,
): { stop: () => void; drawn: () => string } {
  const worklist = worklistView(pool)
  const rows = new Map<string, () => void>()
  const drawRow = (id: string) =>
    autorun(() => {
      const row = worklist.knownRow(id)
      const ready = row?.ready
      if (row === undefined || ready !== 'ready') return
      const progress = row.progress
      void [
        progress === LOADING ? null : progress,
        row.timing,
        row.visibleWorking,
        row.visibleAsking,
        row.origin,
        row.decision,
        row.mergeCommits,
        row.hasChildProgress,
        row.showsChildProgress,
        row.visibleUnread,
        row.errorClass,
        row.returnedFromDefer,
        row.canTuck,
        row.canBringBack,
        row.sessionOnlyDraft,
        row.firstSessionId,
        row.continuation,
        row.visibleFleet,
        row.sessions.length,
        row.visibleSessionIds.length,
        row.awaitingFirstPrompt,
        row.statusWord,
        row.visibleChildIds.length,
        row.selected,
        row.ownerBadge,
      ]
    })
  const sections = autorun(() => {
    const seen = new Set<string>()
    const state = worklist.layout
    const listed = worklist.sections(state)
    const visit = (ids: readonly string[]) => {
      for (const id of ids) {
        seen.add(id)
        if (!rows.has(id)) rows.set(id, drawRow(id))
        const row = worklist.knownRow(id)
        if (row?.ready === 'ready') visit(row.visibleChildIds)
      }
    }
    visit(listed.pinnedIds)
    for (const band of listed.bands) {
      visit(band.rowIds)
      visit(band.snoozedIds)
      visit(band.closedIds)
    }
    for (const [id, stop] of rows)
      if (!seen.has(id)) {
        stop()
        rows.delete(id)
      }
  })
  return {
    stop: () => {
      sections()
      for (const stop of rows.values()) stop()
      rows.clear()
    },
    drawn: () => {
      const root = worklist.knownRow(rootId)
      const progress = root?.ready === 'ready' ? root.progress : undefined
      const total = typeof progress === 'object' ? progress.total : String(progress)
      return `sidebar rows=${rows.size} root=${String(root?.ready)} present=${root?.present} below=${root?.visibleChildIds.length} nested=${root?.visibleDescendantIds.length} progress=${total}`
    },
  }
}

type CorpusRow = Record<string, unknown>

/** A measurement corpus's rows with every timestamp moved by the gap from its clock to the server's. */
export async function loadCorpus(spec: { readonly file: string; readonly tree: number }): Promise<{
  issues: CorpusRow[]
  sessions: CorpusRow[]
  deps: CorpusRow[]
  root: string
  members: number
  treeIds: readonly string[]
}> {
  const corpus = JSON.parse(await readFile(spec.file, 'utf8')) as {
    issueProjections: CorpusRow[]
    sessions: CorpusRow[]
    issueDeps: CorpusRow[]
    fixedNow: number
    measurementTrees: { root: string; size: number; ids: string[] }[]
  }
  const shift = WORLD_NOW - corpus.fixedNow
  const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/
  const moved = (value: unknown): unknown => {
    if (typeof value === 'string' && stamp.test(value))
      return new Date(Date.parse(value) + shift).toISOString()
    if (Array.isArray(value)) return value.map(moved)
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, moved(field)]))
    return value
  }
  const tree = corpus.measurementTrees.find((candidate) => candidate.size === spec.tree)
  if (tree === undefined) throw new Error(`no measurement tree of ${spec.tree} issues`)
  return {
    issues: corpus.issueProjections.map((row) => moved(row) as CorpusRow),
    sessions: corpus.sessions.map((row) => moved(row) as CorpusRow),
    deps: corpus.issueDeps,
    root: tree.root,
    members: tree.size,
    treeIds: tree.ids,
  }
}
