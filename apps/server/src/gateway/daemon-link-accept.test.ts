/**
 * A DAEMON'S LINK, JUDGED AT ACCEPT (credential management §8).
 *
 * Through the gateway's own upgrade and socket handlers (`attachWebSockets`)
 * with a real registry: the upgrade request's facts are recorded with the
 * socket, the hello establishes the machine, and the registry answers
 * `daemonLinkKind`. The peer address is the one thing the test supplies, as
 * Bun's `requestIP` does in production.
 */

import { createHash } from 'node:crypto'
import { asMachineId, firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../relay'
import { resolveTrustedProxyHops } from '../server'
import { openTestStore } from '../test-support/open-test-store'
import { bindToRegistry } from '../test-support/ws-binding'
import { daemonLinkFactsOf } from './daemon-link-kind'
import { attachWebSockets } from './ws-server'

const SILENT_TIMERS = { setInterval: () => 0, clearInterval: () => {} }
const MACHINE = asMachineId('m-link-6922')
const TOKEN = 'tok-link-6922'
/** Another computer on the local network, as the server sees it. */
const PEER = '192.168.7.20'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const reg of registries.splice(0)) await reg.dispose()
})

async function setup(link: { peer: string; hops: number } = { peer: PEER, hops: 0 }) {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'box',
    hostname: 'box',
    tokenHash: sha256(TOKEN),
    ownerUserId: firstAdminMemberId(),
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const handle = attachWebSockets(
    reg,
    { bindWorkspace: bindToRegistry(reg) },
    {
      timers: SILENT_TIMERS,
      daemonLink: (request) => daemonLinkFactsOf(request, link.peer, link.hops),
    },
  )
  return { reg, handle }
}

type Handle = Awaited<ReturnType<typeof setup>>['handle']

/** Upgrade one daemon socket and send its hello; resolves once it is established. */
async function connect(
  handle: Handle,
  init: { url?: string; headers?: Record<string, string>; hello?: Record<string, unknown> } = {},
) {
  let data: unknown
  const server = {
    port: 0,
    stop() {},
    upgrade: (_request: Request, options: { data: unknown }) => {
      data = options.data
      return true
    },
  }
  const refused = await handle.handleRequest(
    new Request(init.url ?? 'http://podium.example:18787/daemon', { headers: init.headers ?? {} }),
    server as never,
  )
  expect(refused).toBeUndefined()
  const sent: string[] = []
  const native = {
    data,
    readyState: 1,
    sendText: (frame: string) => {
      sent.push(frame)
      return frame.length
    },
    sendBinary: () => 1,
    getBufferedAmount: () => 0,
    ping: () => {},
    terminate: vi.fn(),
  }
  const ws = handle.websocket as unknown as {
    open(n: unknown): void
    message(n: unknown, frame: string): void
    close(n: unknown, code: number, reason: string): void
  }
  ws.open(native)
  ws.message(
    native,
    JSON.stringify({
      type: 'hello',
      machineId: MACHINE,
      token: TOKEN,
      hostname: 'box',
      ...init.hello,
    }),
  )
  await vi.waitFor(() => expect(sent.some((frame) => frame.includes('helloOk'))).toBe(true))
  return { close: () => ws.close(native, 1000, '') }
}

describe('the link a daemon is judged on', () => {
  it('a daemon that claims an encrypted connection over a plain one reads plain', async () => {
    const { reg, handle } = await setup()
    await connect(handle, {
      // Its own proxy headers, saying https: zero trusted hops, so not read.
      headers: { 'x-forwarded-proto': 'https', forwarded: 'proto=https' },
      // And its own say-so in the hello: no field of the hello is read.
      hello: { linkKind: 'encrypted', secure: true, encrypted: true, protocol: 'wss:' },
    })
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
  })

  it("trusting the daemon's network makes it trusted without a reconnect, and removing it makes it plain", async () => {
    const { reg, handle } = await setup()
    await connect(handle)
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
    const publish = vi.spyOn(reg.topics, 'publish')
    const admin = firstAdminMemberId()

    await reg.modules.settings.updatePreferences(admin, {
      'daemonLink.trustedNetworks': ['192.168.7.0/24'],
    })
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('trusted')
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        'machine.condition',
        MACHINE,
        expect.objectContaining({ online: true, linkKind: 'trusted' }),
      ),
    )

    publish.mockClear()
    await reg.modules.settings.updatePreferences(admin, { 'daemonLink.trustedNetworks': [] })
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(
        'machine.condition',
        MACHINE,
        expect.objectContaining({ linkKind: 'plain' }),
      ),
    )
  })

  /**
   * THE SAME-COMPUTER DAEMON OF AN ALL-IN-ONE INSTALL (found driving POD-6897).
   * A server bound to loopback trusts one proxy hop by default, so the client
   * is read from `x-forwarded-for`; its own daemon dials loopback directly and
   * sends none. It was judged plain, and every vault credential was refused.
   */
  it('a daemon dialing a loopback-bound server directly reads local', async () => {
    const hops = resolveTrustedProxyHops(undefined, {}, '127.0.0.1')
    expect(hops).toBe(1)
    const { reg, handle } = await setup({ peer: '127.0.0.1', hops })
    await connect(handle, { url: 'http://127.0.0.1:18787/daemon' })
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('local')
  })

  /**
   * POD-7041: a proxy on the server's computer that serves plain http to the
   * network and forwards `/daemon` without any X-Forwarded-* header. It
   * connects from loopback like the server's own daemon, but the request still
   * names the public host it was reached on.
   */
  it('a remote daemon a same-computer proxy forwards with no forwarding headers reads plain', async () => {
    const hops = resolveTrustedProxyHops(undefined, {}, '127.0.0.1')
    const { reg, handle } = await setup({ peer: '127.0.0.1', hops })
    await connect(handle, { url: 'http://podium.example/daemon' })
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
  })

  it('a remote daemon a same-computer proxy forwards over http stays plain', async () => {
    const hops = resolveTrustedProxyHops(undefined, {}, '127.0.0.1')
    const { reg, handle } = await setup({ peer: '127.0.0.1', hops })
    await connect(handle, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
  })

  it("a stale socket's close leaves the newer connection's link", async () => {
    const { reg, handle } = await setup()
    const first = await connect(handle)
    const second = await connect(handle)
    first.close()
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBe('plain')
    second.close()
    expect(await reg.daemonLinks.daemonLinkKind(MACHINE)).toBeUndefined()
  })
})
