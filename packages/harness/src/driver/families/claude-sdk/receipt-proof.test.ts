import type { SessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionHandle, RuntimeEvent } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import { createClaudeSdkRuntime, type ClaudeSdkRuntimeHost } from './runtime.js'
import { createClaudeStreamClient, type ClaudeStreamTransport } from './protocol.js'
import ack from './__fixtures__/user-message-ack.json' with { type: 'json' }
import records from './__fixtures__/transcript-receipts.json' with { type: 'json' }

const SESSION = 'claude-receipt-proof' as SessionId
const NATIVE = ack.lifecycleQueued.session_id
const UUID = ack.userLine.uuid
const MESSAGE = `msg_${UUID}`
const cleanups: Array<() => void> = []

/** The real stream parser and runtime, with the CLI's wire and disk separate. */
async function world(initialHistory = '') {
  const writes: string[] = []
  const lines = new Set<(line: string) => void>()
  const exits = new Set<(code: number | null, signal: string | null) => void>()
  const transport: ClaudeStreamTransport = {
    writeLine: (line) => { writes.push(line) },
    onLine: (cb) => { lines.add(cb); return () => lines.delete(cb) },
    onExit: (cb) => { exits.add(cb); return () => exits.delete(cb) },
    close() {},
  }
  const frame = (value: unknown) => {
    for (const cb of lines) cb(JSON.stringify(value))
  }
  const client = createClaudeStreamClient(transport, { sessionId: NATIVE, timeoutMs: 600_000 })
  const init = JSON.parse(writes[0] ?? '{}')
  frame({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id, response: {} } })
  frame({ type: 'system', subtype: 'init', session_id: NATIVE })
  let history = initialHistory
  const readArchive = vi.fn(async () => ({
    path: `${NATIVE}.jsonl`,
    bytes: new TextEncoder().encode(history),
  }))
  const host: ClaudeSdkRuntimeHost = {
    mintSessionId: () => SESSION,
    mintResumeValue: () => NATIVE,
    now: () => '2026-09-29T16:27:07.881Z',
    startTurn(input) {
      const turn = client.turn(input.turn.text, { ...input, emit() {} }, { userMessageUuid: input.userMessageUuid })
      const done = turn.done.then((result) => ({ resumeValue: result.harnessSessionId, output: result.output }))
      done.catch(() => {})
      return { ...turn, done, accepted: turn.accepted.then(() => {}) }
    },
    readTranscript: async () => ({ items: [], hasMore: false }),
    readArchive,
  }
  const runtime = createClaudeSdkRuntime(host, createMemoryDriverSlots())
  const handle = await runtime.resumeWithId(SESSION, { kind: 'claude-session', value: NATIVE }, {
    harness: 'claude-code',
    selection: { auth: 'subscription', platform: 'linux', available: ['claude-sdk'], preference: 'claude-sdk' },
    workdir: '/scratch/claude-receipt-proof',
    model: {},
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
  })
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of handle.events('bootstrap')) events.push(event)
  })()
  const dispose = () => { runtime.dispose(); client.close() }
  cleanups.push(dispose)
  return {
    handle, runtime, events, writes, readArchive, frame, dispose,
    append(record: unknown) { history += `${JSON.stringify(record)}\n` },
    appendBytes(text: string) { history += text },
    exit() { for (const cb of exits) cb(null, 'SIGKILL') },
  }
}

function userRecord(uuid = UUID) {
  return { ...records.userRecord, uuid, sessionId: NATIVE }
}

function queuedRecord() {
  return {
    ...records.queuedRecord,
    sessionId: NATIVE,
    attachment: { ...records.queuedRecord.attachment, source_uuid: UUID },
  }
}

const tick = () => vi.advanceTimersByTimeAsync(250)
const userItems = (events: RuntimeEvent[]) => events.flatMap((event) =>
  event.t === 'item' && event.item.kind === 'complete' && event.item.item.role === 'user' ? [event.item.item] : [],
)
const deliveries = (events: RuntimeEvent[]) => events.filter((event) => event.t === 'delivery')
const send = (handle: AgentSessionHandle, onTranscriptItem = vi.fn(), onUnrecorded = vi.fn()) =>
  handle.send({ id: MESSAGE, text: 'one' }, { origin: 'human', delivery: 'when-ready', onTranscriptItem, onUnrecorded })

