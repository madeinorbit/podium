import { describe, expect, it } from 'vitest'
import {
  deadLetterNotice,
  describeQueuedChange,
  recoveryCopyFor,
  recoveryDialogCopy,
} from './outbox-recovery-copy'

describe('describeQueuedChange', () => {
  it('specializes an issueUpdate patch from the author’s fields, never the id', () => {
    expect(
      describeQueuedChange('issueUpdate', { id: 'SECRET-ISSUE-ID', patch: { title: 'New name' } }),
    ).toEqual({ label: 'Issue title', summary: null })
    expect(
      describeQueuedChange('issueUpdate', { id: 'SECRET-ISSUE-ID', patch: { stage: 'review' } }),
    ).toEqual({ label: 'Issue stage', summary: 'Moved to Review' })
    expect(
      describeQueuedChange('issueUpdate', {
        id: 'SECRET-ISSUE-ID',
        patch: { title: 'New name', stage: 'review', priority: 1 },
      }),
    ).toEqual({ label: 'Issue update', summary: 'Title, stage, and priority' })
  })

  it('never echoes identifiers from bookkeeping fields', () => {
    const machine = describeQueuedChange('issueUpdate', {
      id: 'SECRET-ISSUE-ID',
      patch: { machineId: 'SECRET-MACHINE-ID' },
    })
    expect(machine.label).toBe('Assigned machine')
    expect(JSON.stringify(machine)).not.toContain('SECRET-')

    const parent = describeQueuedChange('issueUpdate', {
      id: 'SECRET-ISSUE-ID',
      patch: { parentId: 'SECRET-PARENT-ID' },
    })
    expect(parent.summary).toBe('Moved under another issue')
    expect(JSON.stringify(parent)).not.toContain('SECRET-')

    const placement = describeQueuedChange('issueSetPlacement', {
      id: 'SECRET-ISSUE-ID',
      placement: 'own',
      originId: 'SECRET-ORIGIN-ID',
    })
    expect(placement).toEqual({ label: 'Issue moved', summary: 'Moved to your board' })
    expect(JSON.stringify(placement)).not.toContain('SECRET-')
  })

  it('describes tucked and label writes without dumping the payload', () => {
    expect(describeQueuedChange('issueSetTucked', { id: 'i1', tucked: true })).toEqual({
      label: 'Issue visibility',
      summary: 'Hidden from the list',
    })
    expect(describeQueuedChange('issueSetLabels', { id: 'i1', labels: ['design', 'mobile'] })).toEqual({
      label: 'Issue labels',
      summary: 'design, mobile',
    })
  })
})

describe('recovery copy', () => {
  it('keeps unauthorized wording silent about the target', () => {
    const copy = recoveryCopyFor('unauthorized')
    expect(copy.title).toBe('Needs access first')
    expect(copy.detail).not.toMatch(/no longer have access|does not exist|was deleted|not found/i)
  })

  it('says what to do for an invalid write without blaming the server', () => {
    const copy = recoveryCopyFor('invalid')
    expect(copy.title).toBe('Not accepted as written')
    expect(copy.retryLabel).toBeUndefined()
    expect(copy.detail.toLowerCase()).toMatch(/edit|discard/)
  })

  it('names a single failed change in the dialog header', () => {
    expect(recoveryDialogCopy(1)).toEqual({
      title: 'Couldn’t save this change',
      detail: 'It didn’t reach the server.',
    })
    expect(recoveryDialogCopy(2).title).toBe('Couldn’t save 2 changes')
  })

  it('names the change in the toast, not the raw kind', () => {
    expect(
      deadLetterNotice('issueUpdate', { id: 'SECRET', patch: { stage: 'review' } }, 'invalid'),
    ).toBe('Issue stage didn’t sync — it was not accepted as written')
    expect(
      deadLetterNotice('issueUpdate', { id: 'SECRET', patch: { stage: 'review' } }, 'invalid'),
    ).not.toContain('SECRET')
  })
})
