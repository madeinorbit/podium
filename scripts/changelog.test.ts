import { describe, expect, it } from 'vitest'
import { extractRelease } from './changelog'

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Something not yet released.

## [0.4.2] - 2026-08-04

### Added

- Faster reconnects after a daemon restart.

### Fixed

- A stale bundle no longer reload-loops.

## [0.4.1] - 2026-07-30

### Fixed

- An older fix.
`

describe('extractRelease', () => {
  it('extracts the section for the requested version', () => {
    const r = extractRelease(CHANGELOG, '0.4.2')
    expect(r?.summary).toContain('Faster reconnects')
    expect(r?.summary).toContain('stale bundle')
  })

  it('stops at the next version heading', () => {
    expect(extractRelease(CHANGELOG, '0.4.2')?.summary).not.toContain('An older fix')
  })

  it('never returns the Unreleased section', () => {
    // Shipping "Unreleased" to users as their release notes would be a lie about
    // what they just installed.
    expect(extractRelease(CHANGELOG, '0.4.2')?.summary).not.toContain('not yet released')
  })

  it('returns null for a version with no section', () => {
    expect(extractRelease(CHANGELOG, '9.9.9')).toBeNull()
  })

  it('returns null rather than an empty summary for an empty section', () => {
    // The dialog omits the What's new affordance when notes are absent. An empty
    // string would render an empty section instead, which is worse than nothing.
    const empty =
      '# Changelog\n\n## [0.4.3] - 2026-08-05\n\n## [0.4.2] - 2026-08-04\n\n- A thing.\n'
    expect(extractRelease(empty, '0.4.3')).toBeNull()
  })

  it('tolerates a heading without a date', () => {
    expect(extractRelease('## [0.4.2]\n\n- A thing.\n', '0.4.2')?.summary).toContain('A thing')
  })

  it('tolerates a heading without brackets', () => {
    expect(
      extractRelease('## 0.4.2 - 2026-08-04\n\n- A thing.\n', '0.4.2')?.summary,
    ).toContain('A thing')
  })

  it('does not match a version that is a prefix of another', () => {
    const cl = '## [0.4.20]\n\n- Twenty.\n\n## [0.4.2]\n\n- Two.\n'
    expect(extractRelease(cl, '0.4.2')?.summary).toContain('Two')
    expect(extractRelease(cl, '0.4.2')?.summary).not.toContain('Twenty')
  })
})
