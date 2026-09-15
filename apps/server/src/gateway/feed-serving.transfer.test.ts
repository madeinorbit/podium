/**
 * THE SNAPSHOT-TO-LIVE HANDOFF WHEN THE BOOTSTRAP IS LAZY (POD-3931).
 *
 * `serveWorld` used to publish every chunk synchronously and connect the
 * publisher afterwards. Now the chunks are pulled by the peer's sender as its
 * socket drains, which can take minutes on a phone — and any change committed
 * in those minutes must reach the client AFTER the last chunk, chained onto the
 * position the chunks describe. These cases drive a real `FeedServing` with a
 * peer whose sender is under the test's control: nothing is pulled until the
 * test says so, so commits can be placed exactly inside the transfer window.
 */

import type { ServerMessage } from '@podium/protocol'
import { WIRE_VERSION } from '@podium/protocol'
import { DEVICE_GRADE_PRINCIPAL } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { FEED_BOOTSTRAP_CHUNK_ROWS } from './feed-serving'
import { feedTestPlumbing } from './feed-test-plumbing'
import type { SendOutcome, SendSequenceSource } from './ordered-client-send'
import type { EdgePeer } from './wire-feed-edge'

/** A peer whose lazy sink is pulled by hand. Later `send`s wait behind it. */
class LazyPeer implements EdgePeer {
  readonly received: ServerMessage[] = []
  readonly terminate = vi.fn()
  private readonly behind: ServerMessage[] = []
  private source: SendSequenceSource<ServerMessage> | undefined
  private settle: ((outcome: SendOutcome) => void) | undefined
  constructor(
    readonly id: string,
    readonly wireVersion = WIRE_VERSION,
    readonly acceptsDelta = true,
  ) {}
  send(message: ServerMessage): void {
    if (this.source) this.behind.push(message)
    else this.received.push(message)
  }
  sendSequence(source: SendSequenceSource<ServerMessage>): Promise<SendOutcome> {
    this.source = source
    return new Promise((resolve) => {
      this.settle = resolve
    })
  }
  transferring(): boolean {
    return this.source !== undefined
  }
  /** Pull one message; false when the sequence is exhausted (and settled). */
  pull(): boolean {
    const source = this.source
    if (!source) throw new Error('nothing is being transferred')
    const message = source.next()
    if (message !== undefined) {
      this.received.push(message)
      return true
    }
    this.source = undefined
    this.received.push(...this.behind.splice(0))
    this.settle?.({ ok: true })
    return false
  }
  types(): string[] {
    return this.received.map((m) => m.type)
  }
}

class EagerPeer implements EdgePeer {
  readonly received: ServerMessage[] = []
  constructor(
    readonly id: string,
    readonly wireVersion = WIRE_VERSION,
    readonly acceptsDelta = true,
  ) {}
  send(message: ServerMessage): void {
    this.received.push(message)
  }
}

const commit = (
  plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>,
  id: string,
  value: unknown,
) =>
  plumbing.ledger.commit({
    write: async () => {},
    changes: () => [{ entity: 'session', id, op: 'upsert', value }],
  })

async function publishPending(
  plumbing: Awaited<ReturnType<typeof feedTestPlumbing>>,
  fromSeq: number,
): Promise<number> {
  const delivery = await plumbing.authority.changesSince(fromSeq, DEVICE_GRADE_PRINCIPAL)
  if (delivery === null) throw new Error('the log could not serve from that cursor')
  await plumbing.serving.publish(DEVICE_GRADE_PRINCIPAL, delivery)
  return delivery.throughSeq
}

const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 1))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('a lazy bootstrap keeps bootstrap-before-delta and the cursor chain', () => {
  it('a commit inside the transfer window arrives after the last chunk, from the snapshot seq', async () => {
    const p = await feedTestPlumbing()
    const rows = FEED_BOOTSTRAP_CHUNK_ROWS * 2 + 1
    for (let i = 0; i < rows; i++) await commit(p, `s${i}`, { sessionId: `s${i}` })
    const snapshotSeq = await p.authority.cursor()

    const peer = new LazyPeer('phone')
    expect(p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))).toBeNull()
    await until(() => peer.transferring(), 'the transfer to start')
    // The position is installed BEFORE anything is pulled: the connection is
    // already framing from `snapshotSeq`.
    expect(p.serving.connectionCount()).toBe(1)

    expect(peer.pull()).toBe(true)
    // A change lands while the phone is still receiving chunk 1 of 3.
    await commit(p, 'late', { sessionId: 'late' })
    const liveSeq = await publishPending(p, snapshotSeq)
    expect(liveSeq).toBe(snapshotSeq + 1)
    // An eager peer on the same principal was told about it immediately.
    const other = new EagerPeer('desk')
    p.serving.attach(other, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(other.id))
    // Nothing reached the phone's socket past the chunks it has pulled.
    expect(peer.types()).toEqual(['feedBootstrap'])

    while (peer.pull());
    await p.serving.admissionSettled()

    const types = peer.types()
    expect(types).toEqual(['feedBootstrap', 'feedBootstrap', 'feedBootstrap', 'feedDelta'])
    const chunks = peer.received.slice(0, 3) as Array<{ seq: number; last: boolean; changes: unknown[] }>
    expect(chunks.map((c) => c.seq)).toEqual([snapshotSeq, snapshotSeq, snapshotSeq])
    expect(chunks.map((c) => c.last)).toEqual([false, false, true])
    expect(chunks.reduce((n, c) => n + c.changes.length, 0)).toBe(rows)
    const delta = peer.received[3] as { fromSeq: number; seq: number; changes: Array<{ entityId: string }> }
    expect(delta.fromSeq).toBe(snapshotSeq)
    expect(delta.seq).toBe(liveSeq)
    expect(delta.changes.map((c) => c.entityId)).toEqual(['late'])
    expect(peer.terminate).not.toHaveBeenCalled()
    // The desk peer's own world already includes the late row at the new head.
    await p.serving.admissionSettled()
    const deskWorld = other.received.filter((m) => m.type === 'feedBootstrap') as Array<{
      seq: number
      changes: unknown[]
    }>
    expect(deskWorld.map((c) => c.seq)).toEqual(deskWorld.map(() => liveSeq))
    expect(deskWorld.reduce((n, c) => n + c.changes.length, 0)).toBe(rows + 1)
  })

  it('a peer that detaches mid-transfer is dropped without a second admission racing it', async () => {
    const p = await feedTestPlumbing()
    for (let i = 0; i < 5; i++) await commit(p, `s${i}`, { sessionId: `s${i}` })
    const peer = new LazyPeer('phone')
    p.serving.attach(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))
    await until(() => peer.transferring(), 'the transfer to start')
    // A second `hello` inside the window must not start a second world.
    expect(p.serving.renegotiate(peer, DEVICE_GRADE_PRINCIPAL, p.routingPrincipal(peer.id))).toBeNull()
    p.serving.detach(peer.id)
    expect(p.serving.connectionCount()).toBe(0)
    while (peer.pull());
    await p.serving.admissionSettled()
    expect(peer.types()).toEqual(['feedBootstrap'])
    expect(peer.terminate).not.toHaveBeenCalled()
  })
})
