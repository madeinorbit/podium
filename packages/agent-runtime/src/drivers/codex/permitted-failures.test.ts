/**
 * WHAT THIS DRIVER MAY FAIL, AND WHAT IT ACTUALLY FAILS (POD-1761 W6).
 *
 * These are not the same list, and this driver is the first in the epic where
 * they differ — which is the whole reason the file exists. The family row is a
 * CEILING; the capability declaration is the per-driver truth the corpus
 * enforces. A comment asserting that distinction would be a comment; these are
 * assertions.
 */

import { describe, expect, it } from 'vitest'
import { PERMITTED_FAILURES, permits } from '../../permitted-failures.js'
import { codexAppServerCapabilities } from './capabilities.js'
import {
  CODEX_SERVER_EXEMPTION_NAMES,
  CODEX_SERVER_EXHIBITED_FAILURES,
  CODEX_SERVER_PERMITTED_FAILURES,
} from './permitted-failures.js'

describe('the claim, derived rather than copied', () => {
  it('is exactly the server family row', () => {
    // The corpus requires `exemptions` to EQUAL the family's row; a hand-copied
    // list is a second source of truth that agrees until somebody edits the
    // first one.
    expect([...CODEX_SERVER_PERMITTED_FAILURES]).toEqual([...PERMITTED_FAILURES.server])
  })

  it('still yields exactly the one name, so a widening is a visible edit', () => {
    expect([...CODEX_SERVER_PERMITTED_FAILURES]).toEqual([...CODEX_SERVER_EXEMPTION_NAMES])
  })

  it('never carries the two that matter', () => {
    /**
     * `unverified-send` and `at-least-once-interactions` are the terminal
     * family's, permanently. A server driver has a protocol ack and a real
     * request id, so a send it cannot prove and an ask it cannot identify are
     * bugs rather than weaknesses.
     */
    expect(permits('server', 'unverified-send')).toBe(false)
    expect(permits('server', 'at-least-once-interactions')).toBe(false)
    expect(CODEX_SERVER_PERMITTED_FAILURES).not.toContain('unverified-send')
    expect(CODEX_SERVER_PERMITTED_FAILURES).not.toContain('at-least-once-interactions')
  })
})

describe('what this driver actually exhibits', () => {
  it('exhibits NOTHING its family permits — it steers natively', () => {
    /**
     * THE GAP, ASSERTED. The family permits `no-native-steer` because opencode
     * genuinely lacks a steer verb. Codex has `turn/steer`, exercised live, so
     * this driver's exhibited list is empty even though its claimed list is not.
     * Deriving the check from the CAPABILITY rather than restating the constant
     * is what keeps this honest: declare `steer` unsupported and this test goes
     * red until the exhibited list is updated to say so.
     */
    const capabilities = codexAppServerCapabilities()
    const steersNatively = capabilities.send.native.includes('steer')
    expect(steersNatively).toBe(true)
    expect([...CODEX_SERVER_EXHIBITED_FAILURES]).toEqual(
      steersNatively ? [] : ['no-native-steer'],
    )
  })

  it('claims neither of the two weaknesses in its capability declaration either', () => {
    // The corpus checks the converse — a driver that EXHIBITS a weakness it did
    // not claim also fails — so these two flags are the other half of the pair.
    const capabilities = codexAppServerCapabilities()
    expect(capabilities.send.mayReturnUnverified).toBe(false)
    expect(capabilities.interactions.supported).toBe(true)
    if (!capabilities.interactions.supported) return
    expect(capabilities.interactions.value.atLeastOnce).toBe(false)
    expect(capabilities.interactions.value.source).toBe('protocol')
    expect(capabilities.interactions.value.answerable).toBe('structured')
  })
})
