import { asMachineId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonRequestBroker } from '../daemon-request'
import { DaemonRpcService } from './rpc'

const machineId = asMachineId('desk')
const otherId = asMachineId('other')

function setup() {
  const sent: { machineId: typeof machineId; msg: Record<string, unknown> }[] = []
  const broker = new DaemonRequestBroker({
    toMachine: (id, msg) => {
      sent.push({ machineId: id, msg: msg as Record<string, unknown> })
    },
    defaultMachine: () => machineId,
  })
  const rpc = new DaemonRpcService({
    broker,
    memory: {
      canReadSession: async () => true,
      transcriptPathHint: async () => undefined,
      readTranscriptFromLake: async () => ({ items: [], hasMore: false }),
      transcriptHasPredecessors: async () => false,
    },
    toMachine: () => {},
    defaultMachine: () => machineId,
    resolveMachine: () => machineId,
    hasDaemon: () => true,
    machineName: async () => 'desk',
    onlineMachineIds: () => [machineId],
    getSession: () => undefined,
  })
  return { rpc, sent }
}

/** machineName + build resolve on later microtasks; the send lands after them. */
async function flushSends(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const input = {
  model: 'gpt-5.5',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [],
  effort: 'medium' as const,
}

describe('DaemonRpcService.codexComplete (POD-4750)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a codexCompleteRequest to the named machine and settles its reply', async () => {
    const { rpc, sent } = setup()
    const pending = rpc.codexComplete(machineId, input)
    await flushSends()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.machineId).toBe(machineId)
    const requestId = sent[0]!.msg.requestId as string
    expect(sent[0]!.msg).toMatchObject({
      type: 'codexCompleteRequest',
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      effort: 'medium',
    })
    expect(requestId.startsWith('cc')).toBe(true)
    rpc.settleDaemonReply(machineId, {
      type: 'codexCompleteResult',
      requestId,
      ok: true,
      text: 'all clean',
      toolCalls: [],
    })
    await expect(pending).resolves.toEqual({ ok: true, text: 'all clean', toolCalls: [] })
  })

  it('passes an older-daemon refusal through (clear error, not a hang)', async () => {
    const { rpc, sent } = setup()
    const pending = rpc.codexComplete(machineId, input)
    await flushSends()
    const requestId = sent[0]!.msg.requestId as string
    rpc.settleDaemonReply(machineId, {
      type: 'codexCompleteResult',
      requestId,
      ok: false,
      error: 'this daemon (podium 0.4.1) does not know server-side Codex turns — update podium on this machine, then ask again',
    })
    await expect(pending).resolves.toMatchObject({ ok: false, error: expect.stringContaining('update podium') })
  })

  it('a silent (older, pre-arm) daemon resolves on the deadline as "may be older", never "offline"', async () => {
    vi.useFakeTimers()
    const { rpc, sent } = setup()
    const pending = rpc.codexComplete(machineId, input)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(125_000)
    const result = await pending
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('no reply from desk; its daemon may be older than this server'),
    })
    if (!result.ok) expect(result.error).not.toMatch(/offline/)
  })

  it('drops a reply from the wrong machine and leaves the request to the deadline (POD-1175)', async () => {
    vi.useFakeTimers()
    const { rpc, sent } = setup()
    const pending = rpc.codexComplete(machineId, input)
    await vi.advanceTimersByTimeAsync(0)
    const requestId = sent[0]!.msg.requestId as string
    // Another machine's answer must not settle this request.
    rpc.settleDaemonReply(otherId, {
      type: 'codexCompleteResult',
      requestId,
      ok: true,
      text: 'forged',
      toolCalls: [],
    })
    await vi.advanceTimersByTimeAsync(125_000)
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('no reply from desk'),
    })
  })
})
