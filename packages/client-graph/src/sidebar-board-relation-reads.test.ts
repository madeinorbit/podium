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
import { type EmptyDevice, openEmptyDevice } from './test-support/empty-device.test.fixture'
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
 * blocked by E; a session born on E that works on the open child.
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
}

async function device(): Promise<EmptyDevice> {
  const opened = await openEmptyDevice({ world })
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
