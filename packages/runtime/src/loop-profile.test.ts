import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOOP_PROFILE_ENV,
  LOOP_PROFILE_LEVELS,
  type PodiumConfig,
  resolveLoopProfileLevel,
} from './config'

/** A packaged build's version literal — anything that is not `dev`. */
const RELEASE = '0.9.3'

describe('resolveLoopProfileLevel', () => {
  it('takes a level name from the environment, over config and default', () => {
    expect(
      resolveLoopProfileLevel({ loopProfile: 'off' } as PodiumConfig, {
        [LOOP_PROFILE_ENV]: 'full',
        PODIUM_APP_VERSION: RELEASE,
      }),
    ).toEqual({ level: 'full', source: 'env' })
  })

  it('accepts every level name and nothing else', () => {
    for (const level of LOOP_PROFILE_LEVELS) {
      expect(resolveLoopProfileLevel({} as PodiumConfig, { [LOOP_PROFILE_ENV]: level })).toEqual({
        level,
        source: 'env',
      })
    }
  })

  it('refuses the legacy boolean flag, warns, and lets the next layer answer', () => {
    const resolved = resolveLoopProfileLevel({ loopProfile: 'accounting' } as PodiumConfig, {
      [LOOP_PROFILE_ENV]: '1',
      PODIUM_APP_VERSION: RELEASE,
    })
    expect(resolved.level).toBe('accounting')
    expect(resolved.source).toBe('config')
    expect(resolved.warning).toContain(LOOP_PROFILE_ENV)
    expect(resolved.warning).toContain('off, accounting, attribution, full')
  })

  it('carries the refusal warning all the way to the channel default', () => {
    const resolved = resolveLoopProfileLevel({} as PodiumConfig, {
      [LOOP_PROFILE_ENV]: 'true',
      PODIUM_APP_VERSION: RELEASE,
    })
    expect(resolved).toMatchObject({ level: 'off', source: 'default' })
    expect(resolved.warning).toContain('"true"')
  })

  it('ignores an empty or blank variable without warning', () => {
    for (const raw of ['', '   ']) {
      expect(
        resolveLoopProfileLevel({ loopProfile: 'full' } as PodiumConfig, {
          [LOOP_PROFILE_ENV]: raw,
          PODIUM_APP_VERSION: RELEASE,
        }),
      ).toEqual({ level: 'full', source: 'config' })
    }
  })

  it('defaults to attribution on the dev channel and off on stable and edge', () => {
    for (const channel of ['stable', 'edge'] as const) {
      expect(
        resolveLoopProfileLevel({ updateChannel: channel } as PodiumConfig, {
          PODIUM_APP_VERSION: RELEASE,
        }),
      ).toEqual({ level: 'off', source: 'default' })
    }
    expect(
      resolveLoopProfileLevel({ updateChannel: 'dev' } as PodiumConfig, {
        PODIUM_APP_VERSION: RELEASE,
      }),
    ).toEqual({ level: 'attribution', source: 'default' })
  })

  it('defaults to attribution for a source run, whatever the channel says', () => {
    expect(
      resolveLoopProfileLevel({ updateChannel: 'stable' } as PodiumConfig, {
        PODIUM_APP_VERSION: 'dev',
      }),
    ).toEqual({ level: 'attribution', source: 'default' })
  })

  it('lets a stable install pin accounting in config', () => {
    expect(
      resolveLoopProfileLevel(
        { updateChannel: 'stable', loopProfile: 'accounting' } as PodiumConfig,
        {
          PODIUM_APP_VERSION: RELEASE,
        },
      ),
    ).toEqual({ level: 'accounting', source: 'config' })
  })

  it('lets the environment turn a dev install off', () => {
    expect(
      resolveLoopProfileLevel({ updateChannel: 'dev' } as PodiumConfig, {
        [LOOP_PROFILE_ENV]: 'off',
      }),
    ).toEqual({ level: 'off', source: 'env' })
  })

  /**
   * POD-3827. A TEST RUN measures nothing unless it says so. The suite runs
   * from source, so without this rule every file in the repository would
   * inherit the source-run default and install the SQL and scheduler seams for
   * a diagnostic none of them reads. The rule sits BELOW env and config: a test
   * that exercises the instrument states the level it wants.
   *
   * The predicate is the one `inTestRunner()` already uses in
   * apps/server/src/store-database.ts — `VITEST` present at all, or `NODE_ENV`
   * exactly `test` — so the repository has one answer to "am I under a runner".
   */
  describe('under a test runner', () => {
    it('defaults to off where a source run on the dev channel would say attribution', () => {
      // `VITEST: ''` counts: presence is what a runner sets, and a variable
      // that is there at all did not get there by itself.
      for (const runner of [{ VITEST: 'true' }, { VITEST: '' }, { NODE_ENV: 'test' }]) {
        expect(
          resolveLoopProfileLevel({ updateChannel: 'dev' } as PodiumConfig, {
            PODIUM_APP_VERSION: 'dev',
            ...runner,
          }),
          JSON.stringify(runner),
        ).toEqual({ level: 'off', source: 'default' })
      }
    })

    it('reads NODE_ENV for the value test, not for being set at all', () => {
      expect(
        resolveLoopProfileLevel({} as PodiumConfig, {
          PODIUM_APP_VERSION: 'dev',
          NODE_ENV: 'production',
        }),
      ).toEqual({ level: 'attribution', source: 'default' })
    })

    it('still lets the environment, then config, name a level', () => {
      expect(
        resolveLoopProfileLevel({} as PodiumConfig, {
          VITEST: 'true',
          [LOOP_PROFILE_ENV]: 'full',
        }),
      ).toEqual({ level: 'full', source: 'env' })
      expect(
        resolveLoopProfileLevel({ loopProfile: 'attribution' } as PodiumConfig, {
          VITEST: 'true',
        }),
      ).toEqual({ level: 'attribution', source: 'config' })
    })

    it('carries a refused environment value into the test-run default', () => {
      const resolved = resolveLoopProfileLevel({ updateChannel: 'dev' } as PodiumConfig, {
        VITEST: 'true',
        [LOOP_PROFILE_ENV]: '1',
        PODIUM_APP_VERSION: 'dev',
      })
      expect(resolved).toMatchObject({ level: 'off', source: 'default' })
      expect(resolved.warning).toContain(LOOP_PROFILE_ENV)
    })
  })
})

