/**
 * The phone Tasks board on a device that holds only part of the synced state:
 * lane counts are the desktop column's counts over all history (stubs), not
 * the rows this device happens to hold, and the Proposed group counts every
 * screenable proposal.
 */
import { afterEach, expect, it } from 'vitest'
import { attachMobileScreens } from './mobile-screens'
import { MobileTasksBoard } from './mobile-tasks'
import { closedValue, ISSUE, issueValue } from './test-support/device.test.fixture'
import { type EmptyDevice, openEmptyDevice } from './test-support/empty-device.test.fixture'
import { LOADING } from './worklist/rollup'

const OLD = '2025-02-01T00:00:00.000Z'
const DONE = Array.from({ length: 7 }, (_, at) => `done-${at}`)
const PROPOSED = Array.from({ length: 4 }, (_, at) => `proposed-${at}`)

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

async function board() {
  const device = await openEmptyDevice({
    world: (server) => {
      server.put(ISSUE, 'live', issueValue('live', { stage: 'in_progress', title: 'Live work' }))
      // Closed long ago: no policy collection holds them, only their stubs.
      for (const id of DONE) server.put(ISSUE, id, closedValue(id, { updatedAt: OLD, title: id }))
      for (const id of PROPOSED)
        server.put(ISSUE, id, issueValue(id, { stage: 'proposed', updatedAt: OLD, title: id }))
    },
  })
  devices.push(device)
  await attachMobileScreens(device.pool)
  const tasks = device.observe(
    () =>
      new MobileTasksBoard(device.pool, {
        showDone: true,
        expanded: [],
        filter: {},
        ordering: 'priority',
        showAgentTasks: false,
      }),
    (model) => {
      void model.groups
      void model.stageCounts
    },
  )
  await device.untilIdle()
  return { device, tasks: tasks.model }
}

it('counts a lane over all history while the device holds only some of its rows', async () => {
  const { device, tasks } = await board()
  // Canary: the device really does not hold the old closed work, so a count
  // of held rows would come out short.
  const held = DONE.filter((id) => device.pool.tables.issue.has(id))
  expect(held.length).toBeLessThan(DONE.length)

  const counts = tasks.stageCounts
  if (counts === LOADING) throw new Error('stage counts still loading')
  expect(counts.done).toBe(DONE.length)
  expect(counts.in_progress).toBe(1)
})

it('counts every screenable proposal, not the proposal cards in memory', async () => {
  const { device, tasks } = await board()
  expect(PROPOSED.filter((id) => device.pool.tables.issue.has(id)).length).toBeLessThan(
    PROPOSED.length,
  )
  expect(tasks.proposals).toBe(PROPOSED.length)
  const groups = tasks.groups
  if (groups === LOADING) throw new Error('groups still loading')
  expect(groups.find((group) => group.stage === 'proposed')?.total).toBe(PROPOSED.length)
})
