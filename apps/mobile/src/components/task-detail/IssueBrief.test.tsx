import type { IssueViewModel } from '@podium/client-core/replica'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { IssueBrief } from './IssueBody'

vi.mock('../RefChip', () => ({ RefChip: () => null }))
vi.mock('../../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(),
}))

afterEach(cleanup)

it('renders an expanded brief with the existing Markdown headings, emphasis and links', () => {
  const issue = {
    brief:
      '## Part 1\n\nRead **the checklist** and [the guide](https://example.com/guide).\n\n- First item\n- Second item',
  } as IssueViewModel
  const view = render(<IssueBrief issue={issue} />)
  fireEvent.click(screen.getByRole('button', { name: 'Brief' }))
  expect(screen.getByText('Part 1')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'the guide' })).toBeTruthy()
  expect(view.container.textContent).toContain('the checklist')
  expect(view.container.textContent).toContain('Second item')
  expect(view.container.textContent).not.toContain('##')
  expect(view.container.textContent).not.toContain('**')
})
