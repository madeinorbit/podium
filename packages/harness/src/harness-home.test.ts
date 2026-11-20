import { join } from 'node:path'
import type { CommandEnvironment } from '@podium/runtime/command-environment'
import { describe, expect, it } from 'vitest'
import type { HarnessExecutableSnapshot } from './executable-runtime.js'
import {
  harnessAccount,
  harnessChildEnv,
  harnessContext,
  withHarnessHome,
  withHomeScope,
} from './harness-context.js'
import type { ResolvedHarnessExecutable } from './inventory/build-inventory.js'
import { harnessHomeVariable } from './registry.js'

const MACHINE_HOME = '/home/operator'
const HOME_A = '/state/homes/cred_a/codex'
const HOME_B = '/state/homes/cred_b/claude-code'

function snapshot(env: Record<string, string>): HarnessExecutableSnapshot {
  const commandEnvironment: CommandEnvironment = {
    env,
    pathEntries: ['/usr/bin'],
    source: 'login-shell',
    generation: 3,
    machineHome: MACHINE_HOME,
    loginShell: '/bin/bash',
    resolve: () => undefined,
  }
  const executables: ResolvedHarnessExecutable[] = [
    { kind: 'codex', path: '/usr/bin/codex', version: 'codex-cli 0.169.0', generation: 3 },
    { kind: 'claude-code', path: '/usr/bin/claude', version: '2.1.330', generation: 3 },
  ]
  return {
    executables: new Map(executables.map((executable) => [executable.kind, executable])),
    commandEnvironment,
  }
}

const MACHINE_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: MACHINE_HOME,
  CLAUDE_CONFIG_DIR: '/home/operator/.claude-operator',
  CODEX_HOME: '/home/operator/decoy-codex',
}

describe('harnessHomeVariable', () => {
  it('names the variable that moves the harness’s login directory', () => {
    expect(harnessHomeVariable('claude-code')).toBe('CLAUDE_CONFIG_DIR')
    expect(harnessHomeVariable('codex')).toBe('CODEX_HOME')
    // Grok's login is never copied to another machine, but GROK_HOME still
    // moves it with the rest of the folder (POD-7267, POD-7370).
    expect(harnessHomeVariable('grok')).toBe('GROK_HOME')
    expect(harnessHomeVariable('opencode')).toBeUndefined()
  })
})

describe('a context in a home', () => {
  it('points Codex at the home in its env, its roots and its child env, and keeps HOME', () => {
    const base = harnessContext(snapshot(MACHINE_ENV), 'codex', MACHINE_HOME)
    const context = withHarnessHome(base, { id: 'cred_a:codex', dir: HOME_A })
    expect(context.harnessHome).toEqual({ id: 'cred_a:codex', dir: HOME_A, variable: 'CODEX_HOME' })
    expect(context.env.CODEX_HOME).toBe(HOME_A)
    expect(context.roots.state).toBe(HOME_A)
    expect(context.home).toBe(MACHINE_HOME)
    const child = harnessChildEnv(context, {
      // A spawn frame naming another directory never moves the session out of its home.
      sessionEnv: { CODEX_HOME: '/elsewhere' },
      wiringEnv: { CODEX_HOME: '/wiring' },
    })
    expect(child.env.CODEX_HOME).toBe(HOME_A)
    expect(child.env.HOME).toBe(MACHINE_HOME)
  })

  it('points Claude Code at the home, for the machine’s account and for a named account', () => {
    for (const accountHome of [MACHINE_HOME, '/accounts/named']) {
      const base = harnessContext(snapshot(MACHINE_ENV), 'claude-code', accountHome)
      const context = withHarnessHome(base, { id: 'cred_b:claude-code', dir: HOME_B })
      expect(context.env.CLAUDE_CONFIG_DIR).toBe(HOME_B)
      expect(context.roots.state).toBe(HOME_B)
      expect(context.roots.transcripts).toBe(join(HOME_B, 'projects'))
      const child = harnessChildEnv(context, {
        // The stream engine pins the instance's own `.claude` in its session env.
        sessionEnv: { CLAUDE_CONFIG_DIR: `${accountHome}/.claude` },
      })
      expect(child.env.CLAUDE_CONFIG_DIR).toBe(HOME_B)
      expect(child.strip).not.toContain('CLAUDE_CONFIG_DIR')
    }
  })

  it('two homes give two children, neither with the other’s directory', () => {
    const base = harnessContext(snapshot(MACHINE_ENV), 'codex', MACHINE_HOME)
    const one = harnessChildEnv(withHarnessHome(base, { id: 'a', dir: HOME_A }), {}).env
    const two = harnessChildEnv(
      withHarnessHome(base, { id: 'b', dir: '/state/homes/b/codex' }),
      {},
    ).env
    expect(one.CODEX_HOME).toBe(HOME_A)
    expect(two.CODEX_HOME).toBe('/state/homes/b/codex')
    expect(Object.values(two)).not.toContain(HOME_A)
  })

  it('leaves a context without a home exactly as it was', () => {
    const base = harnessContext(snapshot(MACHINE_ENV), 'codex', MACHINE_HOME)
    expect(base.harnessHome).toBeUndefined()
    expect(harnessChildEnv(base, {}).env.CODEX_HOME).toBe(join(MACHINE_HOME, '.codex'))
  })

  it('refuses a home for a harness that keeps no login in a movable directory', () => {
    const opencode = harnessAccount('opencode', MACHINE_HOME, MACHINE_ENV)
    expect(() => withHomeScope('opencode', opencode, '/x')).toThrow(/opencode/)
  })

  it('moves an account scope (quota, transcripts) into the home the same way', () => {
    const account = harnessAccount('claude-code', '/accounts/named', MACHINE_ENV)
    const scoped = withHomeScope('claude-code', account, HOME_B)
    expect(scoped.home).toBe('/accounts/named')
    expect(scoped.env.CLAUDE_CONFIG_DIR).toBe(HOME_B)
    expect(scoped.roots.credentials).toBe(HOME_B)
  })
})
