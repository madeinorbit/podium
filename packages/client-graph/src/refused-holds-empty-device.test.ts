/**
 * POD-7595 — A REFUSED HOLD SETTLES, POOL-WIDE, ON AN EMPTY DEVICE.
 *
 * The server can answer a keyed collection in full without its marker: it
 * will not say the instance is complete. Before this change every holding
 * read (`PoolCollections.held`, `treeHeld`, `subtreeHeld`, `pageEnded`, and
 * through them `LazyCollection.members`) asked for it again on every read,
 * which cleared the refusal: the reader answered LOADING for ever and the
 * device asked the server again after every answer. Now a refused read
 * settles: it stays not held (no reader takes what is in memory for the whole
 * answer), reads as `refused` / `unavailable`, and is asked again only on a
 * real trigger (the connection returns, an access change, an explicit retry).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type CollectionServer, session } from '../../sync/src/conformance/collection-server'
import { issuePages } from './issue-page'
import { LOADING } from './loading'
import type { LoaderInstance } from './shared/source'
import { closedValue, ISSUE, issueValue } from './test-support/device.test.fixture'
import {
  type EmptyDevice,
  openEmptyDevice,
  putIssueWithBodies,
  type RefusedInstance,
  refuseCollections,
  requestKey,
} from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'

const SESSIONS = { collection: 'session.ofIssue', args: { issueId: 'c1' }, part: 'main' } as const
const treeAt = (root: string) =>
  ({ collection: 'issueProjection.tree', args: { root }, part: 'main' }) as const

const asked = (device: EmptyDevice, instance: LoaderInstance): number =>
  device.requestedKeys().filter((key) => key === requestKey(instance)).length

const ids = (value: unknown): unknown =>
  value === LOADING ? 'LOADING' : (value as readonly { id: string }[]).map((m) => m.id).sort()

const named =
  (collection: string, root?: string) =>
  (instance: RefusedInstance): boolean =>
    instance.collection === collection && (root === undefined || instance.args?.['root'] === root)

interface Members {
  readonly members: unknown
  readonly unavailable: boolean
}

/** A recent closed issue the first download holds, its live session, and one that ended long ago. */
function sessionsWorld(server: CollectionServer): void {
  server.put(ISSUE, 'c1', closedValue('c1', { seq: 7, updatedAt: RECENT }))
  for (const [id, status, lastActiveAt] of [
    ['past', 'exited', OLD],
    ['now', 'live', RECENT],
  ] as const)
    server.put(
      'session',
      id,
      session(id, { status, lastActiveAt, issueId: 'c1' }) as Record<string, unknown>,
    )
}

/** An epic `top` and its sub-issue `mid`, open; `mid`'s old child the first download never brought. */
function epicWorld(server: CollectionServer): void {
  server.put(ISSUE, 'top', issueValue('top', { updatedAt: RECENT, deps: [] }))
  server.put(ISSUE, 'mid', issueValue('mid', { updatedAt: RECENT, deps: [], parentId: 'top' }))
  server.put(ISSUE, 'old', closedValue('old', { seq: 90, updatedAt: OLD, parentId: 'mid' }))
}

/** Open a reader of `read` on the device, recording each answer. */
function reader(device: EmptyDevice, read: () => unknown) {
  const answers: unknown[] = []
  const opened = device.observe(
    () => null,
    () => answers.push(read()),
  )
  return { answers, close: () => opened.close() }
}

