import { describe, expect, it } from 'vitest'
import { bundleNames, windowsLauncherShim } from './build-bun'

describe('bundleNames', () => {
  it('POSIX: bare names, sh launcher', () => {
    expect(bundleNames('linux')).toEqual({
      compiled: 'podium',
      cli: 'podium-cli',
      launcher: 'podium',
    })
    expect(bundleNames('darwin')).toEqual(bundleNames('linux'))
  })
  it('Windows: .exe binaries, .cmd launcher', () => {
    expect(bundleNames('win32')).toEqual({
      compiled: 'podium.exe',
      cli: 'podium-cli.exe',
      launcher: 'podium.cmd',
    })
  })
})

// The .cmd launcher can only be EXECUTED on Windows (the windows-smoke workflow does);
// here we pin the structural contract so a refactor can't silently drop a piece.
describe('windowsLauncherShim', () => {
  const shim = windowsLauncherShim()
  it('is a batch file that suppresses echo', () => {
    expect(shim.startsWith('@echo off')).toBe(true)
  })
  it('derives the bundle root from its own location (%~dp0) without a trailing backslash', () => {
    expect(shim).toContain('%~dp0')
    expect(shim).toMatch(/set "DIR=%DIR:~0,-1%"/)
  })
  it('exports PODIUM_HOME and defaults PODIUM_WEB_DIR only when unset', () => {
    expect(shim).toContain('set "PODIUM_HOME=%DIR%"')
    expect(shim).toContain('if not defined PODIUM_WEB_DIR set "PODIUM_WEB_DIR=%DIR%\\web"')
  })
  it('forwards all args to podium-cli.exe and propagates its exit code', () => {
    expect(shim).toContain('"%DIR%\\podium-cli.exe" %*')
    expect(shim).toContain('exit /b %errorlevel%')
  })
})
