import { describe, expect, it } from 'vitest'
import { formatAppError } from '../src/app/AppErrorPage'

describe('formatAppError', () => {
  it('explains old relay servers that do not expose repo discovery', () => {
    const error = new Error('No procedure found on path "discovery.scanRepos"')
    expect(formatAppError(error)).toBe(
      'This relay server is running an older Podium backend that does not support repo discovery. Restart the relay from this branch, or connect to a matching relay server.',
    )
  })
})
