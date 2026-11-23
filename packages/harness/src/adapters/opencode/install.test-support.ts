/** Recorded public GitHub response fields, 2026-11-20 (POD-7267 and live recheck). */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import type { VendorFixture } from '../../inventory/managed-install.test-support.js'

export const OPENCODE_STABLE_RESPONSE = readFileSync(
  new URL('./fixtures/stable-release.json', import.meta.url),
  'utf8',
)

export const OPENCODE_FIXTURE_BINARY = '#!/bin/sh\necho "1.19.6"\n'

/** A normal ustar single-file archive, the measured vendor layout. */
export function opencodeTarFixture(
  name = 'opencode',
  body = OPENCODE_FIXTURE_BINARY,
  type = '0',
): Buffer {
  const content = Buffer.from(body)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000755\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return gzipSync(
    Buffer.concat([
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  )
}

/** Serve both API endpoints and the direct published archive through the ports. */
export function opencodeVendorFixtureWithDigest(digest?: string | null): VendorFixture {
  return {
    async start() {
      const archive = opencodeTarFixture()
      const metadata = JSON.parse(OPENCODE_STABLE_RESPONSE)
      for (const asset of metadata.assets) {
        asset.digest =
          digest === undefined
            ? `sha256:${createHash('sha256').update(archive).digest('hex')}`
            : digest
      }
      const server = createServer((request, response) => {
        if (['/api/latest', '/api/tags/v1.19.6'].includes(request.url ?? ''))
          return response.end(JSON.stringify(metadata))
        if (request.url === '/download/v1.19.6/opencode-linux-x64.tar.gz')
          return response.end(archive)
        response.writeHead(404)
        response.end('not found')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      return {
        origins: {
          'https://api.github.com/repos/anomalyco/opencode/releases': `${origin}/api`,
          'https://github.com/anomalyco/opencode/releases/download': `${origin}/download`,
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

export const opencodeVendorFixture = opencodeVendorFixtureWithDigest()
