import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { sendOfferAction } from './send-offer-action'

const sessionId = asSessionId('session-offer')

function procedures() {
  const sendText = vi.fn(async () => ({ ok: true, disposition: 'delivered' }))
  const resumeAndSend = vi.fn(async () => ({ ok: true, disposition: 'queued' }))
  return {
    sessions: {
      sendText: { mutate: sendText },
      resumeAndSend: { mutate: resumeAndSend },
    },
    sendText,
    resumeAndSend,
  }
}

describe('sendOfferAction', () => {
  it('dispatches a live-session action immediately instead of enqueueing it', async () => {
    const { sessions, sendText, resumeAndSend } = procedures()

    await sendOfferAction(sessions, { sessionId, text: 'Land it', wake: false })

    expect(sendText).toHaveBeenCalledWith({
      sessionId,
      text: 'Land it',
      mutationId: expect.any(String),
    })
    expect(resumeAndSend).not.toHaveBeenCalled()
  })

  it('directly wakes a parked session without routing the action through the outbox', async () => {
    const { sessions, sendText, resumeAndSend } = procedures()

    await sendOfferAction(sessions, { sessionId, text: 'Continue', wake: true })

    expect(resumeAndSend).toHaveBeenCalledWith({
      sessionId,
      text: 'Continue',
      mutationId: expect.any(String),
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('rejects an authority refusal so the action card remains retryable', async () => {
    const { sessions } = procedures()
    sessions.sendText.mutate = vi.fn(async () => ({
      ok: false,
      reason: 'session unavailable',
      disposition: 'dead_letter',
    }))

    await expect(
      sendOfferAction(sessions, { sessionId, text: 'Land it', wake: false }),
    ).rejects.toThrow('session unavailable')
  })
})
