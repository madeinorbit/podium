import { asMachineId, asSessionId, firstAdminMemberId, type TranscriptItem } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { DaemonRpcService, type RpcSessionView, type TranscriptSlice } from './rpc'

const sessionId = asSessionId('history-session')
const machineId = asMachineId('machine')
const reader = { kind: 'user' as const, id: firstAdminMemberId() }
const daemonRow: TranscriptItem = { id: 'daemon-stable', cursor: 'daemon-cursor', role: 'assistant', text: 'hello' }
const lakeRow: TranscriptItem = { id: 'lake-stable', cursor: 'lake-cursor', role: 'assistant', text: 'lake hello' }
const input = { sessionId, direction: 'before' as const, limit: 2 }

function setup(opts?: { predecessors?: boolean; online?: boolean }) {
  const session: RpcSessionView = {
    id: sessionId, machineId, cwd: '/repo', agentKind: 'codex',
    driverId: 'codex-app-server', status: 'live',
    transcriptItems: () => [], runtimeTranscriptItems: () => [],
  }
  const memory = {
    canReadSession: vi.fn(async () => true),
    transcriptPathHint: vi.fn(async () => undefined),
    transcriptHasPredecessors: vi.fn(async () => opts?.predecessors ?? false),
    readTranscriptFromLake: vi.fn(async (): Promise<TranscriptSlice | undefined> => ({ items: [lakeRow], head: 'archive-head', tail: 'archive-tail', hasMore: false })),
  }
  const toMachine = vi.fn()
  const online = vi.fn(() => opts?.online ?? true)
  const rpc = new DaemonRpcService({
    memory, toMachine, hasDaemon: online,
    defaultMachine: () => machineId, resolveMachine: () => machineId,
    machineName: async () => 'machine', onlineMachineIds: () => [machineId],
    getSession: () => session,
  })
  const answerDaemon = (items: TranscriptItem[]) => {
    toMachine.mockImplementation((machine, message) => {
      if (message.type === 'transcriptRead') {
        rpc.settleDaemonReply(machine, {
          type: 'transcriptReadResult', requestId: message.requestId,
          sessionId, items, hasMore: false,
        })
      }
    })
  }
  return { rpc, memory, session, online, toMachine, answerDaemon }
}

describe('single Store transcript read path', () => {
  it('serves a live session from the daemon transcriptRead, never runtimeHistory', async () => {
    const { rpc, memory, toMachine, answerDaemon } = setup()
    answerDaemon([daemonRow])
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([daemonRow])
    expect(page.reset).toBeUndefined()
    expect(toMachine.mock.calls[0]?.[1]).toMatchObject({ type: 'transcriptRead' })
    expect(toMachine.mock.calls.some(([, m]) => m.type === 'runtimeHistoryRequest')).toBe(false)
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('falls back to the lake when the daemon answer is empty', async () => {
    const { rpc, memory, answerDaemon } = setup()
    answerDaemon([])
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([lakeRow])
    expect(page.head).toBe('archive-head')
    expect(memory.readTranscriptFromLake).toHaveBeenCalled()
  })

  it('reads a predecessor chain from the lake even while the machine is online', async () => {
    const { rpc, memory, toMachine, answerDaemon } = setup({ predecessors: true })
    answerDaemon([daemonRow])
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([lakeRow])
    expect(toMachine).not.toHaveBeenCalled()
    expect(memory.readTranscriptFromLake).toHaveBeenCalled()
  })

  it('reads from the lake when no daemon is connected', async () => {
    const { rpc, memory, toMachine } = setup({ online: false })
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([lakeRow])
    expect(toMachine).not.toHaveBeenCalled()
    expect(memory.readTranscriptFromLake).toHaveBeenCalled()
  })

  it('marks an empty offline page with the machine name instead of a silent empty (POD-4808 half 1)', async () => {
    const { rpc, memory } = setup({ online: false })
    memory.readTranscriptFromLake.mockResolvedValue(undefined)
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([])
    expect(page.hasMore).toBe(false)
    expect(page.offline).toEqual({ machineName: 'machine' })
  })

  it('marks a lake-served offline page with the machine name so the chat can show the machine is offline (POD-4808 half 2)', async () => {
    const { rpc } = setup({ online: false })
    const page = await rpc.readTranscript(input, reader)
    expect(page.items).toEqual([lakeRow])
    expect(page.offline).toEqual({ machineName: 'machine' })
  })

  it('passes archive anchors through to the serving source', async () => {
    const { rpc, memory, toMachine, answerDaemon } = setup()
    answerDaemon([daemonRow])
    await rpc.readTranscript({ ...input, direction: 'after', anchor: 'native-anchor' }, reader)
    expect(toMachine.mock.calls[0]?.[1]).toMatchObject({ type: 'transcriptRead', anchor: 'native-anchor', direction: 'after' })
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('gives a client holding a retired runtime cursor a clean first page, not an error', async () => {
    const { rpc, memory, toMachine, answerDaemon } = setup()
    answerDaemon([daemonRow])
    for (const direction of ['before', 'after'] as const) {
      const page = await rpc.readTranscript(
        { ...input, direction, anchor: 'runtime-history:garbage' }, reader,
      )
      expect(page).toMatchObject({ reset: true, items: [daemonRow] })
    }
    // The retired cursor never reaches the daemon or the lake as an anchor.
    for (const [, message] of toMachine.mock.calls) {
      expect(message).toMatchObject({ type: 'transcriptRead' })
      expect((message as { anchor?: string }).anchor).toBeUndefined()
    }
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
  })

  it('checks permission before any daemon, lake, or cursor operation', async () => {
    const { rpc, memory, toMachine } = setup()
    memory.canReadSession.mockResolvedValue(false)
    expect(await rpc.readTranscript({ ...input, anchor: 'runtime-history:garbage' }, reader)).toEqual({ items: [], hasMore: false })
    expect(toMachine).not.toHaveBeenCalled()
    expect(memory.readTranscriptFromLake).not.toHaveBeenCalled()
    expect(memory.transcriptHasPredecessors).not.toHaveBeenCalled()
  })

  it('merges runtime deltas onto the unanchored latest page only', async () => {
    const { rpc, session, answerDaemon } = setup()
    answerDaemon([daemonRow])
    session.runtimeTranscriptItems = () => [{ ...daemonRow, text: 'completed' }]
    const latest = await rpc.readTranscript(input, reader)
    expect(latest.items).toEqual([{ ...daemonRow, text: 'completed' }])
    const anchored = await rpc.readTranscript({ ...input, anchor: 'native-anchor' }, reader)
    expect(anchored.items).toEqual([daemonRow])
  })
})
