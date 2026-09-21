import { DriverRefusalError } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import { ControlMessage, DaemonMessage, type RuntimeHistoryPage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'
import { seedRuntimeHistory } from './history-seed'

const sessionId = asSessionId('history-session')
const range = { direction: 'after' as const, limit: 2, from: { segmentId: 'history-session', components: { item: 1 } } }
const request = { type: 'runtimeHistoryRequest' as const, requestId: 'history-1', sessionId, range }

async function dispatch(history?: () => Promise<RuntimeHistoryPage>) {
  const sent: DaemonMessage[] = []
  const read = vi.fn(history)
  const ctx = {
    send: (message: DaemonMessage) => sent.push(DaemonMessage.parse(message)),
    agentRuntime: { handleFor: () => history ? { transcript: { history: read } } : undefined },
  } as unknown as DaemonContext
  const parsed = ControlMessage.parse(request)
  if (parsed.type !== 'runtimeHistoryRequest') throw new Error('wrong frame')
  runtimeHandlers.runtimeHistoryRequest(ctx, parsed)
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  return { sent, read }
}

describe('runtime history wire', () => {
  it('preserves direction, cursor envelope, and correlation', async () => {
    const page = { items: [], head: range.from, tail: range.from, hasMore: true }
    const { sent, read } = await dispatch(async () => page)
    expect(read).toHaveBeenCalledWith(range)
    expect(sent).toEqual([{ type: 'runtimeHistoryResult', requestId: request.requestId, sessionId, result: { page } }])
  })
  it('answers a missing handle with not_running, never an empty history', async () => {
    const { sent } = await dispatch()
    expect(sent[0]).toMatchObject({ result: { reason: 'not_running' } })
  })
  it('preserves typed cursor refusals', async () => {
    const { sent } = await dispatch(async () => { throw new DriverRefusalError({ reason: 'invalid_value', detail: 'foreign cursor' }) })
    expect(sent[0]).toMatchObject({ result: { reason: 'invalid_value', detail: 'foreign cursor' } })
  })
  it('answers transport failures', async () => {
    const { sent } = await dispatch(async () => { throw new Error('provider disconnected') })
    expect(sent[0]).toMatchObject({ result: { reason: 'not_running' } })
  })
  it('rejects invalid page limits at the wire boundary', () => {
    for (const limit of [0, -1, 1.5, 10001]) {
      expect(ControlMessage.safeParse({ ...request, range: { ...range, limit } }).success).toBe(false)
    }
  })
})


describe('quiet reconnect history seed', () => {
  it.each([{ items: [] }, { items: [{ id: 'stable', cursor: 'native', role: 'assistant' as const, text: 'held' }] }])(
    'publishes an authoritative reset without new provider output: %j', async ({ items }) => {
      const history = vi.fn(async () => ({ items, hasMore: false }))
      const handle = { transcript: { history } }
      const send = vi.fn()
      const ctx = { agentRuntime: { handleFor: () => handle }, send } as unknown as DaemonContext
      await seedRuntimeHistory(ctx, sessionId)
      expect(history).toHaveBeenCalledWith({ direction: 'before', limit: 2000 })
      expect(send).toHaveBeenCalledWith({
        type: 'transcriptDelta', sessionId, items, reset: true,
        ...(items.at(-1)?.cursor ? { tail: items.at(-1)!.cursor } : {}),
      })
    },
  )

  it('drops a late history read when its handle was replaced', async () => {
    let finish!: (page: RuntimeHistoryPage) => void
    let handle: unknown = { transcript: { history: () => new Promise<RuntimeHistoryPage>((resolve) => { finish = resolve }) } }
    const send = vi.fn()
    const ctx = { agentRuntime: { handleFor: () => handle }, send } as unknown as DaemonContext
    const seed = seedRuntimeHistory(ctx, sessionId)
    handle = undefined
    finish({ items: [], hasMore: false })
    await seed
    expect(send).not.toHaveBeenCalled()
  })
})
