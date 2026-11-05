import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { interruptSession } from './interrupt-session'

describe('interruptSession', () => {
  it('names the turn on screen and the controller-selected durable message', async () => {
    const interruptTurn = vi.fn(async () => 'eff_1')
    await interruptSession(
      { interruptTurn },
      { turnStartedAt: '2026-11-05T10:00:00.000Z' },
      asSessionId('session-1'),
      'msg-durable',
    )
    expect(interruptTurn).toHaveBeenCalledWith(asSessionId('session-1'), {
      turn: '2026-11-05T10:00:00.000Z',
      messageId: 'msg-durable',
    })
  })

  it('with no turn known it names none, and stops whatever turn runs', async () => {
    const interruptTurn = vi.fn(async () => 'eff_1')
    await interruptSession({ interruptTurn }, undefined, asSessionId('session-1'))
    expect(interruptTurn).toHaveBeenCalledWith(asSessionId('session-1'), {})
  })

  it('a write that fails rejects, so the composer says so', async () => {
    const interruptTurn = vi.fn(async () => {
      throw new Error('offline outbox full')
    })
    await expect(
      interruptSession({ interruptTurn }, undefined, asSessionId('session-1')),
    ).rejects.toThrow('offline outbox full')
  })
})
