import type { IssueViewModel } from '@podium/client-core/replica'
/**
 * THE CHAT 3-DOTS, DRAFT VS ACTIVE (2026-08-27 device review).
 *
 * A draft vessel's chat is reached straight from its Work row (the row IS its
 * agent), and this screen's menu is SESSION-scoped — archive, work state,
 * snooze all manage a session's lifecycle. A draft has no lifecycle to manage:
 * its menu is exactly one destructive Delete (of the draft issue) plus the
 * sheet's standard Cancel. An active session keeps the session-scoped verbs,
 * including transcript search.
 */
import type { SessionMeta } from '@podium/model'
import { asIssueId, asSessionId, asUserId } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

beforeEach(() => {
  routerReplace.mockClear()
})

const routerReplace = vi.fn()

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: routerReplace,
    dismissTo: vi.fn(),
    canGoBack: () => false,
  }),
  useLocalSearchParams: () => ({ sessionId: 'sess_menu' }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: () => null,
  MoreVertical: () => null,
  SquareTerminal: () => null,
}))
// The transcript is not what this file is about; the menu lives in the chrome.
vi.mock('../components/SessionConversation', () => ({ SessionConversation: () => null }))
vi.mock('../components/AgentMark', () => ({ HarnessChip: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  DetailSkeleton: () => null,
}))
// The real BottomSheet drags with gesture-handler, which has no native host in
// this lane. The ActionSheet's press contract fires the chosen action only
// after the sheet has CLOSED, so the stand-in must report that close — a mock
// that merely stopped rendering would swallow every menu action.
vi.mock('../components/BottomSheet', async () => {
  const { useEffect, useRef } = await import('react')
  const BottomSheet = ({
    visible,
    onClose,
    children,
    head,
    footer,
  }: {
    visible: boolean
    onClose: () => void
    children?: ReactNode
    head?: ReactNode
    footer?: ReactNode
  }) => {
    const was = useRef(visible)
    useEffect(() => {
      if (was.current && !visible) onClose()
      was.current = visible
    }, [onClose, visible])
    return visible ? (
      <>
        {head}
        {children}
        {footer}
      </>
    ) : null
  }
  return { BottomSheet }
})

const { renderWithMobileStore } = await import('../client/test-support')
const { SessionScreen } = await import('./SessionScreen')
const { useIssues } = await import('../client/hooks')

const vesselId = asIssueId('vessel')

const session = (patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    agentKind: 'claude-code',
    cwd: '/home/dev/podium',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-27T10:00:00.000Z',
    lastActiveAt: '2026-08-27T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    title: 'Draft agent',
    issueId: vesselId,
    sessionId: asSessionId('sess_menu'),
    ...patch,
  }) as unknown as SessionMeta

const vessel = (patch: Partial<IssueViewModel> = {}): IssueViewModel =>
  ({
    id: vesselId,
    repoPath: '/src/podium',
    seq: 7,
    priority: 2,
    stage: 'in_progress',
    title: 'New work',
    description: '',
    labels: [],
    deps: [],
    dependents: [],
    needsHuman: false,
    childCount: 0,
    childDoneCount: 0,
    archived: false,
    pinned: false,
    isDraftVessel: true,
    worktreePath: null,
    ...patch,
  }) as unknown as IssueViewModel

async function openMenu(issue: IssueViewModel) {
  const result = await renderWithMobileStore(<SessionScreen />, {
    sessions: [session()],
    issues: [issue],
  })
  fireEvent.click(await screen.findByLabelText('Session actions'))
  await screen.findByLabelText('Cancel')
  return result
}

/** The live store's issues, watched through the real selector — the Delete
 *  confirm resolves into `deleteIssue`, whose optimistic overlay stamps
 *  `deletedAt` on the vessel. A Cancel must leave it unstamped. */
function IssueProbe({ seen }: { seen: { issues: IssueViewModel[] } }) {
  const issues = useIssues()
  seen.issues = issues
  return null
}

const threeSessions = () => [
  session(),
  session({ sessionId: asSessionId('sess_menu_2'), title: 'Second agent' }),
  session({ sessionId: asSessionId('sess_menu_3'), title: 'Third agent' }),
]

async function openDraftMenuWithSessions() {
  const seen: { issues: IssueViewModel[] } = { issues: [] }
  const result = await renderWithMobileStore(
    <>
      <SessionScreen />
      <IssueProbe seen={seen} />
    </>,
    { sessions: threeSessions(), issues: [vessel()] },
  )
  fireEvent.click(await screen.findByLabelText('Session actions'))
  await screen.findByLabelText('Cancel')
  return { ...result, seen }
}

function vesselDeletedAt(seen: { issues: IssueViewModel[] }): string | null | undefined {
  return seen.issues.find((issue) => issue.id === vesselId)?.deletedAt as string | null | undefined
}

