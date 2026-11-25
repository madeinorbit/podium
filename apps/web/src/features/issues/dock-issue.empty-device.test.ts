/**
 * POD-7579 — THE DOCK DECIDES WHETHER A DRAFT IS OCCUPIED FROM ITS HELD
 * SESSIONS, ON AN EMPTY DEVICE.
 *
 * A draft with no checkout shows in the dock only while a session that is not
 * archived sits on it. Before this change the dock read the session ids in
 * memory and asked for nothing, so an agent parked on the draft long ago (not
 * in any policy collection) left the dock empty. The read now holds
 * `session.ofIssue` for the draft and answers LOADING until it is complete.
 */

import { LOADING } from '@podium/client-graph/loading'
import { afterEach, describe, expect, it } from 'vitest'
import { openEmptyDevice } from '@/test-support/empty-device'
import {
  ISSUE,
  issueValue,
} from '../../../../../packages/client-graph/src/test-support/device.test.fixture'
import type { EmptyDevice } from '../../../../../packages/client-graph/src/test-support/empty-device.test.fixture'
import {
  type CollectionServer,
  session,
} from '../../../../../packages/sync/src/conformance/collection-server'
import { poolDockIssueTarget } from './dock-issue'

const devices: EmptyDevice[] = []
afterEach(() => {
  for (const device of devices.splice(0)) device.dispose()
})

const OLD = '2020-01-01T00:00:00.000Z'

async function openDraft(archived: boolean) {
  const device = await openEmptyDevice({
    world: (server: CollectionServer) => {
      server.put(
        ISSUE,
        'd1',
        issueValue('d1', { isDraftVessel: true, stage: 'backlog', updatedAt: OLD, deps: [] }),
      )
      server.put(
        'session',
        'parked',
        session('parked', {
          status: 'hibernated',
          lastActiveAt: OLD,
          issueId: 'd1',
          archived,
        }) as Record<string, unknown>,
      )
    },
  })
  devices.push(device)
  const answers: unknown[] = []
  const opened = device.observe(
    () => null,
    () => answers.push(poolDockIssueTarget(device.pool, 'd1', null)),
  )
  await device.untilIdle()
  return { device, answers, close: opened.close }
}

describe('the dock target of a draft without a checkout', () => {
  it('is the draft once its parked session arrives', async () => {
    const { device, answers, close } = await openDraft(false)
    expect(answers).toContain(LOADING)
    expect(answers.at(-1)).toBe('d1')
    expect(device.requestedKeys()).toContain('session.ofIssue{"issueId":"d1"}')
    close()
    await device.untilIdle()
    expect(
      device.liveHolds({ collection: 'session.ofIssue', args: { issueId: 'd1' }, part: 'main' }),
    ).toBe(0)
  })

  it('is nothing when every session on it is archived', async () => {
    const { device, answers, close } = await openDraft(true)
    expect(answers.at(-1)).toBeNull()
    expect(device.requestedKeys()).toContain('session.ofIssue{"issueId":"d1"}')
    close()
  })
})
