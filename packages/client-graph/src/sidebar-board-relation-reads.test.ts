/**
 * POD-7581 — THE SIDEBAR, THE BOARD, THE HEADER AND NAVIGATION READ WHAT THE
 * POLICY HOLDS, ON AN EMPTY DEVICE.
 *
 * These views list rows. A row must not start a hold of its own (one hold per
 * row downloads every row's history), so their relation reads are declared
 * policy reads (`shared/policy-relation-readers.ts`): they show what the
 * policy collections hold, and the test setup fails on any raw read that is
 * neither declared nor held. Where the stubs answer over all history (child
 * stage counts, the archive cascade), the reader reads the stubs instead.
 */
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { type CollectionServer, session } from '../../sync/src/conformance/collection-server'
import { headerView } from './header-views'
import { boardCards } from './issue-board-cards'
import { createIssueBoardSource } from './issue-board-source'
import { LOADING } from './loading'
import { navigationActivity } from './navigation-activity'
import { closedValue, ISSUE, issueValue } from './test-support/device.test.fixture'
import {
  type EmptyDevice,
  openEmptyDevice,
  refuseCollections,
} from './test-support/empty-device.test.fixture'
import { sidebarView } from './worklist/sidebar'
import { worklistView } from './worklist/view-model'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'

/**
 * An open epic E with an open child, a child closed long ago (held by no
 * policy collection) and a child closed recently; its sessions: one live, one
 * archived long ago; an open spin-off and one closed long ago; an open issue
 * blocked by E; a session born on E that works on the open child. For the
 * review's cases (POD-7581 review): a human task P with an agent-audience
 * child closed long ago; a recently closed task H whose only session is
 * hibernated and idle long ago; an open task O whose session is the same; a
 * backlog task K whose only session was archived long ago.
 */
function world(server: CollectionServer): void {
  const issue = (id: string, value: Record<string, unknown>) =>
    server.put(ISSUE, id, { ...value, deps: [] })
  issue('E', issueValue('E', { seq: 1, updatedAt: RECENT, title: 'Epic' }))
  issue('C1', issueValue('C1', { seq: 2, parentId: 'E', updatedAt: RECENT }))
  issue('C2', closedValue('C2', { seq: 3, parentId: 'E', updatedAt: OLD }))
  issue('C3', closedValue('C3', { seq: 4, parentId: 'E', updatedAt: RECENT }))
  issue('S1', issueValue('S1', { seq: 5, updatedAt: RECENT }))
  issue('S2', closedValue('S2', { seq: 6, updatedAt: OLD }))
  issue('B', issueValue('B', { seq: 7, updatedAt: RECENT }))
  // A dependency edge is its own record; it comes with the issue that depends.
  const dep = (fromId: string, type: string) =>
    server.put('issueDep', `${fromId}-${type}-E`, {
      id: `${fromId}-${type}-E`,
      fromId,
      toId: 'E',
      type,
    })
  dep('S1', 'discovered-from')
  dep('S2', 'discovered-from')
  dep('B', 'blocked-by')
  const put = (id: string, fields: Record<string, unknown>) =>
    server.put('session', id, session(id, fields) as Record<string, unknown>)
  put('sE', { issueId: 'E', status: 'live', lastActiveAt: RECENT })
  put('sEold', { issueId: 'E', status: 'exited', archived: true, lastActiveAt: OLD })
  put('sBorn', { issueId: 'C1', refIssueId: 'E', status: 'live', lastActiveAt: RECENT })
  issue('P', issueValue('P', { seq: 8, updatedAt: RECENT, audience: 'human' }))
  issue('A1', closedValue('A1', { seq: 9, parentId: 'P', updatedAt: OLD, audience: 'agent' }))
  issue('H', closedValue('H', { seq: 10, updatedAt: RECENT }))
  issue('O', issueValue('O', { seq: 11, updatedAt: RECENT }))
  issue('K', issueValue('K', { seq: 12, stage: 'backlog', updatedAt: RECENT }))
  put('sH', { issueId: 'H', status: 'hibernated', lastActiveAt: OLD })
  put('sO', { issueId: 'O', status: 'hibernated', lastActiveAt: OLD })
  put('sK', { issueId: 'K', status: 'exited', archived: true, lastActiveAt: OLD })
}

