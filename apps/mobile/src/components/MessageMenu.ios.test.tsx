import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>
vi.mock('@expo/ui', () => ({
  Host: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@expo/ui/swift-ui', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  const ContextMenu = Object.assign(Box, { Trigger: Box, Items: Box })
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

it('shows the exact time as a native menu section title and keeps all message actions', () => {
  const onAction = vi.fn()
  const timeLabel = '13 Nov 2026 at 14:32:05 GMT+1'
  render(
    <MessageMenu text="The report is ready" timeLabel={timeLabel} canQuote onAction={onAction}>
      <Container>The report is ready</Container>
    </MessageMenu>,
  )
  expect(screen.getByRole('region', { name: timeLabel })).toBeTruthy()
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