/**
 * The module resolves at IMPORT, so each case re-imports it under a stated
 * environment. `PODIUM_LOOP_PROFILE` is set in some shells on this host (the
 * live install's unit exports it), so every case states the variable rather
 * than inheriting whatever the runner happens to carry.
 */
describe('@podium/runtime/loop-profile', () => {
  let dir: string
  const priorEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of [
      LOOP_PROFILE_ENV,
      'PODIUM_STATE_DIR',
      'PODIUM_APP_VERSION',
      'PODIUM_UPDATE_CHANNEL',
    ]) {
      priorEnv[key] = process.env[key]
    }
    dir = mkdtempSync(join(tmpdir(), 'podium-loop-profile-'))
    process.env.PODIUM_STATE_DIR = dir
    process.env.PODIUM_APP_VERSION = RELEASE
    delete process.env.PODIUM_UPDATE_CHANNEL
    vi.resetModules()
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('exports the resolved level and an ordered atLeast', async () => {
    process.env[LOOP_PROFILE_ENV] = 'attribution'
    const mod = await import('./loop-profile')
    expect(mod.loopProfileLevel).toBe('attribution')
    expect(mod.atLeast('off')).toBe(true)
    expect(mod.atLeast('accounting')).toBe(true)
    expect(mod.atLeast('attribution')).toBe(true)
    expect(mod.atLeast('full')).toBe(false)
  })

  it('is off in THIS process when nothing states a level (POD-3827)', async () => {
    // The same source run outside a runner resolves `attribution`; the runner's
    // own environment is what turns it off, so no suite pays for the seams.
    delete process.env[LOOP_PROFILE_ENV]
    process.env.PODIUM_APP_VERSION = 'dev'
    const mod = await import('./loop-profile')
    expect(mod.loopProfile).toEqual({ level: 'off', source: 'default' })
    expect(mod.atLeast('accounting')).toBe(false)
  })

  it('says off is off, including for the weakest gate above it', async () => {
    process.env[LOOP_PROFILE_ENV] = 'off'
    const mod = await import('./loop-profile')
    expect(mod.atLeast('off')).toBe(true)
    expect(mod.atLeast('accounting')).toBe(false)
  })

  it('reports a refused environment value once, through the logger', async () => {
    process.env[LOOP_PROFILE_ENV] = '1'
    const mod = await import('./loop-profile')
    // The refused value falls through to the packaged default.
    expect(mod.loopProfileLevel).toBe('off')

    const warn = vi.fn()
    expect(mod.reportLoopProfileWarning({ warn })).toContain(LOOP_PROFILE_ENV)
    expect(mod.reportLoopProfileWarning({ warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('expected one of')
    expect(warn.mock.calls[0]?.[1]).toEqual({ level: 'off', source: 'default' })
  })

  it('stays silent when the level was resolved cleanly', async () => {
    process.env[LOOP_PROFILE_ENV] = 'accounting'
    const mod = await import('./loop-profile')
    const warn = vi.fn()
    expect(mod.reportLoopProfileWarning({ warn })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
