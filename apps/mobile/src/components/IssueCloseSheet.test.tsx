import {
  asIssueId,
  asSessionId,
  type IssueWire,
  type IssueWireInput,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('lucide-react-native', () => ({
  AlertTriangle: () => null,
  GitBranch: () => null,
  GitCommit: () => null,
  MessageCircleQuestion: () => null,
  Users: () => null,
}))
// The sheet's physics belong to `BottomSheet` and are tested there; what this
// file is about is what the guard SAYS.
vi.mock('./BottomSheet', () => ({
  BottomSheet: ({
    visible,
    children,
    head,
    footer,
  }: {
    visible: boolean
    children: ReactNode
    head?: ReactNode
    footer?: ReactNode
  }) =>
    visible ? (
      <div>
        {head}
        {children}
        {footer}
      </div>
    ) : null,
}))

const { IssueCloseSheet } = await import('./IssueCloseSheet')

const issue = (partial: Partial<IssueWireInput> = {}): IssueWire =>
  ({
    id: asIssueId('task'),
    repoPath: '/src/podium',
    seq: 1,
    priority: 2,
    stage: 'in_progress',
    title: 'A task',
    description: '',
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    parentBranch: 'main',
    archived: false,
    ...partial,
  }) as IssueWire

const session = (partial: Partial<SessionMetaInput> = {}): SessionMeta =>
  ({
    sessionId: asSessionId('s'),
    issueId: asIssueId('task'),
    agentKind: 'codex',
    title: 'Agent',
    cwd: '/r/wt',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 1,
    createdAt: '2026-07-22T10:00:00.000Z',
    lastActiveAt: '2026-07-22T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...partial,
  }) as SessionMeta

const dirtyBranch = {
  updatedAt: '2026-07-23T10:00:00.000Z',
  branch: 'issue/1129',
  shared: false,
  ahead: 2,
  dirtyFiles: 3,
  dirtyOwn: 3,
}

function open(over: Partial<Parameters<typeof IssueCloseSheet>[0]> = {}) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <IssueCloseSheet
      issue={issue()}
      sessions={[]}
      reason="done"
      onConfirm={onConfirm}
      onClose={onClose}
      {...over}
    />,
  )
  return { onConfirm, onClose }
}

describe('IssueCloseSheet', () => {
  it('stays down until a close asks for it', () => {
    open({ reason: null })
    expect(screen.queryByLabelText('Keep open')).toBeNull()
  })

  it('names every consequence, with the sentence that says why it matters', () => {
    open({
      issue: issue({
        needsHuman: true,
        humanQuestion: 'Which direction should we ship?',
        childCount: 3,
        childDoneCount: 1,
        gitState: dirtyBranch,
      }),
      sessions: [
        session({
          sessionId: asSessionId('waiting'),
          offer: { message: 'Choose a direction', actions: [], createdAt: 'now' },
        }),
      ],
    })

    expect(screen.getByText('This task still needs attention')).toBeTruthy()
    expect(screen.getByText('1 pending decision')).toBeTruthy()
    expect(screen.getByText('Closing retires these pending agent decisions.')).toBeTruthy()
    expect(screen.getByText('Which direction should we ship?')).toBeTruthy()
    expect(screen.getByText('2 open sub-tasks')).toBeTruthy()
    expect(screen.getByText('3 dirty files attributed to this issue')).toBeTruthy()
    expect(screen.getByText('2 commits awaiting delivery')).toBeTruthy()
    expect(screen.getByText('The issue branch has not been merged into main.')).toBeTruthy()
  })

  it('offers the close as `anyway` when something is at stake', () => {
    const { onConfirm, onClose } = open({ issue: issue({ gitState: dirtyBranch }) })

    fireEvent.click(screen.getByLabelText('Close anyway'))
    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).toHaveBeenCalledWith('done')
  })

  it('names the ENDING it is confirming, so a mispick is catchable here', () => {
    open({ issue: issue({ gitState: dirtyBranch }), reason: 'cancelled' })

    expect(screen.getByLabelText('Close as cancelled')).toBeTruthy()
  })

  it('keeping it open closes nothing', () => {
    const { onConfirm, onClose } = open({ issue: issue({ gitState: dirtyBranch }) })

    fireEvent.click(screen.getByLabelText('Keep open'))
    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('drops the warning when the work it named finishes underneath it', () => {
    // The list is live, not snapshotted at the press. A host that opened the
    // guard over a working agent must not keep insisting once that agent stops,
    // so the sheet falls back to the plain close it would never have raised.
    open({
      issue: issue(),
      sessions: [session({ agentState: { phase: 'idle', since: 'now', nativeSubagentCount: 0 } })],
    })

    expect(screen.getByText('Close this task?')).toBeTruthy()
    expect(screen.getByText('Nothing unresolved is left on it.')).toBeTruthy()
    expect(screen.getByLabelText('Close task')).toBeTruthy()
  })
})
