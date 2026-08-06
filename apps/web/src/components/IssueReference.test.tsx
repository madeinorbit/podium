// @vitest-environment happy-dom
import { asIssueId } from '@podium/model'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IssueReference } from './IssueReference'

describe('IssueReference', () => {
  it('renders stage, canonical ref, and title as one accessible reference', () => {
    render(
      <IssueReference
        model={{
          ref: 'POD-17',
          issueId: asIssueId('iss_1'),
          title: 'Normalize task references',
          stage: 'review',
          availability: 'present',
          accessibleLabel: 'Review task POD-17: Normalize task references',
        }}
      />,
    )

    const reference = screen.getByLabelText('Review task POD-17: Normalize task references')
    expect(reference.dataset.issueStage).toBe('review')
    expect(reference.textContent).toBe('POD-17Normalize task references')
    expect(reference.querySelector('svg')).toBeTruthy()
  })

  it('uses a quiet fallback and no stale stage for an unavailable issue', () => {
    render(
      <IssueReference
        model={{
          ref: 'POD-99',
          issueId: null,
          title: null,
          stage: null,
          availability: 'unavailable',
          accessibleLabel: 'Task POD-99 is unavailable',
        }}
      />,
    )

    const reference = screen.getByLabelText('Task POD-99 is unavailable')
    expect(reference.dataset.issueStage).toBeUndefined()
    expect(reference.dataset.issueAvailability).toBe('unavailable')
    expect(reference.textContent).toBe('POD-99')
  })
})