/** A read that may throw LOADING, as a screen settles it. */
function settle<T>(read: () => T): T | typeof LOADING {
  try {
    return read()
  } catch (error) {
    if (error !== LOADING) throw error
    return LOADING
  }
}

async function device(more: (server: CollectionServer) => void = () => {}): Promise<EmptyDevice> {
  const opened = await openEmptyDevice({
    world: (server) => {
      world(server)
      more(server)
    },
  })
  devices.push(opened)
  // Canaries: what no policy collection holds is not on the device.
  for (const id of ['C2', 'S2'])
    expect(opened.pool.tables.issue.has(id), `${id} is not on the device`).toBe(false)
  expect(opened.pool.tables.session.has('sEold'), 'the archived session is not').toBe(false)
  return opened
}

/**
 * Every getter a row exposes, as a screen reads them; LOADING is an answer.
 * The tip target's parts are private: they are read through `tipTarget`
 * only when the row has a tip.
 */
function readEvery(row: object): void {
  for (
    let at = Object.getPrototypeOf(row);
    at && at !== Object.prototype;
    at = Object.getPrototypeOf(at)
  )
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(at))) {
      if (name === 'constructor' || descriptor.get === undefined) continue
      if (name.startsWith('tipTarget') && name !== 'tipTarget') continue
      try {
        void (row as Record<string, unknown>)[name]
      } catch (error) {
        if (error !== LOADING) throw error
      }
    }
}

describe('the sidebar', () => {
  it('shows its rows from the policy collections and asks for nothing per row', async () => {
    const opened = await device()
    const shown = opened.observe(
      () => sidebarView(opened.pool),
      (sidebar) => {
        if (sidebar.loading) return
        const sections = sidebar.sections()
        for (const id of [
          ...sections.pinnedIds,
          ...sections.bands.flatMap((band) => band.rowIds),
        ]) {
          const row = sidebar.row(id)
          if (row !== undefined && row !== LOADING) readEvery(row)
        }
      },
    )
    await opened.untilIdle()
    const sections = shown.model.sections()
    expect(sections.bands.flatMap((band) => band.rowIds)).toContain('E')
    const epic = shown.model.row('E')
    if (epic === undefined || epic === LOADING) throw new Error('the epic row is not shown')
    // The children and spin-offs the policy holds; the ones closed long ago are not read.
    expect(epic.childIds).toEqual(['C1', 'C3'])
    expect(epic.spinOffIds).toEqual(['S1'])
    expect(opened.requestedKeys()).toEqual([])
  })
})

describe('the board', () => {
  it('reads its cards and their decorations without a hold per card', async () => {
    const opened = await device()
    const source = createIssueBoardSource(opened.pool)
    const cards = boardCards(opened.pool)
    const stageCounts = (id: string) => {
      try {
        return cards.card(cards.issue(id), false).stageCounts
      } catch (error) {
        if (error !== LOADING) throw error
        return LOADING
      }
    }
    opened.observe(
      () => source,
      (board) => {
        for (const stage of ['in_progress', 'review'] as const) {
          const column = { filter: {}, ordering: 'priority', showAgentTasks: false, stage } as const
          void board.columnHeld(column)
          const ids = board.columnIds(column)
          if (ids === LOADING || ids === undefined) continue
          for (const id of ids) {
            void board.issue(id)
            void board.sessions(id)
            void stageCounts(id)
            void settle(() => cards.issue(id).taskProgress)
          }
        }
      },
    )
    await opened.untilIdle()
    // The open columns read the sidebar collection: nothing was asked for.
    expect(opened.requestedKeys()).toEqual([])
    // Stage counts come from the stubs, over all history: C2 closed long ago
    // and the device holds no row of it, yet it counts.
    expect(opened.pool.tables.issue.has('C2')).toBe(false)
    expect(stageCounts('E')).toEqual([
      { stage: 'in_progress', count: 1 },
      { stage: 'done', count: 2 },
    ])
    // A card counts the sessions the policy holds: E's live one, not its archived history.
    const card = source.issue('E')
    if (card === undefined || card === LOADING) throw new Error('the epic card is not shown')
    expect(card.memberSessionIds).toEqual(['sE'])
    expect(card.dependents.map((dependent) => dependent.id).sort()).toEqual(['B', 'S1'])
    expect(card.sessionsUnknown).toBeUndefined()
    // The card's progress counts every descendant over all history (stubs):
    // three children, two done, though the device holds no row of C2.
    expect(settle(() => cards.issue('E').taskProgress)).toMatchObject({ total: 3, done: 2 })
    source.dispose()
  })
})

