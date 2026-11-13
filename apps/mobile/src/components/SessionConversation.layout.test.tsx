import type { SessionView } from '@podium/client-core/session-values'
import type { TranscriptItem } from '@podium/model'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

const layout = vi.hoisted(() => ({
  report: undefined as undefined | ((height: number) => void),
  insets: [] as number[],
}))
const originalOS = Platform.OS
afterEach(() => {
  cleanup()
  Platform.OS = originalOS
  layout.report = undefined
  layout.insets = []
})

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))
vi.mock('./Composer', () => ({
  Composer: ({ onRestingHeight }: { onRestingHeight?: (height: number) => void }) => {
    layout.report = onRestingHeight
    return <div data-testid="measuring-composer" />
  },
}))
vi.mock('./TranscriptList', () => ({
  TranscriptList: ({ bottomInset, footer }: { bottomInset: number; footer: ReactNode }) => {
    layout.insets.push(bottomInset)
    return <div data-testid="transcript-list">{footer}</div>
  },
}))
vi.mock('./LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => <>{children}</>,
  TranscriptSkeleton: () => null,
}))
vi.mock('./PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./TaskSheet', () => ({ TaskSheet: () => null }))

const { SessionConversation } = await import('./SessionConversation')
const session = {
  sessionId: 'session-layout',
  agentKind: 'claude-code',
  cwd: '/repo',
  title: 'Layout',
  status: 'hibernated',
  resumable: true,
  transcriptAvailable: true,
} as unknown as SessionView

describe('native lifecycle footer first layout', () => {
  it.each([
    { items: [] as TranscriptItem[] },
    { items: [{ id: 'last', role: 'assistant', text: 'Ready to continue.' }] as TranscriptItem[] },
  ])('pays the measured composer inset before mounting a short transcript: %o', async ({
    items,
  }) => {
    Platform.OS = 'ios'
    const view = await renderWithMobileStore(
      <SessionConversation session={session} issue={undefined} />,
      {
        sessions: [session],
        api: { sessions: { transcriptRead: { query: async () => ({ items, hasMore: false }) } } },
      },
    )
    expect(screen.getByTestId('measuring-composer')).toBeTruthy()
    expect(screen.queryByTestId('transcript-list')).toBeNull()
    expect(layout.insets).toEqual([])

    act(() => layout.report?.(148))
    await waitFor(() => expect(screen.getByTestId('hibernated-notice')).toBeTruthy())
    expect(layout.insets[0]).toBe(148)
    expect(layout.insets.every((inset) => inset >= 148)).toBe(true)

    const list = screen.getByTestId('transcript-list')
    await act(async () =>
      view.replica.applyChanges('sessions', [{ ...session, status: 'live' }], []),
    )
    expect(screen.queryByTestId('hibernated-notice')).toBeNull()
    expect(screen.getByTestId('transcript-list')).toBe(list)
    expect(layout.insets.at(-1)).toBe(148)
    await act(async () =>
      view.replica.applyChanges('sessions', [{ ...session, status: 'exited', exitCode: 1 }], []),
    )
    expect(screen.getByTestId('transcript-list')).toBe(list)
    expect(list.contains(screen.getByTestId('exited-notice'))).toBe(true)
    expect(layout.insets.at(-1)).toBe(148)

    view.unmount()
    layout.insets = []
    await renderWithMobileStore(<SessionConversation session={session} issue={undefined} />, {
      sessions: [session],
      api: { sessions: { transcriptRead: { query: async () => ({ items, hasMore: false }) } } },
    })
    expect(screen.queryByTestId('transcript-list')).toBeNull()
    act(() => layout.report?.(164))
    await waitFor(() => expect(screen.getByTestId('hibernated-notice')).toBeTruthy())
    expect(layout.insets[0]).toBe(164)
  })
})
