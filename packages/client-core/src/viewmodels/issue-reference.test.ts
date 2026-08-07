import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { IssueReferenceSource } from './issue-reference'
import { issueReferenceModel, resolveIssueReference } from './issue-reference'

const issue = (patch: Partial<IssueReferenceSource> = {}): IssueReferenceSource => ({
  id: asIssueId('iss_1'),
  seq: 17,
  prefix: 'POD',
  displayRef: 'POD-17',
  title: 'Normalize task references',
  stage: 'review',
  ...patch,
})

describe('issueReferenceModel', () => {
  it('projects the live stage, identity, title, and accessible label', () => {
    expect(issueReferenceModel(issue())).toEqual({
      ref: 'POD-17',
      issueId: 'iss_1',
      title: 'Normalize task references',
      stage: 'review',
      availability: 'present',
      accessibleLabel: 'Review task POD-17: Normalize task references',
    })
  })

  it('keeps workflow stage for archived issues so status chips still resolve', () => {
    const model = issueReferenceModel(issue({ archived: true, stage: 'done' }))
    expect(model).toEqual({
      ref: 'POD-17',
      issueId: 'iss_1',
      title: 'Normalize task references',
      stage: 'done',
      availability: 'archived',
      accessibleLabel: 'Archived Done task POD-17: Normalize task references',
    })
  })

  it('does not expose workflow stage for deleted issues', () => {
    const model = issueReferenceModel(
      issue({ deletedAt: '2026-08-06T10:00:00.000Z', stage: 'review' }),
    )
    expect(model.availability).toBe('deleted')
    expect(model.stage).toBeNull()
    expect(model.accessibleLabel).toBe('Deleted task POD-17: Normalize task references')
  })
})

describe('resolveIssueReference', () => {
  it('resolves a canonical issue token against the current projection', () => {
    expect(resolveIssueReference(' POD-17 ', [issue()])).toEqual(issueReferenceModel(issue()))
  })

  it('keeps a missing row opaque instead of guessing why it is absent', () => {
    expect(resolveIssueReference('POD-99', [issue()])).toEqual({
      ref: 'POD-99',
      issueId: null,
      title: null,
      stage: null,
      availability: 'unavailable',
      accessibleLabel: 'Task POD-99 is unavailable',
    })
  })

  it.each([
    'POD-17-A',
    'POD-DRAFT-2',
    'not-a-ref',
  ])('does not misclassify %s as an issue reference', (token) =>
    expect(resolveIssueReference(token, [issue()])).toBeNull())
})
