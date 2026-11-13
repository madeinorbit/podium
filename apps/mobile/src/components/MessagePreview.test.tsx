import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 1, fontScale: 1 }),
}))
vi.mock('./RichMarkdown', () => ({
  RichMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
const { MessagePreview } = await import('./MessagePreview')
afterEach(cleanup)

it('bounds a long lifted message inside an opaque card within the screen', () => {
  const text = 'A long assistant paragraph.\n'.repeat(40)
  render(<MessagePreview text={text} />)
  const card = screen.getByTestId('message-preview')
  const style = getComputedStyle(card)
  expect(style.width).toBe('354px')
  expect(style.maxHeight).toBe('360px')
  expect(style.overflowX).toBe('hidden')
  expect(style.overflowY).toBe('hidden')
  expect(style.backgroundColor).not.toBe('transparent')
  expect(style.borderRadius).toBe('8px')
  expect(card.textContent).toBe(text)
})
