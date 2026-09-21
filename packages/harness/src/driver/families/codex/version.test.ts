/** Codex admission depends only on the shared minimum version. */

import { describe, expect, it } from 'vitest'
import {
  gateCodexVersion,
  parseCodexVersion,
  SUPPORTED_CODEX,
  supportsCodexAppServerDriver,
} from './version.js'

describe('parsing `codex --version`', () => {
  it('reads the triple out of the real banner, which is not a bare version', () => {
    // `codex --version` prints `codex-cli 0.147.0`. A parser expecting a bare
    // triple gets nothing, which cannot establish a floor violation.
    expect(parseCodexVersion('codex-cli 0.147.0')).toMatchObject({
      major: 0,
      minor: 147,
      patch: 0,
    })
  })

  it('tolerates a `v` prefix and trailing build noise', () => {
    expect(parseCodexVersion('v0.147.3-nightly+abc')).toMatchObject({ minor: 147, patch: 3 })
  })

  it('returns null rather than a guess when there is no triple', () => {
    expect(parseCodexVersion('command not found: codex')).toBeNull()
    expect(parseCodexVersion('')).toBeNull()
  })
})

describe('the shared floor', () => {
  it('admits the version every fixture was recorded from', () => {
    const recorded = parseCodexVersion(SUPPORTED_CODEX.recordedAt)
    expect(recorded).not.toBeNull()
    if (!recorded) return
    // If this ever fails, the pin and the fixtures have drifted apart — which is
    // the one thing the range's justification rests on.
    expect(supportsCodexAppServerDriver(recorded)).toBe(true)
  })

  it('admits the current 0.151.0 binary that was re-proved live', () => {
    const verified = parseCodexVersion(SUPPORTED_CODEX.verifiedThrough)
    expect(verified).not.toBeNull()
    if (!verified) return
    expect(supportsCodexAppServerDriver(verified)).toBe(true)
  })

  it('admits a major bump', () => {
    expect(supportsCodexAppServerDriver({ raw: '1.0.0', major: 1, minor: 0, patch: 0 })).toBe(true)
  })

  it('refuses below the floor and admits newer minors', () => {
    const below = SUPPORTED_CODEX.minimum.minor - 1
    expect(supportsCodexAppServerDriver({ raw: '', major: 0, minor: below, patch: 99 })).toBe(false)
    expect(supportsCodexAppServerDriver({ raw: '', major: 0, minor: 154, patch: 0 })).toBe(true)
  })
})

describe('the diagnostic', () => {
  it('is null — not a thrown string — for a codex we may drive', () => {
    expect(gateCodexVersion(`codex-cli ${SUPPORTED_CODEX.recordedAt}`)).toBeNull()
  })

  it.each([
    'codex: command not found',
    '',
    'codex-cli 0.154.0',
    '1.0.0',
  ])('does not refuse %s', (output) => {
    expect(gateCodexVersion(output)).toBeNull()
  })

  it('carries an actionable floor refusal and the observed version', () => {
    const diagnostic = gateCodexVersion('codex-cli 0.99.0')
    expect(diagnostic?.code).toBe('codex-version-too-old')
    expect(diagnostic?.observedVersion).toBe('codex-cli 0.99.0')
    expect(diagnostic?.body).toContain('Install codex 0.147 or newer')
  })
})
