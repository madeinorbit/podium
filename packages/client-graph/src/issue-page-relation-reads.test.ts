/**
 * POD-7579 — THE ISSUE PAGE AND THE DOCK READ AN ISSUE'S SESSIONS AND
 * SUB-ISSUES THROUGH HOLDING READS, ON AN EMPTY DEVICE.
 *
 * A closed issue that changed long ago is in no policy collection. Opened
 * from search, it arrives through `issue.one` (or with its live session),
 * and neither brings its other sessions or its sub-issues. Before this change
 * the page's rosters, counts and sub-issue list read the raw ids in memory:
 * they showed the live session (the policy holds live sessions), not the one
 * that ended long ago, and they never asked for the rest.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type CollectionServer, session } from '../../sync/src/conformance/collection-server'
import { issuePages } from './issue-page'
import { LOADING } from './loading'
import { closedValue, ISSUE } from './test-support/device.test.fixture'
import { type EmptyDevice, openEmptyDevice } from './test-support/empty-device.test.fixture'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'
const SESSIONS = { collection: 'session.ofIssue', args: { issueId: 'old' }, part: 'main' } as const

const putSession = (server: CollectionServer, id: string, fields: Record<string, unknown>) =>
  server.put('session', id, session(id, { issueId: 'old', ...fields }) as Record<string, unknown>)

/** The closed old issue, an agent that ended on it long ago, one still live, and `more`. */
async function openOldIssue(more: (server: CollectionServer) => void = () => {}) {
  const device = await openEmptyDevice({
    world: (server) => {
      server.put(ISSUE, 'old', closedValue('old', { seq: 90, updatedAt: OLD, deps: [] }))
      putSession(server, 'past', { status: 'exited', lastActiveAt: OLD })
      putSession(server, 'now', { status: 'live', lastActiveAt: RECENT })
      more(server)
    },
  })
  devices.push(device)
  expect(device.pool.tables.session.has('past'), 'the ended session is not on the device').toBe(
    false,
  )
  expect(device.pool.tables.session.has('now'), 'the live session is on the device').toBe(true)
  return device
}

const ids = (value: unknown): unknown =>
  value === LOADING
    ? 'LOADING'
    : (value as readonly { sessionId?: string; id?: string }[])
        .map((each) => each.sessionId ?? each.id)
        .sort()

/** Open the issue page on the device and record what `read` answers on each run. */
function openPage(
  device: EmptyDevice,
  read: (views: ReturnType<typeof issuePages>) => unknown,
): { answers: unknown[]; close(): void } {
  const answers: unknown[] = []
  const opened = device.observe(
    () => issuePages(device.pool),
    (views) => {
      const issue = views.issue('old')
      if (issue === LOADING || issue === undefined) return answers.push('LOADING')
      try {
        answers.push(read(views))
      } catch (error) {
        if (error !== LOADING) throw error
        answers.push('LOADING')
      }
    },
  )
  return { answers, close: opened.close }
}

describe('the issue page of a closed issue opened from search', () => {
  it.each([
    ['memberSessions', ['now', 'past']],
    ['retiredSessions', ['past']],
    ['activeSessions', ['now']],
    ['dockRetiredSessions', ['past']],
  ] as const)('%s asks for the sessions of the issue and shows them', async (list, expected) => {
    const device = await openOldIssue()
    const page = openPage(device, (views) => ids(views.row('old')[list]))
    await device.untilIdle()
    expect(page.answers.at(-1)).toEqual(expected)
    expect(device.requestedKeys()).toContain('session.ofIssue{"issueId":"old"}')
    expect(device.liveHolds(SESSIONS)).toBe(1)
    page.close()
    await device.untilIdle()
    expect(device.liveHolds(SESSIONS)).toBe(0)
  })

  it('the roster and retired counts answer LOADING, then count every session', async () => {
    const device = await openOldIssue()
    const page = openPage(device, (views) => {
      const row = views.row('old')
      return [row.rosterCount, row.retiredCount]
    })
    await device.untilIdle()
    expect(page.answers).toContainEqual([LOADING, LOADING])
    expect(page.answers.at(-1)).toEqual([2, 1])
    expect(device.requestedKeys()).toContain('session.ofIssue{"issueId":"old"}')
    page.close()
  })

  it("the views' rosters ask for the sessions of the issue", async () => {
    const device = await openOldIssue()
    const page = openPage(device, (views) => [
      ids(views.memberSessions('old')),
      ids(views.attachedSessions('old')),
    ])
    await device.untilIdle()
    expect(page.answers.at(-1)).toEqual([
      ['now', 'past'],
      ['now', 'past'],
    ])
    page.close()
  })

  it('the live seat is a parked agent the policy does not hold', async () => {
    // The live session is headless, so it is no seat: the parked agent is.
    const device = await openOldIssue((server) => {
      putSession(server, 'now', { status: 'live', lastActiveAt: RECENT, headless: true })
      putSession(server, 'parked', { status: 'hibernated', lastActiveAt: OLD })
    })
    const page = openPage(device, () => device.pool.issueObject('old').liveSeatId)
    await device.untilIdle()
    expect(page.answers).toContain('LOADING')
    expect(page.answers.at(-1)).toBe('parked')
    expect(device.requestedKeys()).toContain('session.ofIssue{"issueId":"old"}')
    page.close()
  })

  it('the sub-issues are the issue tree, held while the page reads them', async () => {
    const device = await openOldIssue((server) =>
      server.put(
        ISSUE,
        'kid',
        closedValue('kid', { seq: 91, updatedAt: OLD, deps: [], parentId: 'old' }),
      ),
    )
    expect(device.pool.tables.issue.has('kid'), 'the sub-issue is not on the device').toBe(false)
    const page = openPage(device, (views) => ids(views.row('old').children))
    await device.untilIdle()
    expect(page.answers).toContain('LOADING')
    expect(page.answers.at(-1)).toEqual(['kid'])
    expect(device.requestedKeys()).toContain('issueProjection.tree{"root":"old"}')
    page.close()
  })

  it('a superseded issue names its successor, looked up when absent', async () => {
    const device = await openEmptyDevice({
      world: (server) => {
        server.put(
          ISSUE,
          'old',
          closedValue('old', { seq: 90, updatedAt: OLD, deps: [], supersededBy: 'next' }),
        )
        server.put(ISSUE, 'next', closedValue('next', { seq: 92, updatedAt: OLD, deps: [] }))
      },
    })
    devices.push(device)
    const page = openPage(device, (views) => views.row('old').continuation?.kind)
    await device.untilIdle()
    expect(page.answers.at(-1)).toBe('superseded')
    expect(device.pool.tables.issue.has('next'), 'the successor was loaded').toBe(true)
    page.close()
  })
})
