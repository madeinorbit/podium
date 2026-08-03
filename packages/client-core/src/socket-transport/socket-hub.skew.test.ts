/**
 * A DROPPED FRAME IS NOW OBSERVABLE (POD-1610).
 *
 * The incident's entire trace was one `console.warn` on a page nobody had a
 * console open on. The hub now keeps a tally and fans it out, so a UI can say
 * what the console said — and, crucially, keeps saying it, because the condition
 * does not heal.
 */

import { describe, expect, it, vi } from 'vitest'
import { SocketHub, type WebSocketLike, type WireSkew } from './socket-hub'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  raw(text: string): void {
    this.onmessage?.({ data: text })
  }
}

function setup() {
  const sock = new FakeSocket()
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => sock,
    // A feed sink makes this a v2 connection, which is where the frames land.
    feed: { connected: () => {}, disconnected: () => {}, frame: () => {} },
  })
  hub.connect()
  sock.open()
  return { sock, hub }
}

const bootstrap = (changes: unknown[]) =>
  JSON.stringify({
    type: 'feedBootstrap',
    feedId: 'feed-1',
    epoch: 'e1',
    fromSeq: 0,
    seq: 4,
    minAvailableSeq: 0,
    last: true,
    changes,
  })

describe('the hub records what it could not read', () => {
  it('starts with nothing to report', () => {
    const { hub } = setup()
    expect(hub.wireSkew()).toBeNull()
  })

  it('counts a quarantined row and tells subscribers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sock, hub } = setup()
    const seen: WireSkew[] = []
    hub.onWireSkew((skew) => seen.push(skew))
    sock.raw(
      bootstrap([
        { seq: 1, entity: 'session', entityId: 's1', op: 'remove' },
        { seq: 2, entity: 'issue', entityId: 'i1', op: 'upsert', value: { unreadable: true } },
      ]),
    )
    expect(hub.wireSkew()).toMatchObject({ quarantined: 1, refusedFrames: 0 })
    expect(seen).toHaveLength(1)
  })

  it('counts a REFUSED frame separately — the severe case', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sock, hub } = setup()
    sock.raw('{"type":"feedBootstrap","feedId":"f"}') // envelope itself fails
    expect(hub.wireSkew()).toMatchObject({ refusedFrames: 1, quarantined: 0 })
    // The parser's own words, kept for a bug report — not for the UI.
    expect(hub.wireSkew()?.firstError).toBeTypeOf('string')
    expect(hub.wireSkew()?.firstError?.length).toBeGreaterThan(0)
  })

  it('replays the tally to a subscriber that arrives afterwards', () => {
    // The banner mounts AFTER the bootstrap that failed. A subscription that only
    // saw future drops would show nothing on exactly the run that needed it.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sock, hub } = setup()
    sock.raw('not json at all')
    const seen: WireSkew[] = []
    hub.onWireSkew((skew) => seen.push(skew))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.refusedFrames).toBe(1)
  })

  it('CAN SAY NO: a frame it reads fully leaves the tally empty', () => {
    const { sock, hub } = setup()
    sock.raw(bootstrap([{ seq: 1, entity: 'session', entityId: 's1', op: 'remove' }]))
    expect(hub.wireSkew()).toBeNull()
  })

  it('does not report an unknown entity kind as a drop', () => {
    // Forward compatibility is not skew: a kind this build has no arm for is
    // ignored by design, and warning about it would fire on every additive
    // server release.
    const { sock, hub } = setup()
    sock.raw(bootstrap([{ seq: 1, entity: 'somethingNewer', entityId: 'x1', op: 'remove' }]))
    expect(hub.wireSkew()).toBeNull()
  })
})
