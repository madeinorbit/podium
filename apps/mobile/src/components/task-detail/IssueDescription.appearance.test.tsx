import type { IssueViewModel } from '@podium/client-core/replica'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { processColor } from 'react-native'
import { afterEach, expect, it, vi } from 'vitest'

const appearance = vi.hoisted(() => ({
  scheme: 'dark' as 'dark' | 'light',
  listeners: new Set<() => void>(),
}))
vi.mock('react-native', async (original) => {
  const { useSyncExternalStore } = await import('react')
  return {
    ...(await original<object>()),
    useColorScheme: () =>
      useSyncExternalStore(
        (listener) => {
          appearance.listeners.add(listener)
          return () => appearance.listeners.delete(listener)
        },
        () => appearance.scheme,
      ),
  }
})
vi.mock('../../theme/use-live-ink', () => import('../../theme/use-live-ink.ios'))
vi.mock('../RefChip', () => ({ RefChip: () => null }))
vi.mock('../../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))

import { DetailSection, ReferenceGroup } from './chrome'
import { IssueDescription, IssueDescriptionPreview } from './IssueBody'

afterEach(() => {
  cleanup()
  appearance.scheme = 'dark'
  appearance.listeners.clear()
})

function switchAppearance(scheme: 'dark' | 'light') {
  act(() => {
    appearance.scheme = scheme
    for (const listener of appearance.listeners) listener()
  })
}

function setup() {
  const view = render(
    <DetailSection label="Description" testID="description-section">
      <IssueDescription
        issue={{ description: 'Keep **this description** open.' } as IssueViewModel}
        busy={false}
        commands={{ commitDescription: vi.fn() } as never}
      />
    </DetailSection>,
  )
  return view.getByTestId('description-section').lastElementChild as HTMLElement
}

it('recolours mounted Description Markdown ink on a live appearance switch', () => {
  setup()
  const emphasis = screen.getByText('this description')
  switchAppearance('light')
  expect(screen.getByText('this description')).toBe(emphasis)
  expect(processColor(getComputedStyle(emphasis).color)).toBe(processColor('#000000'))
  switchAppearance('dark')
  expect(processColor(getComputedStyle(emphasis).color)).toBe(processColor('#f2f3f5'))
})

it('keeps an open Description draft while appearance changes', () => {
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Task description' }))
  const editor = screen.getByRole('textbox', { name: 'Task description' })
  fireEvent.change(editor, { target: { value: 'Unsaved description draft' } })
  switchAppearance('light')
  expect(screen.getByRole('textbox', { name: 'Task description' })).toBe(editor)
  expect((editor as HTMLTextAreaElement).value).toBe('Unsaved description draft')
  expect(processColor(getComputedStyle(editor).color)).toBe(processColor('#000000'))
})

it('refreshes the grouped reference background while keeping its expanded description mounted', () => {
  render(
    <ReferenceGroup>
      <IssueDescriptionPreview
        issue={{ description: 'Read **this description**.' } as IssueViewModel}
        busy={false}
        commands={{ commitDescription: vi.fn() } as never}
      />
    </ReferenceGroup>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'More description' }))
  const group = screen.getByTestId('issue-reference-group')
  const ground = group.firstElementChild
  const text = screen.getByText('this description')
  switchAppearance('light')
  expect(group.firstElementChild).not.toBe(ground)
  expect(screen.getByText('this description')).toBe(text)
  expect(processColor(getComputedStyle(text).color)).toBe(processColor('#000000'))
})
