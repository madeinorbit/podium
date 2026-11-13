import { cleanup, render, screen } from '@testing-library/react'
import type { TextProps } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolCallContent } from './ToolCallContent'

const nativeTextProps = vi.hoisted(() => new Map<string, TextProps>())
vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>()
  return {
    ...native,
    Text: (props: TextProps) => {
      if (props.testID) nativeTextProps.set(props.testID, props)
      return <native.Text {...props} />
    },
  }
})

afterEach(() => {
  cleanup()
  nativeTextProps.clear()
})

it('bounds a single-line JSON preview by rendered lines and native text size', () => {
  const output = JSON.stringify({ value: 'x'.repeat(100_000), end: 'FULL-OUTPUT-END' })
  const block = {
    item: { id: 'json', role: 'tool' as const, text: '', toolName: 'Bash', toolResult: output },
  }
  const view = render(<ToolCallContent block={block} preview />)
  const preview = screen.getByTestId('tool-call-output-preview')
  // Happy DOM has no rendered line layout; assert the native Text clamp contract.
  expect(nativeTextProps.get('tool-call-output-preview')?.numberOfLines).toBe(6)
  expect(preview.textContent?.length).toBeLessThanOrEqual(960)
  expect(preview.textContent).not.toContain('FULL-OUTPUT-END')
  view.rerender(<ToolCallContent block={block} />)
  expect(view.container.textContent).toContain(output)
})

it('bounds wrapped diff lines while the sheet keeps the complete recorded edit', () => {
  const oldText = `${'old '.repeat(25_000)}END-OF-OLD-LINE`
  const newText = `${'new '.repeat(25_000)}END-OF-NEW-LINE`
  const block = {
    item: {
      id: 'diff',
      role: 'tool' as const,
      text: '',
      toolName: 'Edit',
      toolInputJson: JSON.stringify({
        kind: 'file-edit',
        mode: 'replace',
        hunks: [{ oldText, newText }],
        added: 1,
        removed: 1,
      }),
    },
  }
  const view = render(<ToolCallContent block={block} preview />)
  const preview = screen.getByTestId('tool-call-diff-preview')
  expect(nativeTextProps.get('tool-call-diff-preview')?.numberOfLines).toBe(6)
  expect(preview.textContent?.length).toBeLessThanOrEqual(1024)
  expect(preview.textContent).not.toContain('END-OF-NEW-LINE')
  view.rerender(<ToolCallContent block={block} />)
  expect(view.container.textContent).toContain(oldText)
  expect(view.container.textContent).toContain(newText)
})
