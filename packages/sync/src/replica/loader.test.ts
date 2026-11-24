/**
 * THE ONE LOADER (POD-7087), over the Replica and the small collection
 * server of the device-store cases.
 *
 * Acceptance 1: the design's walkthroughs "Two examples from an empty
 * device" (a small tree; a big tree opened straight after install, stub
 * level first, then full records; the second start with no fetch).
 * Acceptance 2: many lookups within the window make one request with no
 * duplicate instance. Acceptance 4 (kernel half): offline, a load does not
 * start, the view reads "offline", and the queue goes when the connection
 * returns.
 */

import { describe, expect, it } from 'vitest'
import {
  CollectionServer,
  issue,
  RECENTLY,
  session,
  WORLD_NOW,
} from '../conformance/collection-server'
import { inMemoryInstantiation } from '../conformance/in-memory'
import type { ConformanceStorage } from '../conformance/instantiation'
import { policyBudgets, TEST_BUDGETS } from '../conformance/test-budgets'
import { instanceKey } from './cache-state'
import { CollectionLoader, type LoaderSchedule, oneRecord } from './loader'
import { Replica } from './replica'
import type { CachePolicy, InstanceRequest, InstanceSpec, ReplicaEvent } from './types'

const ISSUE = 'issueProjection'
const SESSION = 'session'

/** The production order (`apps/server/src/sync/policy.ts`): always and live, the view, recent, sidebar, stubs. */
const POLICY: CachePolicy = {
  clientType: 'browser',
  steps: [
    { step: 'always', collections: ['session.live', 'session.asking'] },
    { step: 'view', collections: [] },
    { step: 'recent', collections: ['issueProjection.recent', 'session.recent'] },
    { step: 'sidebar', collections: ['issueProjection.sidebar'] },
    { step: 'stubs', collections: ['issueProjection.stubs'] },
  ],
  recentDays: 30,
  ...policyBudgets(TEST_BUDGETS),
}

const SIDEBAR: InstanceSpec = { collection: 'issueProjection.sidebar', part: 'main' }
const STUBS: InstanceSpec = { collection: 'issueProjection.stubs', part: 'stub' }
const tree = (root: string, part: 'main' | 'stub' = 'main'): InstanceRequest => ({
  collection: 'issueProjection.tree',
  args: { root },
  part,
})

const ticks = async (count = 8): Promise<void> => {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A timer the test closes by hand: `due()` runs the armed window. */
function manualSchedule(): { schedule: LoaderSchedule; armed: () => number; due: () => void } {
  let run: (() => void) | null = null
  let armed = 0
  return {
    schedule: (fn) => {
      run = fn
      armed += 1
      return () => {
        run = null
      }
    },
    armed: () => armed,
    due: () => {
      const fn = run
      run = null
      fn?.()
    },
  }
}

interface Device {
  readonly replica: Replica
  readonly loader: CollectionLoader
  readonly events: ReplicaEvent[]
  readonly timer: ReturnType<typeof manualSchedule>
}

function device(
  storage: ConformanceStorage,
  server: CollectionServer,
  onEvent?: (event: ReplicaEvent, d: Device) => void,
  memory: { readonly warmInstances?: number } = {},
): Device {
  const { cache } = storage.viewFor('u-ada')
  const events: ReplicaEvent[] = []
  const timer = manualSchedule()
  let loader: CollectionLoader | undefined
  let self: Device | undefined
  const replica = new Replica({
    store: cache,
    authority: server,
    now: () => WORLD_NOW,
    ...(memory.warmInstances === undefined ? {} : { memory }),
    view: () => loader?.takeView() ?? [],
    request: (specs) => loader?.request(specs),
    onEvent: (event) => {
      events.push(event)
      loader?.onEvent(event)
      if (self !== undefined) onEvent?.(event, self)
    },
  })
  loader = new CollectionLoader({ replica, schedule: timer.schedule })
  self = { replica, loader, events, timer }
  return self
}

/** Run the replica and close the loader's windows until nothing is left to send. */
async function settle(d: Device): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await d.replica.settled()
    await ticks()
    await d.replica.settled()
    const before = d.loader.stats.requests
    d.timer.due()
    await d.loader.flush()
    await d.replica.settled()
    await ticks()
    if (d.loader.stats.requests === before) return
  }
  throw new Error('the loader did not settle')
}

