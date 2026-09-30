/** OpenCode 1.18.33: a 204 precedes storage; only our stored text part proves receipt. */
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionHandle, RuntimeEvent, SessionSpec, TurnReceipt } from '../../host.js'
import { DeliveryUnprovenError } from '../../errors.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import evidence from './__fixtures__/receipt-proof-v1.json' with { type: 'json' }
import { deltaItemIdForPart } from './map.js'
import { OpencodeMessageWithParts } from './protocol.js'
import { createOpencodeRuntime } from './runtime.js'
import { makeOpencodeTestHost } from './test-support/host.js'

const spec: SessionSpec = {
  harness: 'opencode',
  selection: { auth: 'api-key', platform: 'linux', available: ['opencode-server'] },
  workdir: '/tmp/opencode-receipt-proof',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
}
const options = { origin: 'human', delivery: 'when-ready' } as const
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The real HTTP client sees a 204 while history and SSE advance independently. */
async function deferredPrompt(waitMs = 100) {
  let acknowledge!: () => void
  const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve })
  let history: ReturnType<typeof OpencodeMessageWithParts.parse>[] = []
  const host = makeOpencodeTestHost({
    wrapClient: (client) => ({
      ...client,
      messages: async () => history,
      async prompt(sessionId, body) {
        const result = await client.prompt(sessionId, body)
        acknowledge()
        return result
      },
    }),
  })
  // Keep no-proof cases short; the cold case uses the production-sized window.
  host.promptRecordTimeoutMs = waitMs
  const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
  const handle = await runtime.driver.create(spec)
  const server = host.serverFor(handle.binding.sessionId)!
  const sessionID = handle.binding.resume!.value
  const publish = (request: typeof evidence.scenarios.warm.request, withPart: boolean, emit = true) => {
    const text = request.parts[0]!
    const row = OpencodeMessageWithParts.parse({
      info: { id: request.messageID, sessionID, role: 'user', time: { created: 1 } },
      parts: withPart ? [{ ...text, sessionID, messageID: request.messageID }] : [],
    })
    history = [row]
    if (emit) {
      server.emit('message.updated', { sessionID, info: row.info })
      for (const part of row.parts) server.emit('message.part.updated', { sessionID, part })
    }
    return row
  }
  return { runtime, handle, server, sessionID, acknowledged, publish }
}

function collect(handle: AgentSessionHandle): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of handle.events('bootstrap')) events.push(event)
  })()
  return events
}

