import type { IssueViewModel } from '@podium/client-core/replica'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const metrics = vi.hoisted(() => ({ scale: 1, listeners: new Set<() => void>() }))
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => {
    const fontScale = useSyncExternalStore(
      (listener) => {
        metrics.listeners.add(listener)
        return () => metrics.listeners.delete(listener)
      },
      () => metrics.scale,
    )
    return { width: 320, height: 568, fontScale, scale: 2 }
  },
}))
vi.mock('../RefChip', () => ({ RefChip: () => null }))
vi.mock('../../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))

import { InlineEditable, ReferenceGroup } from './chrome'
import { IssueBrief } from './IssueBody'

afterEach(() => {
  cleanup()
  metrics.scale = 1
  metrics.listeners.clear()
})
function resize(scale: number) {
  act(() => {
    metrics.scale = scale
    for (const listener of metrics.listeners) listener()
  })
}

it('invalidates native label and editor measurements across live type changes while preserving open folds and drafts', () => {
  render(
    <ReferenceGroup>
      <InlineEditable
        value="Task title"
        placeholder="Title"
        ariaLabel="Task title"
        busy={false}
        onCommit={() => {}}
      />
      <IssueBrief issue={{ brief: 'Keep this brief expanded.' } as IssueViewModel} />
    </ReferenceGroup>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Brief' }))
  const initialTitle = screen.getByText('Task title')
  resize(3.12)
  expect(screen.getByText('Task title')).not.toBe(initialTitle)
  expect(screen.getByRole('button', { name: 'Brief' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('Keep this brief expanded.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Task title' }))
  const editor = screen.getByRole('textbox', { name: 'Task title' })
  fireEvent.change(editor, { target: { value: 'Unsaved title after AX5' } })
  resize(1)
  const freshEditor = screen.getByRole('textbox', { name: 'Task title' })
  expect(freshEditor).not.toBe(editor)
  expect((freshEditor as HTMLTextAreaElement).value).toBe('Unsaved title after AX5')
  expect(screen.getByRole('button', { name: 'Brief' }).getAttribute('aria-expanded')).toBe('true')
})
