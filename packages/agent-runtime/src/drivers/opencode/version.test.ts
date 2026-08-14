/**
 * THE VERSION GATE, UNIT-TESTED (POD-1761 W5; plan acceptance checklist item 4).
 *
 * The gate's whole value is that it REFUSES, so the tests that matter are the
 * ones where it says no. A gate nobody has watched refuse is a constant.
 */

import { describe, expect, it } from 'vitest'
import {
  gateOpencodeVersion,
  parseOpencodeVersion,
  SUPPORTED_OPENCODE,
  supportsOpencodeServerDriver,
} from './version.js'

describe('opencode version gate', () => {
  it('parses what the binary actually prints', () => {
    // `opencode --version` on 1.18.16 prints exactly this — a bare triple.
    expect(parseOpencodeVersion('1.18.16')).toMatchObject({ major: 1, minor: 18, patch: 16 })
  })

  it('tolerates the decorations every version probe eventually meets', () => {
    expect(parseOpencodeVersion('opencode v1.19.2\n')).toMatchObject({ major: 1, minor: 19 })
    expect(parseOpencodeVersion('  1.20.0-beta.3  ')).toMatchObject({ major: 1, minor: 20, patch: 0 })
  })

  it('ADMITS the version the fixtures were recorded from', () => {
    // If this ever fails, the fixtures and the range have drifted apart and the
    // gate is asserting something the recordings cannot support.
    expect(gateOpencodeVersion(SUPPORTED_OPENCODE.recordedAt)).toBeNull()
  })

  it('admits the whole minor range, because opencode ships minors weekly', () => {
    expect(supportsOpencodeServerDriver({ raw: '', major: 1, minor: 18, patch: 0 })).toBe(true)
    expect(supportsOpencodeServerDriver({ raw: '', major: 1, minor: 24, patch: 99 })).toBe(true)
  })

  it('REFUSES a major bump — the one signal upstream gives that shapes changed', () => {
    const diagnostic = gateOpencodeVersion('2.0.0')
    expect(diagnostic?.code).toBe('opencode-version-unsupported')
    expect(diagnostic?.observedVersion).toBe('2.0.0')
    // The body has to tell a person what to DO, not merely that something is
    // wrong: re-record the fixtures and widen the range, or use the terminal
    // driver.
    expect(diagnostic?.body).toContain('__fixtures__')
    expect(diagnostic?.body).toContain('terminal driver')
  })

  it('REFUSES a minor below the range and one above it', () => {
    expect(gateOpencodeVersion('1.9.0')).not.toBeNull()
    expect(gateOpencodeVersion('1.25.0')).not.toBeNull()
  })

  it('REFUSES a version it cannot read, rather than driving and hoping', () => {
    // The alternative — treat "unknown" as "fine" — fails later and much less
    // legibly, which is the whole reason the gate exists.
    const diagnostic = gateOpencodeVersion('command not found: opencode')
    expect(diagnostic).not.toBeNull()
    expect(diagnostic?.observedVersion).toBe('command not found: opencode')
  })

  it('refuses empty output with an observed version a human can act on', () => {
    expect(gateOpencodeVersion('   ')?.observedVersion).toBe('(no output)')
  })
})
