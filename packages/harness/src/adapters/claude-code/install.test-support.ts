/** Claude's recorded stable response and manifest (2026-11-20, POD-7267). */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { VendorFixture } from '../../inventory/managed-install.test-support.js'

export const CLAUDE_STABLE_RESPONSE = readFileSync(
  new URL('./fixtures/stable.txt', import.meta.url),
  'utf8',
)
export const CLAUDE_MANIFEST_RESPONSE = readFileSync(
  new URL('./fixtures/manifest.json', import.meta.url),
  'utf8',
)

export const CLAUDE_FIXTURE_BINARY = `#!/bin/sh\necho "${CLAUDE_STABLE_RESPONSE.trim()} (Claude Code)"\n`

/** Same vendor layout, with checksums and sizes for the executable stand-in. */
export function claudeManifestFixture() {
  const recorded = JSON.parse(CLAUDE_MANIFEST_RESPONSE) as {
    version: string
    buildDate: string
    platforms: Record<string, { binary: string; checksum: string; size: number }>
  }
  const checksum = createHash('sha256').update(CLAUDE_FIXTURE_BINARY).digest('hex')
  return {
    ...recorded,
    platforms: Object.fromEntries(
      Object.entries(recorded.platforms).map(([platform, entry]) => [
        platform,
        { ...entry, checksum, size: Buffer.byteLength(CLAUDE_FIXTURE_BINARY) },
      ]),
    ),
  }
}

export const claudeVendorFixture: VendorFixture = {
  async start() {
    const manifest = claudeManifestFixture()
    const base = `/${manifest.version}`
    const server = createServer((request, response) => {
      if (request.url === '/stable') return response.end(CLAUDE_STABLE_RESPONSE)
      if (request.url === `${base}/manifest.json`) return response.end(JSON.stringify(manifest))
      if (request.url === `${base}/linux-x64/claude`) return response.end(CLAUDE_FIXTURE_BINARY)
      response.writeHead(404)
      response.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      origins: {
        'https://downloads.claude.ai/claude-code-releases': `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
      stop: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    }
  },
}
