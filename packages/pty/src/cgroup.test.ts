import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cgroupPathForControlGroup,
  parseCgroupKeyed,
  parseCgroupScalar,
  parseProcCgroup,
  readCgroupSample,
  sessionScopeCgroupPath,
  sliceChainPath,
  userManagerCgroupBase,
} from './cgroup.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A cgroup2 tree with one scope in it, written exactly as the kernel does. */
function fixture(files: Record<string, string>): { root: string; scope: string } {
  const root = mkdtempSync(join(tmpdir(), 'podium-cgroup-'))
  roots.push(root)
  const scope = join(
    root,
    'user.slice/user-1000.slice/user@1000.service/podium.slice/podium-sessions.slice/podium-s1.scope',
  )
  mkdirSync(scope, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(scope, name), body)
  return { root, scope }
}

describe('cgroup parsing', () => {
  it('reads "max" as unbounded rather than as a number', () => {
    // `Infinity` would format as a byte count somewhere downstream; undefined
    // is the only reading that cannot be mistaken for a limit.
    expect(parseCgroupScalar('max\n')).toBeUndefined()
    expect(parseCgroupScalar('134217728\n')).toBe(134217728)
    expect(parseCgroupScalar(undefined)).toBeUndefined()
  })

  it('reads the keyed event file', () => {
    expect(parseCgroupKeyed('low 0\nhigh 1834\nmax 20\noom 1\noom_kill 1\n')).toEqual({
      low: 0,
      high: 1834,
      max: 20,
      oom: 1,
      oom_kill: 1,
    })
  })

  it('takes the unified-hierarchy line and refuses a v1-only body', () => {
    expect(parseProcCgroup('0::/user.slice/user-1000.slice/x.scope\n')).toBe(
      '/user.slice/user-1000.slice/x.scope',
    )
    // No `0::` line means no unified hierarchy — nothing to observe, and saying
    // so beats guessing a path from a controller mount.
    expect(parseProcCgroup('12:memory:/user/1000.user\n11:pids:/user/1000.user\n')).toBeUndefined()
  })
})

describe('locating a session scope', () => {
  it('expands a slice name into the directory chain systemd materializes', () => {
    expect(sliceChainPath('podium-sessions.slice')).toBe('podium.slice/podium-sessions.slice')
    expect(sliceChainPath('podium-op-sessions.slice')).toBe(
      'podium.slice/podium-op.slice/podium-op-sessions.slice',
    )
  })

  it('cuts our own cgroup at the user manager, and falls back to logind layout', () => {
    expect(
      userManagerCgroupBase(
        1000,
        '/user.slice/user-1000.slice/user@1000.service/app.slice/a.scope',
      ),
    ).toBe('/user.slice/user-1000.slice/user@1000.service')
    // A SYSTEM service with `User=` has no `user@` component at all — the same
    // situation `userRuntimeDir()` falls back for.
    expect(userManagerCgroupBase(1000, '/system.slice/podium.service')).toBe(
      '/user.slice/user-1000.slice/user@1000.service',
    )
  })

  it('finds a scope in the sessions slice', () => {
    const { root } = fixture({ 'memory.events': 'oom_kill 0\n' })
    expect(
      sessionScopeCgroupPath('podium-s1.scope', {
        uid: 1000,
        slice: 'podium-sessions.slice',
        env: { PODIUM_CGROUP_ROOT: root },
        selfCgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/daemon.scope',
      }),
    ).toContain('podium-sessions.slice/podium-s1.scope')
  })

  it('still finds a pre-hierarchy scope in app.slice', () => {
    // The long-lived session adopted across the upgrade is exactly the one whose
    // memory matters most; it is still where the old spawn path put it.
    const root = mkdtempSync(join(tmpdir(), 'podium-cgroup-'))
    roots.push(root)
    const legacy = join(root, 'user.slice/user-1000.slice/user@1000.service/app.slice/old.scope')
    mkdirSync(legacy, { recursive: true })
    expect(
      sessionScopeCgroupPath('old.scope', {
        uid: 1000,
        slice: 'podium-sessions.slice',
        env: { PODIUM_CGROUP_ROOT: root },
        selfCgroup: '/user.slice/user-1000.slice/user@1000.service/app.slice/daemon.scope',
      }),
    ).toBe(legacy)
  })

  it('composes a path from a systemctl ControlGroup value', () => {
    expect(cgroupPathForControlGroup('/user.slice/x.scope', { PODIUM_CGROUP_ROOT: '/cg' })).toBe(
      '/cg/user.slice/x.scope',
    )
    expect(cgroupPathForControlGroup('/', {})).toBeUndefined()
  })
})

describe('reading a sample', () => {
  it('reports memory, tasks, the budget in force, and the kernel kill counter', () => {
    const { scope } = fixture({
      'memory.events': 'low 0\nhigh 12\nmax 20\noom 1\noom_kill 3\noom_group_kill 0\n',
      'memory.current': '261513216\n',
      'memory.peak': '266100736\n',
      'memory.swap.current': '1024\n',
      'memory.high': '251658240\n',
      'memory.max': '268435456\n',
      'pids.current': '17\n',
      'pids.max': '4096\n',
    })
    expect(readCgroupSample(scope)).toEqual({
      path: scope,
      // Stamped by the kernel when the cgroup is created; the supervisor reads
      // it to tell a session it started from one it adopted.
      createdAtMs: expect.any(Number),
      memoryBytes: 261513216,
      peakMemoryBytes: 266100736,
      swapBytes: 1024,
      memoryHighBytes: 251658240,
      memoryMaxBytes: 268435456,
      tasks: 17,
      tasksMax: 4096,
      oomKills: 3,
      oomGroupKills: 0,
      throttleEvents: 12,
    })
  })

  it('answers undefined for a collected scope instead of a zeroed sample', () => {
    // A garbage-collected scope has no numbers. Inventing zeros here is the
    // "health always reports zero" lie this module replaces.
    expect(readCgroupSample('/nonexistent/podium-gone.scope')).toBeUndefined()
  })

  it('keeps the counters at zero when the kernel omits the keys', () => {
    const { scope } = fixture({ 'memory.events': 'low 0\n', 'memory.max': 'max\n' })
    const sample = readCgroupSample(scope)
    expect(sample?.oomKills).toBe(0)
    // `max` is unbounded, and an unbounded limit is an ABSENT one, not a huge
    // number a UI would render as a budget.
    expect(sample?.memoryMaxBytes).toBeUndefined()
  })
})
