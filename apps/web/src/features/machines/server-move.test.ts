import { describe, expect, it } from 'vitest'
import { SERVER_MOVE_ERROR_COPY, serverMoveErrorCopy } from './server-move'

describe('server-move presenter', () => {
  it('gives every failure code exactly one user sentence', () => {
    expect(Object.keys(SERVER_MOVE_ERROR_COPY).length).toBeGreaterThan(0)
    for (const code of Object.keys(SERVER_MOVE_ERROR_COPY)) {
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

it('distinguishes target reachability from a fleet switch failure', () => {
  expect(serverMoveErrorCopy('target-unreachable')).toMatch(
    /address.*not reachable.*required machine/,
  )
  expect(serverMoveErrorCopy('fleet-handoff-failed')).toMatch(/connected machine.*could not switch/)
  expect(serverMoveErrorCopy('target-unreachable')).not.toBe(
    serverMoveErrorCopy('fleet-handoff-failed'),
  )
})
