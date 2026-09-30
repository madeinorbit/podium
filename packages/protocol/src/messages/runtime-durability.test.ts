import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { parseControlMessage } from '../daemon'
import {
  isDurableRuntimeEvent,
  RuntimeEventMessage,
  SessionSnapshot,
  RuntimeDurableSendRequestMessage,
  RuntimeSendRequestMessage,
  TurnReceipt,
  type RuntimeEventBody,
  type RuntimeEvent,
} from './runtime'

const at = '2026-09-18T12:00:00.000Z'

describe('program-held receipt evidence survives the wire', () => {
  it.each(['memory', 'durable'] as const)('preserves a %s hold on an accepted receipt', (held) => {
    const receipt = {
      outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready',
      provenBy: 'protocol-ack', held, at,
    }
    expect(TurnReceipt.parse(receipt)).toEqual(receipt)
  })

  it('preserves the explicit request rejection cause', () => {
    const receipt = {
      outcome: 'refused',
      refusal: { reason: 'invalid_value', detail: 'HTTP 400', cause: 'rejected-by-agent' },
    }
    expect(TurnReceipt.parse(receipt)).toEqual(receipt)
  })

  it('keeps a refusal when a newer peer sends an unknown cause', () => {
    expect(TurnReceipt.parse({
      outcome: 'refused',
      refusal: { reason: 'invalid_value', cause: 'newer-rejection-cause' },
    })).toEqual({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
  })
})
const bodies = {
  metadata: { t: 'metadata', change: { kind: 'context', source: 'transcript', percent: 42 } },
  binding: { t: 'binding', resume: { kind: 'codex-thread', value: 'native' }, confidence: 'exact', bindingVersion: 1, ackRequested: true },
  delivery: { t: 'delivery', rowId: 'row', outcome: 'delivered' },
  state: { t: 'state', change: { kind: 'activity' } },
  item: { t: 'item', item: { kind: 'complete', item: { id: 'item', role: 'system', text: 'Interrupted', ts: at } } },
  interaction: { t: 'interaction', ev: { ev: 'expired', id: 'ask', at } },
  turn: { t: 'turn', ev: { ev: 'started', turnEpoch: 1, origin: 'human' } },
  process: { t: 'process', ev: { ev: 'exited', code: 0, signal: null, classification: 'clean' } },
  workspace: { t: 'workspace', ev: { ev: 'cwd-changed', cwd: '/repo' } },
  'open-url': { t: 'open-url', ev: { url: 'https://example.com/login', intent: 'login' } },
  draft: { t: 'draft', text: 'latest draft' },
  'transcript-reset': { t: 'transcript-reset', items: [] },
} satisfies Record<RuntimeEventBody['t'], RuntimeEventBody>

function event(body: RuntimeEventBody, provenance: RuntimeEvent['provenance'] = 'live'): RuntimeEvent {
  return {
    ...body, at, provenance, observerGeneration: 2, turnEpoch: 1,
    cursor: { segmentId: 'segment', components: { seq: 1 } },
  }
}

describe('runtime event retention contract', () => {
  it.each(['metadata', 'binding', 'delivery', 'item', 'transcript-reset', 'interaction', 'turn', 'process', 'open-url'] as const)(
    'retains %s because loss is not repaired by the next observation', (kind) => {
      expect(isDurableRuntimeEvent(event(bodies[kind]))).toBe(true)
    },
  )

  it('retains git-activity because commits are additive, not superseded', () => {
    const git = event({ t: 'workspace', ev: { ev: 'git-activity', commits: ['sha'], touchedFiles: [] } })
    expect(isDurableRuntimeEvent(git)).toBe(true)
  })

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

describe('delivery failure cause (POD-4802)', () => {
  const frame = (ev: RuntimeEventBody) => ({
    type: 'runtimeEvent',
    deliveryId: 'delivery-row',
    sessionId: asSessionId('session'),
    event: event(ev),
  })

  it('parses a failed delivery carrying the unconfirmed cause', () => {
    const parsed = RuntimeEventMessage.parse(
      frame({
        t: 'delivery',
        rowId: 'row',
        outcome: 'failed',
        reason: 'delivery could not be confirmed; check the transcript before retrying',
        cause: 'unconfirmed',
      }),
    )
    expect(parsed.event).toMatchObject({
      t: 'delivery',
      rowId: 'row',
      outcome: 'failed',
      cause: 'unconfirmed',
    })
  })

  it('still parses a failed delivery without a cause (older daemon)', () => {
    // The cause is optional, so frames from daemons that predate it keep the
    // previous visible-failure behaviour.
    const parsed = RuntimeEventMessage.parse(
      frame({
        t: 'delivery',
        rowId: 'row',
        outcome: 'failed',
        reason: 'delivery could not be confirmed; check the transcript before retrying',
      }),
    )
    expect(parsed.event).toMatchObject({ t: 'delivery', outcome: 'failed' })
    expect((parsed.event as { cause?: unknown }).cause).toBeUndefined()
  })
})


describe('a send from an older server that still marks coalescable', () => {
  // The routine-mail digest is gone (operator decision, POD-4720); a server
  // that predates the removal still sets the flag. The daemon must accept the
  // frame and deliver the row as its own prompt, so the key is stripped.
  const send = { type: 'runtimeSendRequest', requestId: 'rpc', sessionId: 'session',
    turnId: 'row', rowId: 'row', text: 'routine ack', origin: 'mail', delivery: 'when-ready',
    coalescable: true }

  it('parses and drops the flag, on the frame schema and on the control plane', () => {
    const parsed = RuntimeSendRequestMessage.parse(send)
    expect(parsed).not.toHaveProperty('coalescable')
    expect(parsed).toMatchObject({ turnId: 'row', rowId: 'row', text: 'routine ack' })
    const control = parseControlMessage(JSON.stringify(send))
    expect(control).toMatchObject({ type: 'runtimeSendRequest', turnId: 'row' })
    expect(control).not.toHaveProperty('coalescable')
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


it('preserves title and causal metadata through the snapshot wire schema', () => {
  const metadata = event(bodies.metadata)
  const snapshot = {
    binding: { sessionId: 'session', harness: 'claude-code', driver: 'terminal-claude', family: 'terminal', workdir: '/repo', resume: null,
      bindingVersion: 1, process: { key: 'process' } },
    state: {}, cursor: metadata.cursor, observerGeneration: 2, turnEpoch: 1,
    interactions: [], title: 'Native title', metadata: [metadata], at,
  }
  expect(SessionSnapshot.parse(snapshot)).toMatchObject({ title: 'Native title', metadata: [metadata] })
})

describe('the entry a delivered row became (POD-4774)', () => {
  it('carries transcriptItem on a delivered outcome through the wire schema', () => {
    const named = event({
      t: 'delivery',
      rowId: 'msg_row',
      outcome: 'delivered',
      transcriptItem: { id: 'entry', cursor: 'cur' },
    })
    expect(
      RuntimeEventMessage.parse({ type: 'runtimeEvent', sessionId: 'session', event: named }),
    ).toMatchObject({ event: { transcriptItem: { id: 'entry', cursor: 'cur' } } })
  })

  it('refuses an empty entry id rather than carrying a nameless entry', () => {
    const nameless = event({
      t: 'delivery',
      rowId: 'msg_row',
      outcome: 'delivered',
      transcriptItem: { id: '' },
    })
    expect(
      RuntimeEventMessage.safeParse({ type: 'runtimeEvent', sessionId: 'session', event: nameless })
        .success,
    ).toBe(false)
  })
})

describe("the agent program's own ids for a message (POD-4841)", () => {
  const harnessRef = [
    { kind: 'codex-turn', id: 'turn-1' },
    { kind: 'codex-client-message', id: 'msg_row' },
  ]
  const frame = (body: RuntimeEventBody) =>
    RuntimeEventMessage.safeParse({ type: 'runtimeEvent', sessionId: 'session', event: event(body) })

  it('carries harnessRef on a delivery outcome through the wire schema, on any outcome', () => {
    for (const outcome of ['delivered', 'failed'] as const) {
      const parsed = frame({ t: 'delivery', rowId: 'msg_row', outcome, harnessRef })
      expect(parsed.success).toBe(true)
      expect(parsed.data).toMatchObject({ event: { harnessRef } })
    }
  })

  it('keeps a kind this build does not know', () => {
    const parsed = frame({
      t: 'delivery',
      rowId: 'msg_row',
      outcome: 'delivered',
      harnessRef: [{ kind: 'kind-from-a-newer-daemon', id: 'x' }],
    })
    expect(parsed.data).toMatchObject({
      event: { harnessRef: [{ kind: 'kind-from-a-newer-daemon', id: 'x' }] },
    })
  })

  it('drops a malformed harnessRef and keeps the outcome: the ids never cost a delivery', () => {
    const parsed = frame({
      t: 'delivery',
      rowId: 'msg_row',
      outcome: 'delivered',
      transcriptItem: { id: 'entry' },
      harnessRef: [{ kind: 'codex-turn', id: '' }],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.event).toMatchObject({ outcome: 'delivered', transcriptItem: { id: 'entry' } })
    expect((parsed.data?.event as { harnessRef?: unknown }).harnessRef).toBeUndefined()
  })

  it('carries harnessRef on an accepted receipt', () => {
    const receipt = TurnReceipt.parse({
      outcome: 'accepted',
      turnEpoch: 1,
      deliveredAs: 'when-ready',
      provenBy: 'protocol-ack',
      harnessRef,
      at,
    })
    expect(receipt).toMatchObject({ harnessRef })
  })
})
