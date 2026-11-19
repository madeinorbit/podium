/**
 * POD-7087 — lookups through the one loader, over the real kernel Replica,
 * client facade, row source and pool, against the small collection server.
 *
 * Acceptance 3: a reader of stub fields never triggers a fetch; a reader of
 * other fields triggers exactly one.
 * Acceptance 4: offline, a lookup of an absent record reads "not available
 * offline" and recovers when the connection returns.
 * Item 6: a command on a record the device does not hold makes no
 * optimistic change.
 */
import { createKernelReplica, createSideCache, memoryStorage } from '@podium/client-core/replica'
import { autorun } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CollectionServer,
  issue,
  session,
  WORLD_NOW,
} from '../../sync/src/conformance/collection-server'
import { inMemoryInstantiation } from '../../sync/src/conformance/in-memory'
import { policyBudgets, TEST_BUDGETS } from '../../sync/src/conformance/test-budgets'
import { instanceKey } from '../../sync/src/replica/cache-state'
import { CollectionLoader, type LoaderSchedule } from '../../sync/src/replica/loader'
import { manualMemorySignals } from '../../sync/src/replica/memory'
import { Replica } from '../../sync/src/replica/replica'
import type { CachePolicy, InstanceSpec } from '../../sync/src/replica/types'
import { oneRecordOf } from './collections'
import { createWorklistPool } from './create'
import { createBoardLayout } from './issue-board-layout'
import type { BoardColumnOptions } from './issue-board-schema'
import { LOADING } from './loading'
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
  ...policyBudgets(TEST_BUDGETS),
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

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

async function boot(
  world: (server: CollectionServer) => void = (server) => {
    server.put(ISSUE, 'OPEN', value('OPEN', { stage: 'in_progress' }))
    server.put(ISSUE, 'OLD', value('OLD', { stage: 'done', closedReason: 'completed' }))
  },
  memory: { readonly warmInstances?: number } = {},
) {
  const server = new CollectionServer()
  server.policy = POLICY
  server.chunkRows = 50
  world(server)
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
  // Memory shrinks only when the platform says so (POD-7161); the test is the platform.
  const signals = manualMemorySignals()
  replica = new Replica({
    store: cache,
    authority: server,
    now: () => WORLD_NOW,
    memory: { signals, warmInstances: memory.warmInstances ?? TEST_BUDGETS.warmInstances },
    view: () => loader?.takeView() ?? [],
    request: (specs) => loader?.request(specs),
    onEvent: (event) => {
      facade.onKernelEvent(event)
      loader?.onEvent(event)
    },
    // As the app composes it (assembly.ts): the facade's rows, then the
    // loader's markers and stubs, each once per burst (POD-7165).
    batchEvents: (emit) =>
      loader === undefined ? facade.batch(emit) : loader.batch(() => facade.batch(emit)),
  })
  loader = new CollectionLoader({ replica, schedule: timer.schedule })
  // The loader's holds, counted where the pool takes them (POD-7158).
  let holds = 0
  const show = loader.show.bind(loader)
  loader.show = (spec) => {
    holds += 1
    const release = show(spec)
    let released = false
    return () => {
      if (!released) holds -= 1
      released = true
      release()
    }
  }
  const rows = createRowSource({ principal: { userId: 'u-ada' } }, facade, {
    pending: { byRow: () => new Map() },
  })
  const locals = fixedLocals({ selectedIssueId: null, coarseNow: WORLD_NOW })
  const handle = createWorklistPool(rows.source, locals.source, { schedule: () => () => {} })
  disposers.push(
    () => replica?.disconnect(),
    () => rows.dispose(),
    () => locals.dispose(),
    () => handle.dispose(),
  )
  const kernel = replica
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) {
      await kernel.settled()
      await ticks()
      timer.due()
      await loader!.flush()
      await kernel.settled()
      await ticks()
      rows.flush()
      handle.pool.hydrate()
    }
  }
  kernel.connect()
  await settle()
  const naming = (spec: InstanceSpec) =>
    server.fetches.filter((batch) => batch.some((r) => instanceKey(r) === instanceKey(spec))).length
  return {
    server,
    replica: kernel,
    loader: loader!,
    pool: handle.pool,
    settle,
    naming,
    rows,
    holds: () => holds,
    /** The platform warns of low memory: the warm set shrinks to its budget, the grace overridden. */
    memoryWarning: async () => {
      signals.memoryWarning()
      await settle()
    },
    /** Whether the instance's marker is on the device (in memory or not). */
    onDevice: (spec: InstanceSpec) => cache.readInstances().has(instanceKey(spec)),
  }
}

