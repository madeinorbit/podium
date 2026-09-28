import { describe, expect, it } from 'vitest'
import {
  browserForProject,
  decideBrowserSupport,
  filterFor,
  laneMaySucceed,
  normalizeSuiteSelector,
  parseLaneArgs,
  parseListTotal,
  preflightProjects,
  projectFilterFromForward,
  resolveSelectedSuites,
  stripProjectFlags,
} from './browser-lane'
import type { BrowserSupport, ConfiguredProject } from './browser-lane'

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

const PROJECTS: ConfiguredProject[] = [
  { name: 'chromium-desktop', browser: 'chromium' },
  { name: 'chromium-pixel', browser: 'chromium' },
  { name: 'webkit-desktop', browser: 'webkit' },
  { name: 'webkit-iphone', browser: 'webkit' },
]

/** Fake Playwright answer: webkit can never run on this host, chromium can. */
const flatblockProbe = (browser: string): BrowserSupport =>
  browser === 'webkit'
    ? { kind: 'unsupported', reason: 'Playwright does not support webkit on this host' }
    : { kind: 'ready' }

const allReadyProbe = (): BrowserSupport => ({ kind: 'ready' })

describe('decideBrowserSupport', () => {
  it('reports unsupported when Playwright has no executable path for the browser on this host', () => {
    const r = decideBrowserSupport('webkit', '', false)
    expect(r.kind).toBe('unsupported')
    if (r.kind === 'unsupported') {
      expect(r.reason).toContain('webkit')
      expect(r.reason).toMatch(/does not support/i)
    }
  })

  it('reports ready when the executable path exists on disk', () => {
    expect(decideBrowserSupport('chromium', '/ browsers/chromium-1223/chrome', true)).toEqual({
      kind: 'ready',
    })
  })

  it('reports a missing install — never unsupported — when supported but not on disk', () => {
    const r = decideBrowserSupport('chromium', '/browsers/chromium-1223/chrome', false)
    expect(r.kind).toBe('missing')
    if (r.kind === 'missing') {
      expect(r.detail).toContain('chromium')
      expect(r.detail).toMatch(/install/i)
    }
  })
})

describe('browserForProject', () => {
  it('prefers the config device browser type, falls back to the name prefix', () => {
    expect(browserForProject('webkit-iphone', 'webkit')).toBe('webkit')
    expect(browserForProject('chromium-pixel', undefined)).toBe('chromium')
    expect(browserForProject('firefox-tablet', undefined)).toBe('firefox')
  })

  it('returns null when neither the device type nor the prefix names a known browser', () => {
    expect(browserForProject('mobile-safari', undefined)).toBeNull()
    expect(browserForProject('mobile-safari', 'safari')).toBeNull()
  })
})

describe('preflightProjects', () => {
  it('skips every project on an unsupported browser with a per-project reason', () => {
    const r = preflightProjects(PROJECTS, null, flatblockProbe)
    expect(r.runnable).toEqual(['chromium-desktop', 'chromium-pixel'])
    expect(r.missing).toEqual([])
    expect(r.skipped.map((s) => s.project)).toEqual(['webkit-desktop', 'webkit-iphone'])
    for (const s of r.skipped) {
      expect(s.browser).toBe('webkit')
      expect(s.reason).toContain('webkit')
    }
  })

  it('keeps a supported project in the runnable set so it still runs', () => {
    const r = preflightProjects(PROJECTS, null, allReadyProbe)
    expect(r.runnable).toEqual([
      'chromium-desktop',
      'chromium-pixel',
      'webkit-desktop',
      'webkit-iphone',
    ])
    expect(r.skipped).toEqual([])
    expect(r.missing).toEqual([])
  })

  it('collects supported-but-not-installed browsers as missing, never as skipped', () => {
    const r = preflightProjects(PROJECTS, null, (browser) =>
      browser === 'chromium'
        ? { kind: 'missing', detail: 'chromium is supported here but not installed' }
        : { kind: 'ready' },
    )
    expect(r.skipped).toEqual([])
    expect(r.missing.map((m) => m.project)).toEqual(['chromium-desktop', 'chromium-pixel'])
    expect(r.runnable).toEqual(['webkit-desktop', 'webkit-iphone'])
  })

  it('never skips what it cannot classify: unknown browsers and unknown names still run', () => {
    const seen: string[] = []
    const r = preflightProjects(
      [...PROJECTS, { name: 'mystery-project', browser: null }],
      null,
      (browser) => {
        seen.push(browser)
        return { kind: 'unknown', detail: `no Playwright executable named "${browser}"` }
      },
    )
    expect(r.skipped).toEqual([])
    expect(r.missing).toEqual([])
    expect(r.runnable).toContain('mystery-project')
    // The undeterminable project is not even asked about.
    expect(seen).not.toContain('null')
    // Unknown selected names pass through for Playwright itself to reject.
    const typo = preflightProjects(PROJECTS, ['typo-project'], allReadyProbe)
    expect(typo.runnable).toEqual(['typo-project'])
  })

  it('probes each distinct browser once and honors an explicit project selection', () => {
    const seen: string[] = []
    const probe = (browser: string): BrowserSupport => {
      seen.push(browser)
      return flatblockProbe(browser)
    }
    const r = preflightProjects(PROJECTS, ['chromium-pixel', 'webkit-iphone'], probe)
    expect([...seen].sort()).toEqual(['chromium', 'webkit'])
    expect(r.runnable).toEqual(['chromium-pixel'])
    expect(r.skipped.map((s) => s.project)).toEqual(['webkit-iphone'])
  })
})

describe('projectFilterFromForward / stripProjectFlags', () => {
  it('finds no filter when no --project flag is forwarded', () => {
    expect(projectFilterFromForward(['--grep', 'drag'])).toEqual({ explicit: [], hasFilter: false })
    expect(stripProjectFlags(['--grep', 'drag'])).toEqual(['--grep', 'drag'])
  })

  it('reads the equals form and strips it, keeping every other flag', () => {
    expect(
      projectFilterFromForward(['--project=chromium-pixel', '--grep', 'drag']),
    ).toEqual({ explicit: ['chromium-pixel'], hasFilter: true })
    expect(stripProjectFlags(['--project=chromium-pixel', '--grep', 'drag'])).toEqual([
      '--grep',
      'drag',
    ])
  })

  it('reads the variadic space form (every non-flag token is a project name)', () => {
    const forward = ['--project', 'chromium-pixel', 'webkit-iphone', '--grep', 'drag']
    expect(projectFilterFromForward(forward)).toEqual({
      explicit: ['chromium-pixel', 'webkit-iphone'],
      hasFilter: true,
    })
    expect(stripProjectFlags(forward)).toEqual(['--grep', 'drag'])
  })

  it('handles a trailing bare --project and repeated flags', () => {
    expect(projectFilterFromForward(['--project'])).toEqual({ explicit: [], hasFilter: true })
    expect(stripProjectFlags(['--project'])).toEqual([])
    const repeated = ['--project=chromium-pixel', '--project=webkit-iphone']
    expect(projectFilterFromForward(repeated).explicit).toEqual([
      'chromium-pixel',
      'webkit-iphone',
    ])
    expect(stripProjectFlags(repeated)).toEqual([])
  })
})
