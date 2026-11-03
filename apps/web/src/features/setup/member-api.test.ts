import { SERVER_UNAVAILABLE_MESSAGE } from '@podium/client-core/replica-assembly/server-calls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memberRequest } from './member-api'

afterEach(() => vi.unstubAllGlobals())

describe('memberRequest', () => {
  it('says the server is unreachable when the connection fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')))
    await expect(memberRequest('https://relay.test', 'list')).rejects.toThrow(
      SERVER_UNAVAILABLE_MESSAGE,
    )
  })

  it("says the server is unreachable when WebKit cannot parse a stopped server's proxy page", async () => {
    const response = new Response('<html>502 Bad Gateway</html>', { status: 502 })
    Object.defineProperty(response, 'json', {
      value: async () => {
        throw new DOMException('The string did not match the expected pattern.', 'SyntaxError')
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(memberRequest('https://relay.test', 'list')).rejects.toThrow(
      SERVER_UNAVAILABLE_MESSAGE,
    )
  })

  it("passes on the server's own refusal", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"Invite expired"}', { status: 410 })),
    )
    await expect(memberRequest('https://relay.test', 'accept', {})).rejects.toThrow(
      'Invite expired',
    )
  })
})
