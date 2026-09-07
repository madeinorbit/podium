import { describe, expect, it } from 'vitest'
import { SERVER_MOVE_ERROR_COPY, serverMoveErrorCopy } from './server-move'

const expectedCodes = [
  'active-transfer',
  'invalid-confirmation',
  'invalid-url',
  'target-not-found',
  'target-is-source',
  'target-offline',
  'target-unsupported',
  'source-unhealthy',
  'disk-full',
  'snapshot-failed',
  'source-changed',
  'reauthorization-denied',
  'target-rejected',
  'target-proof-missing',
  'source-config-failed',
  'commit-uncertain',
  'handoff-orphaned',
  'handoff-unsealed',
  'boot-recovery',
  'recovery-refused',
  'legacy-transfer-in-progress',
  'internal',
] as const

describe('server-move presenter', () => {
  it('gives every failure code exactly one user sentence', () => {
    expect(Object.keys(SERVER_MOVE_ERROR_COPY).sort()).toEqual([...expectedCodes].sort())
    for (const code of expectedCodes) {
      const copy = serverMoveErrorCopy(code)
      expect(copy).toBe(SERVER_MOVE_ERROR_COPY[code])
      expect(copy).toMatch(/[.!?]$/)
    }
  })

  it('keeps unknown future errors readable without inventing a meaning', () => {
    expect(serverMoveErrorCopy('future-code', 'A newer server reported a problem.')).toBe(
      'A newer server reported a problem.',
    )
  })

  it('names the version remediation for skew and old-server fallback', () => {
    expect(SERVER_MOVE_ERROR_COPY['target-unsupported']).toBe(
      'Update this machine to the same Podium version as the server first.',
    )
  })
})
