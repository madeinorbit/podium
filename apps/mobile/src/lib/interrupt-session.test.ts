import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { interruptSession } from './interrupt-session'

describe('interruptSession', () => {
  it('passes the controller-selected durable message id to the mutation', async () => {
    const mutate = vi.fn(async () => ({ ok: true }))
    await interruptSession({ interrupt: { mutate } }, asSessionId('session-1'), 'msg-durable')
    expect(mutate).toHaveBeenCalledWith({
      sessionId: asSessionId('session-1'),
      messageId: 'msg-durable',
    })
  })

  it('keeps a refused interrupt retryable', async () => {
    const mutate = vi.fn(async () => ({ ok: false, reason: 'already idle' }))
    await expect(
      interruptSession({ interrupt: { mutate } }, asSessionId('session-1')),
    ).rejects.toThrow('already idle')
  })
})
