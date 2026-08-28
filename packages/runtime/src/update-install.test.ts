import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  oldBundlePath,
  oldBundlePresent,
  pruneOldBundle,
  restoreOldBundle,
  swapHeadlessBundle,
} from './update-install'

const roots: string[] = []

function stagingRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-swap-'))
  roots.push(root)
  return root
}

async function tarballWithHeadless(version: string): Promise<Uint8Array> {
  const root = stagingRoot()
  const headless = join(root, 'headless')
  mkdirSync(headless, { recursive: true })
  writeFileSync(join(headless, 'VERSION'), `${version}\n`)
  writeFileSync(join(headless, 'podium'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const tarball = join(root, 'bundle.tar.gz')
  const { execFileSync } = await import('node:child_process')
  execFileSync('tar', ['-czf', tarball, '-C', root, 'headless'])
  return new Uint8Array(readFileSync(tarball))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('swapHeadlessBundle retain .old', () => {
  it('retains .old by default and pruneOldBundle removes it', async () => {
    const root = stagingRoot()
    const installDir = join(root, 'install')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'VERSION'), '1.0.0\n')

    await swapHeadlessBundle(await tarballWithHeadless('2.0.0'), installDir)
    expect(readFileSync(join(installDir, 'VERSION'), 'utf8').trim()).toBe('2.0.0')
    expect(oldBundlePresent(installDir)).toBe(true)
    expect(readFileSync(join(oldBundlePath(installDir), 'VERSION'), 'utf8').trim()).toBe('1.0.0')

    pruneOldBundle(installDir)
    expect(oldBundlePresent(installDir)).toBe(false)
  })

  it('restoreOldBundle swaps .old back over a bad install', async () => {
    const root = stagingRoot()
    const installDir = join(root, 'install')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'VERSION'), '1.0.0\n')
    await swapHeadlessBundle(await tarballWithHeadless('2.0.0'), installDir)
    writeFileSync(join(installDir, 'VERSION'), '2.0.0-broken\n')

    restoreOldBundle(installDir)
    expect(readFileSync(join(installDir, 'VERSION'), 'utf8').trim()).toBe('1.0.0')
    expect(oldBundlePresent(installDir)).toBe(false)
  })

  it('retainOld:false prunes immediately (legacy opt-out)', async () => {
    const root = stagingRoot()
    const installDir = join(root, 'install')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'VERSION'), '1.0.0\n')
    await swapHeadlessBundle(await tarballWithHeadless('2.0.0'), installDir, { retainOld: false })
    expect(oldBundlePresent(installDir)).toBe(false)
  })
})