/** Tree progress from the stubs on the device: members under `root`, and how many are closed. */
function progress(d: Device, root: string): { done: number; total: number } {
  let done = 0
  let total = 0
  const todo = [...d.loader.stubsByParent(root)]
  while (todo.length > 0) {
    const id = todo.pop()!
    total += 1
    const stub = d.loader.stubOf(ISSUE, id)
    if (stub?.['stage'] === 'done') done += 1
    todo.push(...d.loader.stubsByParent(id))
  }
  return { done, total }
}

const requestsNaming = (server: CollectionServer, spec: InstanceSpec): number =>
  server.fetches.filter((batch) =>
    batch.some((request) => instanceKey(request) === instanceKey(spec)),
  ).length

describe('the loader batches lookups', () => {
  async function liveDevice() {
    const server = new CollectionServer()
    server.policy = POLICY
    for (let i = 1; i <= 30; i += 1)
      server.put(ISSUE, `I${i}`, issue(`I${i}`, { stage: 'done', closedReason: 'completed' }))
    const d = device(await inMemoryInstantiation.open(), server)
    d.replica.connect()
    await settle(d)
    return { server, d }
  }

  it('many lookups within the window make one request, with no duplicate instance', async () => {
    const { server, d } = await liveDevice()
    const before = server.fetches.length
    for (let round = 0; round < 3; round += 1)
      for (let i = 1; i <= 30; i += 1) d.loader.request([oneRecord(ISSUE, `I${i}`)])
    expect(d.timer.armed()).toBeGreaterThan(0)
    d.timer.due()
    await d.loader.flush()
    await d.replica.settled()
    const sent = server.fetches.slice(before)
    // One request for the lookups (what they come with follows in its own).
    expect(sent[0]?.length).toBe(30)
    const keys = sent[0]!.map((request) => instanceKey(request))
    expect(new Set(keys).size).toBe(keys.length)
    for (let i = 1; i <= 30; i += 1) {
      expect(d.replica.isComplete(oneRecord(ISSUE, `I${i}`))).toBeDefined()
      expect(d.replica.view(ISSUE, `I${i}`)).toBeDefined()
    }
    // Asked again once held: nothing is sent.
    await settle(d)
    const after = server.fetches.length
    for (let i = 1; i <= 30; i += 1) d.loader.request([oneRecord(ISSUE, `I${i}`)])
    d.timer.due()
    await d.loader.flush()
    expect(server.fetches.length).toBe(after)
  })

  it('sends what a visible view asks for first', async () => {
    const { server, d } = await liveDevice()
    const before = server.fetches.length
    d.loader.request([oneRecord(ISSUE, 'I1'), oneRecord(ISSUE, 'I2')])
    d.loader.request([oneRecord(ISSUE, 'I3')], 'visible')
    // A background request a view then asks for moves to the front.
    d.loader.request([oneRecord(ISSUE, 'I2')], 'visible')
    d.timer.due()
    await d.loader.flush()
    const first = server.fetches[before]!.map((request) => request.args?.['id'])
    // Visible first, each group in the order it was asked.
    expect(first).toEqual(['I2', 'I3', 'I1'])
  })
})

