// The root digest is only as good as the manifest it reads. These cases pin the
// refusals: a manifest from before the v2 inventory (spec
// 2026-08-28-cached-release-build-design §4.3), a dist whose file set drifted from
// what was inventoried, and a file whose bytes changed after it was hashed.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_BUILD_MANIFEST_FILE,
  clientBuildRootDigestFromSites,
} from './client-build-provenance'

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

/** A site with `files` and a manifest that inventories exactly them. */
function site(files: Record<string, string>, manifestVersion: unknown = 2): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-provenance-'))
  const inventory: Record<string, string> = {}
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
    inventory[name] = sha256(body)
  }
  writeFileSync(
    join(dir, CLIENT_BUILD_MANIFEST_FILE),
    `${JSON.stringify({ manifestVersion, sourceCommit: '47a01e3', fileCount: Object.keys(inventory).length, files: inventory }, null, 2)}\n`,
  )
  return dir
}

const intact = (): { web: string; mobile: string } => ({
  web: site({ 'index.html': '<html></html>', 'assets/a.js': '// a\n' }),
  mobile: site({ 'index.html': '<html></html>', 'assets/b.js': '// b\n' }),
})

describe('clientBuildRootDigestFromSites', () => {
  it('digests two intact sites and is stable across calls', () => {
    const sites = intact()
    const digest = clientBuildRootDigestFromSites(sites)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(clientBuildRootDigestFromSites(sites)).toBe(digest)
  })

  it('refuses a v1 manifest, which has no v2 file inventory', () => {
    const sites = { ...intact(), web: site({ 'index.html': '<html></html>' }, 1) }
    expect(() => clientBuildRootDigestFromSites(sites)).toThrow(/has no v2 file inventory/)
  })

  it('refuses a file the manifest never inventoried', () => {
    const sites = intact()
    writeFileSync(join(sites.mobile, 'extra.txt'), 'x')
    expect(() => clientBuildRootDigestFromSites(sites)).toThrow(/does not exactly inventory/)
  })

  it('refuses an inventoried file that is gone', () => {
    const sites = intact()
    rmSync(join(sites.web, 'assets', 'a.js'))
    expect(() => clientBuildRootDigestFromSites(sites)).toThrow(/does not exactly inventory/)
  })

  it('refuses a file whose bytes changed after the manifest was written', () => {
    const sites = intact()
    writeFileSync(join(sites.web, 'assets', 'a.js'), '// tampered\n')
    expect(() => clientBuildRootDigestFromSites(sites)).toThrow(/hash does not match assets\/a\.js/)
  })
})
