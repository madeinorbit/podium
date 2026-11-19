/**
 * POD-7175 — the board's Search tasks filter over a column the device does not
 * hold (Done): the server's hit is fetched, shows as a card, and the column's
 * count is its cards once the search answer is complete, instead of LOADING.
 * An agent-internal hit with no visible ancestor stays off the board unless
 * Show agent tasks is on, as every other board filter treats it.
 */
import { autorun } from 'mobx'
import { afterEach, describe, expect, it } from 'vitest'
import { createBoardLayout } from './issue-board-layout'
import type { BoardColumnOptions } from './issue-board-schema'
import { ISSUE_SEARCH_DEBOUNCE_MS, issueSearch } from './issue-search'
import { LOADING } from './loading'
import { closedValue, type Device, ISSUE, openDevice } from './test-support/device.test.fixture'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

/** Done over 30 closed issues in pages of 10, and one closed hit for "needle". */
async function doneWithHit(hit: Record<string, unknown>): Promise<Device> {
  const device = await openDevice({
    world: (server) => {
      server.pageRows = 10
      for (let i = 1; i <= 30; i += 1) server.put(ISSUE, `D${i}`, closedValue(`D${i}`))
      server.put(ISSUE, 'H1', closedValue('H1', { title: 'a needle title', ...hit }))
    },
  })
  disposers.push(() => device.dispose())
  issueSearch(device.pool).bind(
    device.recorder.query(async () => ({ hits: [{ id: 'H1' }], next: null })),
  )
  return device
}

/** Read the Done column filtered by "needle" until the device is quiet. */
async function filteredDone(device: Device, showAgentTasks: boolean) {
  const board = createBoardLayout(device.pool)
  const column: BoardColumnOptions = {
    filter: { text: 'needle' },
    ordering: 'priority',
    showAgentTasks,
    stage: 'done',
  }
  let ids: unknown
  let count: unknown
  const stop = autorun(() => {
    ids = board.columnIds(column)
    count = board.columnCount(column)
  })
  disposers.push(() => {
    stop()
    board.dispose()
  })
  await device.settle()
  device.clock.spend(ISSUE_SEARCH_DEBOUNCE_MS)
  await new Promise((resolve) => setTimeout(resolve, ISSUE_SEARCH_DEBOUNCE_MS + 25))
  await device.settle()
  return { ids, count: count === LOADING ? 'LOADING' : count }
}

describe('board text filter over an unheld column (POD-7175)', () => {
  it('shows a closed hit in Done and counts it', async () => {
    const device = await doneWithHit({ audience: 'team' })
    expect(await filteredDone(device, false)).toEqual({ ids: ['H1'], count: 1 })
  })

  it('keeps an agent-internal hit without a visible ancestor off the board unless agent tasks show', async () => {
    const hidden = await doneWithHit({ audience: 'agent' })
    expect(await filteredDone(hidden, false)).toEqual({ ids: [], count: 0 })
    const shown = await doneWithHit({ audience: 'agent' })
    expect(await filteredDone(shown, true)).toEqual({ ids: ['H1'], count: 1 })
  })
})