describe('a lookup through the one loader', () => {
  it('a reader of stub fields never fetches; a reader of other fields fetches exactly once', async () => {
    const { pool, replica, settle, naming } = await boot()
    // The first download left OLD on the device as a stub only.
    expect(replica.stubOf(ISSUE, 'OLD')).toBeDefined()
    expect(replica.view(ISSUE, 'OLD')).toBeUndefined()
    const one = oneRecordOf('issue', 'OLD') as InstanceSpec

    for (let i = 0; i < 5; i += 1) {
      const stub = pool.stub('OLD')
      expect(stub).toMatchObject({ id: 'OLD', stage: 'done', parentId: null })
    }
    await settle()
    expect(naming(one)).toBe(0)

    // A reader of the title needs the whole record: on its way, one request.
    for (let i = 0; i < 5; i += 1) expect(pool.row('issue', 'OLD')).toBe(LOADING)
    await settle()
    expect(naming(one)).toBe(1)
    const row = pool.row('issue', 'OLD') as { title?: string }
    expect(row).not.toBe(LOADING)
    expect(row.title).toBe('Issue OLD')
    // Read again: here, nothing more is fetched; the stub reader is still served.
    pool.row('issue', 'OLD')
    expect(pool.stub('OLD')).toMatchObject({ stage: 'done' })
    await settle()
    expect(naming(one)).toBe(1)
  })

  it('a record the server does not show is gone after one request', async () => {
    const { pool, settle, naming } = await boot()
    expect(pool.row('issue', 'NOWHERE')).toBe(LOADING)
    await settle()
    expect(pool.row('issue', 'NOWHERE')).toEqual({ kind: 'gone', reason: 'not-visible' })
    expect(naming(oneRecordOf('issue', 'NOWHERE') as InstanceSpec)).toBe(1)
  })

  it('offline, an absent record reads "not available offline" and recovers when the connection returns', async () => {
    const { pool, replica, server, settle, naming } = await boot()
    server.put(ISSUE, 'LATE', value('LATE', { stage: 'done', closedReason: 'completed' }))
    replica.disconnect()
    await settle()
    const readings: string[] = []
    const stop = autorun(() => {
      readings.push(pool.collections.reading(pool.row('issue', 'LATE')))
    })
    try {
      expect(readings.at(-1)).toBe('offline')
      await settle()
      // Nothing starts without a connection, and the view says so, not "loading".
      expect(naming(oneRecordOf('issue', 'LATE') as InstanceSpec)).toBe(0)
      expect(readings.at(-1)).toBe('offline')
      replica.connect()
      await settle()
      expect(readings.at(-1)).toBe('here')
      expect(naming(oneRecordOf('issue', 'LATE') as InstanceSpec)).toBe(1)
      expect(readings).not.toContain('gone')
    } finally {
      stop()
    }
  })
})

it('a marker landing tells only the readers of its instance (POD-7165)', async () => {
  const { pool, loader, settle } = await boot((server) => {
    server.put(ISSUE, 'A', value('A', { stage: 'done', closedReason: 'completed' }))
    server.put(ISSUE, 'B', value('B', { stage: 'done', closedReason: 'completed' }))
  })
  const a = oneRecordOf('issue', 'A')
  const b = oneRecordOf('issue', 'B')
  const runs = { a: 0, b: 0 }
  const stopA = autorun(() => {
    pool.collections.complete(a)
    runs.a += 1
  })
  const stopB = autorun(() => {
    pool.collections.complete(b)
    runs.b += 1
  })
  try {
    expect(pool.collections.complete(a)).toBe(false)
    loader.request([a as InstanceSpec], 'visible')
    await settle()
    expect(pool.collections.complete(a)).toBe(true)
    expect(runs.a).toBe(2)
    // B's marker did not move: its reader never re-ran, however many installs.
    expect(runs.b).toBe(1)
    expect(pool.collections.complete(b)).toBe(false)
    loader.request([b as InstanceSpec], 'visible')
    await settle()
    expect(runs.b).toBe(2)
    expect(runs.a).toBe(2)
  } finally {
    stopA()
    stopB()
  }
})

