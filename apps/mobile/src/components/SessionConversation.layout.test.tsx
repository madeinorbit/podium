import type { SessionView } from '@podium/client-core/session-values'
import type { TranscriptItem } from '@podium/model'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { act, type ComponentProps, type ReactNode } from 'react'
import { Platform, type View } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'

const layout = vi.hoisted(() => ({
  report: undefined as undefined | ((height: number) => void),
  insets: [] as number[],
  topInsets: [] as number[],
  placeholderInsets: [] as { topInset?: number; bottomInset?: number }[],
  keyboardLift: 0,
  callbacks: new Map<string, ComponentProps<typeof View>['onLayout']>(),
}))
vi.mock('react-native', async (original) => {
  const rn = await original<typeof import('react-native')>()
  const { forwardRef } = await import('react')
  return {
    ...rn,
    View: forwardRef<View, ComponentProps<typeof View>>((props, ref) => {
      if (props.testID) layout.callbacks.set(props.testID, props.onLayout)
      return <rn.View {...props} ref={ref} onLayout={undefined} />
    }),
  }
})
vi.mock('../hooks/useKeyboardHeight', () => ({ useKeyboardLift: () => layout.keyboardLift }))
const originalOS = Platform.OS
afterEach(() => {
  cleanup()
  Platform.OS = originalOS
  layout.report = undefined
  layout.insets = []
  layout.topInsets = []
  layout.placeholderInsets = []
  layout.keyboardLift = 0
  layout.callbacks.clear()
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
  TranscriptList: ({
    bottomInset,
    topInset,
    footer,
  }: {
    bottomInset: number
    topInset: number
    footer: ReactNode
  }) => {
    layout.insets.push(bottomInset)
    layout.topInsets.push(topInset)
    return <div data-testid="transcript-list">{footer}</div>
  },
}))
vi.mock('./LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({
    children,
    placeholder,
    resolved,
  }: {
    children: ReactNode
    placeholder: ReactNode
    resolved: boolean
  }) => (
    <>
      {resolved ? null : placeholder}
      {children}
    </>
  ),
  TranscriptSkeleton: (props: { topInset?: number; bottomInset?: number }) => {
    layout.placeholderInsets.push(props)
    return <div data-testid="transcript-skeleton" />
  },
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
  it('bounds an expanded pinned question and the composer between the header and keyboard', async () => {
    Platform.OS = 'ios'
    layout.keyboardLift = 336
    const live = { ...session, status: 'live' } as SessionView
    await renderWithMobileStore(
      <SessionConversation session={live} issue={undefined} topInset={132} />,
      {
        sessions: [live],
        api: {
          sessions: {
            transcriptRead: {
              query: async () => ({
                items: [
                  {
                    id: 'long-question',
                    role: 'tool',
                    text: '',
                    toolName: 'AskUserQuestion',
                    toolInputJson: JSON.stringify({
                      questions: [
                        {
                          question: 'Which rollout should we use? '.repeat(15),
                          options: [{ label: 'Staged rollout' }, { label: 'Wait' }],
                        },
                      ],
                    }),
                  },
                ],
                hasMore: false,
              }),
            },
          },
        },
      },
    )
    act(() => {
      layout.report?.(148)
      layout.callbacks.get('conversation-viewport')?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 402, height: 800 } },
      } as never)
    })
    await screen.findByLabelText('Show question')
    fireEvent.click(screen.getByLabelText('Show question'))
    const layer = screen.getByTestId('conversation-composer-layer')
    expect(layer.style.maxHeight).toBe('332px')
    expect(layer.style.bottom).toBe('336px')
    const card = screen.getByTestId('ask-question-tile')
    const scroll = screen.getByTestId('ask-question-scroll')
    expect(getComputedStyle(card.parentElement as HTMLElement).flexShrink).toBe('1')
    expect(getComputedStyle(card).flexShrink).toBe('1')
    expect(getComputedStyle(scroll).flexShrink).toBe('1')
    expect(layer.contains(screen.getByTestId('measuring-composer'))).toBe(true)
    expect(screen.getByLabelText('Wait')).toBeTruthy()
  })

  it.each([
    { items: [] as TranscriptItem[] },
    { items: [{ id: 'last', role: 'assistant', text: 'Ready to continue.' }] as TranscriptItem[] },
  ])('pays the measured composer inset before mounting a short transcript: %o', async ({
    items,
  }) => {
    Platform.OS = 'ios'
    const view = await renderWithMobileStore(
      <SessionConversation session={session} issue={undefined} topInset={147} />,
      {
        sessions: [session],
        api: { sessions: { transcriptRead: { query: async () => ({ items, hasMore: false }) } } },
      },
    )
    expect(screen.getByTestId('measuring-composer')).toBeTruthy()
    expect(screen.queryByTestId('transcript-list')).toBeNull()
    expect(layout.insets).toEqual([])
    expect(layout.placeholderInsets.at(-1)?.topInset).toBe(147)

    act(() => layout.report?.(148))
    await waitFor(() => expect(screen.getByTestId('hibernated-notice')).toBeTruthy())
    expect(layout.insets[0]).toBe(148)
    expect(layout.topInsets[0]).toBe(147)
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
    expect(screen.queryByTestId('measuring-composer')).toBeNull()
    expect(layout.insets.at(-1)).toBe(0)

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

  it('mounts an exited transcript immediately when its composer is hidden', async () => {
    Platform.OS = 'ios'
    const exited = { ...session, status: 'exited', exitCode: 1 } as SessionView
    const view = await renderWithMobileStore(
      <SessionConversation session={exited} issue={undefined} />,
      {
        sessions: [exited],
        api: {
          sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } },
        },
      },
    )
    expect(screen.queryByTestId('measuring-composer')).toBeNull()
    expect(
      screen.getByTestId('transcript-list').contains(screen.getByTestId('exited-notice')),
    ).toBe(true)
    expect(layout.insets[0]).toBe(0)
    const list = screen.getByTestId('transcript-list')
    await act(async () =>
      view.replica.applyChanges('sessions', [{ ...exited, status: 'live' }], []),
    )
    expect(screen.getByTestId('transcript-list')).toBe(list)
    expect(screen.getByTestId('measuring-composer')).toBeTruthy()
    act(() => layout.report?.(148))
    expect(screen.getByTestId('transcript-list')).toBe(list)
    expect(layout.insets.at(-1)).toBe(148)
  })
})
