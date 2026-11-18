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
import { instanceKey } from '../../sync/src/replica/cache-state'
import { CollectionLoader, type LoaderSchedule } from '../../sync/src/replica/loader'
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

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

async function boot(
  world: (server: CollectionServer) => void = (server) => {
    server.put(ISSUE, 'OPEN', value('OPEN', { stage: 'in_progress' }))
    server.put(ISSUE, 'OLD', value('OLD', { stage: 'done', closedReason: 'completed' }))
  },
  policy: Partial<CachePolicy> = {},
) {
  const server = new CollectionServer()
  server.policy = { ...POLICY, ...policy }
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
    // As the app composes it (assembly.ts): the facade's rows, then the
    // loader's markers and stubs, each once per burst (POD-7165).
    batchEvents: (emit) =>
      loader === undefined ? facade.batch(emit) : loader.batch(() => facade.batch(emit)),
  })
  loader = new CollectionLoader({ replica, schedule: timer.schedule })
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
  return { server, replica: kernel, loader: loader!, pool: handle.pool, settle, naming, rows }
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

it('server search adopts hits as cached one-record instances through the real loader', async () => {
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
  issueSearch(pool).bind(async () => [{ id: 'OLD' }])
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

describe('an open view holds what it reads, over a small cache cap (POD-7155)', () => {
  it('reaches ready, keeps its tree while open and stops fetching; closed, the tree is cache', async () => {
    const members: string[] = []
    const { server, replica, pool, settle } = await boot(
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
      // Fewer records than the tree and what it comes with: as cache it never fits.
      { cacheCap: 10 },
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

    // Open, the deck asks for nothing more, a trim included.
    const before = server.fetches.length
    await replica.trim()
    await settle()
    expect(screen.ready).toBe(true)
    expect(server.fetches.length).toBe(before)

    // Closed, the tree is cache: over the cap, the trim lets it go.
    stop()
    screen.close()
    await settle()
    await replica.trim()
    expect(replica.isComplete(tree)).toBeUndefined()
  })

  it('an open board column keeps its page and stops fetching; closed, the page is cache', async () => {
    const { server, replica, pool, settle } = await boot(
      (server) => {
        for (let i = 1; i <= 30; i += 1)
          server.put(ISSUE, `D${i}`, value(`D${i}`, { stage: 'done', closedReason: 'completed' }))
      },
      { cacheCap: 10 },
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

    // Open, the trim keeps the page and the column asks for nothing more.
    const before = server.fetches.length
    await replica.trim()
    await settle()
    expect(held).toBe(true)
    expect(replica.isComplete(page)).toBeDefined()
    expect(server.fetches.length).toBe(before)

    // Closed, the page is cache: over the cap, the trim lets it go.
    stop()
    await settle()
    await replica.trim()
    expect(replica.isComplete(page)).toBeUndefined()
  })
})
