import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  classifyDaemonLink,
  type DaemonLinkFacts,
  type DaemonLinkKind,
  DaemonLinks,
  daemonLinkFactsOf,
  IN_PROCESS_DAEMON_LINK,
} from './daemon-link-kind'

/** A plain request from another computer on the local network, no proxy. */
const base: DaemonLinkFacts & { trustedNetworks: readonly string[] } = {
  url: 'http://podium.example:18787/daemon',
  hasProxyHeaders: false,
  clientAddress: '192.168.1.20',
  trustedProxyHops: 0,
  trustedNetworks: [],
}

describe('classifyDaemonLink', () => {
  it.each<[string, Partial<typeof base>, DaemonLinkKind]>([
    ['an https request', { url: 'https://podium.example/daemon' }, 'encrypted'],
    [
      'x-forwarded-proto https behind one trusted proxy hop',
      {
        forwardedProto: 'https',
        hasProxyHeaders: true,
        clientAddress: '203.0.113.9',
        trustedProxyHops: 1,
      },
      'encrypted',
    ],
    [
      'x-forwarded-proto https with zero trusted hops',
      { forwardedProto: 'https', hasProxyHeaders: true, clientAddress: '203.0.113.9' },
      'plain',
    ],
    [
      'a proxy chain whose trusted hop saw http',
      {
        forwardedProto: 'https, http',
        hasProxyHeaders: true,
        clientAddress: '203.0.113.9',
        trustedProxyHops: 1,
      },
      'plain',
    ],
    ['an empty forwarded proto with one hop', { forwardedProto: '', trustedProxyHops: 1 }, 'plain'],
    ['a loopback client with no proxy header', { clientAddress: '127.0.0.1' }, 'local'],
    ['an IPv6 loopback client with no proxy header', { clientAddress: '::1' }, 'local'],
    [
      'a loopback peer with a proxy header and zero trusted hops',
      { clientAddress: '127.0.0.1', hasProxyHeaders: true, forwardedProto: 'https' },
      'plain',
    ],
    ['an IPv4 address inside a trusted range', { trustedNetworks: ['192.168.1.0/24'] }, 'trusted'],
    [
      'an IPv4-mapped address inside an IPv4 trusted range',
      { clientAddress: '::ffff:192.168.1.20', trustedNetworks: ['192.168.1.0/24'] },
      'trusted',
    ],
    [
      'an IPv6 address inside a trusted range',
      { clientAddress: 'fd7a:115c:a1e0::5', trustedNetworks: ['fd7a:115c:a1e0::/48'] },
      'trusted',
    ],
    [
      'an address outside every trusted range',
      { clientAddress: '10.9.9.9', trustedNetworks: ['192.168.1.0/24', 'fd00::/8'] },
      'plain',
    ],
    [
      'a direct loopback peer behind a loopback bind (one trusted hop), no proxy header',
      {
        url: 'http://127.0.0.1:18787/daemon',
        clientAddress: undefined,
        peerAddress: '127.0.0.1',
        trustedProxyHops: 1,
      },
      'local',
    ],
    [
      'a direct IPv6 loopback peer behind a loopback bind, no proxy header',
      {
        url: 'http://[::1]:18787/daemon',
        clientAddress: undefined,
        peerAddress: '::1',
        trustedProxyHops: 1,
      },
      'local',
    ],
    [
      'a direct loopback peer behind a loopback bind that dialed localhost',
      {
        url: 'http://localhost:18787/daemon',
        clientAddress: undefined,
        peerAddress: '127.0.0.1',
        trustedProxyHops: 1,
      },
      'local',
    ],
    // POD-7041: a proxy on this computer that forwards a remote daemon over
    // http and adds no X-Forwarded-* header connects from loopback, but keeps
    // the public Host it was reached on.
    [
      'a loopback peer with no proxy header behind a trusted hop, addressed to a public name',
      { clientAddress: undefined, peerAddress: '127.0.0.1', trustedProxyHops: 1 },
      'plain',
    ],
    [
      'an IPv6 loopback peer with no proxy header behind a trusted hop, addressed to a LAN address',
      {
        url: 'http://192.168.1.5:18787/daemon',
        clientAddress: undefined,
        peerAddress: '::1',
        trustedProxyHops: 1,
      },
      'plain',
    ],
    [
      'a loopback peer behind two trusted hops, addressed to a public name',
      { clientAddress: undefined, peerAddress: '127.0.0.1', trustedProxyHops: 2 },
      'plain',
    ],
    [
      'a loopback peer with no proxy header and zero trusted hops, addressed to a public name',
      { clientAddress: '127.0.0.1', peerAddress: '127.0.0.1', trustedProxyHops: 0 },
      'local',
    ],
    [
      'a remote client a same-computer proxy spoke for over http',
      {
        clientAddress: '203.0.113.9',
        peerAddress: '127.0.0.1',
        hasProxyHeaders: true,
        trustedProxyHops: 1,
      },
      'plain',
    ],
    [
      'a direct peer from another computer behind a loopback bind',
      { clientAddress: undefined, peerAddress: '192.168.1.20', trustedProxyHops: 1 },
      'plain',
    ],
    [
      'no client address at all',
      { clientAddress: undefined, trustedNetworks: ['0.0.0.0/0'] },
      'plain',
    ],
    ['anything else', {}, 'plain'],
  ])('%s', (_name, change, expected) => {
    expect(classifyDaemonLink({ ...base, ...change })).toBe(expected)
  })
})

