import { beforeEach, describe, expect, it } from 'vitest'
import {
  configureLevelsFromEnv,
  DEFAULT_LEVEL,
  levelConfigVersion,
  matchesNamespace,
  parseNamespaceSpec,
  resetLevels,
  resolveLevel,
  selectLevel,
  setLogLevel,
  setNamespaceLevel,
} from './level-control'

beforeEach(() => {
  resetLevels()
  // Explicitly empty, not merely reset: `resetLevels` clears the cached env and
  // the NEXT resolve re-reads the ambient one. Verified to matter — with
  // PODIUM_LOG="*=error" exported, 'sets and clears a single namespace
  // override' fails without this line. The env-reading behaviour has its own
  // block below, which passes env in explicitly.
  configureLevelsFromEnv({})
})

describe('parseNamespaceSpec', () => {
  it('parses comma-separated pattern=level pairs', () => {
    expect(parseNamespaceSpec('daemon:*=debug,server:events=trace')).toEqual([
      { pattern: 'daemon:*', level: 'debug' },
      { pattern: 'server:events', level: 'trace' },
    ])
  })

  it('treats a bare level as the global default', () => {
    expect(parseNamespaceSpec('debug')).toEqual([{ pattern: '*', level: 'debug' }])
  })

  it('accepts whitespace and semicolons as separators', () => {
    expect(parseNamespaceSpec('daemon:*=debug; web:*=warn')).toHaveLength(2)
  })

  it('drops an entry whose level is not a level rather than failing the boot', () => {
    expect(parseNamespaceSpec('daemon:*=chatty,web:*=warn')).toEqual([
      { pattern: 'web:*', level: 'warn' },
    ])
  })

  it('returns nothing for an empty spec', () => {
    expect(parseNamespaceSpec('   ')).toEqual([])
  })
})

describe('matchesNamespace', () => {
  it('matches a prefix wildcard', () => {
    expect(matchesNamespace('daemon:*', 'daemon:pty')).toBe(true)
    expect(matchesNamespace('daemon:*', 'server:pty')).toBe(false)
  })

  it('matches everything with a lone star', () => {
    expect(matchesNamespace('*', 'anything:at:all')).toBe(true)
  })

  it('matches an exact namespace', () => {
    expect(matchesNamespace('daemon:pty', 'daemon:pty')).toBe(true)
    expect(matchesNamespace('daemon:pty', 'daemon:pty:resize')).toBe(false)
  })

  it('does not let a wildcard metacharacter in a namespace act as a regex', () => {
    expect(matchesNamespace('daemon.pty', 'daemonXpty')).toBe(false)
  })
})

describe('selectLevel', () => {
  it('prefers the most specific matching rule over a broader one', () => {
    const rules = parseNamespaceSpec('*=error,daemon:*=warn,daemon:pty=trace')
    expect(selectLevel('daemon:pty', rules, 'info')).toBe('trace')
    expect(selectLevel('daemon:sync', rules, 'info')).toBe('warn')
    expect(selectLevel('web:app', rules, 'info')).toBe('error')
  })

  it('falls back when nothing matches', () => {
    expect(selectLevel('web:app', parseNamespaceSpec('daemon:*=debug'), 'info')).toBe('info')
  })
})

describe('env control', () => {
  it('defaults to info with no env at all', () => {
    configureLevelsFromEnv({})
    expect(resolveLevel('server:events')).toBe(DEFAULT_LEVEL)
    expect(DEFAULT_LEVEL).toBe('info')
  })

  it('takes the global default from PODIUM_LOG_LEVEL', () => {
    configureLevelsFromEnv({ PODIUM_LOG_LEVEL: 'debug' })
    expect(resolveLevel('server:events')).toBe('debug')
  })

  it('takes per-namespace overrides from PODIUM_LOG', () => {
    configureLevelsFromEnv({ PODIUM_LOG_LEVEL: 'warn', PODIUM_LOG: 'daemon:*=debug' })
    expect(resolveLevel('daemon:pty')).toBe('debug')
    expect(resolveLevel('server:events')).toBe('warn')
  })

  it('ignores an unparseable PODIUM_LOG_LEVEL instead of refusing to log', () => {
    configureLevelsFromEnv({ PODIUM_LOG_LEVEL: 'loud' })
    expect(resolveLevel('server:events')).toBe('info')
  })
})

describe('programmatic control', () => {
  it('overrides the env global — clients have no env', () => {
    configureLevelsFromEnv({ PODIUM_LOG_LEVEL: 'warn' })
    setLogLevel('trace')
    expect(resolveLevel('web:app')).toBe('trace')
  })

  it('sets and clears a single namespace override', () => {
    setLogLevel('warn')
    setNamespaceLevel('web:sync', 'trace')
    expect(resolveLevel('web:sync')).toBe('trace')
    setNamespaceLevel('web:sync', null)
    expect(resolveLevel('web:sync')).toBe('warn')
  })

  it('wins over an env rule for the same pattern', () => {
    configureLevelsFromEnv({ PODIUM_LOG: 'daemon:*=trace' })
    setNamespaceLevel('daemon:*', 'error')
    expect(resolveLevel('daemon:pty')).toBe('error')
  })

  it('bumps the config version on every change so cached gates can notice', () => {
    const before = levelConfigVersion()
    setLogLevel('debug')
    expect(levelConfigVersion()).toBeGreaterThan(before)
  })
})
