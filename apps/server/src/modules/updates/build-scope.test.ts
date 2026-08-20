import { describe, expect, it } from 'vitest'
import {
  DEV_BUILD_CPU_QUOTA,
  DEV_BUILD_CPU_WEIGHT,
  DEV_BUILD_IO_WEIGHT,
  describeBuildExit,
  devBuildCommand,
  devBuildScopeArgv,
  devBuildScopeReclaimArgvs,
  devBuildScopeUnit,
  lowTierSpawnPlan,
} from './build-scope'

const GIB = 1024 ** 3

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

  it('bounds the build, not just its CPU tier', () => {
    // POD-2472: the scope used to carry CPU properties and NOTHING else — no
    // memory cap, no swap bound, no OOM policy — which is the same unbounded
    // shape agent sessions had before POD-2413, on the same live host.
    const argv = devBuildScopeArgv('podium-dev-bundle-build.scope', ['bun', 'x'], {
      budget: { memoryMaxBytes: 4 * GIB, memorySwapMaxBytes: 0, tasksMax: 2048 },
    })
    expect(argv).toContain(`--property=MemoryMax=${4 * GIB}`)
    expect(argv).toContain('--property=MemorySwapMax=0')
    expect(argv).toContain('--property=TasksMax=2048')
    expect(argv).toContain('--property=OOMPolicy=continue')
    // No warning band: a throttled build wedges holding the update lock, and a
    // wedged build is worse than a failed one.
    expect(argv.some((arg) => arg.startsWith('--property=MemoryHigh='))).toBe(false)
  })

  it('carries a budget even when the caller passes none', () => {
    // The default must not be "unbounded": every call site that forgets the
    // budget is the bug this issue fixed.
    const argv = devBuildScopeArgv('podium-dev-bundle-build.scope', ['bun', 'x'])
    expect(argv.some((arg) => arg.startsWith('--property=MemoryMax='))).toBe(true)
    expect(argv).toContain('--property=MemorySwapMax=0')
  })

  it('places the build in the instance builds slice, beside the sessions slice', () => {
    // NOT inside it: the reclaim policy parks agents on the sessions slice's
    // memory pressure, so a build in there would make every redeploy read as
    // agents starving.
    expect(devBuildScopeArgv('u.scope', ['bun', 'x'])).toContain('--slice=podium-builds.slice')
    expect(
      devBuildScopeArgv('u.scope', ['bun', 'x'], { slice: 'podium-blue-builds.slice' }),
    ).toContain('--slice=podium-blue-builds.slice')
  })

  it('names the cap when the kernel kills a build', () => {
    // The kill arrives as a SIGNAL, not a code: `--scope` execs the build in
    // place, so node sees `code: null, signal: 'SIGKILL'` and the old message
    // read "exited with status unknown" — neither of the operator's two facts.
    // Measured by driving a hog through this path under a 256 MiB cap.
    const budget = { memoryMaxBytes: 4 * GIB, memorySwapMaxBytes: 0 }
    const killed = describeBuildExit('bun', { status: null, signal: 'SIGKILL' }, budget)
    expect(killed).toContain('killed by SIGKILL')
    expect(killed).toContain('4.0 GiB')
    expect(killed).toContain('swap disabled')
    expect(killed).toContain('PODIUM_BUILD_MEMORY_MAX')
    // A wrapper (the unscoped fallback path) reports the same death as 137.
    expect(describeBuildExit('bun', { status: 137 }, budget)).toContain('4.0 GiB')
    // An operator who set 256M reads their own number back, not "0.3 GiB".
    expect(
      describeBuildExit('bun', { status: 137 }, { memoryMaxBytes: 256 * 1024 ** 2 }),
    ).toContain('256 MiB')
    // A compile error is a compile error; only a KILL gets the budget note.
    expect(describeBuildExit('bun', { status: 1 }, budget)).toBe('bun exited with status 1')
    expect(describeBuildExit('bun', { status: null, signal: 'SIGKILL' }, {})).toBe(
      'bun was killed by SIGKILL',
    )
    expect(describeBuildExit('bun', { status: null }, budget)).toBe(
      'bun exited with status unknown',
    )
  })

  it('uses the server bun so a scoped build does not search PATH', () => {
    expect(devBuildCommand({}, '/home/podium/.bun/bin/bun')).toBe('/home/podium/.bun/bin/bun')
    expect(devBuildCommand({}, '/opt/bun.exe')).toBe('/opt/bun.exe')
    expect(devBuildCommand({ BUN_BIN: '/opt/bun' }, '/home/podium/.bun/bin/bun')).toBe('/opt/bun')
    expect(devBuildCommand({}, '/usr/bin/node')).toBe('bun')
  })
})
