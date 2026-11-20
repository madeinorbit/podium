/** Public Pi release responses recorded 2026-11-20; binary bytes are synthetic. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { VendorFixture } from '../../inventory/managed-install.test-support.js'
import { opencodeTarFixture } from '../opencode/install.test-support.js'

export const PI_STABLE_RESPONSE = readFileSync(
  new URL('./fixtures/stable-release.json', import.meta.url),
  'utf8',
)
export const PI_STANDALONE_RESPONSE = readFileSync(
  new URL('./fixtures/standalone-release.json', import.meta.url),
  'utf8',
)
export const PI_FIXTURE_BINARY =
  '#!/bin/sh\nif [ "$1" = --help ]; then echo "pi - AI coding assistant"; else echo "1.6.0"; fi\n'

export const PI_FIXTURE_FILES: Record<string, string> = {
  'pi/pi': PI_FIXTURE_BINARY,
  'pi/package.json': '{"version":"1.6.0"}\n',
  'pi/theme/dark.json': '{"name":"dark"}\n',
  'pi/export-html/template.html': '<html>Pi export</html>\n',
}

/** Join ordinary ustar entries in the vendor's pi/ bundle layout. */
export function piTarFixture(files = PI_FIXTURE_FILES): Buffer {
  return gzipSync(
    Buffer.concat([
      ...Object.entries(files).map(([name, body]) =>
        gunzipSync(opencodeTarFixture(name, body)).subarray(0, -1024),
      ),
      Buffer.alloc(1024),
    ]),
  )
}

export function piStandaloneFixture(archive: Buffer) {
  const metadata = JSON.parse(PI_STANDALONE_RESPONSE)
  for (const asset of metadata.assets)
    asset.digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
  return metadata
}

export function piChecksumFixture(archive: Buffer): string {
  const digest = createHash('sha256').update(archive).digest('hex')
  return JSON.parse(PI_STANDALONE_RESPONSE)
    .assets.filter((asset: { name: string }) => asset.name !== 'SHA256SUMS')
    .map((asset: { name: string }) => `${digest}  ${asset.name}\n`)
    .join('')
}

/** Both metadata services and the archive stay behind the mechanism's ports. */
export function piVendorFixtureWithIntegrity(
  kind: 'sums' | 'digest' | 'none' = 'sums',
): VendorFixture {
  return {
    async start() {
      const archive = piTarFixture()
      const metadata = piStandaloneFixture(archive)
      if (kind !== 'sums')
        metadata.assets = metadata.assets.filter(
          (asset: { name: string }) => asset.name !== 'SHA256SUMS',
        )
      if (kind === 'none') for (const asset of metadata.assets) delete asset.digest
      const server = createServer((request, response) => {
        if (request.url === '/installer/latest') return response.end(PI_STABLE_RESPONSE)
        if (request.url === '/api/tags/v1.6.0') return response.end(JSON.stringify(metadata))
        if (request.url === '/download/v1.6.0/SHA256SUMS')
          return response.end(piChecksumFixture(archive))
        if (request.url === '/download/v1.6.0/pi-linux-x64.tar.gz') return response.end(archive)
        response.writeHead(404)
        response.end('not found')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      return {
        origins: {
          'https://pi.dev/api/installer/releases': `${origin}/installer`,
          'https://api.github.com/repos/earendil-works/pi/releases': `${origin}/api`,
          'https://github.com/earendil-works/pi/releases/download': `${origin}/download`,
        },
        stop: () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      }
    },
  }
}

export const piVendorFixture = piVendorFixtureWithIntegrity()
