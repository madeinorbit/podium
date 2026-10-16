/**
 * The mode the session-map comparison starts in (POD-6160): throw under vitest,
 * log in a development build, off in a packaged stable or edge build, and
 * `PODIUM_SESSION_MAP_PARITY` overriding the build outside vitest (the
 * server-data bench sets it off to measure the reads, not the comparison).
 */

import { describe, expect, it } from 'vitest'
import { defaultSessionMapParityMode } from './map-parity'

describe('session-map comparison mode', () => {
  it('throws under vitest, whatever the switch says', () => {
    expect(defaultSessionMapParityMode({ VITEST: 'true', PODIUM_SESSION_MAP_PARITY: 'off' }, undefined)).toBe('throw')
  })

  it('logs in a source run or a development build, and is off in a packaged release', () => {
    expect(defaultSessionMapParityMode({}, undefined)).toBe('log')
    expect(defaultSessionMapParityMode({}, 'dev')).toBe('log')
    expect(defaultSessionMapParityMode({}, 'dev+0123456789abcdef0123456789abcdef01234567')).toBe('log')
    expect(defaultSessionMapParityMode({}, '1.4.2')).toBe('off')
  })

  it('takes the switch over the build outside vitest, and ignores other values', () => {
    expect(defaultSessionMapParityMode({ PODIUM_SESSION_MAP_PARITY: 'off' }, undefined)).toBe('off')
    expect(defaultSessionMapParityMode({ PODIUM_SESSION_MAP_PARITY: 'log' }, '1.4.2')).toBe('log')
    expect(defaultSessionMapParityMode({ PODIUM_SESSION_MAP_PARITY: 'throw' }, '1.4.2')).toBe('off')
  })
})
