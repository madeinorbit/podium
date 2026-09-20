import { asMachineId, asSessionId, firstAdminMemberId, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { DaemonRpcService, encodeHistoryCursor, type RpcSessionView } from './rpc'

const sessionId = asSessionId('history-session')
const machineId = asMachineId('machine')
const reader = { kind: 'user' as const, id: firstAdminMemberId() }
const row: TranscriptItem = { id: 'stable', cursor: 'native-cursor', role: 'assistant', text: 'hello' }
const cursor = { segmentId: 'provider', components: { item: 7 } }
const input = { sessionId, direction: 'before' as const, limit: 2 }

function setup() {
  const session: RpcSessionView = {
    id: sessionId, machineId, cwd: '/repo', agentKind: 'codex',
    driverId: 'codex-app-server', status: 'live',
    transcriptItems: () => [], runtimeTranscriptItems: () => [],
  }
  const memory = {
    canReadSession: vi.fn(async () => true),
    transcriptPathHint: vi.fn(async () => undefined),
    transcriptHasPredecessors: vi.fn(async () => false),
    readTranscriptFromLake: vi.fn(async () => ({ items: [row], head: 'archive-head', tail: 'archive-tail', hasMore: false })),
  }
  const toMachine = vi.fn()
  const online = vi.fn(() => true)
  const rpc = new DaemonRpcService({
    memory, toMachine, hasDaemon: online,
    defaultMachine: () => machineId, resolveMachine: () => machineId,
    machineName: async () => 'machine', onlineMachineIds: () => [machineId],
    getSession: () => session,
  })
  const history = vi.spyOn(rpc, 'runtimeHistory').mockResolvedValue({
    sessionId, result: { page: { items: [row], head: cursor, tail: cursor, hasMore: true } },
  })
  return { rpc, history, memory, session, online, toMachine }
}

describe('shared live and archive transcript boundary', () => {
  it('round trips opaque before/after cursors without changing item identity', async () => {
    const { rpc, history, memory } = setup()
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([row])
    expect(page.head).toBe(encodeHistoryCursor(sessionId, cursor))
    for (const direction of ['before', 'after'] as const) {
      await rpc.readTranscript({ ...input, anchor: page.head, direction }, reader)
      expect(history).toHaveBeenLastCalledWith(sessionId, machineId, { from: cursor, direction, limit: 2 })
    }
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('does not substitute stale archive rows for successful empty driver history', async () => {
    const { rpc, history, memory } = setup()
    history.mockResolvedValue({ sessionId, result: { page: { items: [], hasMore: false } } })
    expect(await rpc.readTranscript(input, reader)).toEqual({ items: [], hasMore: false })
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('checks permission before any history, archive, or cursor operation', async () => {
    const { rpc, history, memory } = setup()
    memory.canReadSession.mockResolvedValue(false)
    expect(await rpc.readTranscript({ ...input, anchor: 'runtime-history:garbage' }, reader)).toEqual({ items: [], hasMore: false })
    expect(history).not.toHaveBeenCalled()
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('rejects foreign/malformed history cursors and preserves typed cursor refusals', async () => {
    const { rpc, history, memory } = setup()
    for (const anchor of ['runtime-history:garbage', encodeHistoryCursor(asSessionId('other'), cursor)]) {
      await expect(rpc.readTranscript({ ...input, anchor }, reader)).rejects.toThrow('Invalid history cursor')
    }
    expect(history).not.toHaveBeenCalled()
    history.mockResolvedValue({ sessionId, result: { reason: 'invalid_value', detail: 'rotated store' } })
    await expect(rpc.readTranscript({ ...input, anchor: encodeHistoryCursor(sessionId, cursor) }, reader)).rejects.toThrow('rotated store')
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('keeps offline and predecessor reads outside live handles', async () => {
    const { rpc, history, memory, online, session } = setup()
    memory.transcriptHasPredecessors.mockResolvedValue(true)
    expect((await rpc.readTranscript(input, reader)).head).toBe('archive-head')
    expect(history).not.toHaveBeenCalled()
    const formerLive = encodeHistoryCursor(sessionId, {
      segmentId: 'history:history-session:', pathHint: 'old-active-file-offset', components: {},
    })
    expect(await rpc.readTranscript({ ...input, anchor: formerLive }, reader))
      .toMatchObject({ reset: true, head: 'archive-head' })
    expect(memory.readTranscriptFromLake).toHaveBeenLastCalledWith(session, input)
    memory.transcriptHasPredecessors.mockResolvedValue(false)
    online.mockReturnValue(false)
    session.status = 'hibernated'
    expect((await rpc.readTranscript(input, reader)).items).toEqual([row])
    expect(history).not.toHaveBeenCalled()
  })

  it('reads a parked session through the archive RPC even while its machine is online', async () => {
    const { rpc, session, toMachine, history } = setup()
    session.status = 'hibernated'
    toMachine.mockImplementation((machine, message) => {
      if (message.type === 'transcriptRead') {
        rpc.settleDaemonReply(machine, {
          type: 'transcriptReadResult', requestId: message.requestId,
          sessionId, items: [row], hasMore: false,
        })
      }
    })
    expect((await rpc.readTranscript(input, reader)).items).toEqual([row])
    expect(history).not.toHaveBeenCalled()
    expect(toMachine.mock.calls[0]?.[1]).toMatchObject({ type: 'transcriptRead' })
  })

  it('maps only the terminal host native cursor at the offline archive boundary', async () => {
    const { rpc, history, memory, online, session } = setup()
    online.mockReturnValue(false)
    session.resume = { kind: 'codex-session', value: 'native' }
    const from = { segmentId: 'history:history-session:native', pathHint: 'native-anchor', components: {} }
    await rpc.readTranscript({ ...input, direction: 'after', anchor: encodeHistoryCursor(sessionId, from) }, reader)
    expect(memory.readTranscriptFromLake).toHaveBeenLastCalledWith(session, { ...input, direction: 'after', anchor: 'native-anchor' })
    expect(history).not.toHaveBeenCalled()
    const replacement = await rpc.readTranscript({ ...input, anchor: encodeHistoryCursor(sessionId, cursor) }, reader)
    expect(replacement).toMatchObject({ reset: true, items: [row], head: 'archive-head' })
    expect(memory.readTranscriptFromLake).toHaveBeenLastCalledWith(session, input)
  })

  it('deduplicates mixed driver and provider carriage by stable identity', async () => {
    const { rpc, session } = setup()
    session.runtimeTranscriptItems = () => [{ ...row, text: 'completed' }]
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([{ ...row, text: 'completed' }])
    expect(page.head).toBe(encodeHistoryCursor(sessionId, cursor))
  })
})
