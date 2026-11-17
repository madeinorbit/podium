/**
 * Where a source-checkout daemon keeps its podium-host build when it runs
 * under a temporary HOME, as the daemon integration and e2e tests do. Runs under
 * Bun on purpose: the daemon runs under Bun, and Bun's `os.userInfo().homedir`
 * answers from `$HOME`, which is what sent the build into the temporary home.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { passwdHome, sourceRustHostCacheDir } from './host-bin'

const saved = {
  HOME: process.env.HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  PODIUM_RUST_HOST_BUILD_DIR: process.env.PODIUM_RUST_HOST_BUILD_DIR,
}
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-bin-home-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('passwdHome', () => {
  test('reads the home field of the entry for the uid', () => {
    const file = join(tempDir(), 'passwd')
    writeFileSync(
      file,
      [
        'root:x:0:0:root:/root:/bin/bash',
        '# a comment line',
        'ana:x:1001:1001:Ana,,,:/home/ana:/bin/zsh',
        'bo:x:10010:10010::/home/bo:/bin/sh',
      ].join('\n'),
    )
    expect(passwdHome(1001, file)).toBe('/home/ana')
    expect(passwdHome(10010, file)).toBe('/home/bo')
    expect(passwdHome(0, file)).toBe('/root')
  })

  test('has no answer for an unknown uid, a missing uid or an unreadable file', () => {
    const file = join(tempDir(), 'passwd')
    writeFileSync(file, 'root:x:0:0:root:/root:/bin/bash\n')
    expect(passwdHome(4242, file)).toBeUndefined()
    expect(passwdHome(undefined, file)).toBeUndefined()
    expect(passwdHome(0, join(tempDir(), 'missing'))).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('the source build cache', () => {
  test('stays in the account home when HOME points at a temporary directory', () => {
    const real = passwdHome(process.getuid?.())
    if (!real) return // an account with no /etc/passwd entry (directory services) cannot be checked here
    delete process.env.XDG_CACHE_HOME
    delete process.env.PODIUM_RUST_HOST_BUILD_DIR
    process.env.HOME = tempDir()
    expect(sourceRustHostCacheDir()).toBe(join(real, '.cache', 'podium', 'podium-host-src'))
  })
})