describe('a holding relation over a keyed instance (LazyCollection.members)', () => {
  async function refusedSessions() {
    const refusal = { on: true }
    const device = await openEmptyDevice({
      world: (server) => {
        sessionsWorld(server)
        refuseCollections(server, named('session.ofIssue'), refusal)
      },
    })
    devices.push(device)
    expect(device.pool.tables.session.has('past')).toBe(false)
    const issue = device.pool.issueObject('c1') as unknown as { sessions: Members }
    return { device, refusal, issue }
  }

  it('stays LOADING, reads as unavailable, and is asked once however often it is read', async () => {
    const { device, issue } = await refusedSessions()
    const page = reader(device, () => ids(issue.sessions.members))
    const flag = reader(device, () => issue.sessions.unavailable)
    await device.untilIdle()
    // Never the sessions that happen to be in memory as if they were all.
    expect(page.answers).toEqual(['LOADING'])
    expect(flag.answers.at(-1)).toBe(true)
    expect(device.pool.collections.holding(SESSIONS)).toBe('refused')
    expect(device.pool.collections.status(SESSIONS)).toBe('unavailable')
    expect(device.pool.collections.reading(LOADING, [SESSIONS])).toBe('unavailable')
    // A second reader of the same relation asks for nothing.
    const second = reader(device, () => ids(issue.sessions.members))
    await device.untilIdle()
    expect(second.answers).toEqual(['LOADING'])
    expect(asked(device, SESSIONS)).toBe(1)
    page.close()
    second.close()
    flag.close()
  })

  it('is asked again once a view retries it, and then answers', async () => {
    const { device, refusal, issue } = await refusedSessions()
    const page = reader(device, () => ids(issue.sessions.members))
    await device.untilIdle()
    refusal.on = false
    device.pool.collections.retry(SESSIONS)
    await device.untilIdle()
    expect(page.answers.at(-1)).toEqual(['now', 'past'])
    expect(issue.sessions.unavailable).toBe(false)
    expect(asked(device, SESSIONS)).toBe(2)
    page.close()
  })

  it('is asked again once the connection returns', async () => {
    const { device, refusal, issue } = await refusedSessions()
    const flag = reader(device, () => issue.sessions.unavailable)
    await device.untilIdle()
    expect(asked(device, SESSIONS)).toBe(1)
    device.offline()
    await device.untilIdle()
    refusal.on = false
    device.online()
    await device.untilIdle()
    expect(flag.answers.at(-1)).toBe(false)
    expect(device.holds(SESSIONS)).toBe(true)
    expect(asked(device, SESSIONS)).toBe(2)
    flag.close()
  })

  it('is asked again on an access change', async () => {
    const { device, refusal, issue } = await refusedSessions()
    const flag = reader(device, () => issue.sessions.unavailable)
    await device.untilIdle()
    refusal.on = false
    device.loader.onEvent({ type: 'kind-reload-installed' })
    await device.untilIdle()
    expect(flag.answers.at(-1)).toBe(false)
    expect(asked(device, SESSIONS)).toBe(2)
    flag.close()
  })
})

describe('a holding relation over a tree (subtreeHolding)', () => {
  it('a refused subtree stays LOADING, unavailable, asked once until a retry', async () => {
    const refusal = { on: true }
    const device = await openEmptyDevice({
      world: (server) => {
        epicWorld(server)
        refuseCollections(server, named('issueProjection.tree'), refusal)
      },
    })
    devices.push(device)
    const mid = device.pool.issueObject('mid') as unknown as { children: Members }
    const children = reader(device, () => ids(mid.children.members))
    const flag = reader(device, () => mid.children.unavailable)
    await device.untilIdle()
    expect(children.answers).toEqual(['LOADING'])
    expect(flag.answers.at(-1)).toBe(true)
    expect(device.pool.collections.subtreeHolding('mid')).toBe('refused')
    expect(asked(device, treeAt('mid'))).toBe(1)
    refusal.on = false
    device.pool.collections.retry(treeAt('mid'))
    await device.untilIdle()
    expect(children.answers.at(-1)).toEqual(['old'])
    expect(flag.answers.at(-1)).toBe(false)
    expect(asked(device, treeAt('mid'))).toBe(2)
    children.close()
    flag.close()
  })

  it("does not wait on a deck's refused tree: the sub-issue asks for its own", async () => {
    const device = await openEmptyDevice({
      world: (server) => {
        epicWorld(server)
        refuseCollections(server, named('issueProjection.tree', 'top'))
      },
    })
    devices.push(device)
    // A flight deck on the root.
    const deck = reader(device, () => device.pool.collections.treeHolding('top'))
    const mid = device.pool.issueObject('mid') as unknown as { children: Members }
    const children = reader(device, () => ids(mid.children.members))
    await device.untilIdle()
    // The deck settles: unavailable, not loading for ever.
    expect(deck.answers.at(-1)).toBe('refused')
    expect(device.pool.collections.treeHeld('top')).toBe(false)
    expect(device.pool.collections.treeStatus('top')).toBe('unavailable')
    expect(children.answers.at(-1)).toEqual(['old'])
    expect(asked(device, treeAt('top'))).toBe(1)
    expect(asked(device, treeAt('mid'))).toBe(1)
    deck.close()
    children.close()
  })
})