describe('offline, a load does not start', () => {
  it('the view reads "offline", nothing is sent, and the queue goes when the connection returns', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.put(ISSUE, 'OLD', issue('OLD', { stage: 'done', closedReason: 'completed' }))
    const d = device(await inMemoryInstantiation.open(), server)
    d.replica.connect()
    await settle(d)
    expect(d.loader.online).toBe(true)

    d.replica.disconnect()
    expect(d.replica.posture).toBe('stale')
    expect(d.loader.online).toBe(false)
    const one = oneRecord(ISSUE, 'OLD')
    const before = server.fetches.length
    d.loader.request([one], 'visible')
    expect(d.loader.status(one)).toBe('offline')
    d.timer.due()
    await d.loader.flush()
    expect(server.fetches.length).toBe(before)
    expect(d.replica.view(ISSUE, 'OLD')).toBeUndefined()

    d.replica.connect()
    await settle(d)
    expect(d.loader.status(one)).toBe('complete')
    expect(d.replica.view(ISSUE, 'OLD')).toBeDefined()
    expect(requestsNaming(server, one)).toBe(1)
  })
})

describe('two examples from an empty device (design POD-7059)', () => {
  it('a small tree: open members and exact progress at once, the closed members with one short fetch', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 50
    server.put(ISSUE, 'R', issue('R', { stage: 'in_progress' }))
    for (let i = 1; i <= 11; i += 1) {
      const closed = i <= 7
      server.put(
        ISSUE,
        `T${i}`,
        issue(`T${i}`, {
          parentId: 'R',
          stage: closed ? 'done' : 'in_progress',
          closedReason: closed ? 'completed' : null,
        }),
      )
    }
    server.put(SESSION, 'S1', session('S1', { issueId: 'T8' }))
    const d = device(await inMemoryInstantiation.open(), server)
    d.replica.connect()
    await settle(d)
    // Always and live, recent, the sidebar and the stubs arrived.
    expect(d.replica.isComplete(SIDEBAR)).toBeDefined()
    expect(d.replica.isComplete(STUBS)).toBeDefined()
    expect(
      server.fetches.some((batch) => batch.some((r) => r.collection === 'issueProjection.tree')),
    ).toBe(false)

    // The flight deck opens: its open members and exact progress at once.
    const release = d.loader.show(tree('R'))
    for (let i = 8; i <= 11; i += 1) expect(d.replica.view(ISSUE, `T${i}`)).toBeDefined()
    expect(progress(d, 'R')).toEqual({ done: 7, total: 11 })
    expect(d.loader.status(tree('R'))).toBe('loading')
    for (let i = 1; i <= 7; i += 1) expect(d.replica.view(ISSUE, `T${i}`)).toBeUndefined()

    // The closed members arrive with one short fetch.
    await settle(d)
    expect(d.loader.status(tree('R'))).toBe('complete')
    for (let i = 1; i <= 7; i += 1) expect(d.replica.view(ISSUE, `T${i}`)).toBeDefined()
    expect(requestsNaming(server, tree('R'))).toBe(1)
    release()
  })

  it('a big tree opened straight after install: stub level first, then the full records, the download behind it', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 100
    server.put(ISSUE, 'BIG', issue('BIG', { stage: 'in_progress' }))
    for (let i = 1; i <= 970; i += 1) {
      const closed = i <= 922
      server.put(
        ISSUE,
        `B${i}`,
        issue(`B${i}`, {
          parentId: i <= 10 ? 'BIG' : `B${1 + (i % 10)}`,
          stage: closed ? 'done' : 'in_progress',
          closedReason: closed ? 'completed' : null,
        }),
      )
    }
    for (let i = 960; i <= 970; i += 1)
      server.put(SESSION, `L${i}`, session(`L${i}`, { issueId: `B${i}` }))
    server.put(ISSUE, 'OTHER', issue('OTHER', { stage: 'review' }))

    // What the screen read at each marker of the first download.
    const seen: {
      stubTree: boolean
      fullTree: boolean
      sidebar: boolean
      stubs: boolean
      progress: { done: number; total: number }
      working: boolean
    }[] = []
    const d = device(await inMemoryInstantiation.open(), server, (event, self) => {
      if (event.type !== 'markers') return
      seen.push({
        stubTree: self.replica.isComplete(tree('BIG', 'stub')) !== undefined,
        fullTree: self.replica.isComplete(tree('BIG')) !== undefined,
        sidebar: self.replica.isComplete(SIDEBAR) !== undefined,
        stubs: self.replica.isComplete(STUBS) !== undefined,
        progress: progress(self, 'BIG'),
        working: self.replica.view(SESSION, 'L970') !== undefined,
      })
    })
    // The deck is the visible view before the download starts.
    d.loader.show(tree('BIG', 'stub'))
    d.loader.show(tree('BIG'))
    d.replica.connect()
    await settle(d)

    // The tree rode in the first download, as its second step: stub level, then full.
    expect(server.bootstraps).toBe(1)
    expect(server.views[0]?.map((request) => request.part)).toEqual(['stub', 'main'])
    const stubAt = seen.findIndex((s) => s.stubTree)
    const fullAt = seen.findIndex((s) => s.fullTree)
    const sidebarAt = seen.findIndex((s) => s.sidebar)
    const stubsAt = seen.findIndex((s) => s.stubs)
    expect(stubAt).toBeGreaterThanOrEqual(0)
    expect(stubAt).toBeLessThan(fullAt)
    expect(fullAt).toBeLessThan(sidebarAt)
    expect(sidebarAt).toBeLessThan(stubsAt)
    // At stub level: "922 of 970", with the live members' working rows painted already.
    expect(seen[stubAt]!.progress).toEqual({ done: 922, total: 970 })
    expect(seen[stubAt]!.working).toBe(true)
    expect(seen[stubAt]!.fullTree).toBe(false)
    // The full records then fill in the done members.
    expect(d.replica.view(ISSUE, 'B1')).toBeDefined()
    expect(d.replica.view(ISSUE, 'B922')).toBeDefined()
    // No separate tree fetch: the view step carried it.
    expect(requestsNaming(server, tree('BIG'))).toBe(0)
    expect(d.loader.stats.viewInstances).toBe(2)
  })

  it('the second start: everything from disk, no fetch, no loading rows; the feed brings what changed', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 50
    server.put(ISSUE, 'R', issue('R', { stage: 'in_progress' }))
    for (let i = 1; i <= 11; i += 1)
      server.put(
        ISSUE,
        `T${i}`,
        issue(`T${i}`, { parentId: 'R', stage: 'done', closedReason: 'completed' }),
      )
    server.put(ISSUE, 'NEW', issue('NEW', { stage: 'review', updatedAt: RECENTLY }))
    const storage = await inMemoryInstantiation.open()
    const first = device(storage, server)
    first.replica.connect()
    await settle(first)
    const release = first.loader.show(tree('R'))
    await settle(first)
    release()
    await settle(first)
    first.replica.disconnect()
    first.loader.dispose()

    // While the app was closed, one issue was renamed.
    server.put(
      ISSUE,
      'T3',
      issue('T3', { parentId: 'R', stage: 'done', closedReason: 'completed', title: 'Renamed' }),
    )
    const bootstraps = server.bootstraps
    const fetches = server.fetches.length

    const second = device(storage, server)
    expect(second.loader.status(tree('R'))).toBe('complete')
    expect(second.loader.status(SIDEBAR)).toBe('complete')
    expect(second.replica.view(ISSUE, 'T1')).toBeDefined()
    second.loader.show(tree('R'))
    second.replica.connect()
    await settle(second)
    expect(server.bootstraps).toBe(bootstraps)
    expect(server.fetches.slice(fetches)).toEqual([])
    expect((second.replica.view(ISSUE, 'T3') as { title?: string } | undefined)?.title).toBe(
      'Renamed',
    )
    expect(second.loader.status(tree('R'))).toBe('complete')
  })
})

