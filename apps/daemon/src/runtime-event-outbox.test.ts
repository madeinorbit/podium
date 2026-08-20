import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeEventOutbox } from './runtime-event-outbox'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('coarse runtime event outbox', () => {
  it('survives a daemon-store reopen and retires only the acknowledged delivery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-runtime-event-outbox-'))
    roots.push(dir)
    const first = createRuntimeEventOutbox(dir)
    first.enqueue({
      type: 'runtimeEvent',
      deliveryId: 'delivery-1',
      sessionId: 'session-1' as SessionId,
      event: {
        t: 'state',
        change: { kind: 'activity' },
        at: '2026-08-20T00:00:00.000Z',
        provenance: 'bootstrap',
        cursor: { segmentId: 'segment-1', components: { seq: 1 } },
        observerGeneration: 1,
        turnEpoch: 1,
      },
    })

    const reopened = createRuntimeEventOutbox(dir)
    expect(reopened.pending()).toHaveLength(1)
    expect(reopened.acknowledge('other-delivery')).toBe(false)
    expect(reopened.pending()).toHaveLength(1)
    expect(reopened.acknowledge('delivery-1')).toBe(true)
    expect(createRuntimeEventOutbox(dir).pending()).toEqual([])
  })
})
