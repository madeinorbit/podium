import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { useMemo, useSyncExternalStore } from 'react'
import {
  openEmptyDevice,
  putIssueWithBodies,
} from '../../../packages/client-graph/src/test-support/empty-device.test.fixture'

export const ISSUE_ID = 'loading-example'
export let device: Awaited<ReturnType<typeof openEmptyDevice>>

/** The real holding reads, held on their way until the capture settles them. */
export async function prepare() {
  device = await openEmptyDevice({
    world(server) {
      server.put('repo', 'repo-1', { id: 'repo-1', prefix: 'POD', name: 'Example workspace' })
      putIssueWithBodies(
        server,
        ISSUE_ID,
        { seq: 42, title: 'Issue page loading state', stage: 'in_progress' },
        {
          description: 'Keep the issue page quiet while its details arrive.',
          stateLine: 'The sections are ready to review.',
          brief: '',
          artifacts: [],
          deferred: [],
          todos: [],
        },
      )
    },
  })
}

export function useWorklistPool() {
  return device.pool
}

export function useWorklistPoolProjection<T>(read: (pool: typeof device.pool) => T, _empty: T): T {
  const projection = useMemo(() => createPoolProjection(device.pool, read), [read])
  return useSyncExternalStore(projection.subscribe, projection.getSnapshot)
}
