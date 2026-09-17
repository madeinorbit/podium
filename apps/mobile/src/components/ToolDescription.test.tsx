import { highlightCode } from '@podium/client-core/code-highlight'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolDescription } from './ToolDescription'

vi.mock('@podium/client-core/code-highlight', async (original) => {
  const actual = await original<typeof import('@podium/client-core/code-highlight')>()
  return { ...actual, highlightCode: vi.fn(actual.highlightCode) }
})
afterEach(() => {
  cleanup()
  vi.mocked(highlightCode).mockClear()
})

const command = 'for file in src/*.ts; do printf "%s\\n" "$file"; done && git diff --stat'

it('uses Bash tokens and preserves the command exactly', () => {
  const { container } = render(<ToolDescription toolName="Bash" command={command} />)
  expect(highlightCode).toHaveBeenCalledWith(command, 'bash')
  expect(container.textContent).toBe(command)
  expect(container.firstElementChild?.children.length).toBeGreaterThan(3)
  const colours = new Set(
    Array.from(container.firstElementChild!.children, (node) => (node as HTMLElement).style.color),
  )
  expect(colours.size).toBeGreaterThan(2)
})

it('keeps long split commands inside one shrinking single-line ellipsis', () => {
  const long = `${command} ${' && echo "$HOME"'.repeat(40)}`
  const { container } = render(<ToolDescription toolName="Bash" command={long} />)
  expect(container.children).toHaveLength(1)
  const outer = container.firstElementChild as HTMLElement
  expect(outer.textContent).toBe(long)
  expect(outer.children.length).toBeGreaterThan(40)
  const style = getComputedStyle(outer)
  expect(style.whiteSpace).toBe('nowrap')
  expect(style.overflow).toBe('hidden')
  expect(style.textOverflow).toBe('ellipsis')
  expect(style.minWidth).toBe('0px')
  expect(style.flex).toBe('1 1 0%')
  for (const leaf of outer.children) expect(leaf.tagName).toBe('SPAN')
})

it('memoises unchanged commands and recomputes changed commands', () => {
  const { rerender } = render(<ToolDescription toolName="Bash" command={command} />)
  rerender(<ToolDescription toolName="Bash" command={command} />)
  expect(highlightCode).toHaveBeenCalledTimes(1)
  rerender(<ToolDescription toolName="Bash" command={`${command} && pwd`} />)
  expect(highlightCode).toHaveBeenCalledTimes(2)
})

it('leaves other tool descriptions plain', () => {
  const { container } = render(<ToolDescription toolName="Read" command={command} />)
  expect(highlightCode).not.toHaveBeenCalled()
  expect(container.textContent).toBe(command)
  expect(container.firstElementChild?.children).toHaveLength(0)
})