describe('two holders of an instance: the policy and an open view', () => {
  it('records a request returns are warm; what a view shows stays in memory; the policy holds its own', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 50
    server.put(ISSUE, 'R', issue('R', { stage: 'done', closedReason: 'completed' }))
    server.put(ISSUE, 'C', issue('C', { stage: 'done', closedReason: 'completed', parentId: 'R' }))
    server.put(ISSUE, 'HIT', issue('HIT', { stage: 'done', closedReason: 'completed' }))
    server.put(ISSUE, 'OPEN', issue('OPEN', { stage: 'review' }))
    // No room for warm instances (POD-7161): a memory warning unloads all of them.
    const d = device(await inMemoryInstantiation.open(), server, undefined, { warmInstances: 0 })
    d.replica.connect()
    await settle(d)
    // A search hit, installed as a "one record" instance; a tree a view shows.
    d.loader.requestRecords(ISSUE, ['HIT'])
    const release = d.loader.show(tree('R'))
    await settle(d)
    expect(requestsNaming(server, oneRecord(ISSUE, 'HIT'))).toBe(1)
    await d.replica.shrinkMemory('memoryWarning')
    // The hit was warm: with no room, it leaves memory and stays on the device.
    expect(d.replica.view(ISSUE, 'HIT')).toBeUndefined()
    expect(d.replica.stubOf(ISSUE, 'HIT')).toBeDefined()
    expect(d.replica.isUnloaded(ISSUE, 'HIT')).toBe(true)
    // The view holds its tree; the policy holds the sidebar.
    expect(d.replica.view(ISSUE, 'C')).toBeDefined()
    expect(d.replica.view(ISSUE, 'OPEN')).toBeDefined()
    // Released, the tree is warm too.
    release()
    await settle(d)
    await d.replica.shrinkMemory('memoryWarning')
    expect(d.replica.view(ISSUE, 'C')).toBeUndefined()
    expect(d.replica.isComplete(tree('R'))).toBeUndefined()
    expect(d.replica.view(ISSUE, 'OPEN')).toBeDefined()
  })
})

