import { describe, expect, it } from 'vitest'
import { sessionTransition, sessionTransitionLabel } from './session-transition'

describe('sessionTransition (POD-6399)', () => {
  it('is nothing for a session nobody has edited', () => {
    expect(sessionTransition({})).toBeUndefined()
  })

  it('is on its way while the revision is ahead of the observed one', () => {
    expect(sessionTransition({ desired: 'stopped', revision: 2 })).toEqual({ kind: 'stopping' })
    expect(sessionTransition({ desired: 'hibernated', revision: 3, observedRevision: 2 })).toEqual({
      kind: 'hibernating',
    })
    expect(sessionTransition({ desired: 'running', revision: 2 })).toEqual({ kind: 'starting' })
  })

  it('is nothing once the controller acknowledged it, whatever the status says', () => {
    // A session that exited on its own keeps desired running: not "Starting…".
    expect(
      sessionTransition({ desired: 'running', revision: 2, observedRevision: 2 }),
    ).toBeUndefined()
  })

  it('shows a refusal of the current revision, and not of an older one', () => {
    const refused = {
      desired: 'stopped' as const,
      revision: 2,
      observedRevision: 2,
      lifecycleFailure: { revision: 2, reason: 'unsaved changes' },
    }
    expect(sessionTransition(refused)).toEqual({
      kind: 'refused',
      desired: 'stopped',
      reason: 'unsaved changes',
    })
    expect(sessionTransitionLabel(sessionTransition(refused)!)).toBe(
      "Couldn't end — unsaved changes",
    )
    // The next edit (painted at revision 3) supersedes it.
    expect(sessionTransition({ ...refused, revision: 3 })).toEqual({ kind: 'stopping' })
  })
})
