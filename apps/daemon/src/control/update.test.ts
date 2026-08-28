import { describe, expect, it } from 'vitest'
import { probeDevArtifact } from './update'

describe('development artifact reachability probe', () => {
  it('uses one bodyless request against the exact signed URL', async () => {
    const calls: { input: string; method?: string }[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), method: init?.method })
      return new Response(null, { status: 200 })
    }) as typeof fetch
    const url = 'http://source:18787/updates/dev-bundle/dev%2Babc1234?token=signed-route-token'

    await expect(probeDevArtifact(url, fetchImpl)).resolves.toEqual({ ok: true, status: 200 })
    expect(calls).toEqual([{ input: url, method: 'HEAD' }])
  })

  it('reports the consumer-side connection failure', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Unable to connect')
    }) as typeof fetch

    await expect(
      probeDevArtifact(
        'http://source:18787/updates/dev-bundle/dev%2Babc1234?token=token',
        fetchImpl,
      ),
    ).resolves.toEqual({ ok: false, detail: 'Unable to connect' })
  })

  it('treats an HTTP refusal as a failed proof', async () => {
    const fetchImpl = (async () => new Response(null, { status: 401 })) as typeof fetch
    await expect(probeDevArtifact('http://source:18787/artifact', fetchImpl)).resolves.toEqual({
      ok: false,
      status: 401,
      detail: 'artifact route answered HTTP 401',
    })
  })
})
