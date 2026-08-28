import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLIENT_FILE_FLOOR, isClientBuildEvidence, verifyClientBuild } from './verify-client-build'
import { CLIENT_BUILD_MANIFEST_FILE, writeWebBuildStamp } from './write-web-build-stamp'

const BUILT_INDEX =
  '<!doctype html><html><head></head><body>' +
  '<script type="module" src="/assets/index-abc12345.js"></script></body></html>'

/** A stamped site of exactly `count` files (index.html + stamp + assets). */
function site(count: number, sha = '47a01e3', version = '0.4.2'): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-verify-site-'))
  writeFileSync(join(dir, 'index.html'), BUILT_INDEX)
  mkdirSync(join(dir, 'assets'))
  for (let i = 0; i < count - 2; i++) writeFileSync(join(dir, 'assets', `f${i}.js`), `// ${i}\n`)
  writeWebBuildStamp(dir, sha, version)
  return dir
}

const good = (): { web: string; mobile: string } => ({
  web: site(CLIENT_FILE_FLOOR.web + 5),
  mobile: site(CLIENT_FILE_FLOOR.mobile + 5),
})

const approved = { sourceCommit: '47a01e3', version: '0.4.2' }

describe('verifyClientBuild', () => {
  it('mints branded evidence for two intact sites', () => {
    const evidence = verifyClientBuild({ ...good(), ...approved })
    expect(isClientBuildEvidence(evidence)).toBe(true)
    expect(evidence.sourceCommit).toBe('47a01e3')
    expect(evidence.version).toBe('0.4.2')
    expect(evidence.clientRootDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a structurally identical object is not evidence', () => {
    const real = verifyClientBuild({ ...good(), ...approved })
    expect(isClientBuildEvidence({ ...real })).toBe(false)
  })

  it('refuses a site whose sourceCommit is not the approved commit', () => {
    const sites = { ...good(), web: site(CLIENT_FILE_FLOOR.web + 5, 'deadbee') }
    expect(() => verifyClientBuild({ ...sites, ...approved })).toThrow(
      /web.*built from deadbee, not 47a01e3/,
    )
  })

  it('refuses a site stamped with another version', () => {
    const sites = { ...good(), web: site(CLIENT_FILE_FLOOR.web + 5, '47a01e3', '0.4.1') }
    expect(() => verifyClientBuild({ ...sites, ...approved })).toThrow(
      /web.*stamped 0\.4\.1, not 0\.4\.2/,
    )
  })

  it('refuses a file whose bytes changed after the manifest', () => {
    const sites = good()
    writeFileSync(join(sites.web, 'assets', 'f0.js'), '// tampered\n')
    expect(() => verifyClientBuild({ ...sites, ...approved })).toThrow(
      /hash does not match assets\/f0\.js/,
    )
  })

  it('refuses an extra file the manifest never inventoried', () => {
    const sites = good()
    writeFileSync(join(sites.mobile, 'extra.txt'), 'x')
    expect(() => verifyClientBuild({ ...sites, ...approved })).toThrow(/does not exactly inventory/)
  })

  it('refuses a site below the file floor even when internally consistent', () => {
    const sites = { ...good(), web: site(CLIENT_FILE_FLOOR.web - 1) }
    expect(() => verifyClientBuild({ ...sites, ...approved })).toThrow(
      new RegExp(`web has ${CLIENT_FILE_FLOOR.web - 1} files, floor is ${CLIENT_FILE_FLOOR.web}`),
    )
  })

  it('refuses a manifest whose fileCount disagrees with its own inventory', () => {
    const sites = good()
    const path = join(sites.web, CLIENT_BUILD_MANIFEST_FILE)
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { fileCount: number }
    manifest.fileCount += 1
    writeFileSync(path, JSON.stringify(manifest))
    expect(() => verifyClientBuild({ ...sites, ...approved })).toThrow(/fileCount/)
  })
})
