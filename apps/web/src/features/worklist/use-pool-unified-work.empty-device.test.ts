/**
 * POD-7581 — THE UNIFIED WORK LIST'S MISSION AND ARCHIVE READS, ON AN EMPTY
 * DEVICE.
 *
 * - Mission membership follows the session that started a task. The read
 *   took that sender from `graph.one('issue', id, 'startedBy')`, which
 *   answers null for a sender the device does not hold, so a task started by
 *   a session that ended long ago fell out of its mission. It now reads the
 *   id the task names and looks the sender up: LOADING, then the answer.
 * - "Archive all" captures each tree for Undo. It walked the children in
 *   memory, so a child closed long ago (held by no policy collection) was
 *   archived by the server's cascade but missing from Undo. The capture now
 *   walks the stubs, which cover all history.
 */

import { LOADING } from '@podium/client-graph/loading'
import { afterEach, describe, expect, it } from 'vitest'
import { openEmptyDevice } from '@/test-support/empty-device'
import {
  closedValue,
  ISSUE,
  issueValue,
} from '../../../../../packages/client-graph/src/test-support/device.test.fixture'
import type { EmptyDevice } from '../../../../../packages/client-graph/src/test-support/empty-device.test.fixture'
import {
  type CollectionServer,
  session,
} from '../../../../../packages/sync/src/conformance/collection-server'
import { createPoolWorkActions, poolMissionContains } from './use-pool-unified-work'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const RECENT = '2026-11-17T12:00:00.000Z'
const OLD = '2020-01-01T00:00:00.000Z'

async function open(world: (server: CollectionServer) => void): Promise<EmptyDevice> {
  const device = await openEmptyDevice({ world })
  devices.push(device)
  return device
}

describe('mission membership through the session that started a task', () => {
  it('looks the sender up when the device does not hold it', async () => {
    const device = await open((server) => {
      server.put(ISSUE, 'R', issueValue('R', { seq: 1, updatedAt: RECENT }))
      // A task R's agent filed: not a child of R, started by a session archived long ago.
      server.put(
        ISSUE,
        'T',
        issueValue('T', { seq: 2, stage: 'backlog', updatedAt: RECENT, startedBySession: 'sOld' }),
      )
      server.put(
        'session',
        'sOld',
        session('sOld', {
          issueId: 'R',
          status: 'exited',
          archived: true,
          lastActiveAt: OLD,
        }) as Record<string, unknown>,
      )
    })
    expect(device.pool.tables.session.has('sOld'), 'the sender is not on the device').toBe(false)
    const answers: unknown[] = []
    device.observe(
      () => null,
      () => answers.push(poolMissionContains(device.pool, 'R', 'T')),
    )
    await device.untilIdle()
    expect(answers[0]).toBe(LOADING)
    expect(answers.at(-1)).toBe(true)
    expect(device.requestedKeys()).toContain('session.one{"id":"sOld"}')
  })
})

describe('archive all in the closed lane', () => {
  it('captures a child closed long ago for Undo, from the stubs', async () => {
    const device = await open((server) => {
      server.put(ISSUE, 'X', closedValue('X', { seq: 1, updatedAt: RECENT }))
      server.put(ISSUE, 'Y', closedValue('Y', { seq: 2, parentId: 'X', updatedAt: OLD }))
      server.put(
        ISSUE,
        'Z',
        closedValue('Z', { seq: 3, parentId: 'X', updatedAt: OLD, archived: true }),
      )
    })
    expect(device.pool.tables.issue.has('Y'), 'the old child is not on the device').toBe(false)
    const actions = createPoolWorkActions(
      device.pool,
      { commands: {}, services: { outbox: { queue: {} } }, ui: {} } as never,
      () => {},
    )
    const trees = actions.captureArchiveBatch(['X'])
    // The archived child stops the cascade, as on the server.
    expect(trees).toEqual([{ rootId: 'X', ids: ['X', 'Y'], queued: false }])
    expect(device.requestedKeys()).toEqual([])
  })
})
