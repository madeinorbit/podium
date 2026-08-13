import type { BootstrapChunk } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import { PushedBootstrapSource } from './bootstrap-source'

const world: BootstrapChunk = {
  feedId: 'feed',
  epoch: 'epoch',
  snapshotSeq: 7,
  changes: [],
  last: true,
}

const firstChunk: BootstrapChunk = {
  ...world,
  snapshotSeq: 8,
  changes: [{ seq: 1, entity: 'session', entityId: 's1', op: 'upsert', payload: {} }],
  last: false,
}

const lastChunk: BootstrapChunk = {
  ...world,
  snapshotSeq: 8,
  changes: [{ seq: 2, entity: 'session', entityId: 's2', op: 'upsert', payload: {} }],
  last: true,
}

describe('PushedBootstrapSource socket bootstrap cadence', () => {
  it('waits for the mandatory world already in flight on a newly opened socket', async () => {
    let requests = 0
    const source = new PushedBootstrapSource({
      requestFreshWorld: () => {
        requests += 1
      },
    })

    source.expectWorld()
    const chunks = source.bootstrap()
    const pending = chunks.next()
    expect(requests).toBe(0)

    source.offer(world)
    await expect(pending).resolves.toEqual({ value: world, done: false })
    await expect(chunks.next()).resolves.toEqual({ value: undefined, done: true })
    expect(requests).toBe(0)
  })

  it('uses an expected world that arrived before a fallback walk began', async () => {
    let requests = 0
    const source = new PushedBootstrapSource({
      requestFreshWorld: () => {
        requests += 1
      },
    })

    source.expectWorld()
    source.offer(world)
    const received: BootstrapChunk[] = []
    for await (const chunk of source.bootstrap()) received.push(chunk)

    expect(received).toEqual([world])
    expect(requests).toBe(0)
  })

  it('still requests a replacement when no socket world is pending', async () => {
    let requests = 0
    const source = new PushedBootstrapSource({
      requestFreshWorld: () => {
        requests += 1
        source.offer(world)
      },
    })

    const received: BootstrapChunk[] = []
    for await (const chunk of source.bootstrap()) received.push(chunk)

    expect(received).toEqual([world])
    expect(requests).toBe(1)
  })

  it('retains queued chunks from one bootstrap stream in arrival order', async () => {
    const source = new PushedBootstrapSource({ requestFreshWorld: () => {} })
    source.expectWorld()
    source.offer(firstChunk)
    source.offer(lastChunk)

    const received: BootstrapChunk[] = []
    for await (const chunk of source.bootstrap()) received.push(chunk)

    expect(received).toEqual([firstChunk, lastChunk])
  })

  it('supersedes an older stream after a walk has started', async () => {
    const replacement = { ...world, feedId: 'replacement', snapshotSeq: 9 }
    const source = new PushedBootstrapSource({ requestFreshWorld: () => {} })
    source.expectWorld()
    const walk = source.bootstrap()
    const first = walk.next()
    source.offer(firstChunk)
    await expect(first).resolves.toEqual({ value: firstChunk, done: false })
    source.offer(replacement)

    await expect(walk.next()).resolves.toEqual({ value: replacement, done: false })
    await expect(walk.next()).resolves.toEqual({ value: undefined, done: true })
  })
})
