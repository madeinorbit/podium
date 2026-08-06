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

  it.each([
    [{ archived: true }, 'archived', 'Archived task POD-17: Normalize task references'],
    [
      { deletedAt: '2026-08-06T10:00:00.000Z' },
      'deleted',
      'Deleted task POD-17: Normalize task references',
    ],
  ] as const)('does not expose stale workflow state for %s issues', (patch, availability, label) => {
    const model = issueReferenceModel(issue(patch))
    expect(model.availability).toBe(availability)
    expect(model.stage).toBeNull()
    expect(model.accessibleLabel).toBe(label)
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
