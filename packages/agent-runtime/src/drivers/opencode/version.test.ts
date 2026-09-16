/**
 * THE VERSION GATE, UNIT-TESTED (POD-1761 W5; plan acceptance checklist item 4).
 *
 * Only a floor violation refuses; verification markers are informational.
 */

import { describe, expect, it } from 'vitest'
import {
  gateOpencodeVersion,
  OPENCODE_VERSION_PROBE_TIMEOUT_MS,
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
    expect(parseOpencodeVersion('  1.20.0-beta.3  ')).toMatchObject({
      major: 1,
      minor: 20,
      patch: 0,
    })
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

  it.each([
    '2.0.0',
    '1.25.0',
    'command not found: opencode',
    '   ',
  ])('admits newer or unknown %s', (output) => {
    expect(gateOpencodeVersion(output)).toBeNull()
  })

  it('refuses only below the floor with an actionable message', () => {
    expect(gateOpencodeVersion('1.17.99')?.body).toContain('Install opencode 1.18 or newer')
  })
})

describe('the probe budget every gating site shares', () => {
  it('is longer than the slowest measurement, with headroom', () => {
    /**
     * THE NUMBER IS A MEASUREMENT AND THIS IS WHAT KEEPS IT ONE.
     *
     * POD-2056 timed `opencode --version` at 11–15s on the build host (bun's
     * startup for a ~180MB bundle, CPU-bound, unaffected by a warm cache).
     * POD-2024 measured codex's ~250MB binary at 26s. A budget in the low tens
     * of seconds is a race with the thing it measures.
     *
     * The failure that budget causes is NOT a slow test. In the daemon a lost
     * race silently downgraded an explicit server-driver override to a PTY
     * session; in a test gate it makes the lane decide it cannot run and skip
     * ITSELF, so the suite reports green while testing nothing. That is why one
     * constant serves all three probe sites instead of each picking a number.
     */
    expect(OPENCODE_VERSION_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 26_000)
  })
})
