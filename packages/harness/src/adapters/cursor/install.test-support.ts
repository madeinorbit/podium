/** Public installer recorded 2026-11-20; package bytes are synthetic. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { VendorFixture } from '../../inventory/managed-install.test-support.js'
import { opencodeTarFixture } from '../opencode/install.test-support.js'

export const CURSOR_STABLE_RESPONSE = readFileSync(
  new URL('./fixtures/stable-installer.sh', import.meta.url),
  'utf8',
)
export const CURSOR_VERSION = '2026.11.19-f005e9d'
export const CURSOR_SOURCE = `https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/x64/agent-cli-package.tar.gz`
export const CURSOR_FIXTURE_BINARY = `#!/bin/sh
case "$*" in
  *--help*) echo "Cursor Agent" ;;
  *create-chat*) echo "12345678-1234-1234-1234-123456789abc" ;;
  *) echo "${CURSOR_VERSION}" ;;
esac
`
export const CURSOR_FIXTURE_FILES = {
  'dist-package/cursor-agent': CURSOR_FIXTURE_BINARY,
  'dist-package/node': '#!/bin/sh\necho bundled node\n',
  'dist-package/index.js': '// Cursor bundle\n',
  'dist-package/resources/tool.txt': 'bundled resource\n',
  // The real bundle uses GNU long-name metadata for tree-sitter resources.
  'dist-package/node_modules/tree-sitter/build/Release/.deps/Release/obj.target/tree_sitter_runtime_binding/src/binding.o.d':
    'native resource\n',
}

export function cursorTarFixture(files: Record<string, string> = CURSOR_FIXTURE_FILES): Buffer {
  return gzipSync(
    Buffer.concat([
      ...Object.entries(files).flatMap(([name, body]) => [
        ...(Buffer.byteLength(name) > 100
          ? [gunzipSync(opencodeTarFixture('././@LongLink', `${name}\0`, 'L')).subarray(0, -1024)]
          : []),
        gunzipSync(opencodeTarFixture(name, body)).subarray(0, -1024),
      ]),
      Buffer.alloc(1024),
    ]),
  )
}

export function cursorChecksumFixture(archive: Buffer): string {
  return `${createHash('sha256').update(archive).digest('hex')}  agent-cli-package.tar.gz\n`
}

/** The real adapter reaches only this fixture through the vendor-origin map. */
export const cursorVendorFixture: VendorFixture = {
  async start() {
    const archive = cursorTarFixture()
    const assetPath = `/${CURSOR_VERSION}/linux/x64/agent-cli-package.tar.gz`
    const server = createServer((request, response) => {
      if (request.url === '/install') return response.end(CURSOR_STABLE_RESPONSE)
      if (request.url === assetPath) return response.end(archive)
      if (request.url === `${assetPath}.sha256`) return response.end(cursorChecksumFixture(archive))
      response.writeHead(404)
      response.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      origins: {
        'https://cursor.com/install': `${origin}/install`,
        'https://downloads.cursor.com/lab': origin,
      },
      stop: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    }
  },
}
