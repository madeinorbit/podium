/** HTTP-only admission over the real Authority, ledger and publisher. */
import type { ServerMessage } from '@podium/protocol'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { feedTestPlumbing } from './feed-test-plumbing'
import type { EdgePeer } from './wire-feed-edge'

class Peer implements EdgePeer {
  readonly received: ServerMessage[] = []
  readonly terminate = vi.fn()
  constructor(
    readonly id: string,
    readonly wireVersion: number,
    readonly acceptsDelta = false,
  ) {}
  send(message: ServerMessage): void {
    this.received.push(message)
  }
  types(): string[] {
    return this.received.map((m) => m.type)
  }
  last(type: string): ServerMessage | undefined {
    return [...this.received].reverse().find((m) => m.type === type)
  }
}

/** One committed entity row. The ONLY way anything enters this harness. */
const commit = (
  plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>,
  entity: 'session' | 'issue' | 'conversation' | 'automation' | 'automationRun',
  id: string,
  value: unknown,
) =>
  plumbing.ledger.commit({
    write: async () => {},
    changes: () => [{ entity, id, op: 'upsert', value }],
  })

/** Publish whatever the Authority has appended, exactly as the funnel does. */
async function publishPending(plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>, fromSeq: number): Promise<number> {
  const delivery = await plumbing.authority.changesSince(fromSeq, DEVICE_GRADE_PRINCIPAL)
  if (delivery === null) throw new Error('the log could not serve from that cursor')
  await plumbing.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
  return delivery.throughSeq
}


describe('HTTP-only feed admission', () => {
  it('grants a populated cold peer the head without reading or pushing a world', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const bootstrap = vi.spyOn(p.authority, 'bootstrap')
    const peer = new Peer('cold', WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    expect(peer.types()).toEqual(['feedResume'])
    expect(peer.last('feedResume')).toMatchObject({ seq: 1 })
    expect(bootstrap).not.toHaveBeenCalled()
    expect(p.serving.connectionCount()).toBe(1)
  })

  it('frames live changes contiguously from the granted head', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('live', WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    await commit(p, 'session', 's2', { sessionId: 's2' })
    await publishPending(p, 1)
    expect(peer.last('feedDelta')).toMatchObject({ fromSeq: 1, seq: 2,
      changes: [{ entityId: 's2', op: 'upsert' }] })
    expect(peer.types()).not.toContain('feedBootstrap')
  })

  it('refuses peers outside the shared wire window without serving anything', async () => {
    const p = await feedTestPlumbing()
    for (const version of [MIN_SUPPORTED_VERSION - 1, WIRE_VERSION + 1]) {
      const peer = new Peer(`bad-${version}`, version)
      expect(p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))?.status).toBe(426)
      await p.serving.admissionSettled()
      expect(peer.received).toEqual([])
    }
  })

  it('coalesces repeated admission while a cursor read is pending', async () => {
    const p = await feedTestPlumbing()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const read = p.authority.cursor.bind(p.authority)
    const cursor = vi.spyOn(p.authority, 'cursor').mockImplementationOnce(async () => {
      await pending
      return read()
    })
    const peer = new Peer('duplicate', WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await vi.waitFor(() => expect(cursor).toHaveBeenCalled())
    p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    release()
    await p.serving.admissionSettled()
    expect(peer.types()).toEqual(['feedResume'])
    expect(p.serving.connectionCount()).toBe(1)
  })

  it('does not revive a peer detached while its admission read was pending', async () => {
    const p = await feedTestPlumbing()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const read = p.authority.cursor.bind(p.authority)
    const cursor = vi.spyOn(p.authority, 'cursor').mockImplementationOnce(async () => {
      await pending
      return read()
    })
    const peer = new Peer('gone', WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await vi.waitFor(() => expect(cursor).toHaveBeenCalled())
    p.serving.detach(peer.id)
    release()
    await p.serving.admissionSettled()
    expect(peer.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })

  it.each(['attach', 'renegotiate'] as const)('terminates a failed %s admission and releases the slot', async entry => {
    const p = await feedTestPlumbing()
    vi.spyOn(p.authority, 'cursor').mockRejectedValueOnce(new Error('cursor read failed'))
    const peer = new Peer(entry, WIRE_VERSION, true)
    p.serving[entry](peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    expect(peer.terminate).toHaveBeenCalledOnce()
    expect(peer.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })

  it('detached peers receive no subsequent publications', async () => {
    const p = await feedTestPlumbing()
    const peer = new Peer('detached', WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    p.serving.detach(peer.id)
    await commit(p, 'issue', 'i1', { id: 'i1' })
    await publishPending(p, 0)
    expect(peer.types()).toEqual(['feedResume'])
    expect(p.serving.connectionCount()).toBe(0)
  })
})
