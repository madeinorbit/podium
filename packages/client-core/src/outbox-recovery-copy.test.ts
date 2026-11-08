import { describe, expect, it } from 'vitest'
import {
  couldNotSaveNotice,
  describeQueuedChange,
  recoverableAuthoredText,
  recoveryCopyFor,
  recoveryDialogCopy,
} from './outbox-recovery-copy'

describe('describeQueuedChange', () => {
  it.each([
    ['session.launch', 'Start the agent'],
    ['session.interrupt', 'Interrupt'],
    ['session.configure', 'Change the model or effort'],
    ['session.handoff', 'Hand off the session'],
    ['session.answer', 'Answer the question'],
    ['issue.start', 'Start a new task'],
    ['issue.begin', 'Start the task'],
    ['issue.stop', 'Stop the task'],
    ['issue.addSession', 'Add a session'],
    ['issue.cleanup', 'Clean up the task'],
    ['issue.ship', 'Ship the task'],
    ['issue.assistant', 'Refresh the assistant'],
    ['issue.merge', 'Merge the task'],
    ['issue.rebase', 'Rebase the task'],
    ['issue.pr', 'Create a pull request'],
    ['issue.integrate', 'Integrate the task'],
    ['issue.artifactAdd', 'Add an artifact'],
    ['issue.artifactPublish', 'Publish an artifact'],
    ['issue.artifactRemove', 'Remove an artifact'],
    ['file.write', 'Save the file'],
    ['approval.execute', 'Run the approved action'],
    ['server.update', 'Update the server'],
    ['server.move', 'Move the server'],
  ])('names the %s effect without echoing its input', (kind, label) => {
    const input = {
      id: 'SECRET-EFFECT',
      kind,
      target: { kind: 'issue', id: 'SECRET-TARGET' },
      input: { text: 'SECRET-TEXT', path: 'SECRET-PATH' },
    }
    expect(describeQueuedChange('effectCreate', input)).toEqual({ label, summary: null })
    expect(couldNotSaveNotice('effectCreate', input)).toBe(
      `Couldn’t ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    )
  })

  it.each([
    [{ model: 'SECRET-MODEL' }, 'Change the model'],
    [{ effort: 'SECRET-EFFORT' }, 'Change the effort'],
    [{ model: 'SECRET', effort: 'SECRET' }, 'Change the model or effort'],
  ])('names the configuration fields being changed', (input, label) => {
    expect(describeQueuedChange('effectCreate', { kind: 'session.configure', input })).toEqual({
      label,
      summary: null,
    })
  })

  it('names dismissal and unknown effects without internal names', () => {
    expect(couldNotSaveNotice('effectDismiss', { id: 'SECRET' })).toBe(
      'Couldn’t dismiss the result',
    )
    for (const input of [null, {}, { kind: 'internal.future', input: { text: 'SECRET' } }]) {
      expect(describeQueuedChange('effectCreate', input)).toEqual({
        label: 'Action',
        summary: null,
      })
    }
  })

  it('names Settings inheritance for a queued auto harness', () => {
    expect(
      describeQueuedChange('issueUpdate', { id: 'issue', patch: { defaultAgent: 'auto' } }),
    ).toEqual({
      label: 'Default agent',
      summary: 'Settings coding harness',
    })
  })
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
    expect(
      describeQueuedChange('issueSetLabels', { id: 'i1', labels: ['design', 'mobile'] }),
    ).toEqual({
      label: 'Issue labels',
      summary: 'design, mobile',
    })
  })
})

describe('recovery copy', () => {
  it('includes the server explanation in a refused Start toast', () => {
    expect(
      couldNotSaveNotice(
        'effectCreate',
        { kind: 'issue.begin' },
        {
          code: 'invalid',
          message: 'Choose a machine before starting the task.',
        },
      ),
    ).toBe('Couldn’t start the task — Choose a machine before starting the task.')
  })

  it('explains a refusal without a server message in user words', () => {
    expect(
      couldNotSaveNotice('effectCreate', { kind: 'issue.begin' }, { code: 'unauthorized' }),
    ).toBe('Couldn’t start the task — it was refused')
  })

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
      detail: 'Your other changes don’t wait for it. Sent again, it goes after them.',
    })
    expect(recoveryDialogCopy(2).title).toBe('Couldn’t save 2 changes')
    // Nothing queued behind a refusal (R1), and a retry goes to the back (R3).
    expect(recoveryDialogCopy(2).detail).toContain('don’t wait for them')
    expect(recoveryDialogCopy(2).detail).toContain('goes after them')
  })

  it('names the change in the toast, not the raw kind', () => {
    expect(couldNotSaveNotice('issueUpdate', { id: 'SECRET', patch: { stage: 'review' } })).toBe(
      'Couldn’t save issue stage',
    )
    expect(
      couldNotSaveNotice('issueUpdate', { id: 'SECRET', patch: { stage: 'review' } }),
    ).not.toContain('SECRET')
  })

  it('finds typed words and ignores bookkeeping fields', () => {
    expect(recoverableAuthoredText({ sessionId: 'SECRET', name: 'mine' })).toBe('mine')
    expect(recoverableAuthoredText({ id: 'SECRET', patch: { title: 'Renamed' } })).toBe('Renamed')
    expect(recoverableAuthoredText({ id: 'SECRET', patch: { stage: 'review' } })).toBeNull()
  })
})
