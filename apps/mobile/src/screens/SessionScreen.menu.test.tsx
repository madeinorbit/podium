/**
 * THE CHAT 3-DOTS, DRAFT VS ACTIVE (2026-08-27 device review).
 *
 * A draft vessel's chat is reached straight from its Work row (the row IS its
 * agent), and this screen's menu is SESSION-scoped — archive, work state,
 * snooze all manage a session's lifecycle. A draft has no lifecycle to manage:
 * its menu is exactly one destructive Delete (of the draft issue) plus the
 * sheet's standard Cancel. An active session keeps the session-scoped verbs,
 * minus the removed "Find in transcript".
 */
import type { IssueWire, SessionMeta } from '@podium/model'
import { asIssueId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

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

const vessel = (patch: Partial<IssueWire> = {}): IssueWire =>
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
    draft: true,
    worktreePath: null,
    ...patch,
  }) as unknown as IssueWire

async function openMenu(issue: IssueWire) {
  const result = await renderWithMobileStore(<SessionScreen />, {
    sessions: [session()],
    issues: [issue],
  })
  fireEvent.click(await screen.findByLabelText('Session actions'))
  await screen.findByLabelText('Cancel')
  return result
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

  it('Delete leaves the dead draft behind', async () => {
    await openMenu(vessel())

    fireEvent.click(screen.getByLabelText('Delete'))
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/work'))
  })
})

describe('the active-session chat menu', () => {
  it('keeps the session verbs but not the removed Find in transcript', async () => {
    await openMenu(vessel({ draft: false, worktreePath: '/tmp/wt/vessel' }))

    expect(screen.queryByLabelText('Find in transcript')).toBeNull()
    expect(screen.queryByLabelText('Delete')).toBeNull()
    expect(screen.getByLabelText('Next session')).toBeTruthy()
    expect(screen.getByLabelText('Archive')).toBeTruthy()
    expect(screen.getByLabelText('Set work state…')).toBeTruthy()
    expect(screen.getByLabelText('Kill session')).toBeTruthy()
  })
})
