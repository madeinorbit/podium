import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireInstallationLease,
  acquireRuntimeInstallationLease,
  canonicalInstallationPath,
  type InstallationLease,
  installationStateRoots,
  registerInstallationStateRoot,
} from './installation-lease'

const roots: string[] = []
const leases: InstallationLease[] = []
afterEach(() => {
  for (const lease of leases.splice(0)) lease.release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'podium-install-lease-'))
  roots.push(root)
  return { root, install: join(root, 'payload') }
}
function acquire(path: string, exclusive: boolean) {
  const lease = acquireInstallationLease(path, exclusive)
  leases.push(lease)
  return lease
}

describe('installation usage lease', () => {
  it('never overwrites a corrupt existing state-root record while registering it again', () => {
    const { root, install } = fixture()
    const lease = acquire(install, true)
    const state = join(root, 'state')
    registerInstallationStateRoot(lease, state)
    const path = join(
      lease.metadataDir,
      'roots',
      readdirSync(join(lease.metadataDir, 'roots'))[0] as string,
    )
    writeFileSync(path, '{broken registry')
    expect(() => registerInstallationStateRoot(lease, state)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken registry')
  })
  it.skipIf(process.getuid?.() === 0)(
    'keeps a read-only image runtime bootable while refusing fallback ownership',
    () => {
      const { root, install } = fixture()
      chmodSync(root, 0o555)
      try {
        expect(acquireRuntimeInstallationLease(install)).toBeUndefined()
        expect(() => acquireInstallationLease(install, true)).toThrow()
      } finally {
        chmodSync(root, 0o755)
      }
    },
  )
  it('allows parent, successor and another instance together; excludes fallback until all release', () => {
    const { install } = fixture()
    const parent = acquire(install, false)
    const successor = acquire(install, false)
    const anotherInstance = acquire(install, false)
    expect(() => acquire(install, true)).toThrow()
    parent.release()
    successor.release()
    expect(() => acquire(install, true)).toThrow()
    anotherInstance.release()
    const fallback = acquire(install, true)
    expect(() => acquire(install, false)).toThrow()
    expect(() => acquire(install, true)).toThrow()
    fallback.release()
    fallback.release()
    expect(acquire(install, false).exclusive).toBe(false)
  })

  it('canonicalizes payload aliases and not-yet-seeded directories to the same lock', () => {
    const { root, install } = fixture()
    mkdirSync(join(root, 'data'))
    symlinkSync(join(root, 'data'), join(root, 'alias'), 'dir')
    const first = join(root, 'data', 'payload')
    const second = join(root, 'alias', 'payload')
    expect(canonicalInstallationPath(first)).toBe(canonicalInstallationPath(second))
    acquire(first, false)
    expect(() => acquire(second, true)).toThrow()
    expect(acquire(install, true).exclusive).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses broken installation aliases and preserves broken state-root records',
    () => {
      const { root, install } = fixture()
      const missing = join(root, 'missing')
      const alias = join(root, 'broken-alias')
      symlinkSync(missing, alias, 'dir')
      expect(() => canonicalInstallationPath(join(alias, 'payload'))).toThrow()
      const lease = acquire(install, true)
      const state = join(root, 'state')
      registerInstallationStateRoot(lease, state)
      const records = join(lease.metadataDir, 'roots')
      const path = join(records, readdirSync(records)[0] as string)
      rmSync(path)
      symlinkSync(missing, path)
      expect(() => registerInstallationStateRoot(lease, state)).toThrow()
      expect(readlinkSync(path)).toBe(missing)
      expect(() => installationStateRoots(lease)).toThrow()
    },
  )

  it('retains every state root after usage ends and refuses corrupt ownership metadata', () => {
    const { root, install } = fixture()
    const owner = acquire(install, false)
    registerInstallationStateRoot(owner, join(root, 'blue'))
    registerInstallationStateRoot(owner, join(root, 'green'))
    registerInstallationStateRoot(owner, join(root, 'blue'))
    owner.release()
    const writer = acquire(install, true)
    expect(installationStateRoots(writer).sort()).toEqual([join(root, 'blue'), join(root, 'green')])
    writeFileSync(join(writer.metadataDir, 'roots', 'damaged.json'), '{')
    expect(() => installationStateRoots(writer)).toThrow()
  })
})
