import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 402, height: 874, scale: 1, fontScale: 1 }),
}))
vi.mock('./RichMarkdown', () => ({
  RichMarkdown: () => {
    throw new Error('Previews must not mount the interactive markdown tree')
  },
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
  expect(card.textContent).toContain('A long assistant paragraph.')
})

it('bounds preview work and renders no image, code or reference children', () => {
  const text =
    '**Summary** ![image](https://example.com/image.png) POD-2425\n\n```ts\n' +
    'const value = 1;\n'.repeat(50_000) +
    '```'
  render(<MessagePreview text={text} />)
  const card = screen.getByTestId('message-preview')
  expect(card.textContent?.startsWith('Summary image POD-2425')).toBe(true)
  expect(card.textContent?.length).toBeLessThanOrEqual(2050)
  expect(card.querySelector('img, a, button, pre')).toBeNull()
})
