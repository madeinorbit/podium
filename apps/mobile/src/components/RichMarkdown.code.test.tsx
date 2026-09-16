import { act, cleanup, render } from '@testing-library/react'
import { processColor } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { prosePalette } from '../theme/syntax'
import { RichMarkdown } from './RichMarkdown'

vi.mock('./RefChip', () => ({ RefChip: () => null }))
vi.mock('../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('colours fenced source and preserves patch lines, headings and whitespace', () => {
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.useFakeTimers()
  const source = 'const value = "<hello>";\n  // second line'
  const patch = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new'
  const { container } = render(
    <RichMarkdown text={`\`\`\`typescript\n${source}\n\`\`\`\n\n\`\`\`patch\n${patch}\n\`\`\``} />,
  )
  act(() => vi.runAllTimers())
  expect(container.textContent).toBe(`typescript${source}patch${patch}`)
  const leaves = Array.from(container.querySelectorAll('span'))
  const leaf = (text: string) => {
    const element = leaves.find((el) => el.textContent === text && el.children.length === 0)
    if (!element) throw new Error(`Missing source leaf: ${text}`)
    return element
  }
  expect(leaf('const')?.style.color).toBe('rgba(187, 154, 247, 1.00)')
  expect(getComputedStyle(leaf('+new')).color).toBe('rgba(34, 197, 94, 1.00)')
  expect(getComputedStyle(leaf('-old\n')).color).toBe('rgba(239, 68, 68, 1.00)')
  expect(getComputedStyle(leaf('@@ -1 +1 @@\n')).color).toBe('rgba(6, 182, 212, 1.00)')
  expect(leaf('+++ b/file\n')?.style.color ?? '').toBe('')
})

it('distinguishes inline symbols from bold prose without a chip', () => {
  const { container } = render(
    <RichMarkdown text="Open `settings.ts` and **check the name**, then run `status`." />,
  )
  const leaves = Array.from(container.querySelectorAll('span'))
  const code = leaves.find((element) => element.textContent === 'settings.ts')
  const strong = leaves.find((element) => element.textContent === 'check the name')
  if (!code || !strong) throw new Error('Missing inline code or bold span')
  expect(processColor(getComputedStyle(code).color)).toBe(
    processColor(prosePalette.dark['code-inline']),
  )
  expect(processColor(getComputedStyle(strong).color)).toBe(
    processColor(prosePalette.dark['text-strong']),
  )
  expect(getComputedStyle(strong).fontFamily).toContain('Geist_600SemiBold')
  expect(['', 'transparent', 'rgba(0, 0, 0, 0)']).toContain(getComputedStyle(code).backgroundColor)
  expect(['', '0px']).toContain(getComputedStyle(code).borderWidth)
  expect(['', '0px']).toContain(getComputedStyle(code).borderRadius)
})
