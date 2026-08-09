import { describe, expect, it } from 'vitest'
import { runWithHeavyTestLease, shouldAcquireHeavyTestLease } from './test-heavy'
import { VALIDATION_HELD_ENV } from './validation-admission'

describe('shouldAcquireHeavyTestLease', () => {
  it('requires a live session identity', () => {
    expect(shouldAcquireHeavyTestLease({})).toBe(false)
    expect(shouldAcquireHeavyTestLease({ PODIUM_SESSION_ID: 'session-1' })).toBe(true)
  })

  it('does not treat unrelated Podium variables as a session', () => {
    expect(shouldAcquireHeavyTestLease({ PODIUM_INSTANCE: 'default' })).toBe(false)
  })
})

describe('runWithHeavyTestLease', () => {
  it('preserves the command exit code outside a live session', async () => {
    await expect(
      runWithHeavyTestLease(['bash', '-c', 'exit 3'], { cwd: process.cwd(), env: {} }),
    ).resolves.toBe(3)
  })

  it('re-enters an explicitly held heavy budget without another acquisition', async () => {
    await expect(
      runWithHeavyTestLease(['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env: {
          PODIUM_SESSION_ID: 'session-1',
          [VALIDATION_HELD_ENV]: 'heavy',
          PATH: '/usr/bin:/bin',
        },
      }),
    ).resolves.toBe(0)
  })
})
