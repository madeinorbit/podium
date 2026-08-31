import { describe, expect, it } from 'vitest'
import { humanizeSendFailure } from './send-failure'

describe('humanizeSendFailure', () => {
  it('translates the wedged-server parser noise into a usable sentence', () => {
    // The literal failure Till's phone showed against the wedged VPS
    // (2026-08-27 device feedback #2): the watchdog kill answers with an empty
    // body, and the tRPC client throws the raw JSON parser error.
    const message = humanizeSendFailure(new Error('JSON Parse error: Unexpected end of input'))
    expect(message).toMatch(/server did not answer/i)
    expect(message).not.toMatch(/JSON/)
  })

  it('covers dead-connection and gateway shapes', () => {
    for (const raw of [
      'Failed to fetch',
      'Network request failed',
      'Load failed',
      '502 Bad Gateway',
      'Unexpected token < in JSON at position 0',
    ]) {
      expect(humanizeSendFailure(new Error(raw))).toMatch(/server did not answer/i)
    }
  })

  it('passes real server-worded refusals through untouched', () => {
    expect(humanizeSendFailure(new Error('another turn is already running'))).toBe(
      'another turn is already running',
    )
    expect(humanizeSendFailure('quota exhausted for this account')).toBe(
      'quota exhausted for this account',
    )
  })
})
