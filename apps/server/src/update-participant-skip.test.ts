import { describe, expect, it } from 'vitest'
import { updateParticipantSkip, updateParticipantSkipNote } from './update-participant-skip'

const none = {
  fleetOnly: false,
  supervisorOwnsUpdates: false,
  runningFromSource: false,
  recoveryOnly: false,
  participantDisabledForRun: false,
} as const

describe('updateParticipantSkip', () => {
  it('names supervisor ownership rather than an undiscoverable parent', () => {
    // The ludovico shape: an installed coordinator whose daemon owns its updates.
    const skip = updateParticipantSkip({ ...none, supervisorOwnsUpdates: true })
    expect(skip.why).toContain('supervising daemon owns updates')
    expect(skip.why).not.toContain('discoverable')
    expect(skip.level).toBe('info')
  })

  it('still reports the genuinely unknown case as a warning', () => {
    expect(updateParticipantSkip(none)).toEqual({
      why: 'no supervising parent is discoverable in the run registry',
      level: 'warn',
    })
  })

  it('prefers the declared fleet-only scope over supervisor ownership', () => {
    const skip = updateParticipantSkip({ ...none, fleetOnly: true, supervisorOwnsUpdates: true })
    expect(skip.why).toContain('updateScope=fleet-only')
    expect(skip.level).toBe('info')
  })

  it('keeps the source checkout quiet and the fenced coordinator loud', () => {
    expect(updateParticipantSkip({ ...none, runningFromSource: true })).toEqual({
      why: 'this coordinator runs from source',
      level: 'debug',
    })
    expect(updateParticipantSkip({ ...none, recoveryOnly: true })).toEqual({
      why: 'the coordinator is fenced in recovery-only mode',
      level: 'warn',
    })
    expect(updateParticipantSkip({ ...none, participantDisabledForRun: true })).toEqual({
      why: 'the local participant is disabled for this run',
      level: 'warn',
    })
  })

  it('reports source checkout ahead of a fence, so the quiet shape stays quiet', () => {
    // Both hold in a dev run; only the source checkout explains it to a human.
    expect(updateParticipantSkip({ ...none, runningFromSource: true, recoveryOnly: true }).level).toBe(
      'debug',
    )
  })

  it('keeps the note explaining what the machine loses', () => {
    expect(updateParticipantSkipNote('because')).toBe(
      'this machine will not report its build or appear online in its own fleet: because',
    )
  })
})
