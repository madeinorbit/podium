import type { MobxPool } from '@podium/client-graph/pool'
import {
  BODY_KINDS,
  bodyOf,
  openEmptyDevice,
  putIssueWithBodies,
} from '@podium/client-graph/test-support/empty-device.test.fixture'
import { asIssueId } from '@podium/model'
import { issueDisplayRef } from '@podium/protocol'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { IssueListView } from './IssueListView'
import { DEFAULT_DISPLAY } from './issues-display'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => state.pool,
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown) =>
    state.pool ? read(state.pool) : undefined,
}))
afterEach(cleanup)

it.each([
  false,
  true,
])('empty-device list: desktop board rows stay visible without per-row history, offline=%s', async (offline) => {
  const device = await openEmptyDevice({
    world(server) {
      putIssueWithBodies(server, 'parent', { title: 'Visible parent', seq: 1 })
      putIssueWithBodies(server, 'child', { title: 'Visible child', seq: 2, parentId: 'parent' })
      putIssueWithBodies(server, 'leaf', { title: 'Visible leaf', seq: 3 })
      server.put('session', 'history', {
        sessionId: 'history',
        issueId: 'parent',
        agentKind: 'codex',
        status: 'ended',
        archived: true,
        cwd: '/synthetic',
        createdAt: '2024-01-01T00:00:00Z',
        lastActiveAt: '2024-01-01T00:00:00Z',
      })
    },
  })
  state.pool = device.pool
  if (offline) device.offline()
  try {
    expect(device.pool.tables.session.has('history')).toBe(false)
    const view = render(
      <IssueListView
        groups={[
          {
            stage: 'in_progress',
            count: 3,
            rows: [
              { id: asIssueId('parent'), depth: 0, childCount: 1, expanded: true },
              { id: asIssueId('child'), depth: 1, childCount: 0, expanded: false },
              { id: asIssueId('leaf'), depth: 0, childCount: 0, expanded: false },
            ],
          },
        ]}
        display={{ ...DEFAULT_DISPLAY, layout: 'list' }}
        focusId={null}
        selected={[]}
        onOpen={() => {}}
        onCreateIn={() => {}}
        onToggleSelect={() => {}}
        onToggleExpand={() => {}}
        onContextMenu={() => {}}
        onStatusPick={() => {}}
      />,
    )
    for (const title of ['Visible parent', 'Visible child', 'Visible leaf'])
      expect(view.getByText(title)).toBeTruthy()
    expect(
      view.getAllByText(issueDisplayRef(device.pool.issueObject('parent'))).length,
    ).toBeGreaterThan(0)
    await act(() => device.untilIdle())
    expect(device.requested()).toEqual([])
    for (const kind of BODY_KINDS)
      for (const id of ['parent', 'child', 'leaf'])
        expect(device.liveHolds(bodyOf(kind, id))).toBe(0)
    expect(device.pool.tables.session.has('history')).toBe(false)
    view.unmount()
  } finally {
    cleanup()
    device.dispose()
    state.pool = null
  }
})