describe('comes with, on the client', () => {
  it('a record entering a collection asks for what it comes with; leaving, it lets it go', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 50
    server.put(ISSUE, 'X', issue('X', { stage: 'done', closedReason: 'completed' }))
    server.put(SESSION, 'SX', session('SX', { issueId: 'X', status: 'ended' }))
    const storage = await inMemoryInstantiation.open()
    const d = device(storage, server)
    d.replica.connect()
    await settle(d)
    // POD-7159: what X comes with is recorded on X (its comes-with complete via).
    const sessionsHeld = () =>
      storage
        .viewFor('u-ada')
        .cache.readDiskIndex()
        .record(`${ISSUE}\u0000X`)
        ?.cw.includes('issueProjection.sidebar') === true
    const sessionsOfX: InstanceSpec = {
      collection: 'session.ofIssue',
      args: { issueId: 'X' },
      part: 'main',
      via: 'issueProjection.sidebar',
    }
    expect(d.replica.view(SESSION, 'SX')).toBeUndefined()

    // Reopened: X enters the sidebar, which comes with its sessions.
    const before = server.head
    server.put(ISSUE, 'X', issue('X', { stage: 'review' }))
    await d.replica.receive(server.frameSince(before))
    await settle(d)
    expect(d.replica.view(ISSUE, 'X')).toBeDefined()
    expect(sessionsHeld()).toBe(true)
    expect(d.replica.view(SESSION, 'SX')).toBeDefined()
    expect(requestsNaming(server, sessionsOfX)).toBe(1)

    // Closed again: X leaves the sidebar. What it came with stays on the
    // device: leaving a collection is not leaving the device (POD-7161; only
    // pruning, POD-7162, removes it).
    const again = server.head
    server.put(ISSUE, 'X', issue('X', { stage: 'done', closedReason: 'completed' }))
    await d.replica.receive(server.frameSince(again))
    await settle(d)
    expect(storage.viewFor('u-ada').cache.readDiskIndex().record(`${SESSION}\u0000SX`)?.level).toBe(
      'main',
    )
  })
})

