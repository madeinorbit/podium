import { describe, expect, it, vi } from 'vitest'
import { BulkPlanePort } from './bulk-port'
import type { PlaneTarget } from './control-port'
import {
  asCapabilityRef,
  asDeviceId,
  asUserId,
  type Principal,
  type VisibilityResolver,
} from './principal'
import { asSubscriberId, type EntityRef } from './routing'

const target: PlaneTarget = {
  subscriberId: asSubscriberId('conn'),
  principal: {
    kind: 'user',
    user: asUserId('alice'),
    device: asDeviceId('d'),
    capability: asCapabilityRef('cap'),
  } satisfies Principal,
}

const resource: EntityRef = { kind: 'transcript', id: 's1' }

const setup = (visibility: VisibilityResolver = { canSee: () => true }) => {
  const read = vi.fn(async (r: EntityRef, page: { offset: number; limit: number }) => ({
    resource: r,
    offset: page.offset,
    bytes: 'x'.repeat(page.limit),
    eof: false,
  }))
  const port = new BulkPlanePort<string>({ visibility, read, maxChunkBytes: 1024 })
  return { port, read }
}

describe('the bulk port is paged, lazy and point-to-point', () => {
  it('declares bulk · bulk and offers no fan-out affordance', () => {
    const { port } = setup()
    expect([...port.planeClasses]).toEqual(['bulk.bulk'])
    // A standing paged channel is never fanned out or oplog-replayed, so the port
    // deliberately has no publish/subscribe surface at all.
    expect('publish' in port).toBe(false)
    expect('subscribe' in port).toBe(false)
  })

  it('serves a page for a principal that may see the resource', async () => {
    const { port, read } = setup()
    const chunk = await port.read(target, resource, { offset: 0, limit: 16 })
    expect(chunk?.offset).toBe(0)
    expect(chunk?.bytes).toHaveLength(16)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('refuses an unreadable resource with a bare null and never calls the reader', async () => {
    const { port, read } = setup({ canSee: () => false })
    expect(await port.read(target, resource, { offset: 0, limit: 16 })).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('bounds the page: a request over the chunk cap is refused, not truncated', async () => {
    const { port, read } = setup()
    expect(await port.read(target, resource, { offset: 0, limit: 4096 })).toBeNull()
    expect(await port.read(target, resource, { offset: 0, limit: 0 })).toBeNull()
    expect(await port.read(target, resource, { offset: -1, limit: 16 })).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
