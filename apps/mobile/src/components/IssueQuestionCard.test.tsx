import type { IssueWire } from '@podium/model'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: vi.fn(async () => {}),
}))

const { IssueQuestionCard } = await import('./IssueQuestionCard')

const issue = {
  id: 'issue-1',
  humanQuestion: 'Which navigation should ship?',
  humanQuestionOptions: ['Work first', 'Tasks first'],
} as unknown as IssueWire

describe('IssueQuestionCard', () => {
  it('answers or resolves a question from its task context', async () => {
    const onAnswer = vi.fn(async () => {})
    const onOpenSession = vi.fn()
    const onResolve = vi.fn(async () => {})
    render(
      <IssueQuestionCard
        issue={issue}
        onAnswer={onAnswer}
        onOpenSession={onOpenSession}
        onResolve={onResolve}
      />,
    )

    fireEvent.click(screen.getByLabelText('Work first'))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('Work first'))
    await waitFor(() =>
      expect(screen.getByLabelText('Answer in session').hasAttribute('disabled')).toBe(false),
    )

    fireEvent.click(screen.getByLabelText('Answer in session'))
    expect(onOpenSession).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByLabelText('Mark question resolved'))
    await waitFor(() => expect(onResolve).toHaveBeenCalledOnce())
  })
})
