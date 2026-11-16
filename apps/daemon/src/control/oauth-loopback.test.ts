/**
 * The loopback listener (credential management §11; epic Task 14, acceptance 4):
 * it relays the callback's query fields once and nothing else, and closes.
 */

import { createServer } from 'node:net'
import { OauthLoopbackCallbackMessage } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { cancelOauthLoopback, closeOauthLoopbacks, startOauthLoopback } from './oauth-loopback'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const request = (port: number, ttlMs = 60_000) => ({
  type: 'oauthLoopbackRequest' as const,
  requestId: `ol-${port}`,
  port,
  path: '/auth/callback' as const,
  state: 'FAKE-state',
  ttlMs,
})

afterEach(() => closeOauthLoopbacks())

describe('oauth loopback listener', () => {
  it('binds 127.0.0.1, relays only the return with the attempt’s state, once, and closes', async () => {
    const port = await freePort()
    const sent: DaemonMessage[] = []
    await startOauthLoopback(request(port), (m) => sent.push(m))
    expect(sent).toEqual([
      { type: 'oauthLoopbackResult', requestId: `ol-${port}`, listening: true },
    ])

    expect((await fetch(`http://127.0.0.1:${port}/other?state=FAKE-state`)).status).toBe(404)
    // Another attempt's state: refused, and the listener keeps waiting.
    expect(
      (await fetch(`http://127.0.0.1:${port}/auth/callback?code=FAKE-other&state=FAKE-other-state`))
        .status,
    ).toBe(404)
    expect(sent).toHaveLength(1)
    const res = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=FAKE-code&state=FAKE-state&client_id=oaiapp_FAKE&scope=openid&access_token=FAKE-should-not-pass`,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/Return to Podium/)
    const callback = sent[1]
    expect(callback).toEqual({
      type: 'oauthLoopbackCallback',
      requestId: `ol-${port}`,
      code: 'FAKE-code',
      state: 'FAKE-state',
      clientId: 'oaiapp_FAKE',
      scope: 'openid',
    })
    expect(OauthLoopbackCallbackMessage.safeParse(callback).success).toBe(true)
    expect(JSON.stringify(sent)).not.toContain('FAKE-should-not-pass')

    // Closed after the one relayed return.
    await expect(fetch(`http://127.0.0.1:${port}/auth/callback?state=FAKE-state`)).rejects.toThrow()
    expect(sent).toHaveLength(2)
  })

  it('does not listen on any address but 127.0.0.1', async () => {
    const port = await freePort()
    await startOauthLoopback(request(port), () => {})
    const { networkInterfaces } = await import('node:os')
    const other = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
    if (other) {
      await expect(
        fetch(`http://${other}:${port}/auth/callback?state=FAKE-state`),
      ).rejects.toThrow()
    }
    expect((await fetch(`http://127.0.0.1:${port}/x`)).status).toBe(404)
  })

  it('closes when the server cancels it', async () => {
    const port = await freePort()
    await startOauthLoopback(request(port), () => {})
    cancelOauthLoopback(`ol-${port}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(fetch(`http://127.0.0.1:${port}/auth/callback?state=FAKE-state`)).rejects.toThrow()
  })

  it('reports a port in use without listening', async () => {
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    const port = (holder.address() as { port: number }).port
    const sent: DaemonMessage[] = []
    await startOauthLoopback(request(port), (m) => sent.push(m))
    expect(sent).toEqual([
      expect.objectContaining({ type: 'oauthLoopbackResult', listening: false }),
    ])
    expect(JSON.stringify(sent)).toMatch(/in use/)
    await new Promise<void>((resolve) => holder.close(() => resolve()))
  })

  it('closes when its time is up', async () => {
    const port = await freePort()
    await startOauthLoopback(request(port, 50), () => {})
    await new Promise((resolve) => setTimeout(resolve, 150))
    await expect(fetch(`http://127.0.0.1:${port}/auth/callback?state=FAKE-state`)).rejects.toThrow()
  })
})