describe('the draft chat menu', () => {
  it('is exactly destructive Delete plus Cancel', async () => {
    await openMenu(vessel())

    expect(screen.getByLabelText('Delete')).toBeTruthy()
    expect(screen.getByLabelText('Cancel')).toBeTruthy()
    for (const gone of [
      'Find in transcript',
      'Pin',
      'Unpin',
      'Next session',
      'Archive',
      'Unarchive',
      'Set work state…',
      'Snooze until next message',
      'Snooze for 1 hour',
      'Snooze until tomorrow',
      'Kill session',
    ]) {
      expect(screen.queryByLabelText(gone)).toBeNull()
    }
  })

  it('Delete asks first with the task cascade, and deletes nothing on the first tap', async () => {
    const { seen } = await openDraftMenuWithSessions()

    fireEvent.click(screen.getByLabelText('Delete'))
    await screen.findByText('Delete this task?')
    expect(
      screen.getByText(
        'This affects 1 task and 3 agents. Tasks and sessions can be restored; running agents will be stopped.',
      ),
    ).toBeTruthy()
    expect(routerReplace).not.toHaveBeenCalled()
    expect(vesselDeletedAt(seen)).toBeFalsy()
  })

  it('Cancel keeps everything: no navigation, no tombstone', async () => {
    const { seen } = await openDraftMenuWithSessions()

    fireEvent.click(screen.getByLabelText('Delete'))
    await screen.findByText('Delete this task?')
    fireEvent.click(screen.getByLabelText('Cancel'))
    await waitFor(() => expect(screen.queryByText('Delete this task?')).toBeNull())
    expect(routerReplace).not.toHaveBeenCalled()
    expect(vesselDeletedAt(seen)).toBeFalsy()
    // The session itself is still here — Cancel did not kill, archive or remove it.
    expect(await screen.findByLabelText('Session actions')).toBeTruthy()
  })

  it('Confirm deletes the whole task (task scope) and leaves the dead draft behind', async () => {
    const { seen } = await openDraftMenuWithSessions()

    fireEvent.click(screen.getByLabelText('Delete'))
    await screen.findByText('Delete this task?')
    // The menu handed off to the confirm sheet, so the only Delete on screen
    // is the confirm's own — tapping it is the task-scope `deleteIssue`.
    fireEvent.click(screen.getByLabelText('Delete'))
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/work'))
    await waitFor(() => expect(vesselDeletedAt(seen)).toBeTruthy())
  })
})

describe('the active-session chat menu', () => {
  it('keeps transcript search and the session verbs', async () => {
    await openMenu(vessel({ isDraftVessel: false, worktreePath: '/tmp/wt/vessel' }))

    expect(screen.getByLabelText('Find in transcript')).toBeTruthy()
    expect(screen.queryByLabelText('Delete')).toBeNull()
    expect(screen.getByLabelText('Next session')).toBeTruthy()
    expect(screen.getByLabelText('Archive')).toBeTruthy()
    expect(screen.getByLabelText('Set work state…')).toBeTruthy()
    expect(screen.getByLabelText('Kill session')).toBeTruthy()
  })
})

describe('session menu snooze from the acting user home', () => {
  const active = vessel({ isDraftVessel: false, worktreePath: '/tmp/wt/vessel' })
  const personal = (snoozedUntil?: string | null) => ({
    userId: asUserId('user:test'),
    sessionId: asSessionId('sess_menu'),
    readAt: null,
    ...(snoozedUntil !== undefined ? { snoozedUntil } : {}),
  })

  it.each([
    false,
    true,
  ])('shows null snooze and hides it when cleared, stripped=%s', async (stripped) => {
    const raw = session({ snoozedUntil: '2099-01-01T00:00:00.000Z' })
    if (stripped) Reflect.deleteProperty(raw, 'snoozedUntil')
    const clear = vi.fn(async () => {})
    const { replica } = await renderWithMobileStore(<SessionScreen />, {
      sessions: [raw],
      issues: [active],
      sessionUserStates: [personal(null)],
      api: { snoozes: { clear: { mutate: clear } } },
    })
    fireEvent.click(await screen.findByLabelText('Session actions'))
    expect(await screen.findByLabelText('Clear snooze')).toBeTruthy()
    await act(async () => {
      replica.applyChanges('sessionUserStates', [personal()], [])
    })
    expect(screen.queryByLabelText('Clear snooze')).toBeNull()
    await act(async () => {
      replica.applyChanges('sessionUserStates', [personal(null)], [])
    })
    fireEvent.click(await screen.findByLabelText('Clear snooze'))
    await waitFor(() => expect(clear).toHaveBeenCalled())
    fireEvent.click(await screen.findByLabelText('Session actions'))
    expect(await screen.findByLabelText('Cancel')).toBeTruthy()
    expect(screen.queryByLabelText('Clear snooze')).toBeNull()
    expect(replica.rows('sessions')[0]).toBe(raw)
  })

  it('does not substitute another user’s snooze for the acting user’s cleared row', async () => {
    await renderWithMobileStore(<SessionScreen />, {
      sessions: [session({ snoozedUntil: null })],
      issues: [active],
      sessionUserStates: [personal(), { ...personal(null), userId: asUserId('user:other') }],
    })
    fireEvent.click(await screen.findByLabelText('Session actions'))
    expect(await screen.findByLabelText('Snooze until next message')).toBeTruthy()
    expect(screen.queryByLabelText('Clear snooze')).toBeNull()
  })

  it('shows the legacy snooze before any personal home arrives', async () => {
    await renderWithMobileStore(<SessionScreen />, {
      sessions: [session({ snoozedUntil: null })],
      issues: [active],
    })
    fireEvent.click(await screen.findByLabelText('Session actions'))
    expect(await screen.findByLabelText('Clear snooze')).toBeTruthy()
  })
})
