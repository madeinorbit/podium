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
      { clientAddress: undefined, peerAddress: '127.0.0.1', trustedProxyHops: 1 },
      'local',
    ],
    [
      'a direct IPv6 loopback peer behind a loopback bind, no proxy header',
      { clientAddress: undefined, peerAddress: '::1', trustedProxyHops: 1 },
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

describe('DaemonLinks', () => {
  const m1 = asMachineId('m-one')
  const m2 = asMachineId('m-two')

  function links(initial: readonly string[] = []) {
    let trusted = initial
    const changed: string[] = []
    const registry = new DaemonLinks({
      trustedNetworks: () => trusted,
      kindChanged: (machineId) => changed.push(machineId),
    })
    return { registry, changed, trust: (next: readonly string[]) => (trusted = next) }
  }

  it("reads the server's own in-process daemon link as local, whatever is trusted", () => {
    const { registry } = links()
    registry.connected(m1, IN_PROCESS_DAEMON_LINK, {})
    expect(registry.daemonLinkKind(m1)).toBe('local')
  })

  it('is undefined for a machine with no connected daemon', () => {
    expect(links().registry.daemonLinkKind(m1)).toBeUndefined()
  })

  it('tells about a machine only when a settings change moved its kind', () => {
    const { registry, changed, trust } = links()
    registry.connected(m1, base, {})
    registry.connected(m2, { ...base, clientAddress: '10.9.9.9' }, {})
    registry.settingsChanged()
    expect(changed).toEqual([])
    trust(['192.168.1.0/24'])
    registry.settingsChanged()
    expect(changed).toEqual([m1])
    expect(registry.daemonLinkKind(m1)).toBe('trusted')
    expect(registry.daemonLinkKind(m2)).toBe('plain')
  })

  it('forgets a link only for the socket that recorded it', () => {
    const { registry } = links()
    const old = {}
    const current = {}
    registry.connected(m1, base, old)
    registry.connected(m1, base, current)
    expect(registry.disconnected(m1, old)).toBe(false)
    expect(registry.daemonLinkKind(m1)).toBe('plain')
    expect(registry.disconnected(m1, current)).toBe(true)
    expect(registry.daemonLinkKind(m1)).toBeUndefined()
  })
})
