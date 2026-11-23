/** Public stable-channel fields recorded 2026-11-20; package bytes are synthetic. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { VendorFixture } from '../../inventory/managed-install.test-support.js'
import { opencodeTarFixture } from '../opencode/install.test-support.js'

export const CODEX_STABLE_RESPONSE = readFileSync(
  new URL('./fixtures/stable-release.json', import.meta.url),
  'utf8',
)
export const CODEX_FIXTURE_FILES: Record<string, string> = {
  'bin/codex': '#!/bin/sh\necho "codex-cli 0.171.0"\n',
  'bin/codex-code-mode-host': '#!/bin/sh\necho helper\n',
  'codex-path/rg': '#!/bin/sh\necho ripgrep\n',
  'codex-resources/resource.txt': 'Codex resource\n',
  'codex-package.json': '{"version":"0.171.0","entrypoint":"bin/codex"}\n',
}

export function codexTarFixture(files = CODEX_FIXTURE_FILES): Buffer {
  // The live 0.171.0 package has a PAX mtime header before each entry.
  const timestamp = gunzipSync(
    opencodeTarFixture('././@PaxHeader', '28 mtime=1795200000.1234567\n', 'x'),
  ).subarray(0, -1024)
  return gzipSync(
    Buffer.concat([
      ...Object.entries(files).map(([name, body]) =>
        Buffer.concat([timestamp, gunzipSync(opencodeTarFixture(name, body)).subarray(0, -1024)]),
      ),
      Buffer.alloc(1024),
    ]),
  )
}

export function codexReleaseFixture(archive: Buffer, github = false) {
  const metadata = JSON.parse(CODEX_STABLE_RESPONSE)
  if (github) {
    metadata.draft = false
    metadata.prerelease = false
  }
  for (const asset of metadata.assets) {
    asset.digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`
    if (github)
      asset.browser_download_url = `https://github.com/openai/codex/releases/download/rust-v0.171.0/${asset.name}`
  }
  return metadata
}

export function codexChecksumFixture(archive: Buffer): string {
  const digest = createHash('sha256').update(archive).digest('hex')
  return JSON.parse(CODEX_STABLE_RESPONSE)
    .assets.filter((asset: { name: string }) => asset.name !== 'codex-package_SHA256SUMS')
    .map((asset: { name: string }) => `${digest}  ${asset.name}\n`)
    .join('')
}

/** The primary and fallback origins are movable through the install ports. */
export const codexVendorFixture: VendorFixture = {
  async start() {
    const archive = codexTarFixture()
    const metadata = JSON.stringify(codexReleaseFixture(archive))
    const server = createServer((request, response) => {
      if (
        ['/codex/channels/latest', '/codex/releases/0.171.0/release.json'].includes(
          request.url ?? '',
        )
      )
        return response.end(metadata)
      if (request.url === '/codex/releases/0.171.0/codex-package_SHA256SUMS')
        return response.end(codexChecksumFixture(archive))
      if (request.url === '/codex/releases/0.171.0/codex-package-x86_64-unknown-linux-musl.tar.gz')
        return response.end(archive)
      response.writeHead(404)
      response.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return {
      origins: {
        'https://releases.openai.com/codex': `${origin}/codex`,
        'https://api.github.com/repos/openai/codex/releases': `${origin}/github-api`,
        'https://github.com/openai/codex/releases/download': `${origin}/github-files`,
      },
      stop: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    }
  },
}
