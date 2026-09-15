import type { AgentSessionHandle } from '@podium/agent-runtime'
import { asSessionId } from '@podium/model'
import { RuntimeDraftRequestMessage, type DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const sessionId = asSessionId('draft-session')
const request = { type: 'runtimeDraftRequest' as const, requestId: 'draft-request', sessionId }

async function dispatch(operation: { verb: 'get' } | { verb: 'set'; text: string }, draft?: AgentSessionHandle['draft']) {
  const sent: DaemonMessage[] = []
  const ctx = {
    send: (message: DaemonMessage) => sent.push(message),
    agentRuntime: { handleFor: () => draft ? { draft } : undefined },
  } as unknown as DaemonContext
  runtimeHandlers.runtimeDraftRequest(ctx, { ...request, operation } as never)
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({ type: 'runtimeDraftResult', requestId: request.requestId, sessionId })
  return sent[0]
}

describe('runtime draft transport', () => {
  it('reads an empty draft without turning it into an absent value', async () => {
    expect(await dispatch({ verb: 'get' }, { get: async () => '', set: vi.fn() })).toMatchObject({ result: { text: '' } })
  })
  it('forwards an empty replacement and preserves the driver refusal', async () => {
    const set = vi.fn(async () => ({ reason: 'unsupported' as const, detail: 'read only' }))
    expect(await dispatch({ verb: 'set', text: '' }, { get: vi.fn(), set })).toMatchObject({ result: { reason: 'unsupported', detail: 'read only' } })
    expect(set).toHaveBeenCalledWith('')
  })
  it('answers when the session is absent or its transport throws', async () => {
    expect(await dispatch({ verb: 'get' })).toMatchObject({ result: { reason: 'not_running' } })
    expect(await dispatch({ verb: 'get' }, { get: async () => { throw new Error('closed') }, set: vi.fn() })).toMatchObject({ result: { reason: 'not_running' } })
  })
  it('rejects a set request without its replacement text', () => {
    expect(RuntimeDraftRequestMessage.safeParse({ ...request, operation: { verb: 'set' } }).success).toBe(false)
    expect(RuntimeDraftRequestMessage.safeParse({ ...request, operation: { verb: 'set', text: '' } }).success).toBe(true)
  })
})
