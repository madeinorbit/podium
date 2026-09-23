/**
 * A SESSION LINK WITH A SHORT ID (POD-4637).
 *
 * `podium session status 214a3887` resolves; `/mobile/session/214a3887` used to
 * look the prefix up as an exact id, find nothing, and tell the person "Session
 * not here yet." about a session that was live. The route now asks the server —
 * the SAME resolver the CLI uses — and opens the full id, or says the prefix is
 * ambiguous, or says no session matches. It never says "not here yet" about a
 * prefix.
 */
import type { SessionMeta } from '@podium/model'
import { asSessionId } from '@podium/model'
import { cleanup, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

const routerReplace = vi.fn()
let routeSessionId = '214a3887'

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
  useLocalSearchParams: () => ({ sessionId: routeSessionId }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 34, left: 0 }),
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: () => null,
  MoreVertical: () => null,
  SquareTerminal: () => null,
}))
vi.mock('../components/SessionConversation', () => ({ SessionConversation: () => null }))
vi.mock('../components/AgentMark', () => ({ HarnessChip: () => null }))
vi.mock('../components/WorkingMark', () => ({ WorkingMark: () => null }))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  DetailSkeleton: () => null,
}))

const { renderWithMobileStore } = await import('../client/test-support')
const { SessionScreen } = await import('./SessionScreen')

const FULL = '214a3887-6146-4a1d-9c3e-0123456789ab'

const live = (): SessionMeta =>
  ({
    agentKind: 'claude-code',
    cwd: '/home/dev/podium',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-09-23T10:00:00.000Z',
    lastActiveAt: '2026-09-23T10:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    title: 'Live agent',
    sessionId: asSessionId(FULL),
  }) as unknown as SessionMeta

async function mount(answer: Promise<unknown>, sessions: SessionMeta[] = [live()]) {
  const resolve = vi.fn(() => answer)
  const rendered = await renderWithMobileStore(<SessionScreen />, {
    sessions,
    api: {
      sessions: {
        transcriptRead: { query: async () => ({ items: [], hasMore: false }) },
        resolve: { query: resolve },
      },
    },
  })
  return { rendered, resolve }
}

beforeEach(() => {
  routerReplace.mockReset()
  routeSessionId = '214a3887'
})

describe('a short session id in the phone route', () => {
  it('opens the full session the server resolves it to', async () => {
    const { resolve } = await mount(Promise.resolve({ kind: 'session', sessionId: FULL }))
    await waitFor(() => expect(routerReplace).toHaveBeenCalled())
    expect(resolve).toHaveBeenCalledWith({ identifier: '214a3887' })
    const href = routerReplace.mock.calls[0]?.[0] as { params: { sessionId: string } }
    expect(href.params.sessionId).toBe(FULL)
  })

  it('never says "not here yet" while the server is answering', async () => {
    await mount(new Promise(() => {}))
    await screen.findByText('Opening session…')
    expect(screen.queryByText('Session not here yet.')).toBeNull()
  })

  it('says the prefix is ambiguous and names why', async () => {
    routeSessionId = '2'
    const message = "ambiguous session id prefix '2' matches 2 sessions: 2a, 2b"
    await mount(Promise.resolve({ kind: 'ambiguous', prefix: '2', candidates: ['2a', '2b'], message }))
    await screen.findByText('Several sessions match this link.')
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.queryByText('Session not here yet.')).toBeNull()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('says not found for a prefix that names nothing', async () => {
    routeSessionId = 'bbbbbbbb'
    await mount(Promise.resolve({ kind: 'absent' }))
    await screen.findByText('Session not found.')
    expect(screen.queryByText('Session not here yet.')).toBeNull()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('a full id already on the phone never asks the server', async () => {
    routeSessionId = FULL
    const { resolve } = await mount(Promise.resolve({ kind: 'absent' }))
    await screen.findByLabelText('Session actions')
    expect(resolve).not.toHaveBeenCalled()
  })
})
