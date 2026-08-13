import { describe, expect, it } from 'vitest'
import {
  DEV_BUILD_CPU_QUOTA,
  DEV_BUILD_CPU_WEIGHT,
  DEV_BUILD_IO_WEIGHT,
  devBuildCommand,
  devBuildScopeArgv,
  devBuildScopeReclaimArgvs,
  devBuildScopeUnit,
  lowTierSpawnPlan,
} from './build-scope'

describe('development build scopes', () => {
  it('names the transient unit per instance', () => {
    expect(devBuildScopeUnit('dev-bundle-build', 'default')).toBe('podium-dev-bundle-build.scope')
    expect(devBuildScopeUnit('dev-bundle-build', 'blue')).toBe('podium-blue-dev-bundle-build.scope')
  })

  it('puts the build in the batch tier under a quota', () => {
    const argv = devBuildScopeArgv('podium-dev-bundle-build.scope', ['bun', 'scripts/build-bun.ts'])
    expect(argv).toContain(`--property=CPUWeight=${DEV_BUILD_CPU_WEIGHT}`)
    expect(argv).toContain(`--property=IOWeight=${DEV_BUILD_IO_WEIGHT}`)
    expect(argv).toContain(`--property=CPUQuota=${DEV_BUILD_CPU_QUOTA}`)
    // The interactive tier the server itself runs at, which the build used to
    // inherit by being a plain child of it (POD-1985).
    expect(DEV_BUILD_CPU_WEIGHT).toBeLessThan(900)
  })

  it('passes every property BEFORE the command separator', () => {
    // systemd-run reads anything after `--` as the command's own arguments, so a
    // property that lands there is silently handed to the build instead.
    const argv = devBuildScopeArgv('u.scope', ['bun', 'scripts/build-bun.ts'])
    const separator = argv.indexOf('--')
    expect(separator).toBeGreaterThan(0)
    expect(argv.slice(separator + 1)).toEqual(['bun', 'scripts/build-bun.ts'])
    expect(argv.slice(0, separator).every((arg) => arg.startsWith('-'))).toBe(true)
  })

  it('runs the scope under a deterministic name it can reclaim', () => {
    const argv = devBuildScopeArgv('podium-dev-web-build.scope', ['bun', 'x'])
    expect(argv).toContain('--unit=podium-dev-web-build.scope')
    expect(devBuildScopeReclaimArgvs('podium-dev-web-build.scope')).toEqual([
      ['--user', 'stop', 'podium-dev-web-build.scope'],
      ['--user', 'reset-failed', 'podium-dev-web-build.scope'],
    ])
  })

  it('falls back to the bare command where systemd-run cannot scope', () => {
    // macOS, Windows, a container without a user manager: the build must still
    // run, just without the tier.
    const build = {
      unit: 'podium-dev-bundle-build.scope',
      command: 'bun',
      args: ['scripts/build-bun.ts'],
      cwd: '/repo',
      env: {},
    }
    expect(lowTierSpawnPlan(build, false)).toEqual({
      file: 'bun',
      args: ['scripts/build-bun.ts'],
    })
    expect(lowTierSpawnPlan(build, true).file).toBe('systemd-run')
  })

  it('uses the server bun so a scoped build does not search PATH', () => {
    expect(devBuildCommand({}, '/home/podium/.bun/bin/bun')).toBe('/home/podium/.bun/bin/bun')
    expect(devBuildCommand({}, '/opt/bun.exe')).toBe('/opt/bun.exe')
    expect(devBuildCommand({ BUN_BIN: '/opt/bun' }, '/home/podium/.bun/bin/bun')).toBe('/opt/bun')
    expect(devBuildCommand({}, '/usr/bin/node')).toBe('bun')
  })
})
