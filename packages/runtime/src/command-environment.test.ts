import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommandEnvironment } from './command-environment'

const roots: string[] = []
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'podium-command-environment-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('createCommandEnvironment', () => {
  it('hydrates only a supervised desktop and keeps login-shell precedence', async () => {
    const home = root()
    const shellBin = join(home, 'shell-bin')
    mkdirSync(shellBin)
    const calls: string[] = []
    const environment = await createCommandEnvironment({
      platform: 'darwin',
      env: {
        HOME: home,
        PATH: ['/usr/bin', shellBin].join(delimiter),
        PODIUM_DESKTOP_SUPERVISED: '1',
        INVOCATION_ID: 'irrelevant',
      },
      accountInfo: () => ({ homedir: '/wrong', shell: '/bin/zsh' }),
      runShell: async ({ shell }) => {
        calls.push(shell)
        return `noise\n\u001b[32m__PODIUM_PATH_START__${shellBin}${delimiter}/opt/homebrew/bin__PODIUM_PATH_END__\u001b[0m\n`
      },
    })
    expect(calls).toEqual(['/bin/zsh'])
    expect(environment.source).toBe('login-shell')
    expect(environment.pathEntries.slice(0, 3)).toEqual([shellBin, '/opt/homebrew/bin', '/usr/bin'])
    expect(environment.env.PATH).toBe(environment.pathEntries.join(delimiter))
  })

  it('reads the current Windows Path from the registry and adds installer folders', async () => {
    const queried: string[] = []
    const environment = await createCommandEnvironment({
      platform: 'win32',
      env: {
        Path: 'C:\\Stale\\bin',
        USERPROFILE: 'C:\\Users\\dev',
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        SystemRoot: 'C:\\Windows',
      },
      machineHome: 'C:\\Users\\dev',
      accountInfo: () => ({ homedir: 'C:\\Users\\dev' }),
      queryRegistry: async (key) => {
        queried.push(key)
        return key.startsWith('HKLM')
          ? '\r\nHKEY_LOCAL_MACHINE\\...\\Environment\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\Git\\cmd\r\n'
          : '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\Users\\dev\\AppData\\Local\\Fresh;%UNSET%\\x\r\n'
      },
    })
    expect(queried).toEqual([
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      'HKCU\\Environment',
    ])
    expect(environment.source).toBe('registry')
    expect(environment.pathEntries).toEqual([
      'C:\\Windows\\system32',
      'C:\\Program Files\\Git\\cmd',
      'C:\\Users\\dev\\AppData\\Local\\Fresh',
      '%UNSET%\\x',
      'C:\\Stale\\bin',
      join('C:\\Users\\dev', '.local', 'bin'),
      join('C:\\Users\\dev', '.bun', 'bin'),
      join('C:\\Users\\dev\\AppData\\Roaming', 'npm'),
      join('C:\\Users\\dev\\AppData\\Local', 'mise', 'shims'),
    ])
  })

  it('does not treat systemd INVOCATION_ID as desktop supervision', async () => {
    let called = false
    const environment = await createCommandEnvironment({
      platform: 'linux',
      env: { PATH: '/usr/bin', INVOCATION_ID: 'unit' },
      runShell: async () => {
        called = true
        return ''
      },
    })
    expect(called).toBe(false)
    expect(environment.source).toBe('inherited')
  })

  it('degrades malformed shell output to inherited PATH plus Homebrew fallbacks', async () => {
    const environment = await createCommandEnvironment({
      platform: 'darwin',
      env: { HOME: root(), PATH: '/custom/bin', PODIUM_DESKTOP_SUPERVISED: '1' },
      runShell: async () => 'profile chatter without sentinels',
    })
    expect(environment.failure).toBe('shell-probe-malformed')
    expect(environment.pathEntries[0]).toBe('/custom/bin')
    expect(environment.pathEntries).toContain('/opt/homebrew/bin')
    expect(environment.pathEntries).toContain('/usr/local/bin')
  })

  it('skips non-executable files and resolves the first runnable command', async () => {
    const home = root()
    const first = join(home, 'first')
    const second = join(home, 'second')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'codex'), '#!/bin/sh\n')
    chmodSync(join(first, 'codex'), 0o644)
    writeFileSync(join(second, 'codex'), '#!/bin/sh\n')
    chmodSync(join(second, 'codex'), 0o755)
    const environment = await createCommandEnvironment({
      platform: 'linux',
      env: { HOME: home, PATH: [first, second].join(delimiter) },
    })
    expect(environment.resolve('codex')).toBe(join(second, 'codex'))
  })

  it('uses explicit account values before environment and user lookup', async () => {
    const environment = await createCommandEnvironment({
      platform: 'linux',
      env: { HOME: '/env-home', SHELL: '/env-shell', PATH: '' },
      machineHome: '/explicit-home',
      loginShell: '/explicit-shell',
      accountInfo: () => ({ homedir: '/account-home', shell: '/account-shell' }),
    })
    expect(environment.machineHome).toBe('/explicit-home')
    expect(environment.loginShell).toBe('/explicit-shell')
  })
})
