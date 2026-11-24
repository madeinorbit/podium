import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }))
vi.mock('../hooks/useReduceMotion', () => ({ useReduceMotion: () => false }))
vi.mock('./SharedFiles', () => ({ SharedFiles: () => null }))
vi.mock('./PendingFiles', () => ({ PendingFiles: () => null }))
vi.mock('./RichMarkdown', async () => {
  const { Text } = await import('react-native')
  return {
    RichMarkdown: ({ text, textStyle }: { text: string; textStyle: object }) => (
      <Text style={textStyle}>{text}</Text>
    ),
    RichMarkdownInline: ({ text }: { text: string }) => <>{text}</>,
  }
})
vi.mock('./ActionSheet', () => ({ ActionSheet: () => null }))
vi.mock('./SelectTextSheet', () => ({ SelectTextSheet: () => null }))
vi.mock('./TranscriptViewport', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  const Viewport = forwardRef<
    import('./TranscriptViewport.types').TranscriptViewportHandle,
    import('./TranscriptViewport.types').TranscriptViewportProps<unknown>
  >((props, ref) => {
    useImperativeHandle(ref, () => ({ pinToNewest() {}, scrollToIndex() {} }))
    return (
      <div>
        <button type="button" onClick={() => props.onFollowChange?.(false)}>
          Read older
        </button>
        {props.data.map((item, index) => (
          <div key={props.keyExtractor(item, index)}>
            {
              props.renderItem({
                item,
                index,
                separators: { highlight() {}, unhighlight() {}, updateProps() {} },
              }) as ReactNode
            }
          </div>
        ))}
        {props.ListFooterComponent}
      </div>
    )
  })
  return { TranscriptViewport: Viewport }
})
const { TranscriptList } = await import('./TranscriptList')
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('keeps a confirmed message below an older unresolved /compact without moving older rows', () => {
  const history = { id: 'earlier', role: 'assistant' as const, text: 'Older answer' }
  const old = {
    id: 'compact',
    text: '/compact',
    afterTranscriptId: 'earlier',
    delivery: 'unknown' as const,
  }
  const props = { live: true, transcriptQuestion: null, onAnswer: async () => {} }
  const view = render(
    <TranscriptList
      {...props}
      items={[history]}
      pendingTurns={[old, { id: 'new', text: 'New message', afterTranscriptId: 'earlier' }]}
    />,
  )
  const bubbles = () => screen.getAllByTestId('operator-message').map((node) => node.textContent)
  expect(bubbles()[0]).toContain('/compact')
  expect(bubbles()[1]).toContain('New message')
  view.rerender(
    <TranscriptList
      {...props}
      items={[history, { id: 'echo', role: 'user', text: 'New message' }]}
      pendingTurns={[old]}
    />,
  )
  expect(bubbles()).toHaveLength(2)
  expect(bubbles()[0]).toContain('/compact')
  expect(bubbles()[1]).toContain('New message')
})

it('gives the interrupted marker its own padded row after cut-off streamed text', () => {
  const view = render(
    <TranscriptList
      items={[
        { id: 'long', role: 'assistant', text: `${'A streamed line\n'.repeat(600)}five h` },
        { id: 'stop', role: 'user', event: 'interrupt', text: '' },
      ]}
      live
      transcriptQuestion={null}
      onAnswer={async () => {}}
    />,
  )
  const marker = screen.getByTestId('interrupted-row')
  expect(Number.parseFloat(getComputedStyle(marker).paddingTop)).toBeGreaterThanOrEqual(8)
  expect(marker.textContent).toContain('Interrupted by you')
  expect(marker.textContent).not.toContain('five h')
  expect(view.container.textContent?.indexOf('five h')).toBeLessThan(
    view.container.textContent?.indexOf('Interrupted by you'),
  )
})

it('removes Newest immediately when a send pins, before any viewport callback', () => {
  const props = { items: [], live: true, transcriptQuestion: null, onAnswer: async () => {} }
  const view = render(<TranscriptList {...props} pinRequest={0} />)
  fireEvent.click(screen.getByText('Read older'))
  expect(screen.getByLabelText('Jump to newest message')).toBeTruthy()
  view.rerender(
    <TranscriptList
      {...props}
      pinRequest={1}
      pendingTurns={[{ id: 'pending', text: 'New message' }]}
    />,
  )
  expect(screen.queryByLabelText('Jump to newest message')).toBeNull()
})

it('reserves identical bubble and meta geometry when pending text becomes recorded', () => {
  const at = Date.now()
  const yesterday = new Date(at)
  yesterday.setDate(yesterday.getDate() - 1)
  const history = {
    id: 'earlier',
    role: 'assistant' as const,
    text: 'An earlier answer',
    ts: yesterday.toISOString(),
  }
  const props = { live: true, transcriptQuestion: null, onAnswer: async () => {} }
  const view = render(
    <TranscriptList
      {...props}
      items={[history]}
      pendingTurns={[{ id: 'pending', text: 'A message', delivery: 'sent', at }]}
    />,
  )
  const geometry = () =>
    [...screen.getByTestId('operator-message').querySelectorAll<HTMLElement>('*')].map((node) => {
      const style = getComputedStyle(node)
      return [
        node.tagName,
        style.paddingTop,
        style.paddingBottom,
        style.paddingLeft,
        style.paddingRight,
        style.minHeight,
        style.lineHeight,
        style.width,
        style.maxWidth,
        style.flexDirection,
      ]
    })
  const pending = geometry()
  expect(screen.getAllByText('Today')).toHaveLength(1)
  view.rerender(
    <TranscriptList
      {...props}
      items={[
        history,
        { id: 'recorded', role: 'user', text: 'A message', ts: new Date(at).toISOString() },
      ]}
      pendingTurns={[]}
    />,
  )
  expect(geometry()).toEqual(pending)
  expect(screen.getAllByText('Today')).toHaveLength(1)
  const frame = screen.getByTestId('operator-message').parentElement?.parentElement
  if (!frame) throw new Error('Missing operator frame')
  expect(getComputedStyle(frame).opacity).toBe('1')
})

it('keeps interrupted and pending-send rows free of old clocks', () => {
  vi.useFakeTimers()
  const props = { items: [], live: true, transcriptQuestion: null, onAnswer: async () => {} }
  const view = render(
    <TranscriptList
      {...props}
      tail={{ label: 'interrupted', tone: 'idle', since: '2026-11-13T10:00:00Z' }}
    />,
  )
  expect(screen.getByText('interrupted')).toBeTruthy()
  expect(screen.queryByLabelText('Working')).toBeNull()
  const before = view.container.textContent
  act(() => {
    vi.advanceTimersByTime(12_000)
  })
  expect(view.container.textContent).toBe(before)
  view.rerender(
    <TranscriptList
      {...props}
      tail={{ label: 'Sending', tone: 'idle', since: '2026-11-13T10:00:00Z' }}
    />,
  )
  expect(screen.getByText('Sending')).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/\d+[smh]/)
})
