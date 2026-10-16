/**
 * The mode the issue-map comparison starts in (POD-6158): throw under vitest,
 * log in a development build, off in a packaged stable or edge build, and
 * `PODIUM_ISSUE_MAP_PARITY` overriding the build outside vitest (the
 * server-data bench sets it off to measure the reads, not the comparison).
 */

import { describe, expect, it } from 'vitest'
import { defaultIssueMapParityMode } from './map-parity'

describe('issue-map comparison mode', () => {
  it('throws under vitest, whatever the switch says', () => {
    expect(defaultIssueMapParityMode({ VITEST: 'true', PODIUM_ISSUE_MAP_PARITY: 'off' }, undefined)).toBe('throw')
  })

  it('logs in a source run or a development build, and is off in a packaged release', () => {
    expect(defaultIssueMapParityMode({}, undefined)).toBe('log')
    expect(defaultIssueMapParityMode({}, 'dev')).toBe('log')
    expect(defaultIssueMapParityMode({}, 'dev+0123456789abcdef0123456789abcdef01234567')).toBe('log')
    expect(defaultIssueMapParityMode({}, '1.4.2')).toBe('off')
  })

  it('takes the switch over the build outside vitest, and ignores other values', () => {
    expect(defaultIssueMapParityMode({ PODIUM_ISSUE_MAP_PARITY: 'off' }, undefined)).toBe('off')
    expect(defaultIssueMapParityMode({ PODIUM_ISSUE_MAP_PARITY: 'log' }, '1.4.2')).toBe('log')
    expect(defaultIssueMapParityMode({ PODIUM_ISSUE_MAP_PARITY: 'throw' }, '1.4.2')).toBe('off')
  })
})
