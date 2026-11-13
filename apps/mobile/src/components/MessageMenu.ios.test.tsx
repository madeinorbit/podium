import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>
const native = vi.hoisted(() => ({
  bodyLayout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
  host: {} as Record<string, unknown>,
}))
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>()
  return {
    ...actual,
    View: (props: ComponentProps<typeof actual.View>) => {
      if (props.testID === 'message-menu-body') native.bodyLayout = props.onLayout
      return <actual.View {...props} />
    },
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 1, fontScale: 1 }),
  }
})
vi.mock('./MessagePreview', () => ({
  MessagePreview: ({ text }: { text: string }) => <div data-testid="preview">{text}</div>,
}))
vi.mock('@expo/ui', () => ({
  Host: (props: { children?: ReactNode }) => {
    native.host = props
    return <div>{props.children}</div>
  },
}))
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const ContextMenu = Object.assign(Box, {
    Trigger: ({ children }: { children?: ReactNode }) => (
      <div data-testid="message-trigger">{children}</div>
    ),
    Items: Box,
    Preview: Box,
  })
  return {
    ContextMenu,
    RNHostView: Box,
    Section: ({ title, children }: { title?: string; children?: ReactNode }) => (
      <section aria-label={title}>{children}</section>
    ),
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
      <button type="button" onClick={onPress}>
        {label}
      </button>
    ),
  }
})
const { MessageMenu } = await import('./MessageMenu.ios')
afterEach(cleanup)

it('reserves the full measured height of very long and growing markdown even before SwiftUI catches up', () => {
  const view = render(
    <MessageMenu text="Long message" canQuote={false} onAction={() => {}}>
      <Container>{'A streamed line\n'.repeat(600)}five h</Container>
    </MessageMenu>,
  )
  const measure = (height: number) =>
    act(() =>
      native.bodyLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 370, height } },
      } as LayoutChangeEvent),
    )
  measure(14_424)
  expect(getComputedStyle(screen.getByTestId('message-menu-host')).minHeight).toBe('14424px')
  expect(native.host).toMatchObject({ ignoreSafeArea: 'all', style: { minHeight: 14_424 } })
  view.rerender(
    <MessageMenu text="Long message plus final line" canQuote={false} onAction={() => {}}>
      <Container>{'A streamed line\n'.repeat(601)}Last line</Container>
    </MessageMenu>,
  )
  measure(14_448)
  expect(getComputedStyle(screen.getByTestId('message-menu-host')).minHeight).toBe('14448px')
  measure(96)
  expect(getComputedStyle(screen.getByTestId('message-menu-host')).minHeight).toBe('96px')
})

it('keeps Copy bound to the opened note when the following assistant row changes', () => {
  const onAction = vi.fn()
  const note = 'The complete by-id note body.'
  const messages = (reply: string) => (
    <>
      <MessageMenu text={note} timeLabel="Note delivered" canQuote onAction={onAction}>
        <Container>{note}</Container>
      </MessageMenu>
      <MessageMenu text={reply} timeLabel="Assistant replied" canQuote onAction={onAction}>
        <Container>{reply}</Container>
      </MessageMenu>
    </>
  )
  const view = render(messages('Nothing has changed.'))
  fireEvent.click(within(screen.getByRole('region', { name: 'Note delivered' })).getByText('Copy'))
  expect(onAction).toHaveBeenLastCalledWith(note, 'copy')
  view.rerender(messages('The next assistant message.'))
  fireEvent.click(within(screen.getByRole('region', { name: 'Note delivered' })).getByText('Copy'))
  expect(onAction).toHaveBeenLastCalledWith(note, 'copy')
})

it('measures transcript paragraphs at the host width so their last line stays above the next row', () => {
  render(
    <MessageMenu text="A long paragraph" canQuote={false} onAction={() => {}}>
      <Container>A long paragraph</Container>
    </MessageMenu>,
  )
  const body = screen.getByTestId('message-trigger').querySelector<HTMLElement>('[style]')
  expect(body).toBeTruthy()
  expect(Number.parseFloat(body?.style.width ?? '')).toBeGreaterThan(0)
})

it('shows the exact time as a native menu section title and keeps all message actions', () => {
  const onAction = vi.fn()
  const timeLabel = '13 Nov 2026 at 14:32:05 GMT+1'
  render(
    <MessageMenu text="The report is ready" timeLabel={timeLabel} canQuote onAction={onAction}>
      <Container>The report is ready</Container>
    </MessageMenu>,
  )
  expect(screen.getByRole('region', { name: timeLabel })).toBeTruthy()
  expect(screen.getByTestId('preview').textContent).toBe('The report is ready')
  fireEvent.click(screen.getByText('Copy', { exact: true }))
  expect(onAction).toHaveBeenLastCalledWith('The report is ready', 'copy')
  fireEvent.click(screen.getByText('Quote in Reply'))
  expect(onAction).toHaveBeenLastCalledWith('The report is ready', 'quote')
  fireEvent.click(screen.getByText('Select Text'))
  expect(onAction).toHaveBeenLastCalledWith('The report is ready', 'select')
})

it('keeps an undated message menu free of an invented timestamp', () => {
  render(
    <MessageMenu text="Older message" canQuote={false} onAction={() => {}}>
      <Container>Older message</Container>
    </MessageMenu>,
  )
  expect(screen.queryByRole('region')).toBeNull()
  expect(screen.queryByText('Quote in Reply')).toBeNull()
  expect(screen.getByText('Copy')).toBeTruthy()
})
