import { describe, expect, it, vi } from 'vitest'
import { toBootstrapChunk, toDeltaFrame } from './frames'
import { FeedSink } from './sink'

function setup(posture = 'cold') {
  const replica = {
    posture,
    cursor: { feedId: 'f', epoch: 'e', seq: 2 },
    connect: vi.fn(),
    transportDisconnected: vi.fn(),
    requestRebootstrap: vi.fn(),
    receive: vi.fn(),
  }
  return { replica, sink: new FeedSink({ replica: replica as never }) }
}
describe('HTTP feed sink lifecycle', () => {
  it('starts the kernel ladder on connection and leaves an active HTTP bootstrap alone', () => {
    const { replica, sink } = setup()
    sink.connected()
    expect(replica.connect).toHaveBeenCalledOnce()
    replica.posture = 'bootstrapping'
    sink.connected()
    expect(replica.connect).toHaveBeenCalledOnce()
    expect(sink.syncHttp).toBe(true)
  })
  it('hands transport loss and HTTP rebootstrap to the kernel', () => {
    const { replica, sink } = setup()
    sink.disconnected()
    sink.requestRebootstrap()
    expect(replica.transportDisconnected).toHaveBeenCalledOnce()
    expect(replica.requestRebootstrap).toHaveBeenCalledOnce()
  })
  it('presents the committed cursor and observes resume without applying another world', () => {
    const { replica, sink } = setup('stale')
    expect(sink.helloFields()).toEqual({ feedCursor: replica.cursor })
    sink.frame({ type: 'feedResume', feedId: 'f', epoch: 'e', seq: 2 })
    expect(replica.receive).not.toHaveBeenCalled()
    expect(new FeedSink({ replica: { cursor: null } as never }).helloFields()).toBeNull()
  })
  it('maps live deltas and resync refusals to kernel inputs', () => {
    const { replica, sink } = setup('live')
    sink.frame({
      type: 'feedDelta',
      feedId: 'f',
      epoch: 'e',
      fromSeq: 2,
      seq: 3,
      minAvailableSeq: 0,
      changes: [],
    })
    expect(replica.receive).toHaveBeenLastCalledWith({
      kind: 'delta',
      feedId: 'f',
      epoch: 'e',
      fromSeq: 2,
      seq: 3,
      minAvailableSeq: 0,
      changes: [],
    })
    sink.frame({
      type: 'feedResyncRequired',
      feedId: 'f',
      epoch: 'e',
      cause: 'authority-shed-load',
      reason: 'cursor-rejected',
    })
    expect(replica.receive).toHaveBeenCalledTimes(2)
  })
})

describe('provenance on frame rows', () => {
  const provenance = { originId: 'peer-1', causationId: 'mut-1', mutationId: 'mut-1' }
  const range = { feedId: 'f', epoch: 'e', fromSeq: 2, seq: 4, minAvailableSeq: 0 }
  it('toDeltaFrame puts provenance on the envelope', () => {
    const frame = toDeltaFrame({
      type: 'feedDelta',
      ...range,
      changes: [
        {
          seq: 3,
          entity: 'repo',
          entityId: 'r1',
          op: 'upsert',
          value: { id: 'r1' },
          ...provenance,
        },
        { seq: 4, entity: 'repo', entityId: 'r2', op: 'remove', mutationId: 'mut-2' },
      ] as never,
    })
    expect(frame.changes).toEqual([
      {
        seq: 3,
        entity: 'repo',
        entityId: 'r1',
        op: 'upsert',
        payload: { id: 'r1' },
        ...provenance,
      },
      { seq: 4, entity: 'repo', entityId: 'r2', op: 'remove', mutationId: 'mut-2' },
    ])
  })
  it('omits absent provenance keys from the envelope', () => {
    const frame = toDeltaFrame({
      type: 'feedDelta',
      ...range,
      changes: [{ seq: 3, entity: 'repo', entityId: 'r1', op: 'evict' }] as never,
    })
    expect(Object.keys(frame.changes[0] ?? {})).toEqual(['seq', 'entity', 'entityId', 'op'])
  })
  it('keeps bootstrap rows provenance-free, because the install cursor covers them', () => {
    const chunk = toBootstrapChunk({
      type: 'feedBootstrap',
      ...range,
      fromSeq: 0,
      last: true,
      changes: [
        {
          seq: 3,
          entity: 'repo',
          entityId: 'r1',
          op: 'upsert',
          value: { id: 'r1' },
          ...provenance,
        },
      ] as never,
    })
    expect(chunk.changes).toEqual([
      { seq: 3, entity: 'repo', entityId: 'r1', op: 'upsert', payload: { id: 'r1' } },
    ])
  })
})
