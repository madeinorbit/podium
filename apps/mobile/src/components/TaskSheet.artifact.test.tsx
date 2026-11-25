import type { IssueViewModel } from '@podium/client-core/replica'
import { fullDevice } from '@podium/client-graph/full-device-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import {
  FULL_BODIES,
  openEmptyDevice,
  putIssueWithBodies,
} from '@podium/client-graph/test-support/empty-device.test.fixture'
import type { IssuePanelArtifact } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * THE VIEWER MUST NOT BE BORN INSIDE THE SHEET'S MODAL.
 *
 * The artifact viewer is a `Modal`, and it used to render inside the sheet
 * body — itself inside the BottomSheet's `Modal`. iOS silently drops a modal
 * presented from within another, so tapping an artifact in the peek did
 * NOTHING: no viewer, no fetch, no error (2026-08-28; proven from the device's
 * own URL cache, which held rows for every artifact opened elsewhere and none
 * for these). This pins the shape of the fix: the row hands the artifact up,
 * the sheet closes first, and only then does the viewer take the screen.
 */

afterEach(cleanup)
const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('../client/use-issue-close', () => ({ useIssueCloseGuard: () => () => false }))

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
// Ships untranspiled Flow; the whole barrel is stubbed through a Proxy so any
// glyph a child reaches for resolves — rows are found by label, not by icon.
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  return {
    __esModule: true,
    default: View,
    Svg: View,
    Circle: View,
    Line: View,
    Path: View,
    G: View,
  }
})
vi.mock('./WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('./AgentMark', () => ({ HarnessChip: () => null, AgentMark: () => null }))
vi.mock('./Composer', () => ({ Composer: () => null }))
vi.mock('../client/hooks', () => ({
  useHttpOrigin: () => 'https://podium.local',
  useTrpc: () => ({ issues: { addComment: { mutate: vi.fn(async () => {}) } } }),
  useStoreActions: () => ({ updateIssue: vi.fn(), closeIssue: vi.fn() }),
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// The sheet itself is not under test — only WHERE the viewer is mounted
// relative to it, so the sheet renders its children inline.
vi.mock('./BottomSheet', async () => {
  const { View } = await import('react-native')
  return {
    BottomSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? <View testID="sheet">{children}</View> : null,
    dismissThen: (close: () => void, action: () => void) => () => {
      close()
      action()
    },
  }
})
vi.mock('./ArtifactViewer', async () => {
  const { Text } = await import('react-native')
  return {
    ArtifactViewer: ({ url }: { url: string | null }) =>
      url ? <Text testID="viewer">{url}</Text> : null,
  }
})

const { TaskSheet } = await import('./TaskSheet')

it.each([
  false,
  true,
])('the empty-device sheet keeps the state line pending, offline=%s', async (offline) => {
  const device = await openEmptyDevice({ world: (server) => putIssueWithBodies(server, 'sheet') })
  state.pool = device.pool
  if (offline) device.offline()
  const view = render(
    <TaskSheet
      issue={device.pool.issueObject('sheet') as unknown as IssueViewModel}
      pool={device.pool}
      onClose={() => {}}
      onOpenSession={() => {}}
    />,
  )
  try {
    expect(view.queryByText('No status posted yet.')).toBeNull()
    await act(() => device.untilIdle())
    if (offline) {
      expect(view.getAllByText('Not available offline').length).toBeGreaterThan(0)
      expect(view.queryByText('No status posted yet.')).toBeNull()
      await act(async () => {
        device.online()
        await device.untilIdle()
      })
    }
    expect(view.getByText(FULL_BODIES.description)).toBeTruthy()
    expect(view.getByText(FULL_BODIES.stateLine)).toBeTruthy()
    expect(view.getByText(FULL_BODIES.artifacts[0]!.title)).toBeTruthy()
  } finally {
    view.unmount()
    device.dispose()
    state.pool = null
  }
})

const artifact = { path: 'report.html', addedAt: '2026-08-28T10:00:00.000Z' } as IssuePanelArtifact

const issue = {
  id: 'iss_1',
  repoPath: '/tmp/repo',
  worktreePath: '/tmp/repo',
  seq: 7,
  title: 'A task with evidence',
  prefix: 'POD',
  stage: 'doing',
  panel: { todos: [], artifacts: [artifact], deferred: [] },
  description: '',
  deps: [],
  dependents: [],
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  sessions: [],
  labels: [],
  comments: [],
  createdAt: '2026-08-28T09:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
} as unknown as IssueViewModel

describe('TaskSheet artifacts', () => {
  it('closes the sheet first, then opens the viewer outside it', async () => {
    const onClose = vi.fn()
    const pool = fullDevice(new MobxPool({ selectedIssueId: null, coarseNow: 0 }))
    // The panel's artifacts are records of their own (POD-6778).
    pool.apply({
      type: 'replace',
      rows: [
        { kind: 'issue', id: issue.id, value: issue },
        {
          kind: 'issuePanelArtifact',
          id: 'iss_1-artifact-0',
          value: { ...artifact, id: 'iss_1-artifact-0', issueId: issue.id, position: 0 },
        },
      ] as never,
    })
    render(<TaskSheet issue={issue} pool={pool} onClose={onClose} onOpenSession={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Open report.html'))

    // The dismissal is the FIRST thing that happens — the viewer waits for it.
    expect(onClose).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('viewer')).toBeTruthy())
    expect(screen.getByTestId('viewer').textContent).toContain('report.html')
    pool.dispose()
  })
})
