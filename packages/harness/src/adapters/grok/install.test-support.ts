/** Grok's recorded stable pointer (2026-11-20, POD-7267) and a stand-in download. */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { VendorFixture } from '../../inventory/managed-install.test-support.js'

export const GROK_STABLE_RESPONSE = readFileSync(
  new URL('./fixtures/stable.txt', import.meta.url),
  'utf8',
)

export const grokVendorFixture: VendorFixture = {
  async start() {
    const server = createServer((request, response) => {
      if (request.url === '/stable') return response.end(GROK_STABLE_RESPONSE)
      if (request.url === `/grok-${GROK_STABLE_RESPONSE.trim()}-linux-x86_64`) {
        return response.end(`#!/bin/sh\necho "grok ${GROK_STABLE_RESPONSE.trim()}"\n`)
      }
      response.writeHead(404)
      response.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      origins: { 'https://x.ai/cli': `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
      stop: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    }
  },
}
