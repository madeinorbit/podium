import { describe, expect, it } from 'vitest'
import { channelForVersion, compareVersions, promoteUnreleased } from './release-cut'

describe('channelForVersion', () => {
  it('routes the two shapes the release workflow understands', () => {
    expect(channelForVersion('0.2.0')).toBe('stable')
    expect(channelForVersion('1.10.3')).toBe('stable')
    expect(channelForVersion('0.2.0-edge.1')).toBe('edge')
    expect(channelForVersion('0.2.0-edge.12')).toBe('edge')
  })

  it('refuses a prerelease that names no channel, before anything is created', () => {
    // The tag workflow refuses these too — but only once the tag exists and has to be deleted.
    expect(() => channelForVersion('0.2.0-rc1')).toThrow(/neither/)
    expect(() => channelForVersion('0.2.0-beta.1')).toThrow(/neither/)
    expect(() => channelForVersion('v0.2.0')).toThrow(/neither/)
    expect(() => channelForVersion('0.2')).toThrow(/neither/)
  })
})

describe('compareVersions', () => {
  it('orders releases numerically, not lexically', () => {
    // The bug this guards: "0.1.10" < "0.1.9" as strings, which would reject a legitimate bump.
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1)
    expect(compareVersions('0.1.4', '0.1.4')).toBe(0)
  })

  it('orders an edge prerelease before its own stable release', () => {
    // Getting this backwards would let release:cut accept a version the updater then ignores.
    expect(compareVersions('0.2.0-edge.1', '0.2.0')).toBe(-1)
    expect(compareVersions('0.2.0', '0.2.0-edge.9')).toBe(1)
    expect(compareVersions('0.2.0-edge.2', '0.2.0-edge.10')).toBe(-1)
    expect(compareVersions('0.2.0-edge.1', '0.1.9')).toBe(1)
  })
})

describe('promoteUnreleased', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- A new thing.',
    '',
    '## [0.1.3] - 2026-07-01',
    '',
    '- An older thing.',
    '',
  ].join('\n')

  it('moves the Unreleased body under the new version heading', () => {
    const { markdown, notes } = promoteUnreleased(changelog, '0.1.4', '2026-08-13')
    expect(notes).toContain('- A new thing.')
    expect(markdown).toContain('## [0.1.4] - 2026-08-13')
    // The body must land between its own heading and the previous release, subheadings included.
    const start = markdown.indexOf('## [0.1.4]')
    const end = markdown.indexOf('## [0.1.3]')
    const section = markdown.slice(start, end)
    expect(section).toContain('### Added')
    expect(section).toContain('- A new thing.')
  })

  it('leaves a fresh empty Unreleased above the release', () => {
    const { markdown } = promoteUnreleased(changelog, '0.1.4', '2026-08-13')
    const unreleased = markdown.indexOf('## [Unreleased]')
    const released = markdown.indexOf('## [0.1.4]')
    expect(unreleased).toBeGreaterThanOrEqual(0)
    expect(released).toBeGreaterThan(unreleased)
    // Nothing may remain under Unreleased, or the next release would ship these notes again.
    expect(markdown.slice(unreleased + '## [Unreleased]'.length, released).trim()).toBe('')
  })

  it('keeps earlier releases intact', () => {
    const { markdown } = promoteUnreleased(changelog, '0.1.4', '2026-08-13')
    expect(markdown).toContain('## [0.1.3] - 2026-07-01')
    expect(markdown).toContain('- An older thing.')
  })

  it('allows an empty Unreleased and reports it as empty notes', () => {
    // An edge build cut purely to exercise the pipeline has nothing to say; that is not an error,
    // but the caller needs to know so it can warn.
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.1.3] - 2026-07-01\n\n- Old.\n'
    const { markdown, notes } = promoteUnreleased(empty, '0.1.4', '2026-08-13')
    expect(notes).toBe('')
    expect(markdown).toContain('## [0.1.4] - 2026-08-13')
  })

  it('refuses a changelog with no Unreleased heading rather than inventing one', () => {
    expect(() =>
      promoteUnreleased('# Changelog\n\n## [0.1.3]\n\n- Old.\n', '0.1.4', '2026-08-13'),
    ).toThrow(/no "## \[Unreleased\]" heading/)
  })
})