describe('a board column whose page the server refused', () => {
  const DONE = { filter: {}, ordering: 'priority', showAgentTasks: false, stage: 'done' } as const

  /** The done column as the web column reads it: its ids and its count row. */
  async function doneColumn(refused: boolean) {
    const opened = await device((server) => {
      if (refused)
        refuseCollections(server, (instance) => instance.collection === 'issueProjection.byStage')
    })
    const source = createIssueBoardSource(opened.pool)
    const answers: unknown[] = []
    opened.observe(
      () => source,
      (board) => {
        void board.columnHeld(DONE)
        void board.columnIds(DONE)
        answers.push(board.read('issueBoardColumnCount', JSON.stringify(DONE)))
      },
    )
    await opened.untilIdle()
    return { opened, source, answers }
  }

  it('says it is not available, keeping only the count the stubs answer, and asks once', async () => {
    const { opened, source, answers } = await doneColumn(true)
    // S2 (closed long ago) and H are the column's roots: the stubs count them.
    expect(answers.at(-1)).toEqual({ count: 2, unavailable: true })
    expect(
      opened.requestedKeys().filter((key) => key.startsWith('issueProjection.byStage')),
    ).toHaveLength(1)
    source.dispose()
  })

  it('is available when the server answers the page', async () => {
    const { source, answers } = await doneColumn(false)
    expect(answers.at(-1)).toEqual({ count: 2 })
    source.dispose()
  })
})

describe("the review's cases", () => {
  /** Observe `read` on a fresh device as a screen would; its last answer. */
  async function last(read: (opened: EmptyDevice) => unknown): Promise<unknown> {
    const opened = await device()
    const answers: unknown[] = []
    opened.observe(
      () => null,
      () => answers.push(settle(() => read(opened))),
    )
    await opened.untilIdle()
    expect(opened.requestedKeys()).toEqual([])
    return answers.at(-1)
  }

  it('stage counts with agent tasks hidden count an agent child held only as a stub', async () => {
    const cards = (opened: EmptyDevice) => boardCards(opened.pool)
    expect(
      await last((opened) => cards(opened).card(cards(opened).issue('P'), false).stageCounts),
    ).toEqual([{ stage: 'done', count: 1 }])
  })

  it('an open task whose session is hibernated is live: the sidebar comes with that session', async () => {
    expect(await last((opened) => opened.pool.issueObject('O').live)).toBe(true)
  })

  it('declared: a closed task idle for N days whose session is hibernated is not seen as live', async () => {
    // `IssueModel@*.live` covers hibernated sessions only on an open issue or
    // active in the last N days (policy-relation-readers.ts).
    expect(await last((opened) => opened.pool.issueObject('H').live)).toBe(false)
  })

  it('declared: a backlog task whose senders are all archived and idle for N days is to do here', async () => {
    // `IssueModel@*.missionBucket` covers archived senders only when active
    // in the last N days (policy-relation-readers.ts). The flight deck holds
    // the whole roster and reads "waiting" (mission-full-deck.test.ts).
    expect(await last((opened) => opened.pool.issueObject('K').missionBucket)).toBe('todo')
  })

  it('a card of an issue that is not open says its session count is unknown', async () => {
    const opened = await device()
    const source = createIssueBoardSource(opened.pool)
    const answers: unknown[] = []
    opened.observe(
      () => source,
      (board) => answers.push(board.issue('H')),
    )
    await opened.untilIdle()
    expect(answers.at(-1)).toMatchObject({ sessionsUnknown: true })
    source.dispose()
  })
})

describe('the header and navigation', () => {
  it('summarise the selected mission and its activity from what the policy holds', async () => {
    const opened = await device()
    runInAction(() => {
      worklistView(opened.pool).selectedId = 'E'
    })
    opened.observe(
      () => ({ header: headerView(opened.pool), activity: navigationActivity(opened.pool) }),
      ({ header, activity }) => {
        void header.folded()
        void activity.activityAt('E')
      },
    )
    await opened.untilIdle()
    expect(opened.requestedKeys()).toEqual([])
  })
})