it('server search holds its hits as one-record instances through the real loader', async () => {
  const { pool, replica, settle, naming } = await boot()
  const { issueSearch } = await import('./issue-search')
  const one = oneRecordOf('issue', 'OLD') as InstanceSpec
  expect(replica.view(ISSUE, 'OLD')).toBeUndefined()
  const { issuePages } = await import('./issue-page')
  const page = issuePages(pool)
  try {
    expect(page.row('OPEN').hasTargets).toBe(true)
  } finally {
    page.dispose()
  }
  expect(naming(one)).toBe(0)
  issueSearch(pool).bind(async () => ({ hits: [{ id: 'OLD' }], next: null }))
  let ids: readonly string[] = []
  const stop = autorun(() => {
    ids = issueSearch(pool).read('old', ['OPEN']).ids
  })
  try {
    expect(ids).toEqual(['OPEN'])
    await new Promise((resolve) => setTimeout(resolve, 175))
    await settle()
    expect(ids).toEqual(['OPEN', 'OLD'])
    expect(pool.collections.complete(one)).toBe(true)
    expect(naming(one)).toBe(1)
    expect(replica.view(ISSUE, 'OLD')).toBeDefined()
    const issue = pool.model('issue', 'OLD')
    expect(issue).toBe(pool.model('issue', 'OLD'))
    expect(pool.issueObject('OLD').title).toBe('Issue OLD')
  } finally {
    stop()
  }
})

describe('an open view holds what it reads, over a tiny warm budget (POD-7155, POD-7161)', () => {
  it('reaches ready, keeps its tree while open and stops fetching; closed, the tree is warm and can leave memory', async () => {
    const members: string[] = []
    const { server, replica, pool, settle, memoryWarning, onDevice } = await boot(
      (server) => {
        server.put(ISSUE, 'R', value('R', { stage: 'in_progress' }))
        const closed = (id: string, parentId: string) => {
          server.put(ISSUE, id, value(id, { parentId, stage: 'done', closedReason: 'completed' }))
          // Each member's session comes with its issue (and that issue with its parent).
          server.put(
            'session',
            `S-${id}`,
            session(`S-${id}`, { issueId: id, status: 'ended', cwd: '/synthetic' }),
          )
          members.push(id)
        }
        for (let a = 1; a <= 3; a += 1) {
          closed(`A${a}`, 'R')
          for (let b = 1; b <= 3; b += 1) {
            closed(`B${a}${b}`, `A${a}`)
            for (let c = 1; c <= 3; c += 1) closed(`C${a}${b}${c}`, `B${a}${b}`)
          }
        }
      },
      // No room for warm instances: closed, the tree leaves memory on the first warning.
      { warmInstances: 0 },
    )
    attachMissionTestPreferences(pool)
    const tree: InstanceSpec = {
      collection: 'issueProjection.tree',
      args: { root: 'R' },
      part: 'main',
    }
    const screen = new MissionScreen(pool, 'R', { sessionName: (s) => s.name ?? '' })
    let rows = 0
    const stop = autorun(() => {
      if (!screen.ready) return
      rows = screen.rows.length
    })
    for (let round = 0; round < 6 && !screen.ready; round += 1) await settle()
    expect(screen.ready).toBe(true)
    expect(rows).toBe(members.length + 1)
    for (const id of members) expect(replica.view(ISSUE, id)).toBeDefined()

    // Open, the deck asks for nothing more, a memory warning included.
    const before = server.fetches.length
    await memoryWarning()
    await settle()
    expect(screen.ready).toBe(true)
    expect(server.fetches.length).toBe(before)

    // Closed, the tree is warm: over the budget, a warning takes it out of
    // memory, and the device keeps it.
    stop()
    screen.close()
    await settle()
    await memoryWarning()
    expect(replica.isComplete(tree)).toBeUndefined()
    expect(onDevice(tree)).toBe(true)
  })

  it('an open board column keeps its page and stops fetching; closed, the page is warm and can leave memory', async () => {
    const { server, replica, pool, settle, memoryWarning, onDevice } = await boot(
      (server) => {
        for (let i = 1; i <= 30; i += 1)
          server.put(ISSUE, `D${i}`, value(`D${i}`, { stage: 'done', closedReason: 'completed' }))
      },
      { warmInstances: 0 },
    )
    const board = createBoardLayout(pool)
    const column: BoardColumnOptions = {
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
      stage: 'done',
    }
    const page: InstanceSpec = {
      collection: 'issueProjection.byStage',
      args: { stage: 'done' },
      part: 'main',
    }
    let held = false
    const stop = autorun(() => {
      held = board.columnHeld(column)
    })
    for (let round = 0; round < 6 && !held; round += 1) await settle()
    expect(held).toBe(true)
    expect(replica.isComplete(page)).toBeDefined()

    // Open, a memory warning keeps the page and the column asks for nothing more.
    const before = server.fetches.length
    await memoryWarning()
    await settle()
    expect(held).toBe(true)
    expect(replica.isComplete(page)).toBeDefined()
    expect(server.fetches.length).toBe(before)

    // Closed, the page is warm: over the budget, a warning takes it out of memory, not off the device.
    stop()
    await settle()
    await memoryWarning()
    expect(replica.isComplete(page)).toBeUndefined()
    expect(onDevice(page)).toBe(true)
  })
})

