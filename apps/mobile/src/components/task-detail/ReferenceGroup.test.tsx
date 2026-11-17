import type { IssueViewModel } from '@podium/client-core/replica'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../RefChip', () => ({ RefChip: () => null }))
vi.mock('../../lib/podium-link', () => ({ followPodiumLink: vi.fn() }))
vi.mock('../../hooks/useReduceMotion', () => ({ useReduceMotion: () => true }))
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }))
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'light' } }))

import { ReferenceGroup } from './chrome'
import { IssueBrief, IssueDescriptionPreview } from './IssueBody'

afterEach(cleanup)

it('keeps description context and folded reference rows in one group, with More revealing the editable Markdown', () => {
  const issue = {
    description: 'Context with **emphasis**.\n\n- First bullet\n- Second bullet',
    brief: 'Agent instructions',
  } as IssueViewModel
  render(
    <ReferenceGroup>
      <IssueDescriptionPreview
        issue={issue}
        busy={false}
        commands={{ commitDescription: vi.fn() } as never}
      />
      <IssueBrief issue={issue} />
    </ReferenceGroup>,
  )
  const group = screen.getByTestId('issue-reference-group')
  expect(group.contains(screen.getByText('emphasis'))).toBe(true)
  expect(screen.queryByRole('button', { name: 'Task description' })).toBeNull()
  expect(screen.queryByText('Agent instructions')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'More description' }))
  expect(screen.getByRole('button', { name: 'Task description' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Brief' }))
  expect(group.contains(screen.getByText('Agent instructions'))).toBe(true)
})
