import { describe, expect, it } from 'vitest'
import {
  filterFor,
  laneMaySucceed,
  normalizeSuiteSelector,
  parseLaneArgs,
  parseListTotal,
  resolveSelectedSuites,
} from './browser-lane'

const SUITES = [
  'clipboard.browser.e2e.ts',
  'tabs.browser.e2e.ts',
  'issues.browser.e2e.ts',
  'expo-mobile-keyboard.browser.e2e.ts',
] as const

describe('normalizeSuiteSelector', () => {
  it('accepts the short stem, stem+suffix, full filename, and path prefixes', () => {
    expect(normalizeSuiteSelector('clipboard')).toBe('clipboard.browser.e2e.ts')
    expect(normalizeSuiteSelector('clipboard.browser.e2e')).toBe('clipboard.browser.e2e.ts')
    expect(normalizeSuiteSelector('clipboard.browser.e2e.ts')).toBe('clipboard.browser.e2e.ts')
    expect(normalizeSuiteSelector('tests/e2e/browser/clipboard.browser.e2e.ts')).toBe(
      'clipboard.browser.e2e.ts',
    )
  })
})

describe('filterFor', () => {
  it('escapes dots so the positional is an anchored path regex', () => {
    expect(filterFor('clipboard.browser.e2e.ts')).toBe(
      'browser/clipboard\\.browser\\.e2e\\.ts$',
    )
  })
})

describe('parseLaneArgs', () => {
  it('pulls repeated --suite / --suite= out and forwards the rest', () => {
    expect(
      parseLaneArgs([
        '--suite',
        'clipboard',
        '--project=chromium-pixel',
        '--suite=tabs',
        '--grep',
        'drag',
      ]),
    ).toEqual({
      suiteSelectors: ['clipboard', 'tabs'],
      forward: ['--project=chromium-pixel', '--grep', 'drag'],
      help: false,
      buildOnly: false,
    })
  })

  it('records a blank selector when --suite is missing its value', () => {
    expect(parseLaneArgs(['--suite', '--project=chromium-pixel'])).toEqual({
      suiteSelectors: [''],
      forward: ['--project=chromium-pixel'],
      help: false,
      buildOnly: false,
    })
  })

  it('recognizes help and --build-only without forwarding them', () => {
    expect(parseLaneArgs(['--help']).help).toBe(true)
    expect(parseLaneArgs(['-h']).help).toBe(true)
    expect(parseLaneArgs(['--build-only'])).toEqual({
      suiteSelectors: [],
      forward: [],
      help: false,
      buildOnly: true,
    })
  })
})

describe('resolveSelectedSuites', () => {
  it('with no selectors returns the full available list', () => {
    const r = resolveSelectedSuites([], SUITES)
    expect(r).toEqual({ ok: true, suites: [...SUITES] })
  })

  it('resolves short stems and dedupes', () => {
    const r = resolveSelectedSuites(['clipboard', 'clipboard.browser.e2e.ts', 'tabs'], SUITES)
    expect(r).toEqual({
      ok: true,
      suites: ['clipboard.browser.e2e.ts', 'tabs.browser.e2e.ts'],
    })
  })

  it('errors on unknown names instead of falling back to everything', () => {
    const r = resolveSelectedSuites(['does-not-exist'], SUITES)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('matched no discovered suite')
      expect(r.error).toContain('does-not-exist')
    }
  })

  it('errors when the selector names a quarantined suite', () => {
    const r = resolveSelectedSuites(
      ['clipboard'],
      SUITES.filter((s) => s !== 'clipboard.browser.e2e.ts'),
      new Set(['clipboard.browser.e2e.ts']),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/quarantined/i)
  })

  it('errors on a blank --suite value', () => {
    const r = resolveSelectedSuites([''], SUITES)
    expect(r.ok).toBe(false)
  })

  it('does not treat a stem as a prefix match across multiple suites', () => {
    // "expo-mobile" is not a unique suite stem here; require exact stem.
    const r = resolveSelectedSuites(['expo-mobile'], SUITES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('expo-mobile')
  })
})

describe('parseListTotal', () => {
  it('reads the Playwright list summary line', () => {
    expect(parseListTotal('Listing tests:\nTotal: 3 tests in 1 file\n')).toBe(3)
    expect(parseListTotal('Total: 0 tests in 0 files')).toBe(0)
    expect(parseListTotal('Total: 1 test in 1 file')).toBe(1)
    expect(parseListTotal('no summary here')).toBeNull()
  })
})

describe('laneMaySucceed', () => {
  const green = {
    playwrightStatus: 0,
    unloadableCount: 0,
    runningSuiteCount: 2,
    listedTests: 5,
  }

  it('is green only when status, imports, selection, and listed total all clear', () => {
    expect(laneMaySucceed(green)).toEqual({ ok: true })
  })

  it('refuses a zero listed-test total even when Playwright exited 0', () => {
    const r = laneMaySucceed({ ...green, listedTests: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/zero tests/i)
  })

  it('refuses unloadable suites and empty selections', () => {
    expect(laneMaySucceed({ ...green, unloadableCount: 1 }).ok).toBe(false)
    expect(laneMaySucceed({ ...green, runningSuiteCount: 0 }).ok).toBe(false)
    expect(laneMaySucceed({ ...green, playwrightStatus: 1 }).ok).toBe(false)
  })

  it('does not hard-fail when the list total could not be parsed (playwright status still rules)', () => {
    // Parse failure is a warning path in the runner; only an explicit 0 is the
    // silent-success signature we must refuse.
    expect(laneMaySucceed({ ...green, listedTests: null })).toEqual({ ok: true })
  })
})