describe('v1 receipt proof from the measured storage boundary', () => {
  it.each(['warm', 'cold'] as const)('confirms the %s prompt only when its text part appears', async (name) => {
    const measured = evidence.scenarios[name]
    const w = await deferredPrompt(5000)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      let settled = false
      const sent = w.handle.send({ id: measured.request.messageID, text: measured.request.parts[0]!.text }, options)
      void sent.then(() => { settled = true })
      await w.acknowledged
      w.publish(measured.request, false)
      await pause(20)
      expect(settled, 'neither the 204 nor the text-less message row is receipt proof').toBe(false)
      timer = setTimeout(() => w.publish(measured.request, true), measured.part!.atMs - measured.replyMs)
      const receipt = await sent
      expect(receipt).toMatchObject({
        outcome: 'accepted',
        provenBy: 'transcript-echo',
        transcriptItem: { id: deltaItemIdForPart(w.sessionID, measured.request.parts[0]!.id) },
      })
      expect(receipt).not.toHaveProperty('held')
    } finally {
      clearTimeout(timer)
      w.runtime.dispose()
    }
  }, 10_000)

  it('finds the stored part through history when its SSE event was missed', async () => {
    const w = await deferredPrompt(1000)
    try {
      const measured = evidence.scenarios.warm
      const sent = w.handle.send({ id: measured.request.messageID, text: measured.request.parts[0]!.text }, options)
      await w.acknowledged
      w.publish(measured.request, true, false)
      expect(await sent).toMatchObject({ outcome: 'accepted', transcriptItem: { id: deltaItemIdForPart(w.sessionID, measured.request.parts[0]!.id) } })
    } finally { w.runtime.dispose() }
  })

  it.each([false, true])('never confirms a kill after 204, even with a text-less row: %s', async (rowSurvives) => {
    const measured = evidence.scenarios.killed
    expect(measured.status).toBe(204)
    expect(measured.part).toBeNull()
    const w = await deferredPrompt()
    try {
      const late = vi.fn()
      const events = collect(w.handle)
      const sent = w.handle.send({ id: measured.request.messageID, rowId: measured.request.messageID, text: measured.request.parts[0]!.text }, { ...options, onLateProof: late })
      expect(await sent).toMatchObject({ outcome: 'queued' })
      await w.acknowledged
      if (rowSurvives) w.publish(measured.request, false)
      await w.server.close()
      await expect.poll(() => events.filter((event) => event.t === 'delivery').length).toBe(1)
      expect(events.filter((event) => event.t === 'delivery')).toEqual([
        expect.objectContaining({ rowId: measured.request.messageID, outcome: 'failed', cause: 'unconfirmed' }),
      ])
      expect(late).not.toHaveBeenCalled()
    } finally { w.runtime.dispose() }
  })

  it('returns unverified without a held receipt and confirms a later part exactly once', async () => {
    const w = await deferredPrompt()
    try {
      const measured = evidence.scenarios.warm
      const late = vi.fn()
      const named = vi.fn()
      const sent = w.handle.send({ id: measured.request.messageID, text: measured.request.parts[0]!.text }, { ...options, onLateProof: late, onTranscriptItem: named })
      await w.acknowledged
      w.publish(measured.request, false)
      const receipt = await sent
      expect(receipt).toMatchObject({ outcome: 'unverified', verificationWindowMs: 100 })
      expect(receipt).not.toHaveProperty('held')
      w.server.goIdle(w.sessionID)
      w.publish(measured.request, true)
      await expect.poll(() => late.mock.calls.length).toBe(1)
      expect(late).toHaveBeenCalledWith({
        transcriptItem: { id: deltaItemIdForPart(w.sessionID, measured.request.parts[0]!.id), cursor: expect.any(Object) },
        harnessRef: [
          { kind: 'opencode-message', id: measured.request.messageID },
          { kind: 'opencode-part', id: measured.request.parts[0]!.id },
        ],
      })
      w.publish(measured.request, true)
      await pause(20)
      expect(late).toHaveBeenCalledTimes(1)
      expect(named).not.toHaveBeenCalled()
    } finally { w.runtime.dispose() }
  })

  it('keeps a stored prompt confirmed when a later model error fails the turn', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const events = collect(handle)
      await handle.send({ id: 'msg_model_error', rowId: 'msg_model_error', text: 'ERR400' }, options)
      await expect.poll(() => events.filter((event) => event.t === 'delivery').length).toBe(1)
      expect(events.filter((event) => event.t === 'delivery')[0]).toMatchObject({ outcome: 'delivered', transcriptItem: { id: expect.any(String) } })
      host.serverFor(handle.binding.sessionId)!.emit('session.error', { sessionID: handle.binding.resume!.value, error: { name: 'APIError', message: 'model HTTP 400' } })
      await expect.poll(() => events.some((event) => event.t === 'turn' && event.ev.ev === 'failed')).toBe(true)
      expect(events.filter((event) => event.t === 'delivery')).toHaveLength(1)
    } finally { runtime.dispose() }
  })

  it('moves a durable row forward through proveLate only after the stored part lands', async () => {
    const w = await deferredPrompt()
    try {
      const measured = evidence.scenarios.warm
      const events = collect(w.handle)
      await w.handle.send({ id: measured.request.messageID, rowId: measured.request.messageID, text: measured.request.parts[0]!.text }, options)
      await w.acknowledged
      w.publish(measured.request, false)
      await expect.poll(() => events.filter((event) => event.t === 'delivery').length).toBe(1)
      expect(events.filter((event) => event.t === 'delivery')[0]).toMatchObject({ outcome: 'failed', cause: 'unconfirmed' })
      w.server.goIdle(w.sessionID)
      w.publish(measured.request, true)
      await expect.poll(() => events.filter((event) => event.t === 'delivery').length).toBe(2)
      expect(events.filter((event) => event.t === 'delivery')[1]).toMatchObject({
        outcome: 'delivered',
        transcriptItem: { id: deltaItemIdForPart(w.sessionID, measured.request.parts[0]!.id) },
        harnessRef: [
          { kind: 'opencode-message', id: measured.request.messageID },
          { kind: 'opencode-part', id: measured.request.parts[0]!.id },
        ],
      })
    } finally { w.runtime.dispose() }
  })

  it('bounds the wait even when the post-send history read never answers', async () => {
    let reads = 0
    const host = makeOpencodeTestHost({
      wrapClient: (client) => ({ ...client, messages: async () => ++reads === 1 ? [] : new Promise(() => {}) }),
    })
    host.promptRecordTimeoutMs = 50
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const receipt = await handle.send({ id: 'msg_stalled_read', text: 'waiting' }, options)
      expect(receipt).toMatchObject({ outcome: 'unverified', verificationWindowMs: 50 })
      expect(reads).toBe(2)
    } finally { runtime.dispose() }
  })
})

