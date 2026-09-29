/**
 * The control socket, end to end in one process: a real user-only unix socket,
 * the real config write, and the real Connect publisher. What is asserted is
 * what Connect is TOLD — config holding the URL is necessary but not the point.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolvePublicUrl, saveConfig } from '@podium/runtime/config'
import type { InstallationIdentity } from '@podium/runtime/installation-identity'
import { applyPublicUrl } from '@podium/runtime/setup'
import { listenUserSocket, type UserSocketServer } from '@podium/runtime/user-socket'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_BODY_MAX_BYTES, controlSocketHandler } from './control-socket'
import type { CheckResult, ConnectClient, LocatorRecord } from './modules/connect/client'
import { ConnectPublisher, TICK_MS } from './modules/connect/publisher'

const A = 'https://prairie-otter-lamp-nine.trycloudflare.com'
const B = 'https://copper-hill-mango-seven.trycloudflare.com'

const identity: InstallationIdentity = {
  version: 1,
  installationId: `pdm_${'a'.repeat(43)}`,
  privateKey: 'x',
  publicKey: 'y',
  generation: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
}

function send(
  socketPath: string,
  opts: { method?: string; path?: string; body?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path: opts.path ?? '/v1/public-url', method: opts.method ?? 'POST' },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text) as Record<string, unknown>,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('server control socket', () => {
  const priorStateDir = process.env.PODIUM_STATE_DIR
  let dir: string
  let socket: UserSocketServer
  let published: string[]
  let publisherTimers: { fn: () => void; ms: number }[]
  let publisher: ConnectPublisher
  let socketPath: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-control-'))
    process.env.PODIUM_STATE_DIR = dir
    published = []
    publisherTimers = []
    const client: ConnectClient = {
      register: async () => ({ ok: true }),
      publish: async (record: LocatorRecord) => {
        published.push(record.endpoints[0]!.url)
        return { ok: true }
      },
      clear: async () => ({ ok: true }),
      check: async (url): Promise<CheckResult> => ({ ok: true, url, resolvedTo: [] }),
      resolve: async () => undefined,
    }
    publisher = new ConnectPublisher({
      client,
      identity: () => identity,
      // The reader server.ts hands the publisher: env, then config.json.
      publicUrl: () => resolvePublicUrl(loadConfig(), {}),
      enabled: () => true,
      log: { info: () => {}, warn: () => {} },
      // Collected, never fired: nothing below waits for the 5-minute tick.
      setTimer: (fn, ms) => {
        const t = { fn, ms }
        publisherTimers.push(t)
        return t
      },
      clearTimer: (h) => {
        const i = publisherTimers.indexOf(h as { fn: () => void; ms: number })
        if (i >= 0) publisherTimers.splice(i, 1)
      },
    })
    // The same composition server.ts does.
    socketPath = join(dir, 'run', 'control.sock')
    socket = await listenUserSocket(
      socketPath,
      controlSocketHandler({
        setPublicUrl: (url, opts) => {
          const result = applyPublicUrl(url, opts)
          if (result.ok && result.changed) publisher.publicUrlChanged()
          return result
        },
      }),
      'server control socket',
    )
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    publisher.stop()
    await socket.close()
    process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('a rotated URL posted on the socket is published to Connect at once, not on the tick', async () => {
    saveConfig({ mode: 'all-in-one', networkOption: 'cloudflare-tunnel' })
    publisher.start()
    await publisher.settled
    expect(published).toEqual([])
    expect(publisherTimers.map((t) => t.ms)).toEqual([TICK_MS])

    expect(await send(socketPath, { body: JSON.stringify({ url: A }) })).toEqual({
      status: 200,
      json: { ok: true, publicUrl: A, changed: true },
    })
    await publisher.settled
    expect(published).toEqual([A])

    // The tunnel restarts with a new URL.
    const rotated = await send(socketPath, {
      body: JSON.stringify({ url: B, confirmUrlChange: true }),
    })
    expect(rotated).toEqual({ status: 200, json: { ok: true, publicUrl: B, changed: true } })
    await publisher.settled
    expect(loadConfig().publicUrl).toBe(B)
    expect(published).toEqual([A, B])
    expect(publisher.state).toBe('published')
  })

  it('the same URL again writes nothing and publishes nothing', async () => {
    saveConfig({ mode: 'all-in-one', publicUrl: A })
    publisher.start()
    await publisher.settled
    expect(published).toEqual([A])
    const again = await send(socketPath, {
      body: JSON.stringify({ url: A, confirmUrlChange: true }),
    })
    expect(again).toEqual({ status: 200, json: { ok: true, publicUrl: A, changed: false } })
    await publisher.settled
    expect(published).toEqual([A])
  })

  it('409 without confirmation over a different live URL, and nothing changes', async () => {
    saveConfig({ mode: 'all-in-one', publicUrl: A })
    const refused = await send(socketPath, { body: JSON.stringify({ url: B }) })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ ok: false, error: expect.stringContaining('already set') })
    expect(loadConfig().publicUrl).toBe(A)
  })

  it('409 when PODIUM_PUBLIC_URL owns the URL', async () => {
    saveConfig({ mode: 'all-in-one', publicUrl: A })
    vi.stubEnv('PODIUM_PUBLIC_URL', 'https://podium.example.com')
    const refused = await send(socketPath, {
      body: JSON.stringify({ url: B, confirmUrlChange: true }),
    })
    expect(refused.status).toBe(409)
    expect(refused.json.error).toContain('PODIUM_PUBLIC_URL')
    expect(loadConfig().publicUrl).toBe(A)
  })

  it('400 for a body that is not JSON or not a URL; 404 elsewhere; 413 when oversized', async () => {
    saveConfig({ mode: 'server' })
    expect((await send(socketPath, { body: 'nope' })).status).toBe(400)
    expect((await send(socketPath, { body: JSON.stringify({ href: A }) })).status).toBe(400)
    expect((await send(socketPath, { body: JSON.stringify({ url: 'not a url' }) })).status).toBe(
      400,
    )
    expect((await send(socketPath, { method: 'GET' })).status).toBe(404)
    expect((await send(socketPath, { path: '/v1/other', body: '{}' })).status).toBe(404)
    const huge = JSON.stringify({ url: A, pad: 'x'.repeat(CONTROL_BODY_MAX_BYTES) })
    expect((await send(socketPath, { body: huge })).status).toBe(413)
    expect(loadConfig().publicUrl).toBeUndefined()
  })
})