describe('daemonLinkFactsOf', () => {
  it('reads the peer when no proxy is trusted, and notices any proxy header', () => {
    const request = new Request('http://podium.example:18787/daemon', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    })
    expect(daemonLinkFactsOf(request, '127.0.0.1', 0)).toEqual({
      url: 'http://podium.example:18787/daemon',
      hasProxyHeaders: true,
      clientAddress: '127.0.0.1',
      peerAddress: '127.0.0.1',
      trustedProxyHops: 0,
    })
  })

  it('reads the client from the trusted hop of x-forwarded-for', () => {
    const request = new Request('http://127.0.0.1:18787/daemon', {
      headers: { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' },
    })
    expect(daemonLinkFactsOf(request, '127.0.0.1', 1)).toEqual({
      url: 'http://127.0.0.1:18787/daemon',
      forwardedProto: 'https',
      hasProxyHeaders: true,
      clientAddress: '198.51.100.7',
      peerAddress: '127.0.0.1',
      trustedProxyHops: 1,
    })
  })

  it('keeps the direct peer when the trusted hop sent no header', () => {
    const request = new Request('http://127.0.0.1:18787/daemon')
    expect(daemonLinkFactsOf(request, '127.0.0.1', 1)).toEqual({
      url: 'http://127.0.0.1:18787/daemon',
      hasProxyHeaders: false,
      clientAddress: undefined,
      peerAddress: '127.0.0.1',
      trustedProxyHops: 1,
    })
  })
})

/**
 * POD-6906 finding S1, inverted (POD-7041): a same-computer proxy serving
 * plain http to the network, forwarding `/daemon` without X-Forwarded-*
 * headers, to a loopback-bound server (one trusted hop by default).
 */
describe('a same-computer proxy that forwards no X-Forwarded-* header', () => {
  const judge = (url: string, peer: string, hops: number) =>
    classifyDaemonLink({
      ...daemonLinkFactsOf(new Request(url), peer, hops),
      trustedNetworks: [],
    })

  it('reads plain when the request names a public host', () => {
    expect(judge('http://podium.example/daemon', '127.0.0.1', 1)).toBe('plain')
  })

  it('reads local for a daemon that dialed the loopback-bound server directly', () => {
    expect(judge('http://127.0.0.1:18787/daemon', '127.0.0.1', 1)).toBe('local')
    expect(judge('http://localhost:18787/daemon', '::1', 1)).toBe('local')
  })

  it('reads local with zero trusted hops, as before', () => {
    expect(judge('http://podium.example/daemon', '127.0.0.1', 0)).toBe('local')
  })
})

describe('DaemonLinks', () => {
  const m1 = asMachineId('m-one')
  const m2 = asMachineId('m-two')

  function links(initial: readonly string[] = []) {
    let trusted = initial
    let reads = 0
    const changed: string[] = []
    const registry = new DaemonLinks({
      trustedNetworks: async () => {
        reads++
        return trusted
      },
      kindChanged: (machineId) => changed.push(machineId),
    })
    return {
      registry,
      changed,
      reads: () => reads,
      trust: (next: readonly string[]) => (trusted = next),
    }
  }

  it("reads the server's own in-process daemon link as local, whatever is trusted", async () => {
    const { registry, reads } = links()
    registry.connected(m1, IN_PROCESS_DAEMON_LINK, {})
    expect(await registry.daemonLinkKind(m1)).toBe('local')
    expect(reads()).toBe(0)
  })

  it('is undefined for a machine with no connected daemon', async () => {
    expect(await links().registry.daemonLinkKind(m1)).toBeUndefined()
  })

  it('reads the trusted networks at each judgement, and only when they decide it', async () => {
    const { registry, reads, trust } = links()
    registry.connected(m1, base, {})
    registry.connected(m2, { ...base, url: 'https://podium.example/daemon' }, {})
    expect(await registry.daemonLinkKind(m1)).toBe('plain')
    trust(['192.168.1.0/24'])
    expect(await registry.daemonLinkKind(m1)).toBe('trusted')
    expect(reads()).toBe(2)
    expect(await registry.daemonLinkKind(m2)).toBe('encrypted')
    expect(reads()).toBe(2)
  })

  it('tells about the machines whose kind the trusted networks decide', () => {
    const { registry, changed } = links()
    registry.connected(m1, base, {})
    registry.connected(m2, { ...base, url: 'https://podium.example/daemon' }, {})
    registry.settingsChanged()
    expect(changed).toEqual([m1])
  })

  it('judges again a socket that replaced the judged one during the read', async () => {
    let release!: () => void
    const registry = new DaemonLinks({
      trustedNetworks: () =>
        new Promise((resolve) => {
          release = () => resolve(['192.168.1.0/24'])
        }),
      kindChanged: () => {},
    })
    registry.connected(m1, base, {})
    const kind = registry.daemonLinkKind(m1)
    registry.connected(m1, { ...base, url: 'https://podium.example/daemon' }, {})
    release()
    expect(await kind).toBe('encrypted')
  })

  it('forgets a link only for the socket that recorded it', async () => {
    const { registry } = links()
    const old = {}
    const current = {}
    registry.connected(m1, base, old)
    registry.connected(m1, base, current)
    expect(registry.disconnected(m1, old)).toBe(false)
    expect(await registry.daemonLinkKind(m1)).toBe('plain')
    expect(registry.disconnected(m1, current)).toBe(true)
    expect(await registry.daemonLinkKind(m1)).toBeUndefined()
  })
})
