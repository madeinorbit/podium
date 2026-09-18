import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  isDurableRuntimeEvent,
  RuntimeEventMessage,
  RuntimeDurableSendRequestMessage,
  RuntimeSendRequestMessage,
  type RuntimeEventBody,
  type RuntimeEvent,
} from './runtime'

const at = '2026-09-18T12:00:00.000Z'
const bodies = {
  delivery: { t: 'delivery', rowId: 'row', outcome: 'delivered' },
  state: { t: 'state', change: { kind: 'activity' } },
  item: { t: 'item', item: { kind: 'complete', item: { id: 'item', role: 'system', text: 'Interrupted', ts: at } } },
  interaction: { t: 'interaction', ev: { ev: 'expired', id: 'ask', at } },
  turn: { t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } },
  process: { t: 'process', ev: { ev: 'exited', code: 0, signal: null, classification: 'clean' } },
  workspace: { t: 'workspace', ev: { ev: 'cwd-changed', cwd: '/repo' } },
  'open-url': { t: 'open-url', ev: { url: 'https://example.com/login', intent: 'login' } },
  draft: { t: 'draft', text: 'latest draft' },
} satisfies Record<RuntimeEventBody['t'], RuntimeEventBody>

function event(body: RuntimeEventBody, provenance: RuntimeEvent['provenance'] = 'live'): RuntimeEvent {
  return {
    ...body, at, provenance, observerGeneration: 2, turnEpoch: 1,
    cursor: { segmentId: 'segment', components: { seq: 1 } },
  }
}

describe('runtime event retention contract', () => {
  it.each(['delivery', 'item', 'interaction', 'turn', 'process', 'open-url'] as const)(
    'retains %s because loss is not repaired by the next observation', (kind) => {
      expect(isDurableRuntimeEvent(event(bodies[kind]))).toBe(true)
    },
  )

  it.each(['state', 'workspace', 'draft'] as const)(
    'sends %s live without a delivery id, but retains its bootstrap', (kind) => {
      const live = event(bodies[kind])
      expect(isDurableRuntimeEvent(live)).toBe(false)
      const frame = { type: 'runtimeEvent', sessionId: asSessionId('session'), event: live }
      expect(RuntimeEventMessage.parse(frame)).toEqual(frame)
      expect(isDurableRuntimeEvent(event(bodies[kind], 'bootstrap'))).toBe(true)
    },
  )

  it.each(['live', 'bootstrap'] as const)('keeps fine fragments live-only for %s provenance', (provenance) => {
    expect(isDurableRuntimeEvent(event({ t: 'item', item: { kind: 'delta', itemId: 'item', textDelta: 'token' } }, provenance))).toBe(false)
    expect(isDurableRuntimeEvent(event({ t: 'item', item: { kind: 'partial', item: { id: 'tool', role: 'assistant', text: 'running', ts: at } } }, provenance))).toBe(false)
  })
})


describe('durable admission command', () => {
  it('requires migration discriminators and cannot parse as a legacy send', () => {
    const frame = { type: 'runtimeDurableSendRequest', requestId: 'rpc', sessionId: 'session',
      turnId: 'row', rowId: 'row', deliveryRecovery: true, initialPrompt: true,
      text: 'create once', origin: 'human', delivery: 'when-ready' }
    expect(RuntimeDurableSendRequestMessage.parse(frame)).toMatchObject(frame)
    expect(RuntimeSendRequestMessage.safeParse(frame).success).toBe(false)
    expect(RuntimeDurableSendRequestMessage.safeParse({ ...frame, deliveryRecovery: undefined }).success).toBe(false)
  })
})
