import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RichMarkdown } from './RichMarkdown'

vi.mock('./RefChip', () => ({ RefChip: () => null }))
vi.mock('../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('colours fenced source and preserves patch lines, headings and whitespace', () => {
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.useFakeTimers()
  const source = 'const value = "<hello>";\n  // second line'
  const patch = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new'
  const {container} = render(<RichMarkdown text={`\`\`\`typescript\n${source}\n\`\`\`\n\n\`\`\`patch\n${patch}\n\`\`\``} />)
  act(() => vi.runAllTimers())
  expect(container.textContent).toBe(`typescript${source}patch${patch}`)
  const leaves = Array.from(container.querySelectorAll('span'))
  const leaf = (text: string) => leaves.find(el => el.textContent === text && el.children.length === 0)
  expect(leaf('const')?.style.color).toBe('rgb(187, 154, 247)')
  expect(leaf('+new')?.style.color).toBe('rgb(34, 197, 94)')
  expect(leaf('-old\n')?.style.color).toBe('rgb(239, 68, 68)')
  expect(leaf('@@ -1 +1 @@\n')?.style.color).toBe('rgb(6, 182, 212)')
  expect(leaf('+++ b/file\n')?.style.color ?? '').toBe('')
})