describe('a memory warning while an answer streams (POD-7155, POD-7161)', () => {
  it('keeps the records an instance in flight has brought before its marker', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 2
    server.put(ISSUE, 'R', issue('R', { stage: 'in_progress' }))
    const members = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
    for (const id of members)
      server.put(ISSUE, id, issue(id, { parentId: 'R', stage: 'done', closedReason: 'completed' }))
    const d = device(await inMemoryInstantiation.open(), server, undefined, { warmInstances: 0 })
    d.replica.connect()
    await settle(d)

    // The tree's answer stops after its first two chunks: four members are
    // on the device whole, and its marker has not come yet.
    let resume: () => void = () => {}
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    const answer = server.collections.bind(server)
    server.collections = (instances) => {
      const chunks = answer(instances)
      if (!instances.some((request) => request.collection === 'issueProjection.tree')) return chunks
      return (async function* () {
        let served = 0
        for await (const chunk of chunks) {
          if (served === 2) await paused
          served += 1
          yield chunk
        }
      })()
    }
    const release = d.loader.show(tree('R'))
    d.timer.due()
    const loading = d.loader.flush()
    await ticks(20)
    expect(d.replica.view(ISSUE, 'C1')).toBeDefined()
    expect(d.replica.isComplete(tree('R'))).toBeUndefined()

    // Memory shrinks meanwhile, the grace overridden (the platform warned).
    await d.replica.shrinkMemory('memoryWarning')
    expect(d.replica.view(ISSUE, 'C1')).toBeDefined()

    resume()
    await loading
    await settle(d)
    expect(d.replica.isComplete(tree('R'))).toBeDefined()
    for (const id of members) expect(d.replica.view(ISSUE, id)).toBeDefined()
    release()
  })
})

describe('a paged instance, a page at a time (POD-7158)', () => {
  const PAGE: InstanceRequest = {
    collection: 'issueProjection.byStage',
    args: { stage: 'done' },
    part: 'main',
  }

  async function pagedDevice() {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 50
    server.pageRows = 10
    for (let i = 1; i <= 25; i += 1)
      server.put(ISSUE, `P${i}`, issue(`P${i}`, { stage: 'done', closedReason: 'completed' }))
    const d = device(await inMemoryInstantiation.open(), server)
    d.replica.connect()
    await settle(d)
    d.loader.request([PAGE], 'visible')
    await settle(d)
    const resident = () =>
      Array.from({ length: 25 }, (_, i) => `P${i + 1}`).filter(
        (id) => d.replica.view(ISSUE, id) !== undefined,
      ).length
    return { server, d, resident }
  }

  it('a later page loads below the last position held; asked again, or past the end, nothing is sent', async () => {
    const { server, d, resident } = await pagedDevice()
    const first = d.replica.isComplete(PAGE)
    expect(first?.range?.end).toBe(false)
    expect(resident()).toBe(10)
    expect(requestsNaming(server, PAGE)).toBe(1)

    // The page after the first: its instance is complete, yet the page is not on the device.
    d.loader.request([{ ...PAGE, after: first!.range!.through! }], 'visible')
    await settle(d)
    expect(requestsNaming(server, PAGE)).toBe(2)
    expect(resident()).toBe(20)
    const second = d.replica.isComplete(PAGE)
    expect(second?.range?.end).toBe(false)
    expect(second?.range?.through).not.toEqual(first!.range!.through)

    // The same page asked again: the device holds past it, nothing is sent.
    d.loader.request([{ ...PAGE, after: first!.range!.through! }], 'visible')
    await settle(d)
    expect(requestsNaming(server, PAGE)).toBe(2)

    // The last page, then nothing more.
    d.loader.request([{ ...PAGE, after: second!.range!.through! }], 'visible')
    await settle(d)
    expect(resident()).toBe(25)
    const last = d.replica.isComplete(PAGE)
    expect(last?.range?.end).toBe(true)
    d.loader.request([{ ...PAGE, after: last!.range!.through! }], 'visible')
    d.loader.request([PAGE], 'visible')
    await settle(d)
    expect(requestsNaming(server, PAGE)).toBe(3)
  })

  it("a later page keeps the first page's total", async () => {
    const { d } = await pagedDevice()
    const first = d.replica.isComplete(PAGE)
    expect(first?.total).toBe(25)
    d.loader.request([{ ...PAGE, after: first!.range!.through! }], 'visible')
    await settle(d)
    const second = d.replica.isComplete(PAGE)
    expect(second?.range?.through).not.toEqual(first!.range!.through)
    expect(second?.total).toBe(25)
  })
})

