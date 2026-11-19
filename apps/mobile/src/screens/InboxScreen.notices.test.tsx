/**
 * THE PHONE'S INBOX LISTS MY NOTICES (POD-6881, acceptance 7): my open notices,
 * newest first, with the unread count, and tapping one marks it read and opens
 * what it is about.
 */
import { asUserId, type NoticeWire } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
}))
const push = vi.hoisted(() => vi.fn())
vi.mock('expo-router', () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/inbox',
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 72 }))
vi.mock('react-native-svg', async () => {
  const { View } = await import('react-native')
  const Svg = ({ children }: { children?: ReactNode }) => <View>{children}</View>
  return { default: Svg, Svg, Circle: () => null }
})
vi.mock('expo-blur', async () => {
  const { View } = await import('react-native')
  return { BlurView: (props: object) => <View {...props} /> }
})
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
// Sheets drag with react-native-gesture-handler, whose native module has no
// host in this lane. Nothing here opens one.
vi.mock('../components/BottomSheet', () => ({
  BottomSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null,
}))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  WorkSkeleton: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const { renderWithMobileStore } = await import('../client/test-support')
const { InboxScreen } = await import('./InboxScreen')

const ME = 'user:test'

const notice = (noticeId: string, patch: Partial<NoticeWire> = {}): NoticeWire => ({
  noticeId,
  recipientUserId: asUserId(ME),
  kind: 'mention',
  subjectKind: 'issue',
  subjectId: 'iss_task',
  subjectAnchor: `cmt_${noticeId}`,
  title: `Bob mentioned you on POD-1: Task ${noticeId}`,
  body: '@Me look',
  createdAt: '2026-11-13T00:00:00.000Z',
  ...patch,
})

const applied = () =>
  vi.fn(async (_envelope: unknown) => ({
    outcome: 'applied',
    result: { marked: true },
    receipt: { feedId: 'f', epoch: 'e', seq: 0 },
    replayed: false,
  }))

describe('the phone inbox lists my notices', () => {
  it('lists my notices with the unread count', async () => {
    await renderWithMobileStore(<InboxScreen />, {
      principal: ME,
      inboxNotices: [notice('a'), notice('b', { readAt: '2026-11-13T00:01:00.000Z' })],
    })
    expect(await screen.findByText('1 unread')).toBeTruthy()
    expect(screen.getByText('Bob mentioned you on POD-1: Task a')).toBeTruthy()
    expect(screen.getByText('Bob mentioned you on POD-1: Task b')).toBeTruthy()
    expect(screen.getByLabelText('Unread: Bob mentioned you on POD-1: Task a')).toBeTruthy()
  })

  it('tapping a notice marks it read and opens its task', async () => {
    push.mockClear()
    const submit = applied()
    await renderWithMobileStore(<InboxScreen />, {
      principal: ME,
      inboxNotices: [notice('a')],
      api: { sync: { submit: { mutate: submit } } },
    })
    fireEvent.click(await screen.findByLabelText('Unread: Bob mentioned you on POD-1: Task a'))
    expect(push).toHaveBeenCalledWith('/issue/iss_task')
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'notices.markRead', input: { id: 'a' } }),
      ),
    )
  })

  it('a session notice opens the session', async () => {
    push.mockClear()
    await renderWithMobileStore(<InboxScreen />, {
      principal: ME,
      inboxNotices: [
        notice('s', {
          subjectKind: 'session',
          subjectId: 'sess_1',
          subjectAnchor: undefined,
          readAt: '2026-11-13T00:01:00.000Z',
        }),
      ],
    })
    fireEvent.click(await screen.findByLabelText('Bob mentioned you on POD-1: Task s'))
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/session/[sessionId]' }))
  })
})
