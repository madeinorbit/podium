import { describe, expect, it } from 'vitest'
import { MAX_CONVERGENCE_ATTEMPTS, resolveOnBoot } from './convergence'

const pending = {
  grantId: 'g1',
  targetVersion: '0.4.2',
  previousVersion: '0.4.1',
  attempts: 1,
  startedAt: 1_000,
}

describe('resolveOnBoot', () => {
  it('does nothing on an ordinary boot with no pending grant', () => {
    expect(resolveOnBoot({ pending: null, runningVersion: '0.4.2' })).toBeNull()
  })

  it('confirms when the daemon came back on the target', () => {
    expect(resolveOnBoot({ pending, runningVersion: '0.4.2' })).toEqual({
      action: 'confirm',
      state: 'current',
    })
  })

  it('retries when the swap did not take and attempts remain', () => {
    expect(resolveOnBoot({ pending, runningVersion: '0.4.1' })).toEqual({
      action: 'retry',
      attempts: 2,
    })
  })

  it('gives up and pins to last-known-good once attempts are exhausted', () => {
    const verdict = resolveOnBoot({
      pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
      runningVersion: '0.4.1',
    })
    expect(verdict).toMatchObject({ action: 'rollback', state: 'stuck' })
  })

  it('confirms at the attempt ceiling if the daemon actually made it', () => {
    expect(
      resolveOnBoot({
        pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
        runningVersion: '0.4.2',
      }),
    ).toEqual({ action: 'confirm', state: 'current' })
  })

  it('treats an unexpected third version as a failure, not a success', () => {
    const verdict = resolveOnBoot({
      pending: { ...pending, attempts: MAX_CONVERGENCE_ATTEMPTS },
      runningVersion: '0.3.0',
    })
    expect(verdict).toMatchObject({ action: 'rollback' })
  })

  it('bounds at two attempts', () => {
    expect(MAX_CONVERGENCE_ATTEMPTS).toBe(2)
  })
})
