/**
 * Root identity of the exact web + mobile files a fresh client build produced.
 *
 * Per-site manifests may travel with a bundle for inspection. This digest is
 * captured from the build directory before packaging, so an archive cannot
 * rewrite both its bytes and the proof the release gate trusts.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const CLIENT_BUILD_MANIFEST_FILE = 'podium-build-manifest.json'
export const CLIENT_ROOT_DIGEST_FILE = 'client-root-digest.sha256'

interface ClientBuildManifest {
  manifestVersion?: unknown
  files?: unknown
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function exactSiteEntries(siteDir: string): Array<[string, string]> {
  const manifestPath = join(siteDir, CLIENT_BUILD_MANIFEST_FILE)
  let manifest: ClientBuildManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ClientBuildManifest
  } catch (error) {
    throw new Error(`${siteDir} has no readable ${CLIENT_BUILD_MANIFEST_FILE}: ${String(error)}`)
  }
  if (manifest.manifestVersion !== 1 || typeof manifest.files !== 'object' || !manifest.files) {
    throw new Error(`${manifestPath} has no v1 file inventory`)
  }
  const expected = manifest.files as Record<string, unknown>
  const actual = new Map<string, string>()
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = relative(siteDir, path).split(sep).join('/')
      if (name === CLIENT_BUILD_MANIFEST_FILE) continue
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !lstatSync(path).isFile()) {
        throw new Error(`${siteDir} contains unsupported non-regular entry ${name}`)
      }
      actual.set(name, sha256(readFileSync(path)))
    }
  }
  visit(siteDir)

  const expectedNames = Object.keys(expected).sort()
  const actualNames = [...actual.keys()].sort()
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    throw new Error(`${manifestPath} does not exactly inventory its build output`)
  }
  for (const name of actualNames) {
    if (expected[name] !== actual.get(name)) {
      throw new Error(`${manifestPath} hash does not match ${name}`)
    }
  }
  return actualNames.map((name) => [name, actual.get(name) as string])
}

/** SHA-256 over the sorted `[site/path, file-sha256]` entry set. */
export function clientBuildRootDigestFromSites(sites: { web: string; mobile: string }): string {
  const entries: Array<[string, string]> = []
  for (const site of ['mobile', 'web'] as const) {
    for (const [name, digest] of exactSiteEntries(sites[site])) {
      entries.push([`${site}/${name}`, digest])
    }
  }
  // Locale collation is machine- and language-dependent and disagrees with the
  // Python verifier on ordinary Vite names containing `_`, `-`, and capitals.
  // Compare Unicode code points directly so every implementation hashes one order.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return sha256(JSON.stringify(entries))
}

export function clientBuildRootDigest(clientRoot: string): string {
  return clientBuildRootDigestFromSites({
    web: join(clientRoot, 'web'),
    mobile: join(clientRoot, 'mobile'),
  })
}
