import { beforeEach, describe, expect, it } from 'vitest'
import {
  configureLevelsFromEnv,
  DEFAULT_LEVEL,
  levelConfigVersion,
  matchesNamespace,
  namespaceFloor,
  parseNamespaceSpec,
  resetLevels,
  resolveLevel,
  selectLevel,
  setLogLevel,
  setNamespaceFloor,
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

/**
 * The floor exists so a namespace nobody has configured is still loud enough to
 * answer questions asked of a log file after the fact, WITHOUT becoming a cap on
 * the operator who turns everything up. Both halves are asserted: raising the
 * floored namespace is the case a plain override would have broken.
 */
describe('namespace floors', () => {
  it('lifts a namespace above the process default', () => {
    setLogLevel('warn')
    setNamespaceFloor('web:updates*', 'info')
    expect(resolveLevel('web:updates')).toBe('info')
    expect(resolveLevel('web:updates:poll')).toBe('info')
    expect(resolveLevel('web:store')).toBe('warn')
  })

  it('never caps a louder setting — the defect a plain override would have', () => {
    setNamespaceFloor('web:updates', 'info')
    setLogLevel('debug')
    expect(resolveLevel('web:updates')).toBe('debug')
    setNamespaceLevel('web:updates', 'trace')
    expect(resolveLevel('web:updates')).toBe('trace')
  })

  it('never quietens a namespace below what it would otherwise be', () => {
    setLogLevel('debug')
    setNamespaceFloor('web:updates', 'warn')
    expect(resolveLevel('web:updates')).toBe('debug')
  })

  it('composes two floors by verbosity rather than by specificity', () => {
    setLogLevel('error')
    setNamespaceFloor('web:*', 'warn')
    setNamespaceFloor('web:updates', 'debug')
    expect(resolveLevel('web:updates')).toBe('debug')
    expect(resolveLevel('web:store')).toBe('warn')
  })

  it('withdraws a floor when it is set to null', () => {
    setLogLevel('warn')
    setNamespaceFloor('web:updates', 'info')
    setNamespaceFloor('web:updates', null)
    expect(resolveLevel('web:updates')).toBe('warn')
    expect(namespaceFloor('web:updates')).toBeNull()
  })

  it('reads floors from PODIUM_LOG_FLOOR', () => {
    configureLevelsFromEnv({ PODIUM_LOG_LEVEL: 'warn', PODIUM_LOG_FLOOR: 'daemon:update=info' })
    expect(resolveLevel('daemon:update')).toBe('info')
    expect(resolveLevel('daemon:pty')).toBe('warn')
  })

  it('reports the floor itself, for the daemon forwarding sink that needs it', () => {
    setNamespaceFloor('daemon:update', 'info')
    expect(namespaceFloor('daemon:update')).toBe('info')
    expect(namespaceFloor('daemon:pty')).toBeNull()
  })

  it('bumps the config version so cached gates re-derive', () => {
    const before = levelConfigVersion()
    setNamespaceFloor('web:updates', 'info')
    expect(levelConfigVersion()).toBeGreaterThan(before)
  })
})
