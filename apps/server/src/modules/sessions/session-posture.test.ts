import { DEFAULT_SESSION_POSTURE } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { legacyPermissionModeFor, sessionPostureFor } from './session-posture'

/**
 * THE ONE PLACE PRODUCT CODE CHOOSES A POSTURE (POD-6858 Task 9). A mode the
 * person picked from the harness's own list rides as that native mode;
 * otherwise the session runs on the default. No harness word is decided here.
 */
describe('sessionPostureFor', () => {
  it('is the default when nobody picked a mode', () => {
    expect(sessionPostureFor({})).toEqual(DEFAULT_SESSION_POSTURE)
    expect(sessionPostureFor({})).toEqual({ mode: 'autonomous' })
  })

  it("is the person's native pick when there is one", () => {
    expect(sessionPostureFor({ nativeMode: 'plan' })).toEqual({ mode: { native: 'plan' } })
  })

  it('reads an empty pick as no pick', () => {
    expect(sessionPostureFor({ nativeMode: '' })).toEqual(DEFAULT_SESSION_POSTURE)
  })

  it('returns a value nobody else can mutate into the shared default', () => {
    const posture = sessionPostureFor({})
    expect(posture).not.toBe(DEFAULT_SESSION_POSTURE)
  })
})

/**
 * WHAT A PRE-POSTURE DAEMON READS (LEGACY). Those daemons took a Claude mode
 * word in `permissionMode`; the server keeps sending the word that reproduces
 * what it sent before posture existed.
 */
describe('legacyPermissionModeFor', () => {
  it("sends 'auto' for autonomous, exactly as the superagent always did", () => {
    expect(legacyPermissionModeFor({ mode: 'autonomous' })).toBe('auto')
  })

  it("sends 'default' for supervised", () => {
    expect(legacyPermissionModeFor({ mode: 'supervised' })).toBe('default')
  })

  it('sends a native pick as its own word', () => {
    expect(legacyPermissionModeFor({ mode: { native: 'plan' } })).toBe('plan')
  })
})