describe('what an open view holds through a gap the feed cannot bridge (POD-7538)', () => {
  /** Disconnect, let the server move past what it retains, and reconnect. */
  async function gap(d: Device, server: CollectionServer, change: () => void): Promise<void> {
    d.replica.disconnect()
    change()
    server.minAvailableSeq = server.head
    d.replica.connect()
    await settle(d)
  }

  it('a reload of a held instance that broke off is sent again while the device stays live', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.put(ISSUE, 'R', issue('R'))
    server.put(ISSUE, 'C', issue('C', { stage: 'done', closedReason: 'completed', parentId: 'R' }))
    const d = device(await inMemoryInstantiation.open(), server)
    d.replica.connect()
    await settle(d)
    const release = d.loader.show(tree('R'))
    await settle(d)
    expect(d.replica.isComplete(tree('R'))).toBeDefined()
    // The tree's first reload after the load fails; the route itself stays up.
    const collections = server.collections.bind(server)
    let failures = 0
    server.collections = (instances) => {
      if (failures === 0 && instances.some((spec) => spec.collection === 'issueProjection.tree')) {
        failures += 1
        return (async function* () {
          yield* []
          throw new Error('the route failed')
        })()
      }
      return collections(instances)
    }
    d.replica.disconnect()
    server.put(
      ISSUE,
      'C',
      issue('C', { stage: 'done', closedReason: 'completed', parentId: 'R', title: 'new C' }),
    )
    server.minAvailableSeq = server.head
    d.replica.connect()
    // The broken answer is reported once, as every failed fetch is.
    await expect(settle(d)).rejects.toThrow('the route failed')
    expect(d.replica.posture).toBe('live')
    expect(d.replica.instanceStale(tree('R'))).toBe(true)
    await settle(d)
    // Retried with no reconnect: replaced, current, never left refreshing.
    expect(failures).toBe(1)
    expect(d.replica.posture).toBe('live')
    expect(d.replica.instanceStale(tree('R'))).toBe(false)
    expect((d.replica.view(ISSUE, 'C') as { title?: string } | undefined)?.title).toBe('new C')
    release()
  })

  it('a held paged instance reloads every page the device held, not only the first', async () => {
    const server = new CollectionServer()
    server.policy = POLICY
    server.chunkRows = 50
    server.pageRows = 10
    for (let i = 1; i <= 25; i += 1)
      server.put(ISSUE, `P${i}`, issue(`P${i}`, { stage: 'done', closedReason: 'completed' }))
    const PAGE: InstanceRequest = {
      collection: 'issueProjection.byStage',
      args: { stage: 'done' },
      part: 'main',
    }
    const d = device(await inMemoryInstantiation.open(), server)
    d.replica.connect()
    await settle(d)
    const release = d.loader.show(PAGE)
    await settle(d)
    const first = d.replica.isComplete(PAGE)
    d.loader.request([{ ...PAGE, after: first!.range!.through! }], 'visible')
    await settle(d)
    const held = d.replica.isComplete(PAGE)?.range
    expect(held?.end).toBe(false)
    const resident = () =>
      Array.from({ length: 25 }, (_, i) => `P${i + 1}`).filter(
        (id) => d.replica.view(ISSUE, id) !== undefined,
      ).length
    expect(resident()).toBe(20)
    // While offline, something the board does not show changes.
    await gap(d, server, () => server.put(ISSUE, 'X', issue('X')))
    expect(d.replica.posture).toBe('live')
    expect(d.replica.instanceStale(PAGE)).toBe(false)
    // The open board stays where it was: both pages, the same range, current.
    expect(d.replica.isComplete(PAGE)?.range).toEqual(held)
    expect(resident()).toBe(20)
    release()
  })
})
