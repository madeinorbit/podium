/** HTTP-only admission over the real Authority, ledger and publisher. */

import type { ServerMessage } from '@podium/protocol'
import { CLIENT_WIRE_VERSION, MIN_CLIENT_WIRE_VERSION } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL, type ScopedChange } from '@podium/sync'
import { testLedgerWriter } from '@podium/sync/testing'
import { describe, expect, it, vi } from 'vitest'
import { toFeedChange } from './feed-serving'
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
  entity: 'session' | 'issueProjection' | 'conversation' | 'automation' | 'automationRun',
  id: string,
  value: unknown,
) =>
  testLedgerWriter(plumbing.ledger).commit({
    write: async () => {},
    changes: () => [{ entity, id, op: 'upsert', value }],
  })

/** Publish whatever the Authority has appended, exactly as the funnel does. */
async function publishPending(
  plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>,
  fromSeq: number,
): Promise<number> {
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
    const peer = new Peer('cold', CLIENT_WIRE_VERSION, true)
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
    const peer = new Peer('live', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    await commit(p, 'session', 's2', { sessionId: 's2' })
    await publishPending(p, 1)
    expect(peer.last('feedDelta')).toMatchObject({
      fromSeq: 1,
      seq: 2,
      changes: [{ entityId: 's2', op: 'upsert' }],
    })
    expect(peer.types()).not.toContain('feedBootstrap')
  })

  it('refuses peers outside the shared wire window without serving anything', async () => {
    const p = await feedTestPlumbing()
    for (const version of [MIN_CLIENT_WIRE_VERSION - 1, CLIENT_WIRE_VERSION + 1]) {
      const peer = new Peer(`bad-${version}`, version)
      expect(
        p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))?.status,
      ).toBe(426)
      await p.serving.admissionSettled()
      expect(peer.received).toEqual([])
    }
  })

  it('coalesces repeated admission while a cursor read is pending', async () => {
    const p = await feedTestPlumbing()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = p.authority.cursor.bind(p.authority)
    const cursor = vi.spyOn(p.authority, 'cursor').mockImplementationOnce(async () => {
      await pending
      return read()
    })
    const peer = new Peer('duplicate', CLIENT_WIRE_VERSION, true)
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
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = p.authority.cursor.bind(p.authority)
    const cursor = vi.spyOn(p.authority, 'cursor').mockImplementationOnce(async () => {
      await pending
      return read()
    })
    const peer = new Peer('gone', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await vi.waitFor(() => expect(cursor).toHaveBeenCalled())
    p.serving.detach(peer.id)
    release()
    await p.serving.admissionSettled()
    expect(peer.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })

  it.each([
    'attach',
    'renegotiate',
  ] as const)('terminates a failed %s admission and releases the slot', async (entry) => {
    const p = await feedTestPlumbing()
    vi.spyOn(p.authority, 'cursor').mockRejectedValueOnce(new Error('cursor read failed'))
    const peer = new Peer(entry, CLIENT_WIRE_VERSION, true)
    p.serving[entry](peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    expect(peer.terminate).toHaveBeenCalledOnce()
    expect(peer.received).toEqual([])
    expect(p.serving.connectionCount()).toBe(0)
  })

  it('detached peers receive no subsequent publications', async () => {
    const p = await feedTestPlumbing()
    const peer = new Peer('detached', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    p.serving.detach(peer.id)
    await commit(p, 'issueProjection', 'i1', { id: 'i1' })
    await publishPending(p, 0)
    expect(peer.types()).toEqual(['feedResume'])
    expect(p.serving.connectionCount()).toBe(0)
  })
})

describe('a publication that fails or is asked for from a closed transaction (POD-6779)', () => {
  const deltaIds = (peer: Peer): string[] =>
    peer.received.flatMap((message) =>
      message.type === 'feedDelta' ? message.changes.map((change) => change.entityId) : [],
    )

  it('publishes at the root when the write that asked for it has already closed', async () => {
    const p = await feedTestPlumbing()
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('live', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    await commit(p, 'session', 's2', { sessionId: 's2' })
    const delivery = await p.authority.changesSince(1, DEVICE_GRADE_PRINCIPAL)
    if (delivery === null) throw new Error('the log could not serve from that cursor')
    let close!: () => void
    const closed = new Promise<void>((resolve) => {
      close = resolve
    })
    let leaked: Promise<void> = Promise.resolve()
    // The continuation is created inside the write, so it carries the write's
    // scope, and it runs only once that write is over.
    await p.store.transact(async () => {
      leaked = closed.then(() => p.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery))
    })
    close()
    await leaked
    // Delivered by this call, not later by recovery.
    expect(peer.last('feedDelta')).toMatchObject({
      fromSeq: 1,
      seq: 2,
      changes: [{ entityId: 's2', op: 'upsert' }],
    })
  })

  it('delivers the rows of a failed publication before the next range', async () => {
    let fail = false
    const p = await feedTestPlumbing({
      retention: {
        minAvailableSeq: async () => {
          if (fail) {
            fail = false
            throw new Error('retention read refused')
          }
          return 1
        },
      },
    })
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('live', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    // The commit publishes by itself; that publication is the one that fails.
    fail = true
    await commit(p, 'session', 's2', { sessionId: 's2' })
    await vi.waitFor(() => expect(fail).toBe(false))
    expect(deltaIds(peer)).toEqual([])
    await commit(p, 'session', 's3', { sessionId: 's3' })
    // The range the client is certified through contains both rows, in order.
    await vi.waitFor(() => expect(deltaIds(peer)).toEqual(['s2', 's3']), { timeout: 2_000 })
    expect(peer.last('feedDelta')).toMatchObject({ seq: 3 })
  })

  it('republishes owed rows by itself when nothing newer follows', async () => {
    let fail = false
    const p = await feedTestPlumbing({
      retention: {
        minAvailableSeq: async () => {
          if (fail) {
            fail = false
            throw new Error('retention read refused')
          }
          return 1
        },
      },
    })
    await commit(p, 'session', 's1', { sessionId: 's1' })
    const peer = new Peer('live', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    fail = true
    await commit(p, 'session', 's2', { sessionId: 's2' })
    await vi.waitFor(() => expect(fail).toBe(false))
    expect(deltaIds(peer)).toEqual([])
    await vi.waitFor(() => expect(deltaIds(peer)).toEqual(['s2']), { timeout: 2_000 })
  })
})

describe('provenance on v2 rows', () => {
  const provenance = { originId: 'peer-1', causationId: 'mut-1', mutationId: 'mut-1' }
  // Built directly, as the Authority hands them over, so this suite does not
  // depend on how the change log stamps provenance.
  const caused = {
    seq: 1,
    entity: 'session',
    entityId: 's1',
    op: 'upsert',
    value: { sessionId: 's1' },
    ...provenance,
  } as unknown as ScopedChange
  const uncaused = {
    seq: 2,
    entity: 'session',
    entityId: 's2',
    op: 'remove',
  } as unknown as ScopedChange

  it('toFeedChange/toWireFrame carry provenance and omit absent keys', async () => {
    expect(toFeedChange(caused)).toEqual({
      seq: 1,
      entity: 'session',
      entityId: 's1',
      op: 'upsert',
      value: { sessionId: 's1' },
      ...provenance,
    })
    expect(Object.keys(toFeedChange(uncaused))).toEqual(['seq', 'entity', 'entityId', 'op'])

    const p = await feedTestPlumbing()
    const peer = new Peer('live', CLIENT_WIRE_VERSION, true)
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await p.serving.admissionSettled()
    await p.serving.publish(DEVICE_GRADE_PRINCIPAL, {
      kind: 'batch',
      throughSeq: 2,
      changes: [caused, uncaused],
    })
    const frame = peer.last('feedDelta') as { changes: Record<string, unknown>[] } | undefined
    expect(frame?.changes).toEqual([
      {
        seq: 1,
        entity: 'session',
        entityId: 's1',
        op: 'upsert',
        value: { sessionId: 's1' },
        ...provenance,
      },
      { seq: 2, entity: 'session', entityId: 's2', op: 'remove' },
    ])
    expect(Object.keys(frame?.changes[1] ?? {})).toEqual(['seq', 'entity', 'entityId', 'op'])
  })
})