describe('the holding reads themselves', () => {
  it('held, treeHeld and pageEnded answer false on a refusal and ask once', async () => {
    const page = {
      collection: 'issueProjection.byStage',
      args: { stage: 'done' },
      part: 'main',
    } as const
    const device = await openEmptyDevice({
      world: (server) => {
        sessionsWorld(server)
        epicWorld(server)
        refuseCollections(
          server,
          (instance) =>
            named('session.ofIssue')(instance) ||
            named('issueProjection.tree')(instance) ||
            named('issueProjection.byStage')(instance),
        )
      },
    })
    devices.push(device)
    const reads = reader(device, () => [
      device.pool.collections.held(SESSIONS),
      device.pool.collections.treeHeld('top'),
      device.pool.collections.pageEnded(page),
    ])
    await device.untilIdle()
    expect(reads.answers.at(-1)).toEqual([false, false, false])
    expect(device.pool.collections.holding(SESSIONS)).toBe('refused')
    expect(device.pool.collections.treeHolding('top')).toBe('refused')
    expect(device.pool.collections.status(page)).toBe('unavailable')
    // A handful of reruns at most, never a request per read.
    expect(reads.answers.length).toBeLessThan(6)
    expect(asked(device, SESSIONS)).toBe(1)
    expect(asked(device, treeAt('top'))).toBe(1)
    expect(asked(device, page)).toBe(1)
    reads.close()
  })
})

describe('the issue page and the body fields', () => {
  it('say unavailable, with no rows, no count and no empty text, and ask once', async () => {
    const device = await openEmptyDevice({
      world: (server) => {
        sessionsWorld(server)
        server.put(ISSUE, 'kid', closedValue('kid', { seq: 8, updatedAt: OLD, parentId: 'c1' }))
        putIssueWithBodies(server, 'b1')
        refuseCollections(
          server,
          (instance) =>
            named('session.ofIssue')(instance) ||
            named('issueProjection.tree')(instance) ||
            named('issueDescription.ofIssue')(instance),
        )
      },
    })
    devices.push(device)
    const answers: unknown[] = []
    const page = device.observe(
      () => issuePages(device.pool),
      (views) => {
        const row = views.row('c1')
        answers.push({
          children: ids(row.children),
          childrenUnavailable: row.childrenUnavailable,
          sessions: ids(row.memberSessions),
          sessionsUnavailable: row.sessionsUnavailable,
          rosterCount: row.rosterCount === LOADING ? 'LOADING' : row.rosterCount,
        })
      },
    )
    const body = device.pool.issueObject('b1') as unknown as {
      description: unknown
      descriptionUnavailable: boolean
      briefUnavailable: boolean
    }
    const bodies = reader(device, () => [
      body.description === LOADING ? 'LOADING' : body.description,
      body.descriptionUnavailable,
      body.briefUnavailable,
    ])
    await device.untilIdle()
    expect(answers.at(-1)).toEqual({
      children: 'LOADING',
      childrenUnavailable: true,
      sessions: 'LOADING',
      sessionsUnavailable: true,
      rosterCount: 'LOADING',
    })
    // Never an empty description to edit: unavailable; the brief is unaffected.
    expect(bodies.answers.at(-1)).toEqual(['LOADING', true, false])
    expect(asked(device, SESSIONS)).toBe(1)
    expect(asked(device, treeAt('c1'))).toBe(1)
    expect(
      asked(device, {
        collection: 'issueDescription.ofIssue',
        args: { issueId: 'b1' },
        part: 'main',
      }),
    ).toBe(1)
    page.close()
    bodies.close()
  })
})
