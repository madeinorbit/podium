/**
 * The systemd scope a durable host runs in (`./scope.ts`, moved out of the
 * abduco module in POD-4986): argv shape, batch tier, reclaim, runtime dir.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { daemonTool, scopeReclaimArgvs, systemdScopeArgv, userRuntimeDir } from './scope.js'

describe('systemd scope argv', () => {
  it('wraps the create command in a named transient --user scope (the cgroup that survives redeploy)', () => {
    expect(
      systemdScopeArgv('podium-1.scope', ['podium-host', 'create', '--socket', '/s'], {
        slice: 'podium-sessions.slice',
        budget: { memoryHighBytes: 900, memoryMaxBytes: 1000, tasksMax: 64 },
      }),
    ).toEqual([
      '--user',
      '--scope',
      '--collect',
      '--quiet',
      '--slice=podium-sessions.slice',
      '--property=CPUWeight=50',
      '--property=IOWeight=100',
      '--property=MemoryHigh=900',
      '--property=MemoryMax=1000',
      '--property=TasksMax=64',
      '--property=OOMPolicy=continue',
      '--unit=podium-1.scope',
      '--',
      'podium-host',
      'create',
      '--socket',
      '/s',
    ])
  })
  it('pins agent scopes to the batch scheduling tier (POD-598)', () => {
    const argv = systemdScopeArgv('podium-1.scope', ['podium-host'])
    expect(argv.indexOf('--property=CPUWeight=50')).toBeLessThan(argv.indexOf('--'))
    expect(argv.indexOf('--property=IOWeight=100')).toBeLessThan(argv.indexOf('--'))
  })
  it('builds reclaim commands that free a stale same-named scope', () => {
    expect(scopeReclaimArgvs('podium-1.scope')).toEqual([
      ['--user', 'stop', 'podium-1.scope'],
      ['--user', 'reset-failed', 'podium-1.scope'],
    ])
  })
})

describe('userRuntimeDir', () => {
  it('prefers XDG_RUNTIME_DIR when the environment provides it', () => {
    const prev = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = '/run/user/424242'
    try {
      expect(userRuntimeDir()).toBe('/run/user/424242')
    } finally {
      if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = prev
    }
  })

  it('falls back to /run/user/<uid> when unset (system service with User=) if it exists', () => {
    // A system unit with `User=` never gets XDG_RUNTIME_DIR from logind, which used
    // to silently disable scoping and park every master in the service cgroup — the
    // "all sessions die when podium.service restarts" bug.
    const prev = process.env.XDG_RUNTIME_DIR
    delete process.env.XDG_RUNTIME_DIR
    try {
      const dir = userRuntimeDir()
      if (process.platform === 'linux' && typeof process.getuid === 'function') {
        const logind = `/run/user/${process.getuid()}`
        expect(dir === undefined || dir === logind).toBe(true)
      } else {
        expect(dir).toBeUndefined()
      }
    } finally {
      if (prev === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = prev
    }
  })
})

describe.skipIf(process.platform === 'win32')("the daemon's own tools (POD-7060)", () => {
  it('resolve on the PATH given, to the first executable file; the bare name when none holds it', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-daemon-tool-'))
    try {
      const notExec = join(root, 'plain')
      const exec = join(root, 'bin')
      const dirOnly = join(root, 'dir')
      mkdirSync(notExec)
      mkdirSync(exec)
      mkdirSync(join(dirOnly, 'systemd-run'), { recursive: true })
      writeFileSync(join(notExec, 'systemd-run'), '')
      writeFileSync(join(exec, 'systemd-run'), '#!/bin/sh\n')
      chmodSync(join(exec, 'systemd-run'), 0o755)
      const PATH = ['', dirOnly, notExec, exec].join(delimiter)
      expect(daemonTool('systemd-run', { PATH })).toBe(join(exec, 'systemd-run'))
      // An agent PATH without systemd's folder is not where the daemon looks.
      expect(daemonTool('systemd-run', { PATH: notExec })).toBe('systemd-run')
      expect(daemonTool('systemd-run', {})).toBe('systemd-run')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
