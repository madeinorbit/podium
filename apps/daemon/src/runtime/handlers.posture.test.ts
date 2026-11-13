/**
 * THE TURN FRAME'S POSTURE REACHES THE DRIVER (POD-6858 Task 9).
 *
 * A server that knows posture sends it beside the old vendor-worded fields; an
 * older server sends only those. The daemon hands the driver `posture` when
 * the frame has one, derives it from the old `permissionMode` when it does
 * not, and leaves it absent (the session's own posture applies) when the
 * frame states neither. The old fields still reach the driver unchanged, as
 * the facts the server minted the turn's digest over.
 */

import type { AgentSessionHandle, TurnInput } from '@podium/harness/driver/host'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from '../control/context'
import { runtimeHandlers } from './handlers'

const SESSION = asSessionId('s-posture')

function daemon() {
  const sent: DaemonMessage[] = []
  const turns: TurnInput[] = []
  const handle = {
    binding: { sessionId: SESSION, driver: 'stub', harness: 'claude-code' },
    send: vi.fn(async (turn: TurnInput) => {
      turns.push(turn)
      return { outcome: 'accepted', at: new Date(0).toISOString() }
    }),
  } as unknown as AgentSessionHandle
  const ctx = {
    agentRuntime: { handleFor: () => handle },
    send: (msg: DaemonMessage) => void sent.push(msg),
  } as unknown as DaemonContext
  return { ctx, turns }
}

function frame(extra: Record<string, unknown>) {
  return {
    type: 'runtimeSendRequest',
    requestId: 'req-1',
    turnId: 'turn-1',
    sessionId: SESSION,
    text: 'hello',
    origin: 'system',
    delivery: 'when-ready',
    ...extra,
  } as never
}

describe('the turn frame states the posture the driver runs the turn on', () => {
  it('a frame with posture yields a turn with that posture', async () => {
    const d = daemon()
    runtimeHandlers.runtimeSendRequest(
      d.ctx,
      frame({ posture: { mode: 'supervised' }, permissionMode: 'auto' }),
    )
    await vi.waitFor(() => expect(d.turns).toHaveLength(1))
    expect(d.turns[0]?.posture).toEqual({ mode: 'supervised' })
  })

  it("an older server's permissionMode alone yields that native mode", async () => {
    const d = daemon()
    runtimeHandlers.runtimeSendRequest(d.ctx, frame({ permissionMode: 'plan' }))
    await vi.waitFor(() => expect(d.turns).toHaveLength(1))
    expect(d.turns[0]?.posture).toEqual({ mode: { native: 'plan' } })
  })

  it("an older server's structuredPermissions alone (asks reach chat) yields supervised", async () => {
    const d = daemon()
    runtimeHandlers.runtimeSendRequest(d.ctx, frame({ structuredPermissions: true }))
    await vi.waitFor(() => expect(d.turns).toHaveLength(1))
    expect(d.turns[0]?.posture).toEqual({ mode: 'supervised' })
  })

  it('a frame with neither leaves the turn on the session posture', async () => {
    const d = daemon()
    runtimeHandlers.runtimeSendRequest(d.ctx, frame({}))
    await vi.waitFor(() => expect(d.turns).toHaveLength(1))
    expect(d.turns[0]).not.toHaveProperty('posture')
    expect(d.turns[0]).not.toHaveProperty('legacyTerms')
  })

  it('the old fields still reach the driver as the digest facts, and steer nothing else', async () => {
    const d = daemon()
    runtimeHandlers.runtimeSendRequest(
      d.ctx,
      frame({
        posture: { mode: 'autonomous' },
        permissionMode: 'auto',
        allowedTools: ['mcp__podium__issue_list'],
        structuredPermissions: true,
      }),
    )
    await vi.waitFor(() => expect(d.turns).toHaveLength(1))
    expect(d.turns[0]?.legacyTerms).toEqual({
      permissionMode: 'auto',
      allowedTools: ['mcp__podium__issue_list'],
      structuredPermissions: true,
    })
    expect(d.turns[0]).not.toHaveProperty('permissionMode')
    expect(d.turns[0]).not.toHaveProperty('allowedTools')
    expect(d.turns[0]).not.toHaveProperty('structuredPermissions')
  })

  it('the durable twin carries the posture the same way', async () => {
    const d = daemon()
    runtimeHandlers.runtimeDurableSendRequest(d.ctx, {
      ...(frame({ posture: { mode: { native: 'acceptEdits' } } }) as object),
      type: 'runtimeDurableSendRequest',
      rowId: 'row-1',
      deliveryRecovery: false,
    } as never)
    await vi.waitFor(() => expect(d.turns).toHaveLength(1))
    expect(d.turns[0]?.posture).toEqual({ mode: { native: 'acceptEdits' } })
  })
})
