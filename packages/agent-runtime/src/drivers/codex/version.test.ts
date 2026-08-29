/**
 * THE VERSION GATE (POD-1761 W6).
 *
 * The plan's first pitfall is that Codex has renamed app-server methods before,
 * and the failure mode of a wrong method name is not an error — it is an
 * approval request that never arrives and a session that hangs on its first tool
 * call. So the gate refusing is the cheap failure, and these are the cases where
 * it must refuse.
 */

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
    // triple gets nothing and — see below — that means a refusal.
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

describe('the supported window', () => {
  it('admits the version every fixture was recorded from', () => {
    const recorded = parseCodexVersion(SUPPORTED_CODEX.recordedAt)
    expect(recorded).not.toBeNull()
    if (!recorded) return
    // If this ever fails, the pin and the fixtures have drifted apart — which is
    // the one thing the range's justification rests on.
    expect(supportsCodexAppServerDriver(recorded)).toBe(true)
  })

  it('admits the current 0.150.1 binary that was re-proved live', () => {
    const verified = parseCodexVersion(SUPPORTED_CODEX.verifiedThrough)
    expect(verified).not.toBeNull()
    if (!verified) return
    expect(supportsCodexAppServerDriver(verified)).toBe(true)
  })

  it('refuses a MAJOR bump outright', () => {
    // Codex is pre-1.0 and its minor is the breaking-change axis, so a major
    // bump is the loudest possible signal that everything below was rewritten.
    expect(supportsCodexAppServerDriver({ raw: '1.0.0', major: 1, minor: 0, patch: 0 })).toBe(false)
  })

  it('refuses either side of the minor window', () => {
    const below = SUPPORTED_CODEX.minMinor - 1
    const above = SUPPORTED_CODEX.maxMinor + 1
    expect(supportsCodexAppServerDriver({ raw: '', major: 0, minor: below, patch: 0 })).toBe(false)
    expect(supportsCodexAppServerDriver({ raw: '', major: 0, minor: above, patch: 0 })).toBe(false)
  })

  it('admits any patch inside the window', () => {
    expect(
      supportsCodexAppServerDriver({ raw: '', major: 0, minor: SUPPORTED_CODEX.maxMinor, patch: 99 }),
    ).toBe(true)
  })
})

describe('the diagnostic', () => {
  it('is null — not a thrown string — for a codex we may drive', () => {
    expect(gateCodexVersion(`codex-cli ${SUPPORTED_CODEX.recordedAt}`)).toBeNull()
  })

  it('REFUSES a version it cannot read, rather than driving it and hoping', () => {
    /**
     * An unparseable version is the case where "assume it's fine" is most
     * tempting and most wrong: the alternative to refusing is a driver that
     * fails later, deeper, and less legibly.
     */
    const diagnostic = gateCodexVersion('codex: command not found')
    expect(diagnostic).not.toBeNull()
    expect(diagnostic?.code).toBe('codex-app-server-version-unsupported')
    expect(diagnostic?.observedVersion).toBe('codex: command not found')
  })

  it('carries a machine-readable code and the observed version, not just prose', () => {
    // The spawn path has to BRANCH on this — refuse the session, fall back to
    // terminal, surface it — and a caller cannot branch on a message.
    const diagnostic = gateCodexVersion('codex-cli 0.99.0')
    expect(diagnostic?.code).toBe('codex-app-server-version-unsupported')
    expect(diagnostic?.observedVersion).toBe('codex-cli 0.99.0')
    expect(diagnostic?.title).toBe('codex app-server driver needs review')
  })

  it('tells the reader how to widen it, including where the fixtures come from', () => {
    const body = gateCodexVersion('codex-cli 0.99.0')?.body ?? ''
    expect(body).toContain('__fixtures__')
    // The self-describing binary is the thing that makes re-recording cheap, so
    // the diagnostic names it rather than leaving the next person to find it.
    expect(body).toContain('generate-ts')
    expect(body).toContain('terminal driver')
  })
})