describe('holding follows reading: every view read holds what it reads (POD-7158)', () => {
  const closed = (id: string, fields: Record<string, unknown> = {}) =>
    value(id, { stage: 'done', closedReason: 'completed', ...fields })
  /** Lookups nobody reads (warm), more than the budget: memory has to choose. */
  const crowd = async (
    pool: ReturnType<typeof createWorklistPool>['pool'],
    settle: () => Promise<void>,
  ) => {
    for (let i = 1; i <= 30; i += 1) pool.row('issue', `C${i}`)
    await settle()
  }
  const crowded = (server: CollectionServer) => {
    for (let i = 1; i <= 30; i += 1) server.put(ISSUE, `C${i}`, closed(`C${i}`))
  }

  it('the deck holds its tree, its root (a lookup) and the root body while open; closed, they are warm', async () => {
    const { server, replica, pool, settle, holds, memoryWarning, onDevice } = await boot(
      (server) => {
        // A closed root: no policy collection holds it, the deck looks it up.
        server.put(ISSUE, 'R', closed('R'))
        for (let a = 1; a <= 3; a += 1) {
          server.put(ISSUE, `A${a}`, closed(`A${a}`, { parentId: 'R' }))
          for (let b = 1; b <= 4; b += 1)
            server.put(ISSUE, `B${a}${b}`, closed(`B${a}${b}`, { parentId: `A${a}` }))
        }
        crowded(server)
      },
      { warmInstances: 0 },
    )
    attachMissionTestPreferences(pool)
    const base = holds()
    const tree: InstanceSpec = {
      collection: 'issueProjection.tree',
      args: { root: 'R' },
      part: 'main',
    }
    const body: InstanceSpec = {
      collection: 'issueDescription.ofIssue',
      args: { issueId: 'R' },
      part: 'main',
    }
    const root = oneRecordOf('issue', 'R') as InstanceSpec
    const screen = new MissionScreen(pool, 'R', { sessionName: (s) => s.name ?? '' })
    let rows = 0
    let title = ''
    const stop = autorun(() => {
      title = screen.rootTitle
      if (!screen.ready) return
      rows = screen.rows.length
    })
    for (let round = 0; round < 6 && !screen.ready; round += 1) await settle()
    expect(screen.ready).toBe(true)
    expect(rows).toBe(16)
    expect(title).toBe('Issue R')
    await crowd(pool, settle)

    // Open: a memory warning keeps all of it, and the deck asks for nothing more.
    const before = server.fetches.length
    await memoryWarning()
    await settle()
    expect(screen.ready).toBe(true)
    expect(title).toBe('Issue R')
    expect(replica.view(ISSUE, 'R')).toBeDefined()
    for (const spec of [tree, body, root])
      expect(replica.isComplete(spec)?.releasedAt).toBeUndefined()
    expect(server.fetches.length).toBe(before)

    // Closed: every hold is released at once, and the deck's instances are
    // warm; a warning takes them out of memory, and the device keeps them.
    stop()
    screen.close()
    expect(holds()).toBe(base)
    await settle()
    await memoryWarning()
    expect(replica.isComplete(tree)).toBeUndefined()
    expect(onDevice(tree)).toBe(true)
    for (const spec of [body, root]) {
      const marker = replica.isComplete(spec)
      if (marker !== undefined) expect(marker.releasedAt).toBeDefined()
    }
  })

  it('a board column holds its page and the next page while open; closed, they are warm', async () => {
    const { server, replica, pool, settle, holds, memoryWarning, onDevice } = await boot(
      (server) => {
        server.pageRows = 10
        for (let i = 1; i <= 30; i += 1) server.put(ISSUE, `D${i}`, closed(`D${i}`))
      },
      { warmInstances: 0 },
    )
    const base = holds()
    const board = createBoardLayout(pool)
    const column: BoardColumnOptions = {
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
      stage: 'done',
    }
    const page: InstanceSpec = {
      collection: 'issueProjection.byStage',
      args: { stage: 'done' },
      part: 'main',
    }
    const resident = () =>
      Array.from({ length: 30 }, (_, i) => `D${i + 1}`).filter(
        (id) => replica.view(ISSUE, id) !== undefined,
      )
    let ended = true
    let total: number | typeof LOADING = LOADING
    const stop = autorun(() => {
      ended = board.columnHeld(column)
      total = pool.collections.pageTotal(page)
    })
    for (let round = 0; round < 6 && total === LOADING; round += 1) await settle()
    expect(total).toBe(30)
    expect(ended).toBe(false)
    expect(replica.isComplete(page)?.range?.end).toBe(false)
    expect(resident().length).toBeGreaterThanOrEqual(10)

    // The next page, asked for under the column's reader, is held with the first.
    pool.collections.nextPage(page)
    await settle()
    expect(resident().length).toBeGreaterThanOrEqual(20)
    expect(total).toBe(30)
    const held = resident()

    // Open: a memory warning keeps both pages, and the column asks for nothing more.
    const before = server.fetches.length
    await memoryWarning()
    await settle()
    expect(resident()).toEqual(held)
    expect(replica.isComplete(page)?.releasedAt).toBeUndefined()
    expect(server.fetches.length).toBe(before)

    // Closed: the hold is released at once; over the budget a warning takes
    // the pages out of memory, and the device keeps them.
    stop()
    expect(holds()).toBe(base)
    await settle()
    await memoryWarning()
    expect(replica.isComplete(page)).toBeUndefined()
    expect(onDevice(page)).toBe(true)
  })

  it('an issue opened by lookup is held while read; closed, it is warm', async () => {
    const { server, replica, pool, settle, holds, memoryWarning } = await boot(
      (server) => {
        server.put(ISSUE, 'OLD', closed('OLD'))
        crowded(server)
      },
      { warmInstances: 0 },
    )
    const base = holds()
    const one = oneRecordOf('issue', 'OLD') as InstanceSpec
    let title: string | undefined
    const stop = autorun(() => {
      const row = pool.row('issue', 'OLD')
      title = row === LOADING ? undefined : (row as { title?: string }).title
    })
    await settle()
    expect(title).toBe('Issue OLD')
    await crowd(pool, settle)

    // Open: over the budget, a memory warning keeps the record, and nothing is asked again.
    const before = server.fetches.length
    await memoryWarning()
    await settle()
    expect(title).toBe('Issue OLD')
    expect(replica.view(ISSUE, 'OLD')).toBeDefined()
    expect(replica.isComplete(one)?.releasedAt).toBeUndefined()
    expect(server.fetches.length).toBe(before)

    // Closed: released at once; the record is warm.
    stop()
    expect(holds()).toBe(base)
    await settle()
    expect(replica.isComplete(one)?.releasedAt).toBeDefined()
  })

  it('a search result list holds its hits while it reads them; closed, they are warm', async () => {
    const { server, replica, pool, settle, holds, memoryWarning, onDevice } = await boot(
      (server) => {
        for (let i = 1; i <= 12; i += 1) server.put(ISSUE, `H${i}`, closed(`H${i}`))
        crowded(server)
      },
      { warmInstances: 0 },
    )
    const { issueSearch } = await import('./issue-search')
    const hits = Array.from({ length: 12 }, (_, i) => `H${i + 1}`)
    const ones = hits.map((id) => oneRecordOf('issue', id) as InstanceSpec)
    const base = holds()
    issueSearch(pool).bind(async () => ({ hits: hits.map((id) => ({ id })), next: null }))
    let ids: readonly string[] = []
    // The list reads the ids only; its rows render them later.
    const stop = autorun(() => {
      ids = issueSearch(pool).read('needle', []).serverIds
    })
    await new Promise((resolve) => setTimeout(resolve, 175))
    await settle()
    expect(ids).toEqual(hits)
    for (const spec of ones) expect(replica.isComplete(spec)).toBeDefined()
    await crowd(pool, settle)

    // Open: more hits than the budget, all kept by a memory warning; nothing is asked again.
    const before = server.fetches.length
    await memoryWarning()
    await settle()
    for (const id of hits) expect(replica.view(ISSUE, id)).toBeDefined()
    for (const spec of ones) expect(replica.isComplete(spec)?.releasedAt).toBeUndefined()
    expect(server.fetches.length).toBe(before)

    // Closed: released at once; over the budget, a warning takes the hits out of memory, not off the device.
    stop()
    expect(holds()).toBe(base)
    await settle()
    await memoryWarning()
    expect(ones.filter((spec) => replica.isComplete(spec) !== undefined)).toEqual([])
    for (const spec of ones) expect(onDevice(spec)).toBe(true)
  })

  it('opening and closing the same views 100 times leaves no hold behind', async () => {
    const { server, pool, settle, holds } = await boot(
      (server) => {
        server.pageRows = 10
        server.put(ISSUE, 'R', closed('R'))
        for (let a = 1; a <= 3; a += 1)
          server.put(ISSUE, `A${a}`, closed(`A${a}`, { parentId: 'R' }))
        for (let i = 1; i <= 30; i += 1) server.put(ISSUE, `D${i}`, closed(`D${i}`))
      },
      { warmInstances: 0 },
    )
    attachMissionTestPreferences(pool)
    const { issueSearch } = await import('./issue-search')
    issueSearch(pool).bind(async () => ({ hits: [{ id: 'D3' }, { id: 'D4' }], next: null }))
    const board = createBoardLayout(pool)
    const column: BoardColumnOptions = {
      filter: {},
      ordering: 'priority',
      showAgentTasks: false,
      stage: 'done',
    }
    const base = holds()
    for (let round = 0; round < 100; round += 1) {
      const screen = new MissionScreen(pool, 'R', { sessionName: (s) => s.name ?? '' })
      const stop = autorun(() => {
        void screen.ready
        void screen.rootTitle
        void board.columnHeld(column)
        void pool.row('issue', 'D1')
        void issueSearch(pool).read('needle', []).serverIds
      })
      expect(holds()).toBeGreaterThan(base)
      // Every tenth opening lets the loads land, so holds are taken over held data too.
      if (round % 10 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 175))
        await settle()
      }
      stop()
      screen.close()
      expect(holds()).toBe(base)
    }
    await settle()
    expect(holds()).toBe(base)
    expect(server.fetches.length).toBeGreaterThan(0)
  })
})