describe('Claude SDK receipt proof from its history (POD-4889)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const dispose of cleanups.splice(0)) dispose()
    vi.useRealTimers()
  })

  it('queued accepts in memory; started, replay, completed and cancelled cannot confirm', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const receipt = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    await expect(receipt).resolves.toMatchObject({ outcome: 'accepted', held: 'memory', provenBy: 'protocol-ack' })
    expect(await receipt).not.toHaveProperty('transcriptItem')
    w.frame(ack.lifecycleStarted)
    w.frame(ack.freshEcho)
    w.frame({ ...ack.lifecycleStarted, state: 'completed' })
    w.frame({ ...ack.lifecycleStarted, state: 'cancelled' })
    await tick()
    expect(confirmed).not.toHaveBeenCalled()
    expect(userItems(w.events)).toEqual([])
    expect(deliveries(w.events)).toEqual([])
  })

  it('names and publishes the user entry only when the transcript holds our uuid', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const receipt = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    await receipt
    w.append(userRecord('99999999-9999-4999-8999-999999999999'))
    await tick()
    expect(confirmed).not.toHaveBeenCalled()
    w.append(userRecord())
    await tick()
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ id: UUID }, [{ kind: 'claude-uuid', id: UUID }])
    expect(userItems(w.events)).toEqual([expect.objectContaining({ id: UUID, text: 'ERR400 S10A idle' })])
    await tick()
    expect(confirmed).toHaveBeenCalledTimes(1)
  })

  it('binds a queued_command source_uuid to the attachment entry, including SDK text blocks', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const receipt = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    await receipt
    const record = queuedRecord()
    w.append(record)
    await tick()
    expect(confirmed).toHaveBeenCalledExactlyOnceWith({ id: record.uuid }, [{ kind: 'claude-uuid', id: UUID }])
    expect(userItems(w.events)).toEqual([expect.objectContaining({ id: record.uuid, text: 'QUEUED-K2 in tool' })])
  })

  it('a kill after queued leaves the accepted line unconfirmed when no record exists', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const receipt = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    w.frame(ack.lifecycleStarted)
    await receipt
    w.exit()
    await tick()
    expect(await receipt).toMatchObject({ outcome: 'accepted', held: 'memory' })
    expect(confirmed).not.toHaveBeenCalled()
    expect(userItems(w.events)).toEqual([])
    expect(deliveries(w.events)).toEqual([])
  })

  it('HTTP 400 and cancelled do not prevent confirmation, even when the record is read later', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const unrecorded = vi.fn()
    const receipt = send(w.handle, confirmed, unrecorded)
    w.frame(ack.lifecycleQueued)
    await receipt
    w.frame({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 400', session_id: NATIVE })
    w.frame({ ...ack.lifecycleStarted, state: 'cancelled' })
    await tick()
    expect(unrecorded).not.toHaveBeenCalled()
    w.append(userRecord())
    await tick()
    expect(confirmed).toHaveBeenCalledTimes(1)
    expect(unrecorded).not.toHaveBeenCalled()
  })

  it('a repeated uuid confirms the same recorded entry and publishes no second user entry', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const first = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    await first
    w.append(userRecord())
    await tick()
    w.frame({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: NATIVE })
    await tick()
    const again = send(w.handle, confirmed)
    w.frame(ack.duplicateEchoSameProcess)
    await again
    await tick()
    expect(confirmed.mock.calls.map(([item]) => item)).toEqual([{ id: UUID }, { id: UUID }])
    expect(userItems(w.events).map((item) => item.id)).toEqual([UUID])
    expect(w.writes.map((line) => JSON.parse(line)).filter((line) => line.type === 'user').map((line) => line.uuid)).toEqual([UUID, UUID])
  })

  it('resends a lost durable line after restart under the same uuid and confirms once', async () => {
    const first = await world()
    const lost = send(first.handle)
    first.frame(ack.lifecycleQueued)
    await lost
    first.exit()
    first.dispose()
    const resumed = await world()
    await resumed.handle.send({ id: MESSAGE, rowId: MESSAGE, deliveryRecovery: true, text: 'one' }, { origin: 'human', delivery: 'when-ready' })
    await tick()
    const userLines = (writes: string[]) => writes.map((line) => JSON.parse(line)).filter((line) => line.type === 'user')
    expect(userLines(first.writes).map((line) => line.uuid)).toEqual([UUID])
    expect(userLines(resumed.writes).map((line) => line.uuid)).toEqual([UUID])
    resumed.frame(ack.lifecycleQueued)
    await tick()
    expect(deliveries(resumed.events)).toEqual([])
    resumed.append(userRecord())
    await tick()
    expect(deliveries(resumed.events)).toEqual([expect.objectContaining({ rowId: MESSAGE, outcome: 'delivered', transcriptItem: { id: UUID } })])
    await tick()
    expect(deliveries(resumed.events)).toHaveLength(1)
  })

  it('recovery of an already recorded line confirms the existing entry after Claude skips it', async () => {
    const w = await world(`${JSON.stringify(userRecord())}\n`)
    await w.handle.send({ id: MESSAGE, rowId: MESSAGE, deliveryRecovery: true, text: 'one' }, { origin: 'human', delivery: 'when-ready' })
    await tick()
    expect(w.writes.map((line) => JSON.parse(line)).filter((line) => line.type === 'user')).toHaveLength(1)
    w.frame(ack.duplicateEchoAfterResume)
    w.frame(ack.duplicateCompletedAfterResume)
    await tick()
    expect(deliveries(w.events)).toEqual([expect.objectContaining({ outcome: 'delivered', transcriptItem: { id: UUID } })])
    expect(userItems(w.events)).toHaveLength(1)
  })

  it('ignores another session, sidechains, synthetic prompts, and replay echoes even with our uuid', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const receipt = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    await receipt
    w.append({ ...userRecord(), sessionId: 'another-conversation' })
    w.append({ ...userRecord(), isSidechain: true })
    w.append({ ...userRecord(), isCompactSummary: true })
    w.append({ ...userRecord(), isMeta: true })
    w.append({ ...userRecord(), isReplay: true })
    const queued = queuedRecord()
    w.append({ ...queued, attachment: { ...queued.attachment, commandMode: 'task-notification' } })
    await tick()
    expect(confirmed).not.toHaveBeenCalled()
    expect(userItems(w.events)).toEqual([])
  })

  it('waits for the complete JSONL record across a partial append', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const receipt = send(w.handle, confirmed)
    w.frame(ack.lifecycleQueued)
    await receipt
    const line = JSON.stringify(userRecord())
    w.appendBytes(line.slice(0, -2))
    await tick()
    expect(confirmed).not.toHaveBeenCalled()
    w.appendBytes(`${line.slice(-2)}\n`)
    await tick()
    expect(confirmed).toHaveBeenCalledTimes(1)
  })

  it('checks the transcript after a process exit before closing its watch', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const unrecorded = vi.fn()
    const receipt = send(w.handle, confirmed, unrecorded)
    w.frame(ack.lifecycleQueued)
    await receipt
    w.runtime.processEvent(SESSION, { ev: 'exited', code: null, signal: 'SIGKILL', classification: 'killed' })
    w.append(userRecord())
    await tick()
    expect(confirmed).toHaveBeenCalledTimes(1)
    expect(unrecorded).not.toHaveBeenCalled()
  })

  it('closes an expired watch as unrecorded once, without claiming a failed delivery', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const unrecorded = vi.fn()
    const receipt = send(w.handle, confirmed, unrecorded)
    w.frame(ack.lifecycleQueued)
    await receipt
    await vi.advanceTimersByTimeAsync(121_000)
    expect(await receipt).toMatchObject({ outcome: 'accepted', held: 'memory' })
    expect(unrecorded).toHaveBeenCalledTimes(1)
    expect(confirmed).not.toHaveBeenCalled()
    const reads = w.readArchive.mock.calls.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(w.readArchive).toHaveBeenCalledTimes(reads)
    expect(unrecorded).toHaveBeenCalledTimes(1)
  })

  it('teardown releases the watch and never confirms a later append', async () => {
    const w = await world()
    const confirmed = vi.fn()
    const unrecorded = vi.fn()
    const receipt = send(w.handle, confirmed, unrecorded)
    w.frame(ack.lifecycleQueued)
    await receipt
    w.dispose()
    const reads = w.readArchive.mock.calls.length
    w.append(userRecord())
    await tick()
    expect(unrecorded).toHaveBeenCalledTimes(1)
    expect(confirmed).not.toHaveBeenCalled()
    expect(w.readArchive).toHaveBeenCalledTimes(reads)
  })

  it('keeps the shared recovery stop when no stable message id was supplied', async () => {
    const w = await world()
    await w.handle.send({ rowId: MESSAGE, deliveryRecovery: true, text: 'one' }, { origin: 'human', delivery: 'when-ready' })
    await tick()
    expect(w.writes.map((line) => JSON.parse(line)).filter((line) => line.type === 'user')).toEqual([])
    expect(deliveries(w.events)).toEqual([expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' })])
  })
})