describe('v1 recovery never changes the prompt identity or text', () => {
  it('refuses changed text under an already sent message id before another POST', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      await handle.send({ id: 'msg_repeat', text: 'original\n text' }, options)
      server.goIdle(sessionID)
      const receipt = await handle.send({ id: 'msg_repeat', text: 'original text' }, options)
      expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value', detail: expect.stringContaining('same text') } })
      expect(server.promptCount(sessionID)).toBe(1)
      expect(server.session(sessionID)!.messages[0]!.parts[0]!.text).toBe('original\n text')
    } finally { runtime.dispose() }
  })

  it('allows recovery after adoption only with the same message id, part id and text', async () => {
    const host = makeOpencodeTestHost({ adoptsLiveEndpoint: true })
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      await handle.send({ id: 'turn:recovery', text: 'same\n text' }, options)
      const first = server.lastPrompt(sessionID)!
      const firstPart = first.parts[0]!
      if (firstPart.type !== 'text') throw new Error('fixture prompt must carry a text part')
      server.goIdle(sessionID)
      const adopted = await runtime.driver.adopt(handle.binding)
      await expect(adopted.send({ id: 'turn:recovery', text: 'different', deliveryRecovery: true }, options)).resolves.toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
      expect(server.promptCount(sessionID)).toBe(1)
      const receipt = await adopted.send({ id: 'turn:recovery', text: 'same\n text', deliveryRecovery: true }, options)
      expect(receipt).toMatchObject({ outcome: 'accepted', transcriptItem: { id: deltaItemIdForPart(sessionID, firstPart.id!) } })
      expect(server.lastPrompt(sessionID)).toEqual(first)
      expect(server.session(sessionID)!.messages).toHaveLength(1)
      expect(server.session(sessionID)!.messages[0]!.parts).toHaveLength(1)
    } finally { runtime.dispose() }
  })

  it('refuses recovery without a stable id instead of minting another message and part', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const receipt = await handle.send({ text: 'same', deliveryRecovery: true }, options)
      expect(receipt).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
      expect(host.serverFor(handle.binding.sessionId)!.promptCount(handle.binding.resume!.value)).toBe(0)
    } finally { runtime.dispose() }
  })

  it('keeps the immutable retry guard across a runtime restart with no recorded part', async () => {
    const host = makeOpencodeTestHost({ adoptsLiveEndpoint: true })
    host.promptRecordTimeoutMs = 100
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    const restarted = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      server.omitNextPromptRecord()
      expect(await handle.send({ id: 'msg_lost', text: 'original' }, options)).toMatchObject({ outcome: 'unverified' })
      expect(server.session(sessionID)!.messages).toEqual([])
      const binding = handle.binding
      runtime.forget(binding.sessionId)
      const adopted = await restarted.driver.adopt(binding)
      expect(await adopted.send({ id: 'msg_lost', text: 'changed', deliveryRecovery: true }, options)).toMatchObject({ outcome: 'refused' })
      expect(server.promptCount(sessionID)).toBe(1)
      expect(await adopted.send({ id: 'msg_lost', text: 'original', deliveryRecovery: true }, options)).toMatchObject({ outcome: 'accepted', transcriptItem: { id: deltaItemIdForPart(sessionID, 'prt_000000000000lost') } })
      expect(server.lastPrompt(sessionID)).toMatchObject({ messageID: 'msg_lost', parts: [{ type: 'text', id: 'prt_000000000000lost', text: 'original' }] })
    } finally { runtime.dispose(); restarted.dispose() }
  })

  it('refuses an old message whose stored text has a different part id', async () => {
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const server = host.serverFor(handle.binding.sessionId)!
      const sessionID = handle.binding.resume!.value
      server.session(sessionID)!.messages.push({
        info: { id: 'msg_old', sessionID, role: 'user', time: { created: 1 } },
        parts: [{ id: 'prt_program_minted', sessionID, messageID: 'msg_old', type: 'text', text: 'same' }],
      })
      expect(await handle.send({ id: 'msg_old', text: 'same', deliveryRecovery: true }, options)).toMatchObject({ outcome: 'refused', refusal: { reason: 'invalid_value' } })
      expect(server.promptCount(sessionID)).toBe(0)
      expect(server.session(sessionID)!.messages[0]!.parts).toHaveLength(1)
    } finally { runtime.dispose() }
  })
})

describe('v1 prompt transport failures are unproven', () => {
  it.each([new TypeError('connection dropped'), new DOMException('timed out', 'TimeoutError')])('does not refuse %s', async (error) => {
    const host = makeOpencodeTestHost({ wrapClient: (client) => ({ ...client, prompt: async () => { throw error } }) })
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      await expect(handle.send({ id: 'msg_transport', text: 'uncertain' }, options)).rejects.toBeInstanceOf(DeliveryUnprovenError)
    } finally { runtime.dispose() }
  })

  it.each(['badId', 'badPart', 'unknownSession'] as const)('refuses the measured %s reply that stored nothing', async (name) => {
    const measured = evidence.scenarios[name]
    const host = makeOpencodeTestHost()
    const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
    try {
      const handle = await runtime.driver.create(spec)
      const server = host.serverFor(handle.binding.sessionId)!
      server.failNextPrompt(measured.status)
      const receipt: TurnReceipt = await handle.send({ id: 'msg_refused', text: 'not recorded' }, options)
      expect(receipt).toMatchObject({ outcome: 'refused', refusal: { cause: 'rejected-by-agent', detail: expect.stringContaining(String(measured.status)) } })
      expect(server.session(handle.binding.resume!.value)!.messages).toEqual([])
    } finally { runtime.dispose() }
  })
})
